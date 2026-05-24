import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { decrypt, encrypt } from '../crypto';
import { createChildLogger } from '../observability/logger';
import { sendText, sendTemplate, WhatsAppCredentials } from './client';
import { renderTemplate, DEFAULT_TEMPLATES } from './templates';
import { onEvent, DomainEventType, DomainEventRow } from '../events';
import { normalizePhone } from '../customers';
import { withIdempotency, makeKey, IdempotencyInProgressError } from '../idempotency';

const log = createChildLogger({ module: 'whatsapp' });

interface WhatsAppSettingsRow {
  id: string;
  tenant_id: string;
  phone_number_id: string;
  business_account_id: string | null;
  display_phone_number: string | null;
  encrypted_access_token: string;
  verify_token: string | null;
  enabled: boolean;
}

interface TemplateRow {
  id: string;
  tenant_id: string;
  purpose: string;
  template_name: string | null;
  language_code: string;
  body_text: string;
  variables: string[];
  enabled: boolean;
}

async function getSettings(tenantId: string): Promise<WhatsAppSettingsRow | null> {
  const db = getDb();
  const row = await db('whatsapp_settings').where({ tenant_id: tenantId, enabled: true }).first();
  return row || null;
}

/**
 * Send a free-form text reply (used by chatbots responding to inbound messages).
 * The 24-hour customer-service window applies; outside it, only templates work.
 */
export async function sendFreeText(args: {
  tenantId: string;
  toPhone: string;
  body: string;
  orderId?: string | null;
  customerId?: string | null;
}): Promise<{ sent: boolean; wa_message_id?: string | null; error?: string; skipped_reason?: string }> {
  const db = getDb();
  const settings = await getSettings(args.tenantId);
  if (!settings) return { sent: false, skipped_reason: 'WhatsApp not configured' };

  const phoneNormalized = normalizePhone(args.toPhone);
  if (!phoneNormalized) return { sent: false, skipped_reason: 'Invalid recipient phone' };

  const logId = (await db('whatsapp_messages').insert({
    tenant_id: args.tenantId,
    direction: 'outbound',
    phone_to: phoneNormalized,
    phone_from: settings.display_phone_number,
    purpose: 'chatbot_reply',
    body: args.body,
    status: 'queued',
    order_id: args.orderId || null,
    customer_id: args.customerId || null,
  }).returning('id'))[0].id;

  try {
    const result = await sendText(settingsToCreds(settings), phoneNormalized, args.body);
    await db('whatsapp_messages').where({ id: logId }).update({
      status: 'sent',
      wa_message_id: result.wa_message_id,
      updated_at: new Date(),
    });
    return { sent: true, wa_message_id: result.wa_message_id };
  } catch (err: any) {
    await db('whatsapp_messages').where({ id: logId }).update({
      status: 'failed',
      last_error: err.message,
      updated_at: new Date(),
    });
    return { sent: false, error: err.message };
  }
}

async function getTemplate(tenantId: string, purpose: string): Promise<TemplateRow | null> {
  const db = getDb();
  const row = await db('whatsapp_templates')
    .where({ tenant_id: tenantId, purpose, enabled: true })
    .first();
  return row || null;
}

function settingsToCreds(s: WhatsAppSettingsRow): WhatsAppCredentials {
  return {
    phoneNumberId: s.phone_number_id,
    accessToken: decrypt(s.encrypted_access_token),
  };
}

export interface DispatchResult {
  sent: boolean;
  skipped_reason?: string;
  message_id?: string;
  wa_message_id?: string | null;
  error?: string;
}

/**
 * Render and send a templated WhatsApp message for a given purpose.
 * If a Meta-approved template_name is configured, uses sendTemplate; otherwise uses sendText.
 * Always logs to whatsapp_messages.
 */
