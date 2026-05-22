import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware } from './middleware';
import { getDb } from '../db/connection';
import { saveSettings, dispatchByPurpose } from '../whatsapp';
import { encrypt, decrypt } from '../crypto';
import { createMetaTemplate, getMetaTemplate, deleteMetaTemplate, validateTemplateName, convertBodyForMeta, MetaTemplateCategory } from '../whatsapp/metaTemplates';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'whatsapp-api' });
const router = Router();

router.use(authMiddleware);

/**
 * GET /whatsapp/settings - returns whether WhatsApp is configured (no token).
 */
router.get('/settings', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const row = await db('whatsapp_settings').where({ tenant_id: tenantId }).first();
  if (!row) {
    return res.status(200).json({ success: true, data: { configured: false } });
  }
  return res.status(200).json({
    success: true,
    data: {
      configured: true,
      enabled: row.enabled,
      phone_number_id: row.phone_number_id,
      business_account_id: row.business_account_id,
      display_phone_number: row.display_phone_number,
      updated_at: row.updated_at,
    },
  });
});

/**
 * POST /whatsapp/settings - upsert credentials.
 */
router.post('/settings', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const {
    phone_number_id,
    access_token,
    business_account_id,
    display_phone_number,
    verify_token,
  } = req.body;

  if (!phone_number_id) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'phone_number_id is required' } });
  }
  if (!access_token) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'access_token is required' } });
  }

  await saveSettings({
    tenantId,
    phoneNumberId: phone_number_id,
    accessToken: access_token,
    businessAccountId: business_account_id,
    displayPhoneNumber: display_phone_number,
    verifyToken: verify_token,
  });

  log.info({ tenantId }, 'WhatsApp settings saved');
  return res.status(200).json({ success: true, data: { message: 'WhatsApp settings saved' } });
});

/**
 * DELETE /whatsapp/settings
 */
router.delete('/settings', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  await db('whatsapp_settings').where({ tenant_id: tenantId }).delete();
  return res.status(200).json({ success: true, data: { message: 'WhatsApp settings removed' } });
});

/**
 * GET /whatsapp/templates
 */
router.get('/templates', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const rows = await db('whatsapp_templates').where({ tenant_id: tenantId }).orderBy('purpose');
  return res.status(200).json({ success: true, data: rows });
});

/**
 * PUT /whatsapp/templates/:purpose - update a template body / variables / enabled flag.
 */
router.put('/templates/:purpose', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { purpose } = req.params;
  const { body_text, template_name, language_code, variables, enabled, event_types, header_text, footer_text, buttons, sample_values, meta_category } = req.body;

  const data: any = {};
  if (body_text !== undefined) data.body_text = body_text;
  if (template_name !== undefined) data.template_name = template_name || null;
  if (language_code !== undefined) data.language_code = language_code;
  if (variables !== undefined) data.variables = JSON.stringify(variables);
  if (enabled !== undefined) data.enabled = !!enabled;
  if (event_types !== undefined) data.event_types = JSON.stringify(Array.isArray(event_types) ? event_types : []);
  if (header_text !== undefined) data.header_text = header_text || null;
  if (footer_text !== undefined) data.footer_text = footer_text || null;
  if (buttons !== undefined) data.buttons = JSON.stringify(Array.isArray(buttons) ? buttons : []);
  if (sample_values !== undefined) data.sample_values = JSON.stringify(Array.isArray(sample_values) ? sample_values : []);
  if (meta_category !== undefined) data.meta_category = meta_category;

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ success: false, error: { code: 'NO_CHANGES', message: 'No fields to update' } });
  }

  data.updated_at = new Date();

  const updated = await db('whatsapp_templates')
    .where({ tenant_id: tenantId, purpose })
    .update(data)
    .returning('*');

  if (!updated || updated.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Template not found' } });
  }
  return res.status(200).json({ success: true, data: updated[0] });
});

/**
 * POST /whatsapp/templates - create a new template (saved as DRAFT, not yet submitted to Meta)
 */
