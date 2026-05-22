import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { chatCompletion, ToolDefinition, ChatMessage, ToolCall } from '../ai/openai';
import { normalizePhone } from '../customers';
import { getActiveCorrections, buildCorrectionMessages } from '../ai/runRecorder';
import { getCachedToolResult, setCachedToolResult } from './toolCache';
import { getDistilledRules, maybeDistill } from '../ai/correctionsDistiller';

const log = createChildLogger({ module: 'chatbot:order-support' });

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'lookup_orders_by_phone',
      description: "Find this customer's recent orders. Always call this first if the user asks about 'my order' or 'where is my parcel'. Returns the most recent orders with status, waybill, pincode and locker.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'How many recent orders to return (default 5, max 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order_status',
      description: 'Get the latest tracking detail for a specific order by order number or waybill.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'The order number (digits only, no #)' },
          waybill: { type: 'string', description: 'The waybill / tracking reference (e.g. LD-9CNQBD)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: "Hand the conversation off to a human agent when the user asks for one, expresses frustration, or the issue cannot be resolved automatically.",
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short reason for the handoff' },
        },
        required: ['reason'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a friendly order support agent for a South African e-commerce store. You answer customer questions about their orders over WhatsApp.

Guidelines:
- Keep replies short and warm (1-3 short sentences). WhatsApp users prefer brevity.
- Always look up the user's actual orders before guessing — call lookup_orders_by_phone first.
- If they ask about a specific order, use get_order_status with the order number or waybill.
- If they ask for a refund / complaint / damaged parcel / wrong item, call escalate_to_human.
- Never invent waybill numbers, PINs, or delivery dates. If you don't know, say so and offer to escalate.
- When sharing a PIN code, format it on its own line so it stands out.
- Use plain text only — no markdown.
- Refer to the courier as "PUDO" or "The Courier Guy" if relevant.
- If the user is greeting you, respond warmly and ask how you can help.

When you're done helping, end the reply naturally — do not say "is there anything else?" every time.`;

export interface OrderSupportInput {
  tenantId: string;
  conversationId: string;
  customerPhone: string;
  customerName?: string | null;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  message: string;
}

export interface OrderSupportResult {
  reply: string;
  escalated: boolean;
  escalation_reason?: string;
  tool_calls: Array<{ name: string; args: any; result: any }>;
}

/**
 * Run the order support agent for one inbound message.
 * Loops up to 4 turns of tool-calling, then forces a final natural-language reply.
 */
export async function runOrderSupport(input: OrderSupportInput): Promise<OrderSupportResult> {
  // Load corrections for this agent (few-shot examples from past feedback)
  const corrections = await getActiveCorrections('order_support', input.tenantId, 5);
  const correctionMessages = buildCorrectionMessages(corrections);

  // Load custom instructions from chatbot settings
  const db = getDb();
  const chatSettings = await db('chatbot_settings').where({ tenant_id: input.tenantId }).first();
  const customInstructions = chatSettings?.custom_instructions || '';
  const botName = chatSettings?.bot_name || '';

  // Build system prompt with custom instructions appended
  let systemPrompt = SYSTEM_PROMPT;
  if (botName) systemPrompt = systemPrompt.replace('You are a friendly order support agent', `You are ${botName}, a friendly order support agent`);
  if (customInstructions) systemPrompt += `\n\nAdditional instructions from the store owner:\n${customInstructions}`;

  // Append distilled rules (learned from corrections over time)
  const distilledRules = await getDistilledRules('order_support', input.tenantId);
  if (distilledRules) systemPrompt += `\n\nLearned rules (follow these strictly):\n${distilledRules}`;

  // Trigger distillation in background if enough corrections have accumulated
  maybeDistill('order_support', input.tenantId).catch(() => {});

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...correctionMessages,
  ];

  // Add condensed history (last 6 turns)
  for (const h of input.history.slice(-6)) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: input.message });

  const toolLog: Array<{ name: string; args: any; result: any }> = [];
  let escalated = false;
  let escalationReason: string | undefined;

  for (let i = 0; i < 4; i++) {
    const res = await chatCompletion({
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 600,
      agent: 'order_support',
      tenantId: input.tenantId,
    });

    if (res.tool_calls && res.tool_calls.length > 0) {
      // Push assistant message preserving tool_calls
      messages.push({
        role: 'assistant',
        content: res.content,
        tool_calls: res.tool_calls,
      });

      for (const call of res.tool_calls) {
        const args = safeJson(call.function.arguments);
        const toolResult = await dispatchTool(input.tenantId, input.customerPhone, call.function.name, args, input.conversationId);
        toolLog.push({ name: call.function.name, args, result: toolResult });

        if (call.function.name === 'escalate_to_human') {
          escalated = true;
          escalationReason = args?.reason || 'unspecified';
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        });
      }
      // Loop again for the model to use the tool results.
      continue;
    }

    // No tool calls — this is the final natural-language reply.
    return {
      reply: (res.content || '').trim() || 'Sorry, I had trouble responding. A team member will follow up.',
      escalated,
      escalation_reason: escalationReason,
      tool_calls: toolLog,
    };
  }

  // Forced final pass without tools
  const final = await chatCompletion({
    messages: [...messages, { role: 'user', content: 'Now give a short, friendly final reply to the customer based on what you have learned. No tool calls.' }],
    temperature: 0.4,
    max_tokens: 400,
    agent: 'order_support',
    tenantId: input.tenantId,
  });
  return {
    reply: (final.content || '').trim() || 'Thanks for reaching out — a team member will follow up shortly.',
    escalated,
    escalation_reason: escalationReason,
    tool_calls: toolLog,
  };
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