export async function dispatchByPurpose(args: {
  tenantId: string;
  purpose: string;
  toPhone: string;
  variables: Record<string, string | number | null | undefined>;
  orderId?: string | null;
  customerId?: string | null;
  domainEventId?: string | null;
}): Promise<DispatchResult> {
  const db = getDb();
  const settings = await getSettings(args.tenantId);
  if (!settings) {
    return { sent: false, skipped_reason: 'WhatsApp not configured for tenant' };
  }
  const template = await getTemplate(args.tenantId, args.purpose);
  if (!template) {
    return { sent: false, skipped_reason: `No template for purpose: ${args.purpose}` };
  }

  const phoneNormalized = normalizePhone(args.toPhone);
  if (!phoneNormalized || phoneNormalized.length < 5) {
    return { sent: false, skipped_reason: 'Recipient phone is missing or invalid' };
  }

  const renderedBody = renderTemplate(template.body_text, args.variables);

  // Pre-insert log row in queued state
  const logId = uuidv4();
  await db('whatsapp_messages').insert({
    id: logId,
    tenant_id: args.tenantId,
    direction: 'outbound',
    phone_to: phoneNormalized,
    phone_from: settings.display_phone_number,
    purpose: args.purpose,
    body: renderedBody,
    status: 'queued',
    order_id: args.orderId || null,
    customer_id: args.customerId || null,
    domain_event_id: args.domainEventId || null,
    meta: JSON.stringify({ template_id: template.id }),
  });

  const creds = settingsToCreds(settings);

  try {
    let result;
    if (template.template_name) {
      // Use approved Meta template path
      const params = (template.variables || []).map((key) => ({
        type: 'text' as const,
        text: String(args.variables[key] ?? ''),
      }));
      const components = params.length
        ? [{ type: 'body' as const, parameters: params }]
        : [];
      result = await sendTemplate(creds, phoneNormalized, template.template_name, template.language_code || 'en', components);
    } else {
      result = await sendText(creds, phoneNormalized, renderedBody);
    }

    await db('whatsapp_messages').where({ id: logId }).update({
      status: 'sent',
      wa_message_id: result.wa_message_id,
      updated_at: new Date(),
    });

    log.info({
      tenantId: args.tenantId,
      purpose: args.purpose,
      to: phoneNormalized,
      waMessageId: result.wa_message_id,
    }, 'WhatsApp message sent');

    return { sent: true, message_id: logId, wa_message_id: result.wa_message_id };
  } catch (err: any) {
    await db('whatsapp_messages').where({ id: logId }).update({
      status: 'failed',
      last_error: err.message,
      updated_at: new Date(),
    });
    log.warn({ tenantId: args.tenantId, purpose: args.purpose, error: err.message }, 'WhatsApp send failed');
    return { sent: false, message_id: logId, error: err.message };
  }
}

/**
 * Save WhatsApp credentials for a tenant, encrypting the access token.
 * Also seeds default templates if none exist yet.
 *
 * Throws WhatsAppPhoneClaimedError if another active tenant already claims this
 * phone_number_id. Inbound webhooks key off phone_number_id, so two tenants
 * with the same number would race to receive the same customer messages.
 */
export class WhatsAppPhoneClaimedError extends Error {
  public claimedByTenantId: string;
  constructor(phoneNumberId: string, claimedByTenantId: string) {
    super(`WhatsApp phone_number_id ${phoneNumberId} is already in use by another tenant`);
    this.name = 'WhatsAppPhoneClaimedError';
    this.claimedByTenantId = claimedByTenantId;
  }
}