router.post('/templates', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const {
    purpose, body_text, language_code = 'en', variables = [], event_types = [],
    header_text, footer_text, buttons = [], sample_values = [], meta_category = 'UTILITY',
  } = req.body;

  if (!purpose || !body_text) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'purpose and body_text required' } });
  }
  const nameCheck = validateTemplateName(purpose);
  if (!nameCheck.ok) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_NAME', message: nameCheck.error } });
  }

  // Check duplicate
  const existing = await db('whatsapp_templates').where({ tenant_id: tenantId, purpose }).first();
  if (existing) {
    return res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'Template with this purpose already exists' } });
  }

  const [row] = await db('whatsapp_templates').insert({
    tenant_id: tenantId,
    purpose,
    language_code,
    body_text,
    variables: JSON.stringify(variables),
    event_types: JSON.stringify(event_types),
    enabled: true,
    header_text: header_text || null,
    footer_text: footer_text || null,
    buttons: JSON.stringify(buttons),
    sample_values: JSON.stringify(sample_values),
    meta_category,
    meta_status: 'DRAFT',
  }).returning('*');

  log.info({ tenantId, purpose }, 'WhatsApp template created (DRAFT)');
  return res.status(201).json({ success: true, data: row });
});

/**
 * DELETE /whatsapp/templates/:purpose
 */
/**
 * GET /whatsapp/event-types - list all available domain events that templates can subscribe to.
 */
router.get('/event-types', async (_req: AuthenticatedRequest, res: Response) => {
  const { DomainEventType } = await import('../events');
  const events = Object.values(DomainEventType);
  return res.status(200).json({ success: true, data: events });
});

router.delete('/templates/:purpose', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { purpose } = req.params;
  const deleted = await db('whatsapp_templates').where({ tenant_id: tenantId, purpose }).delete();
  if (deleted === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Template not found' } });
  return res.status(200).json({ success: true, data: { message: 'Template deleted' } });
});

// ---------- Meta Business credentials ----------

router.get('/business-settings', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const row = await db('whatsapp_business_settings').where({ tenant_id: tenantId }).first();
  if (!row) return res.status(200).json({ success: true, data: { configured: false } });
  return res.status(200).json({ success: true, data: { configured: true, business_account_id: row.business_account_id, updated_at: row.updated_at } });
});

router.post('/business-settings', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { business_account_id, system_user_token } = req.body;
  if (!business_account_id || !system_user_token) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'business_account_id and system_user_token required' } });
  }

  const existing = await db('whatsapp_business_settings').where({ tenant_id: tenantId }).first();
  const data = {
    tenant_id: tenantId,
    business_account_id,
    encrypted_system_user_token: encrypt(system_user_token),
  };
  if (existing) {
    await db('whatsapp_business_settings').where({ id: existing.id }).update({ ...data, updated_at: new Date() });
  } else {
    await db('whatsapp_business_settings').insert(data);
  }
  return res.status(200).json({ success: true, data: { message: 'Business settings saved' } });
});

// ---------- Meta template submission ----------

/**
 * POST /whatsapp/templates/:purpose/submit-to-meta
 * Submits the local template to Meta for approval.
 */
