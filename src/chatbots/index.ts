import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { normalizePhone } from '../customers';
import { classifyIntent, Intent } from './router';
import { runOrderSupport } from './orderSupport';
import { runTenantInfo } from './tenantInfo';
import { maybeSummarize, getConversationContext } from './summarizer';
import { buildCustomerProfile, formatProfileContext } from './customerContext';
import { executeHandoff } from './handoff';

const log = createChildLogger({ module: 'chatbot' });

export interface InboundMessage {
  tenantId: string;
  fromPhone: string;
  body: string;
  waMessageId?: string | null;
}

export interface ChatbotReply {
  reply: string;
  intent: Intent;
  agent: 'order_support' | 'tenant_info' | 'router' | 'system';
  conversationId: string;
  escalated: boolean;
}

/**
 * Process one inbound WhatsApp message:
 *  1. Find or create conversation
 *  2. Save user message
 *  3. Classify intent
 *  4. Run the matching agent
 *  5. Save assistant reply
 *  6. Return reply to caller (caller actually sends it via WhatsApp)
 */
export async function handleInbound(msg: InboundMessage): Promise<ChatbotReply | null> {
  const db = getDb();
  const phoneNormalized = normalizePhone(msg.fromPhone);
  if (!phoneNormalized || phoneNormalized.length < 5) {
    log.warn({ from: msg.fromPhone }, 'Invalid sender phone, skipping');
    return null;
  }

  // 1. Find or create conversation
  const conversation = await getOrCreateConversation(msg.tenantId, phoneNormalized);

  // 2. Save user message
  await db('chat_messages').insert({
    conversation_id: conversation.id,
    tenant_id: msg.tenantId,
    role: 'user',
    content: msg.body,
    wa_message_id: msg.waMessageId || null,
  });
  await db('chat_conversations').where({ id: conversation.id }).update({
    last_message_at: new Date(),
    updated_at: new Date(),
  });

  // 3. Classify intent
  const cls = await classifyIntent(msg.body, conversation.current_intent);
  log.info({ conversationId: conversation.id, intent: cls.intent, confidence: cls.confidence }, 'Intent classified');

  // 4. Build context using summarizer (includes summary + recent messages)
  const ctx = await getConversationContext(conversation.id);
  const history = ctx.recentMessages.slice(0, -1); // exclude the just-stored user message
  const summaryPrefix = ctx.summary ? `[Previous context: ${ctx.summary}]` : null;

  // 4b. Build customer profile for memory
  const profile = await buildCustomerProfile(msg.tenantId, phoneNormalized);
  const profileContext = formatProfileContext(profile);
  const contextPrefix = [summaryPrefix, profileContext].filter(Boolean).join('\n');

  let reply: string;
  let agent: 'order_support' | 'tenant_info' | 'router' | 'system' = 'router';
  let escalated = false;
  let toolCalls: any[] = [];

  // Load chatbot settings for this tenant
  const chatSettings = await db('chatbot_settings').where({ tenant_id: msg.tenantId }).first();
  const botName = chatSettings?.bot_name || 'Muti AI';
  const escalationMsg = chatSettings?.escalation_message || "Sure — I have flagged this for a team member. They will reach out shortly.";
  const greetingMsg = chatSettings?.greeting_message || null;
  const unknownMsg = chatSettings?.unknown_intent_message || "I can help with your orders or store questions. What would you like to know?";
  const blockedTopics = Array.isArray(chatSettings?.blocked_topics) ? chatSettings.blocked_topics : [];
  const blockedResponse = chatSettings?.blocked_topic_response || escalationMsg;

  // Check blocked topics
  if (blockedTopics.length > 0) {
    const msgLower = msg.body.toLowerCase();
    const isBlocked = blockedTopics.some((t: string) => msgLower.includes(t.toLowerCase()));
    if (isBlocked) {
      agent = 'system';
      escalated = true;
      reply = blockedResponse;
      // Save and return early
      await db('chat_messages').insert({ conversation_id: conversation.id, tenant_id: msg.tenantId, role: 'assistant', content: reply, intent: 'blocked_topic', agent });
      await db('chat_conversations').where({ id: conversation.id }).update({ current_intent: 'blocked_topic', status: 'escalated', escalated_at: new Date(), updated_at: new Date() });
      return { reply, intent: 'unknown' as Intent, agent, conversationId: conversation.id, escalated: true };
    }
  }

  // 5. Dispatch to matching agent
  // Low-confidence handling: only ask a clarifying question for very low confidence
  // ambiguous text. Otherwise route to the best-guess agent — they ground in their
  // own data (orders DB / knowledge base) and will say so if they can't help.
  if (cls.confidence < 0.4 && cls.intent !== 'small_talk' && cls.intent !== 'human_handoff') {
    agent = 'system';
    reply = "I'm not sure I understood. Are you asking about your order (tracking, delivery, PIN), or about our store (shipping, returns, products)?";
    await db('chat_messages').insert({ conversation_id: conversation.id, tenant_id: msg.tenantId, role: 'assistant', content: reply, intent: cls.intent, agent });
    await db('chat_conversations').where({ id: conversation.id }).update({ current_intent: cls.intent, updated_at: new Date() });
    maybeSummarize(conversation.id).catch(() => {});
    return { reply, intent: cls.intent, agent, conversationId: conversation.id, escalated: false };
  }

  if (cls.intent === 'order_support') {
    agent = 'order_support';
    const r = await runOrderSupport({
      tenantId: msg.tenantId,
      conversationId: conversation.id,
      customerPhone: phoneNormalized,
      history,
      message: contextPrefix ? `${contextPrefix}\n\n${msg.body}` : msg.body,
    });
    reply = r.reply;
    escalated = r.escalated;
    toolCalls = r.tool_calls;
    if (r.escalated) {
      executeHandoff({
        tenantId: msg.tenantId,
        conversationId: conversation.id,
        customerPhone: phoneNormalized,
        customerName: profile.name,
        reason: r.escalation_reason || 'Agent escalated',
        recentMessages: history,
      }).catch(() => {});
    }
  } else if (cls.intent === 'tenant_info') {
    agent = 'tenant_info';
    const r = await runTenantInfo({
      tenantId: msg.tenantId,
      history,
      message: contextPrefix ? `${contextPrefix}\n\n${msg.body}` : msg.body,
    });
    reply = r.reply;
  } else if (cls.intent === 'small_talk') {
    agent = 'system';
    reply = greetingMsg || pickGreeting();
  } else if (cls.intent === 'human_handoff') {
    agent = 'system';
    escalated = true;
    reply = escalationMsg;
    // Execute structured handoff (notify human agent with context)
    executeHandoff({
      tenantId: msg.tenantId,
      conversationId: conversation.id,
      customerPhone: phoneNormalized,
      customerName: profile.name,
      reason: 'Customer requested human agent',
      recentMessages: history,
    }).catch(() => {});
  } else {
    agent = 'system';
    reply = unknownMsg;
  }

  // 6. Save assistant reply
  await db('chat_messages').insert({
    conversation_id: conversation.id,
    tenant_id: msg.tenantId,
    role: 'assistant',
    content: reply,
    intent: cls.intent,
    agent,
    tool_calls: JSON.stringify(toolCalls),
  });

  // Update conversation state
  const updates: any = { current_intent: cls.intent, updated_at: new Date() };
  if (escalated) {
    updates.status = 'escalated';
    updates.escalated_at = new Date();
  }
  await db('chat_conversations').where({ id: conversation.id }).update(updates);

  // Summarize if conversation is getting long (fire-and-forget)
  maybeSummarize(conversation.id).catch(() => {});

  return {
    reply,
    intent: cls.intent,
    agent,
    conversationId: conversation.id,
    escalated,
  };
}

async function getOrCreateConversation(tenantId: string, phoneNormalized: string): Promise<any> {
  const db = getDb();
  const existing = await db('chat_conversations')
    .where({ tenant_id: tenantId, channel: 'whatsapp', customer_phone_normalized: phoneNormalized })
    .first();
  if (existing) return existing;

  // Try to link to existing customer
  const customer = await db('customers')
    .where({ tenant_id: tenantId, phone_normalized: phoneNormalized })
    .first();

  const [row] = await db('chat_conversations').insert({
    tenant_id: tenantId,
    channel: 'whatsapp',
    customer_phone_normalized: phoneNormalized,
    customer_id: customer?.id || null,
    status: 'open',
    last_message_at: new Date(),
  }).returning('*');

  return row;
}

const GREETINGS = [
  "Hi there! How can I help you today?",
  "Hey! Need help with an order or store info?",
  "Hello! I can check your orders or answer questions about the store. What would you like?",
];
function pickGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}