export async function saveSettings(args: {
  tenantId: string;
  phoneNumberId: string;
  accessToken: string;
  businessAccountId?: string | null;
  displayPhoneNumber?: string | null;
  verifyToken?: string | null;
}): Promise<void> {
  const db = getDb();
  const existing = await db('whatsapp_settings').where({ tenant_id: args.tenantId }).first();

  // Block another tenant from claiming the same phone_number_id. Inbound
  // webhooks route by phone_number_id, so duplicates cause silent message
  // misrouting. We allow the same tenant to update its own row.
  const claim = await db('whatsapp_settings')
    .where({ phone_number_id: args.phoneNumberId, enabled: true })
    .whereNot({ tenant_id: args.tenantId })
    .first();
  if (claim) {
    log.warn(
      { tenantId: args.tenantId, phoneNumberId: args.phoneNumberId, claimedBy: claim.tenant_id },
      'Refusing WhatsApp save — phone_number_id already in use by another tenant',
    );
    throw new WhatsAppPhoneClaimedError(args.phoneNumberId, claim.tenant_id);
  }

  const data = {
    tenant_id: args.tenantId,
    phone_number_id: args.phoneNumberId,
    business_account_id: args.businessAccountId || null,
    display_phone_number: args.displayPhoneNumber || null,
    encrypted_access_token: encrypt(args.accessToken),
    verify_token: args.verifyToken || null,
    enabled: true,
  };

  if (existing) {
    await db('whatsapp_settings').where({ id: existing.id }).update({ ...data, updated_at: new Date() });
  } else {
    await db('whatsapp_settings').insert(data);
  }

  // Seed default templates
  const existingTemplates = await db('whatsapp_templates').where({ tenant_id: args.tenantId }).count<{ count: string }[]>('id as count');
  const count = parseInt(existingTemplates[0]?.count || '0', 10);
  if (count === 0) {
    await db('whatsapp_templates').insert(
      DEFAULT_TEMPLATES.map((t) => ({
        tenant_id: args.tenantId,
        purpose: t.purpose,
        language_code: t.language_code,
        body_text: t.body_text,
        variables: JSON.stringify(t.variables),
        enabled: true,
      })),
    );
    log.info({ tenantId: args.tenantId, seeded: DEFAULT_TEMPLATES.length }, 'Default WhatsApp templates seeded');
  }
}

/**
 * Map a domain event type to a template purpose. Returns null if no notification is wanted.
 */
function purposeForEvent(eventType: string): string | null {
  switch (eventType) {
    case DomainEventType.ORDER_CONFIRMED: return 'order_confirmed';
    case DomainEventType.ORDER_IN_TRANSIT: return 'order_in_transit';
    case DomainEventType.ORDER_AT_LOCKER: return 'order_at_locker';
    case DomainEventType.ORDER_OUT_FOR_DELIVERY: return 'order_out_for_delivery';
    case DomainEventType.ORDER_DELIVERED: return 'order_delivered';
    case DomainEventType.ORDER_FLAGGED: return 'order_flagged';
    default: return null;
  }
}

/**
 * Build the variables map for an order-related event by hydrating the order row.
 */
async function buildOrderVariables(orderId: string): Promise<{
  vars: Record<string, string | number | null | undefined>;
  toPhone: string;
  customerId: string | null;
} | null> {
  const db = getDb();
  const order = await db('orders').where({ id: orderId }).first();
  if (!order) return null;
  return {
    vars: {
      customer_name: order.customer_name || '',
      order_number: order.order_number || '',
      waybill: order.waybill || '',
      pincode: order.pincode || '',
      delivery_method: order.delivery_method || '',
    },
    toPhone: order.customer_phone || '',
    customerId: order.customer_id || null,
  };
}

/**
 * Default subscriber that turns order.* domain events into WhatsApp messages.
 *
 * The mapping is data-driven: each tenant can configure which templates fire
 * for which events via whatsapp_templates.event_types (jsonb array of event type strings).
 * Multiple templates can match the same event; all matching ones will fire.
 *
 * Wrapped in idempotency keyed on (tenant, domain_event_id, template_id) so the outbox
 * relay can safely re-dispatch failed events without sending duplicate messages.
 */
