import { Router, Request, Response } from 'express';
import { getDb } from '../db/connection';
import { handleInbound } from '../chatbots';
import { sendFreeText } from '../whatsapp';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'whatsapp-webhook' });
const router = Router();

/**
 * GET /whatsapp/webhook
 * Meta verification handshake. Meta calls with hub.mode, hub.challenge and hub.verify_token.
 * We look up the matching tenant by verify_token. If found, echo the challenge.
 */
router.get('/webhook', async (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || !token) {
    return res.status(400).send('bad_request');
  }

  const db = getDb();
  const settings = await db('whatsapp_settings').where({ verify_token: token, enabled: true }).first();
  if (!settings) {
    log.warn({ token }, 'Webhook verification failed - unknown verify_token');
    return res.status(403).send('forbidden');
  }

  log.info({ tenantId: settings.tenant_id }, 'WhatsApp webhook verified');
  return res.status(200).send(String(challenge || ''));
});

/**
 * POST /whatsapp/webhook
 * Inbound messages and status callbacks from Meta.
 *
 * We route on the phone_number_id (settings.phone_number_id) to find the tenant
 * since Meta sends one webhook per WABA / phone_number_id.
 */
router.post('/webhook', async (req: Request, res: Response) => {
  // Always ack 200 quickly so Meta does not retry.
  res.status(200).send('ok');

  try {
    const body = req.body;
    const entries = body?.entry || [];

    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        const value = change?.value || {};
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const db = getDb();
        const settings = await db('whatsapp_settings').where({ phone_number_id: phoneNumberId }).first();
        if (!settings) {
          log.warn({ phoneNumberId }, 'No WhatsApp tenant found for inbound webhook');
          continue;
        }

        // Handle inbound messages
        const messages = value?.messages || [];
        for (const m of messages) {
          await handleInboundMessage(settings.tenant_id, m);
        }

        // Handle delivery / read status callbacks
        const statuses = value?.statuses || [];
        for (const s of statuses) {
          await handleStatusUpdate(settings.tenant_id, s);
        }
      }
    }
  } catch (err: any) {
    log.error({ error: err.message, stack: err.stack }, 'WhatsApp webhook processing failed');
  }
});

async function handleInboundMessage(tenantId: string, m: any): Promise<void> {
  const db = getDb();
  const from = m?.from;
  const waMessageId = m?.id;
  const text = m?.text?.body || m?.button?.text || m?.interactive?.button_reply?.title || m?.interactive?.list_reply?.title || '';

  if (!from || !text) {
    log.debug({ from, type: m?.type }, 'Inbound message missing from/text, skipping');
    return;
  }

  // Log the inbound message
  await db('whatsapp_messages').insert({
    tenant_id: tenantId,
    direction: 'inbound',
    phone_to: '',
    phone_from: from,
    purpose: 'chatbot_inbound',
    body: text,
    status: 'received',
    wa_message_id: waMessageId,
  });

  // Run the chatbot
  const reply = await handleInbound({
    tenantId,
    fromPhone: from,
    body: text,
    waMessageId,
  });

  if (!reply || !reply.reply) {
    log.warn({ tenantId, from }, 'Chatbot returned no reply');
    return;
  }

  // Send the reply via WhatsApp
  const send = await sendFreeText({
    tenantId,
    toPhone: from,
    body: reply.reply,
  });

  if (!send.sent) {
    log.warn({ tenantId, from, error: send.error || send.skipped_reason }, 'Failed to send chatbot reply');
  } else {
    log.info({ tenantId, conversationId: reply.conversationId, intent: reply.intent, agent: reply.agent, escalated: reply.escalated }, 'Chatbot reply sent');
  }
}

async function handleStatusUpdate(tenantId: string, s: any): Promise<void> {
  const db = getDb();
  const waId = s?.id;
  const status = s?.status; // sent | delivered | read | failed
  if (!waId || !status) return;

  await db('whatsapp_messages')
    .where({ tenant_id: tenantId, wa_message_id: waId })
    .update({ status, updated_at: new Date() });
}

export default router;
