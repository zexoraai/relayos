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
        // Prefer enabled rows; if multiple tenants share a phone_number_id (e.g. after
        // a data import), take the most-recently-updated one and warn so the operator
        // can clean up. A real prod system should keep this column unique-per-active-row.
        const matchingRows = await db('whatsapp_settings')
          .where({ phone_number_id: phoneNumberId, enabled: true })
          .orderBy('updated_at', 'desc');
        if (matchingRows.length === 0) {
          log.warn({ phoneNumberId }, 'No WhatsApp tenant found for inbound webhook');
          continue;
        }
        if (matchingRows.length > 1) {
          log.error(
            {
              phoneNumberId,
              candidateTenantIds: matchingRows.map((r: any) => r.tenant_id),
              picked: matchingRows[0].tenant_id,
            },
            'Multiple tenants share the same WhatsApp phone_number_id — using most-recently-updated. Clean this up in Settings → WhatsApp.',
          );
        }
        const settings = matchingRows[0];

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

  // When Meta marks a message as 'failed', the webhook payload carries
  // an `errors` array with code/title/message and a top-level
  // `error_data.details`. Without surfacing that we end up with rows
  // that say `status=failed` but `last_error=''` — which is exactly
  // the silent-failure pattern we hit on outbound order_confirmed /
  // order_in_transit / order_delivered messages today.
  let lastError: string | null = null;
  let metaPatch: any = null;
  if (status === 'failed') {
    const errs: any[] = Array.isArray(s.errors) ? s.errors : [];
    if (errs.length) {
      const parts = errs.map((e: any) => {
        const bits = [];
        if (e.code !== undefined) bits.push(`code=${e.code}`);
        if (e.title) bits.push(e.title);
        const msg = e.message || e?.error_data?.details;
        if (msg) bits.push(msg);
        return bits.join(' | ');
      });
      lastError = parts.join(' ; ').slice(0, 500);
      metaPatch = { status_errors: errs };
    } else if (s?.error_data?.details) {
      lastError = String(s.error_data.details).slice(0, 500);
    }
  }

  const update: any = { status, updated_at: new Date() };
  if (lastError) update.last_error = lastError;

  // Stash the raw status payload so a future operator can audit exactly
  // what Meta said. meta is jsonb; we shallow-merge with a fresh field
  // namespaced as `last_status_*` so we don't clobber template_id etc.
  if (metaPatch || status) {
    update.meta = db.raw(
      `coalesce(meta, '{}'::jsonb) || ?::jsonb`,
      [JSON.stringify({
        last_status: status,
        last_status_at: new Date().toISOString(),
        ...(metaPatch || {}),
      })],
    );
  }

  await db('whatsapp_messages')
    .where({ tenant_id: tenantId, wa_message_id: waId })
    .update(update);
}

export default router;