async function whatsappEventSubscriber(event: DomainEventRow): Promise<void> {
  if (event.aggregate_type !== 'order') return;

  const db = getDb();
  // Find all enabled templates for this tenant that subscribe to this event type
  const templates = await db('whatsapp_templates')
    .where({ tenant_id: event.tenant_id, enabled: true })
    .whereRaw(`event_types::jsonb @> ?::jsonb`, [JSON.stringify([event.event_type])]);

  if (templates.length === 0) {
    log.debug({ eventId: event.id, eventType: event.event_type, tenantId: event.tenant_id }, 'No templates subscribed to this event');
    return;
  }

  const hydrated = await buildOrderVariables(event.aggregate_id);
  if (!hydrated || !hydrated.toPhone) {
    log.debug({ eventId: event.id }, 'Cannot dispatch — missing order or phone');
    return;
  }

  // Fire each matching template
  for (const template of templates) {
    const idemKey = makeKey('whatsapp_send', event.tenant_id, `${event.id}:${template.id}`);
    try {
      await withIdempotency({
        key: idemKey,
        tenantId: event.tenant_id,
        actionType: 'whatsapp_send',
        businessKey: `${event.id}:${template.id}`,
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        fn: async () => {
          const r = await dispatchByPurpose({
            tenantId: event.tenant_id,
            purpose: template.purpose,
            toPhone: hydrated.toPhone,
            variables: hydrated.vars,
            orderId: event.aggregate_id,
            customerId: hydrated.customerId,
            domainEventId: event.id,
          });
          return { response: r };
        },
      });
    } catch (err: any) {
      if (err instanceof IdempotencyInProgressError) {
        log.info({ eventId: event.id, templateId: template.id }, 'WhatsApp send already in flight — skipping');
        continue;
      }
      log.warn({ eventId: event.id, templateId: template.id, error: err.message }, 'WhatsApp dispatch failed');
    }
  }
}

let initialized = false;

/**
 * Schedule a delivery satisfaction follow-up 24h after delivery.
 * Creates a marketing_sends row with scheduled_at = now + 24h.
 * The marketing worker will fire it when the time comes.
 */
async function scheduleDeliveryFollowUp(event: DomainEventRow): Promise<void> {
  if (event.aggregate_type !== 'order') return;
  const db = getDb();

  // Check if there's a template for delivery follow-up
  const template = await db('whatsapp_templates')
    .where({ tenant_id: event.tenant_id, purpose: 'delivery_followup', enabled: true })
    .first();
  if (!template) return; // No follow-up template configured — skip silently

  const order = await db('orders').where({ id: event.aggregate_id }).first();
  if (!order || !order.customer_phone) return;

  // Schedule the send 24h from now
  const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Avoid duplicates
  const existing = await db('marketing_sends')
    .where({ tenant_id: event.tenant_id, phone: normalizePhone(order.customer_phone) })
    .whereRaw("metadata->>'type' = 'delivery_followup'")
    .where('scheduled_at', '>', new Date(Date.now() - 48 * 60 * 60 * 1000))
    .first();
  if (existing) return;

  await db('marketing_sends').insert({
    tenant_id: event.tenant_id,
    campaign_id: null,
    step_id: null,
    customer_id: order.customer_id || null,
    phone: normalizePhone(order.customer_phone),
    status: 'pending',
    scheduled_at: scheduledAt,
  }).catch(() => {}); // ignore if columns don't allow null campaign_id

  log.info({ orderId: event.aggregate_id, scheduledAt: scheduledAt.toISOString() }, 'Delivery follow-up scheduled');
}

/**
 * Wire WhatsApp into the event bus. Idempotent.
 */
export function initWhatsApp(): void {
  if (initialized) return;
  initialized = true;

  // Subscribe to all known order events. The subscriber decides per-template whether to fire.
  onEvent(DomainEventType.ORDER_CONFIRMED, whatsappEventSubscriber);
  onEvent(DomainEventType.ORDER_COLLECTED, whatsappEventSubscriber);
  onEvent(DomainEventType.ORDER_IN_TRANSIT, whatsappEventSubscriber);
  onEvent(DomainEventType.ORDER_AT_LOCKER, whatsappEventSubscriber);
  onEvent(DomainEventType.ORDER_OUT_FOR_DELIVERY, whatsappEventSubscriber);
  onEvent(DomainEventType.ORDER_DELIVERED, whatsappEventSubscriber);
  onEvent(DomainEventType.ORDER_CANCELLED, whatsappEventSubscriber);
  onEvent(DomainEventType.ORDER_FAILED, whatsappEventSubscriber);
  onEvent(DomainEventType.ORDER_FLAGGED, whatsappEventSubscriber);
  // Proactive follow-up: schedule a satisfaction check 24h after delivery
  onEvent(DomainEventType.ORDER_DELIVERED, scheduleDeliveryFollowUp);

  log.info('WhatsApp event subscribers registered');
}
