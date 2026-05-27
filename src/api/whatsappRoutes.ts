import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { saveSettings, dispatchByPurpose, WhatsAppPhoneClaimedError } from '../whatsapp';
import { encrypt, decrypt } from '../crypto';
import { createMetaTemplate, getMetaTemplate, deleteMetaTemplate, validateTemplateName, convertBodyForMeta, MetaTemplateCategory, listMetaTemplates } from '../whatsapp/metaTemplates';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'whatsapp-api' });
const router = Router();

router.use(authMiddleware);

/**
 * GET /whatsapp/settings - returns whether WhatsApp is configured (no token).
 */
router.get('/settings', requirePermission('whatsapp.view'), async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/settings', requirePermission('whatsapp.settings.manage'), async (req: AuthenticatedRequest, res: Response) => {
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

  try {
    await saveSettings({
      tenantId,
      phoneNumberId: phone_number_id,
      accessToken: access_token,
      businessAccountId: business_account_id,
      displayPhoneNumber: display_phone_number,
      verifyToken: verify_token,
    });
  } catch (err: any) {
    if (err instanceof WhatsAppPhoneClaimedError) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'PHONE_NUMBER_ID_IN_USE',
          message: 'Another tenant on this RelayOS instance is already using this WhatsApp phone number ID. Each Meta phone_number_id can only be claimed by one tenant.',
        },
      });
    }
    throw err;
  }

  log.info({ tenantId }, 'WhatsApp settings saved');
  return res.status(200).json({ success: true, data: { message: 'WhatsApp settings saved' } });
});

/**
 * DELETE /whatsapp/settings
 */
router.delete('/settings', requirePermission('whatsapp.settings.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  await db('whatsapp_settings').where({ tenant_id: tenantId }).delete();
  return res.status(200).json({ success: true, data: { message: 'WhatsApp settings removed' } });
});

/**
 * GET /whatsapp/templates
 */
router.get('/templates', requirePermission('whatsapp.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const rows = await db('whatsapp_templates').where({ tenant_id: tenantId }).orderBy('purpose');
  return res.status(200).json({ success: true, data: rows });
});

/**
 * PUT /whatsapp/templates/:purpose - update a template body / variables / enabled flag.
 */