router.post('/templates/:purpose/submit-to-meta', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { purpose } = req.params as { purpose: string };

  const template = await db('whatsapp_templates').where({ tenant_id: tenantId, purpose }).first();
  if (!template) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Template not found' } });

  const business = await db('whatsapp_business_settings').where({ tenant_id: tenantId }).first();
  if (!business) return res.status(400).json({ success: false, error: { code: 'NO_BUSINESS', message: 'Configure WhatsApp Business credentials first' } });

  // Convert internal {{var_name}} into Meta's {{1}}, {{2}} positional syntax
  const variables = Array.isArray(template.variables) ? template.variables : (typeof template.variables === 'string' ? JSON.parse(template.variables) : []);
  const sampleValues = Array.isArray(template.sample_values) ? template.sample_values : (typeof template.sample_values === 'string' ? JSON.parse(template.sample_values) : []);
  const buttons = Array.isArray(template.buttons) ? template.buttons : (typeof template.buttons === 'string' ? JSON.parse(template.buttons) : []);

  const { metaBody, orderedVars } = convertBodyForMeta(template.body_text, variables);

  // Build samples in the same order as the variables in the body
  const orderedSamples = orderedVars.map((varName) => {
    const idx = variables.indexOf(varName);
    return sampleValues[idx] || `Sample ${varName}`;
  });

  try {
    const metaResult = await createMetaTemplate(
      { businessAccountId: business.business_account_id, systemUserToken: decrypt(business.encrypted_system_user_token) },
      {
        name: purpose,
        language: template.language_code || 'en',
        category: (template.meta_category || 'UTILITY') as MetaTemplateCategory,
        body_text: metaBody,
        body_examples: orderedSamples,
        header_text: template.header_text || undefined,
        footer_text: template.footer_text || undefined,
        buttons: buttons.length ? buttons : undefined,
      },
    );

    await db('whatsapp_templates').where({ id: template.id }).update({
      template_name: purpose,
      meta_template_id: metaResult.id,
      meta_status: metaResult.status,
      meta_submitted_at: new Date(),
      meta_last_synced_at: new Date(),
      updated_at: new Date(),
    });

    log.info({ tenantId, purpose, metaTemplateId: metaResult.id, status: metaResult.status }, 'Template submitted to Meta');
    return res.status(200).json({ success: true, data: { meta_template_id: metaResult.id, status: metaResult.status } });
  } catch (err: any) {
    log.warn({ tenantId, purpose, error: err.message }, 'Meta template submission failed');
    return res.status(500).json({ success: false, error: { code: 'META_SUBMIT_FAILED', message: err.message } });
  }
});

/**
 * POST /whatsapp/templates/:purpose/sync-from-meta
 * Refresh the template's status from Meta.
 */
router.post('/templates/:purpose/sync-from-meta', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { purpose } = req.params;

  const template = await db('whatsapp_templates').where({ tenant_id: tenantId, purpose }).first();
  if (!template?.meta_template_id) {
    return res.status(400).json({ success: false, error: { code: 'NOT_SUBMITTED', message: 'Template has not been submitted to Meta' } });
  }

  const business = await db('whatsapp_business_settings').where({ tenant_id: tenantId }).first();
  if (!business) return res.status(400).json({ success: false, error: { code: 'NO_BUSINESS', message: 'Configure WhatsApp Business credentials first' } });

  try {
    const detail = await getMetaTemplate(
      { businessAccountId: business.business_account_id, systemUserToken: decrypt(business.encrypted_system_user_token) },
      template.meta_template_id,
    );

    const update: any = {
      meta_status: detail.status,
      meta_quality_score: detail.quality_score?.score || null,
      meta_last_synced_at: new Date(),
      updated_at: new Date(),
    };
    if (detail.status === 'APPROVED' && !template.meta_approved_at) update.meta_approved_at = new Date();

    await db('whatsapp_templates').where({ id: template.id }).update(update);
    return res.status(200).json({ success: true, data: { status: detail.status, quality_score: detail.quality_score?.score } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'META_SYNC_FAILED', message: err.message } });
  }
});

/**
 * GET /whatsapp/messages - recent message log.
 */
router.get('/messages', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { limit = '100' } = req.query;

  const rows = await db('whatsapp_messages')
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'desc')
    .limit(parseInt(limit as string, 10));

  return res.status(200).json({ success: true, data: rows });
});

/**
 * POST /whatsapp/test - send a test message to a recipient.
 */
router.post('/test', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const { to, purpose = 'order_confirmed', variables = {} } = req.body;

  if (!to) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'to is required' } });
  }

  const result = await dispatchByPurpose({
    tenantId,
    purpose,
    toPhone: to,
    variables: {
      customer_name: variables.customer_name || 'Test customer',
      order_number: variables.order_number || 'TEST-001',
      waybill: variables.waybill || 'TEST-WB',
      pincode: variables.pincode || '000000',
      ...variables,
    },
  });

  return res.status(200).json({ success: true, data: result });
});

export default router;
