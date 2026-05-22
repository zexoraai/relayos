import { getDb } from '../db/connection';
import { sendFreeText } from '../whatsapp';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'chatbot:handoff' });

/**
 * Structured human handoff.
 *
 * When the chatbot escalates, this:
 * 1. Generates a context summary (customer info + conversation highlights)
 * 2. Notifies the human agent via WhatsApp (if configured)
 * 3. Marks the conversation as escalated with the summary attached
 */
export async function executeHandoff(args: {
  tenantId: string;
  conversationId: string;
  customerPhone: string;
  customerName?: string | null;
  reason: string;
  recentMessages: Array<{ role: string; content: string }>;
}): Promise<{ notified: boolean; summary: string }> {
  const db = getDb();

  // Build context summary
  const recentExchange = args.recentMessages
    .slice(-6)
    .map(m => `${m.role}: ${(m.content || '').substring(0, 150)}`)
    .join('\n');

  const summary = [
    `Customer: ${args.customerName || 'Unknown'} (${args.customerPhone})`,
    `Reason for escalation: ${args.reason}`,
    `Recent conversation:`,
    recentExchange,
  ].join('\n');

  // Store the summary on the conversation
  await db('chat_conversations').where({ id: args.conversationId }).update({
    status: 'escalated',
    escalated_at: new Date(),
    summary: summary.substring(0, 2000),
    updated_at: new Date(),
  });

  // Notify the human agent if configured
  const chatSettings = await db('chatbot_settings').where({ tenant_id: args.tenantId }).first();
  const agentPhone = chatSettings?.escalation_phone;
  const agentName = chatSettings?.escalation_name || 'Team';

  let notified = false;
  if (agentPhone) {
    const notification = [
      `🔔 New escalation from ${args.customerName || args.customerPhone}`,
      ``,
      `Reason: ${args.reason}`,
      ``,
      `Last messages:`,
      ...args.recentMessages.slice(-4).map(m => `${m.role === 'user' ? '👤' : '🤖'} ${(m.content || '').substring(0, 100)}`),
      ``,
      `Reply to ${args.customerPhone} to help them.`,
    ].join('\n');

    try {
      const sendResult = await sendFreeText({
        tenantId: args.tenantId,
        toPhone: agentPhone,
        body: notification,
      });
      notified = sendResult.sent;
      if (notified) log.info({ tenantId: args.tenantId, agentPhone, conversationId: args.conversationId }, 'Human agent notified of escalation');
    } catch (err: any) {
      log.warn({ error: err.message }, 'Failed to notify human agent');
    }
  }

  return { notified, summary };
}
