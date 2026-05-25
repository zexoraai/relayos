import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'chatbot-settings-api' });
const router = Router();

router.use(authMiddleware);

router.get('/', requirePermission('prompts.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const row = await db('chatbot_settings').where({ tenant_id: tenantId }).first();
  if (!row) {
    return res.status(200).json({ success: true, data: { configured: false, defaults: getDefaults() } });
  }
  return res.status(200).json({ success: true, data: { configured: true, ...row } });
});

router.post('/', requirePermission('prompts.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const {
    bot_name, tone, language, custom_instructions,
    escalation_phone, escalation_email, escalation_name, escalation_message,
    greeting_message, unknown_intent_message, outside_hours_message,
    blocked_topics, blocked_topic_response,
    timezone, hours_start, hours_end, active_days, enabled,
  } = req.body;

  const data: any = { tenant_id: tenantId, updated_at: new Date() };
  if (bot_name !== undefined) data.bot_name = bot_name;
  if (tone !== undefined) data.tone = tone;
  if (language !== undefined) data.language = language;
  if (custom_instructions !== undefined) data.custom_instructions = custom_instructions || null;
  if (escalation_phone !== undefined) data.escalation_phone = escalation_phone || null;
  if (escalation_email !== undefined) data.escalation_email = escalation_email || null;
  if (escalation_name !== undefined) data.escalation_name = escalation_name || null;
  if (escalation_message !== undefined) data.escalation_message = escalation_message || null;
  if (greeting_message !== undefined) data.greeting_message = greeting_message || null;
  if (unknown_intent_message !== undefined) data.unknown_intent_message = unknown_intent_message || null;
  if (outside_hours_message !== undefined) data.outside_hours_message = outside_hours_message || null;
  if (blocked_topics !== undefined) data.blocked_topics = JSON.stringify(Array.isArray(blocked_topics) ? blocked_topics : []);
  if (blocked_topic_response !== undefined) data.blocked_topic_response = blocked_topic_response || null;
  if (timezone !== undefined) data.timezone = timezone || null;
  if (hours_start !== undefined) data.hours_start = hours_start || null;
  if (hours_end !== undefined) data.hours_end = hours_end || null;
  if (active_days !== undefined) data.active_days = JSON.stringify(Array.isArray(active_days) ? active_days : [1,2,3,4,5]);
  if (enabled !== undefined) data.enabled = !!enabled;

  const existing = await db('chatbot_settings').where({ tenant_id: tenantId }).first();
  if (existing) {
    await db('chatbot_settings').where({ id: existing.id }).update(data);
  } else {
    await db('chatbot_settings').insert(data);
  }

  log.info({ tenantId }, 'Chatbot settings updated');
  return res.status(200).json({ success: true, data: { message: 'Chatbot settings saved' } });
});

function getDefaults() {
  return {
    bot_name: 'Muti AI',
    tone: 'friendly',
    language: 'en',
    escalation_message: "I've flagged this for a team member. They'll reach out shortly.",
    greeting_message: "Hi there! I can help with your orders or answer questions about the store. What would you like?",
    unknown_intent_message: "I can help with your orders or store questions. What would you like to know?",
    blocked_topics: [],
  };
}

export default router;