router.put('/templates/:purpose', requirePermission('whatsapp.templates.manage'), async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/templates', requirePermission('whatsapp.templates.manage'), async (req: AuthenticatedRequest, res: Response) => {
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
router.get('/event-types', requirePermission('whatsapp.view'), async (_req: AuthenticatedRequest, res: Response) => {
  const { DomainEventType } = await import('../events');
  const events = Object.values(DomainEventType);
  return res.status(200).json({ success: true, data: events });
});

router.delete('/templates/:purpose', requirePermission('whatsapp.templates.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { purpose } = req.params;
  const deleted = await db('whatsapp_templates').where({ tenant_id: tenantId, purpose }).delete();
  if (deleted === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Template not found' } });
  return res.status(200).json({ success: true, data: { message: 'Template deleted' } });
});

// ---------- Meta Business credentials ----------

router.get('/business-settings', requirePermission('whatsapp.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const row = await db('whatsapp_business_settings').where({ tenant_id: tenantId }).first();
  if (!row) return res.status(200).json({ success: true, data: { configured: false } });
  return res.status(200).json({ success: true, data: { configured: true, business_account_id: row.business_account_id, updated_at: row.updated_at } });
});

router.post('/business-settings', requirePermission('whatsapp.settings.manage'), async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/templates/:purpose/submit-to-meta', requirePermission('whatsapp.templates.manage'), async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/templates/:purpose/sync-from-meta', requirePermission('whatsapp.templates.manage'), async (req: AuthenticatedRequest, res: Response) => {
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
 * GET /whatsapp/templates/meta
 *
 * List every template that lives on the WABA (Meta) side. The operator
 * can scan this list to see which templates have been APPROVED on Meta
 * — those are the only ones that can deliver messages outside the 24h
 * customer-service window. Templates that we have locally but Meta
 * doesn't know about will fail every send with the silent
 * "structure mismatch" error.
 *
 * Returns: { rows: [...], local: { purpose: localTemplateRow } } so the
 * UI can show "imported / not imported" against each Meta row.
 */
router.get('/templates/meta', requirePermission('whatsapp.templates.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const business = await db('whatsapp_business_settings').where({ tenant_id: tenantId }).first();
  if (!business) {
    return res.status(400).json({ success: false, error: { code: 'NO_BUSINESS', message: 'Configure WhatsApp Business credentials first (Settings → WhatsApp Business)' } });
  }

  try {
    const rows = await listMetaTemplates({
      businessAccountId: business.business_account_id,
      systemUserToken: decrypt(business.encrypted_system_user_token),
    });
    // Local map keyed by template_name so the UI can show whether each Meta
    // row is already wired to a local purpose. Multiple local purposes can
    // share a template_name (rare) so we surface the latest match.
    const local = await db('whatsapp_templates').where({ tenant_id: tenantId });
    const localByName: Record<string, any> = {};
    for (const t of local) {
      if (t.template_name) localByName[t.template_name] = t;
    }
    return res.status(200).json({ success: true, data: { rows, local_by_template_name: localByName } });
  } catch (err: any) {
    log.warn({ tenantId, error: err.message }, 'List Meta templates failed');
    return res.status(500).json({ success: false, error: { code: 'META_LIST_FAILED', message: err.message } });
  }
});

/**
 * POST /whatsapp/templates/meta/import
 *
 * Link a Meta-approved template to a local `purpose` so dispatchByPurpose
 * uses the template send path (allowed outside the 24h window) instead
 * of the free-text path (rejected outside the window — which is what
 * we observed in production today).
 *
 * Body: {
 *   meta_template_id: string,
 *   meta_template_name: string,
 *   language_code: string,        // e.g. 'en' / 'en_US'
 *   purpose: string,              // local key — usually matches template_name
 *   body_text: string,            // copied from Meta so we can render
 *                                 //   variables locally for the audit log
 *   variables: string[],          // ordered names matching {{1}}, {{2}}
 *   event_types?: string[],       // domain events to subscribe (defaults
 *                                 //   to DEFAULT_EVENT_TYPES_BY_PURPOSE
 *                                 //   if recognised)
 *   meta_status: string,          // APPROVED / PENDING / REJECTED
 *   meta_category?: string,       // UTILITY / MARKETING / AUTHENTICATION
 *   header_text?, footer_text?, buttons?
 * }
 *
 * Idempotent: if a row already exists for `purpose`, we update it in
 * place. The send path picks up the new template_name + language on the
 * next dispatch.
 */
router.post('/templates/meta/import', requirePermission('whatsapp.templates.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const {
    meta_template_id,
    meta_template_name,
    language_code,
    purpose,
    body_text,
    variables,
    event_types,
    meta_status,
    meta_category,
    header_text,
    footer_text,
    buttons,
  } = req.body || {};

  if (!meta_template_name || !language_code || !purpose) {
    return res.status(400).json({
      success: false,
      error: { code: 'MISSING_FIELDS', message: 'meta_template_name, language_code and purpose required' },
    });
  }

  // Default event_types from the well-known purpose -> event mapping when
  // the caller didn't specify and the purpose matches one of the defaults.
  let resolvedEventTypes: string[] = Array.isArray(event_types) ? event_types : [];
  if (!resolvedEventTypes.length) {
    const { DEFAULT_EVENT_TYPES_BY_PURPOSE } = await import('../whatsapp/templates');
    resolvedEventTypes = DEFAULT_EVENT_TYPES_BY_PURPOSE[purpose] || [];
  }

  const existing = await db('whatsapp_templates').where({ tenant_id: tenantId, purpose }).first();
  const data: any = {
    template_name: meta_template_name,
    language_code,
    body_text: body_text || existing?.body_text || '',
    variables: JSON.stringify(Array.isArray(variables) ? variables : (existing ? (typeof existing.variables === 'string' ? JSON.parse(existing.variables) : existing.variables) : [])),
    event_types: JSON.stringify(resolvedEventTypes),
    enabled: true,
    meta_template_id: meta_template_id || existing?.meta_template_id || null,
    meta_status: meta_status || existing?.meta_status || 'APPROVED',
    meta_category: meta_category || existing?.meta_category || 'UTILITY',
    meta_last_synced_at: new Date(),
    header_text: header_text ?? existing?.header_text ?? null,
    footer_text: footer_text ?? existing?.footer_text ?? null,
    buttons: JSON.stringify(Array.isArray(buttons) ? buttons : (existing && existing.buttons ? (typeof existing.buttons === 'string' ? JSON.parse(existing.buttons) : existing.buttons) : [])),
    updated_at: new Date(),
  };

  if (existing) {
    await db('whatsapp_templates').where({ id: existing.id }).update(data);
  } else {
    await db('whatsapp_templates').insert({
      tenant_id: tenantId,
      purpose,
      ...data,
    });
  }

  log.info({ tenantId, purpose, meta_template_name, language_code }, 'Imported Meta template into local registry');
  return res.status(200).json({ success: true, data: { purpose, meta_template_name, language_code } });
});

/**
 * POST /whatsapp/templates/meta/import-all
 *
 * Convenience: pull the Meta list and import any template whose `name`
 * matches one of the well-known purposes (order_confirmed,
 * order_in_transit, order_at_locker, order_out_for_delivery,
 * order_delivered, order_flagged, order_details_updated). Skips
 * non-APPROVED templates by default. Returns a summary so the operator
 * can see which were imported / skipped.
 */
router.post('/templates/meta/import-all', requirePermission('whatsapp.templates.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const includeNonApproved = !!req.body?.include_non_approved;

  const business = await db('whatsapp_business_settings').where({ tenant_id: tenantId }).first();
  if (!business) {
    return res.status(400).json({ success: false, error: { code: 'NO_BUSINESS', message: 'Configure WhatsApp Business credentials first (Settings → WhatsApp Business)' } });
  }

  let metaRows: any[];
  try {
    metaRows = await listMetaTemplates({
      businessAccountId: business.business_account_id,
      systemUserToken: decrypt(business.encrypted_system_user_token),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'META_LIST_FAILED', message: err.message } });
  }

  const { DEFAULT_EVENT_TYPES_BY_PURPOSE } = await import('../whatsapp/templates');
  const knownPurposes = Object.keys(DEFAULT_EVENT_TYPES_BY_PURPOSE);
  const summary: { imported: string[]; skipped: { name: string; reason: string }[] } = {
    imported: [],
    skipped: [],
  };

  for (const t of metaRows) {
    const purpose = knownPurposes.find((p) => p === t.name);
    if (!purpose) {
      summary.skipped.push({ name: t.name, reason: 'unknown purpose (rename or import manually)' });
      continue;
    }
    if (!includeNonApproved && t.status !== 'APPROVED') {
      summary.skipped.push({ name: t.name, reason: `status ${t.status}` });
      continue;
    }

    // Reconstruct body_text + ordered variables from Meta components.
    // Meta uses {{1}}, {{2}} positional placeholders; we keep the same
    // shape locally so renderTemplate (called only for audit log preview
    // when we use the template path) doesn't get confused. The actual
    // send goes through sendTemplate which never re-substitutes.
    const bodyComp = (t.components || []).find((c: any) => c.type === 'BODY');
    const headerComp = (t.components || []).find((c: any) => c.type === 'HEADER');
    const footerComp = (t.components || []).find((c: any) => c.type === 'FOOTER');
    const buttonsComp = (t.components || []).find((c: any) => c.type === 'BUTTONS');

    // Variables: count {{n}} in body and map back to the well-known
    // positional names from DEFAULT_TEMPLATES (customer_name, order_number,
    // waybill, pincode...). Operator can edit later if the order doesn't
    // match.
    const bodyText: string = bodyComp?.text || '';
    const placeholders = (bodyText.match(/\{\{(\d+)\}\}/g) || []).map((m) => m);
    const positions = placeholders.map((p) => parseInt(p.replace(/[^0-9]/g, ''), 10));
    const max = positions.length ? Math.max(...positions) : 0;
    const { DEFAULT_TEMPLATES } = await import('../whatsapp/templates');
    const localTpl = DEFAULT_TEMPLATES.find((d) => d.purpose === purpose);
    const variables = (localTpl?.variables || []).slice(0, max);

    await db('whatsapp_templates')
      .insert({
        tenant_id: tenantId,
        purpose,
        template_name: t.name,
        language_code: t.language || 'en',
        body_text: bodyText,
        variables: JSON.stringify(variables),
        event_types: JSON.stringify(DEFAULT_EVENT_TYPES_BY_PURPOSE[purpose] || []),
        enabled: true,
        meta_template_id: t.id,
        meta_status: t.status,
        meta_category: t.category || 'UTILITY',
        meta_last_synced_at: new Date(),
        header_text: headerComp?.text || null,
        footer_text: footerComp?.text || null,
        buttons: JSON.stringify(buttonsComp?.buttons || []),
      })
      .onConflict(['tenant_id', 'purpose'])
      .merge();

    summary.imported.push(purpose);
  }

  log.info({ tenantId, imported: summary.imported, skipped: summary.skipped.length }, 'Imported Meta templates in bulk');
  return res.status(200).json({ success: true, data: summary });
});

/**
 * GET /whatsapp/messages - recent message log.
 */
router.get('/messages', requirePermission('whatsapp.view'), async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/test', requirePermission('whatsapp.send.test'), async (req: AuthenticatedRequest, res: Response) => {
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