async function dispatchTool(tenantId: string, customerPhone: string, name: string, args: any, conversationId?: string): Promise<any> {
  // Check cache first (skip redundant lookups within same conversation)
  if (conversationId && (name === 'lookup_orders_by_phone' || name === 'get_order_status')) {
    const cached = getCachedToolResult(conversationId, name + ':' + JSON.stringify(args));
    if (cached) {
      log.debug({ tool: name, conversationId }, 'Tool result served from cache');
      return cached;
    }
  }

  let result: any;
  switch (name) {
    case 'lookup_orders_by_phone':
      result = await lookupOrders(tenantId, customerPhone, Math.min(Math.max(args?.limit || 5, 1), 10));
      // Smart retry: if no orders found by phone, try alternative lookups
      if (result.orders && result.orders.length === 0) {
        result = await smartRetryLookup(tenantId, customerPhone, result);
      }
      break;
    case 'get_order_status':
      result = await getOrderStatus(tenantId, args?.order_number, args?.waybill);
      break;
    case 'escalate_to_human':
      result = { ok: true, message: 'Escalation logged' };
      break;
    default:
      result = { error: 'Unknown tool' };
  }

  // Cache the result
  if (conversationId && (name === 'lookup_orders_by_phone' || name === 'get_order_status')) {
    setCachedToolResult(conversationId, name + ':' + JSON.stringify(args), result);
  }

  return result;
}

/**
 * Smart retry: when phone lookup returns empty, try finding orders by:
 * 1. Normalized phone variants (with/without +27 prefix)
 * 2. Any order with matching customer_phone substring
 */
async function smartRetryLookup(tenantId: string, customerPhone: string, originalResult: any): Promise<any> {
  const db = getDb();

  // Try with different phone formats
  const variants = [
    customerPhone,
    customerPhone.replace(/^\+27/, '0'),
    customerPhone.replace(/^0/, '+27'),
    customerPhone.replace(/^\+/, ''),
  ];

  for (const variant of variants) {
    if (!variant || variant === customerPhone) continue;
    const orders = await db('orders')
      .where({ tenant_id: tenantId })
      .where('customer_phone', 'like', `%${variant.slice(-9)}%`) // match last 9 digits
      .orderBy('created_at', 'desc')
      .limit(5);

    if (orders.length > 0) {
      return {
        customer: null,
        orders: orders.map((o: any) => ({
          order_number: o.order_number,
          status: o.status,
          milestone: o.status,
          courier_status: o.courier_status,
          waybill: o.waybill,
          pincode: o.pincode,
          delivery_method: o.delivery_method,
          locker: o.nearest_locker_name,
          created_at: o.created_at,
        })),
        note: 'Found by phone number variant match',
      };
    }
  }

  return originalResult;
}

async function lookupOrders(tenantId: string, customerPhone: string, limit: number): Promise<any> {
  const db = getDb();
  const phoneNormalized = normalizePhone(customerPhone);

  const customer = await db('customers')
    .where({ tenant_id: tenantId, phone_normalized: phoneNormalized })
    .first();

  let orders;
  if (customer) {
    orders = await db('orders')
      .where({ customer_id: customer.id })
      .orderBy('created_at', 'desc')
      .limit(limit);
  } else {
    // Fallback: match by raw phone column (older orders may not be linked yet)
    orders = await db('orders')
      .where({ tenant_id: tenantId, customer_phone: customerPhone })
      .orderBy('created_at', 'desc')
      .limit(limit);
  }

  return {
    customer: customer ? { name: customer.name, phone: customer.phone_normalized, total_orders: customer.order_count } : null,
    orders: orders.map((o: any) => ({
      order_number: o.order_number,
      status: o.status,
      milestone: o.status,
      courier_status: o.courier_status,
      waybill: o.waybill,
      pincode: o.pincode,
      delivery_method: o.delivery_method,
      locker: o.nearest_locker_name,
      created_at: o.created_at,
    })),
  };
}

async function getOrderStatus(tenantId: string, orderNumber?: string, waybill?: string): Promise<any> {
  const db = getDb();
  const q = db('orders').where({ tenant_id: tenantId });
  if (orderNumber) q.andWhere({ order_number: String(orderNumber).replace('#', '') });
  else if (waybill) q.andWhere({ waybill });
  else return { error: 'Provide order_number or waybill' };

  const order = await q.first();
  if (!order) return { found: false };

  // Pull most recent tracking events
  const job = await db('fulfillment_jobs').where({ order_id: order.id }).first();
  let events: any[] = [];
  if (job) {
    events = await db('fulfillment_events')
      .where({ fulfillment_job_id: job.id })
      .orderBy('event_date', 'desc')
      .limit(5)
      .select('status', 'message', 'location', 'event_date');
  }

  return {
    found: true,
    order_number: order.order_number,
    customer_name: order.customer_name,
    waybill: order.waybill,
    pincode: order.pincode,
    delivery_method: order.delivery_method,
    status: order.status,
    courier_status: order.courier_status,
    locker: order.nearest_locker_name,
    estimated_delivery: order.estimated_delivery_to,
    last_events: events,
  };
}
