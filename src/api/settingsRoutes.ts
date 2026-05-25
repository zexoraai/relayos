import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { validateBody } from './validate';
import { shopifyApiBodySchema, collectionContactBodySchema } from '../schemas/settings';
import { getDb } from '../db/connection';
import { encrypt } from '../crypto';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'settings-api' });
const router = Router();

router.use(authMiddleware);

// GET /settings/shopify-api - Get current Shopify API settings (without the token)
router.get('/shopify-api', requirePermission('settings.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const settings = await db('tenant_shopify_api_settings').where({ tenant_id: tenantId }).first();

  if (!settings) {
    return res.status(200).json({
      success: true,
      data: { configured: false, shopify_store: null },
    });
  }

  return res.status(200).json({
    success: true,
    data: {
      configured: true,
      shopify_store: settings.shopify_store,
      updated_at: settings.updated_at,
    },
  });
});

// POST /settings/shopify-api - Upsert Shopify API credentials (any plan)
router.post('/shopify-api', requirePermission('settings.shopify.manage'), validateBody(shopifyApiBodySchema), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { shopify_store, shopify_access_token } = req.body;

  // Find or create the ecommerce integration
  let integration = await db('tenant_ecommerce_integrations')
    .where({ tenant_id: tenantId, platform: 'shopify' })
    .first();

  if (!integration) {
    return res.status(400).json({
      success: false,
      error: { code: 'NO_PLATFORM', message: 'Configure Shopify as your platform first' },
    });
  }

  const encryptedToken = encrypt(shopify_access_token);

  const existing = await db('tenant_shopify_api_settings')
    .where({ tenant_id: tenantId, ecommerce_integration_id: integration.id })
    .first();

  const apiData = {
    tenant_id: tenantId,
    ecommerce_integration_id: integration.id,
    shopify_store,
    encrypted_access_token: encryptedToken,
  };

  if (existing) {
    await db('tenant_shopify_api_settings').where({ id: existing.id }).update({ ...apiData, updated_at: new Date() });
  } else {
    await db('tenant_shopify_api_settings').insert(apiData);
  }

  log.info({ tenantId }, 'Shopify API credentials updated');

  return res.status(200).json({
    success: true,
    data: { message: 'Shopify API credentials saved', shopify_store },
  });
});

// DELETE /settings/shopify-api - Remove Shopify API credentials
router.delete('/shopify-api', requirePermission('settings.shopify.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  await db('tenant_shopify_api_settings').where({ tenant_id: tenantId }).delete();

  log.info({ tenantId }, 'Shopify API credentials removed');

  return res.status(200).json({ success: true, data: { message: 'Shopify API credentials removed' } });
});

// GET /settings/imap - Get current IMAP settings (without the password)
router.get('/imap', requirePermission('settings.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const settings = await db('tenant_imap_settings').where({ tenant_id: tenantId }).first();

  if (!settings) {
    return res.status(200).json({
      success: true,
      data: { configured: false },
    });
  }

  return res.status(200).json({
    success: true,
    data: {
      configured: true,
      imap_host: settings.imap_host,
      imap_port: settings.imap_port,
      imap_username: settings.imap_username,
      imap_mailbox: settings.imap_mailbox,
      imap_use_ssl: settings.imap_use_ssl,
      polling_interval: settings.polling_interval,
      batch_size: settings.batch_size,
      updated_at: settings.updated_at,
    },
  });
});

// POST /settings/imap - Upsert IMAP credentials post-onboarding.
// Used by the dashboard's Settings page to fix or rotate IMAP credentials
// without going back through onboarding.
router.post('/imap', requirePermission('settings.imap.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { imap_host, imap_port, imap_username, imap_password, imap_mailbox, imap_use_ssl, polling_interval, batch_size } = req.body;

  if (!imap_host) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'imap_host is required' } });
  if (!imap_port || isNaN(Number(imap_port))) return res.status(400).json({ success: false, error: { code: 'INVALID_PORT', message: 'imap_port is required and must be numeric' } });
  if (!imap_username) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'imap_username is required' } });

  // Find the Shopify Basic integration. IMAP is only meaningful for that plan,
  // so reuse the existing integration row.
  const integration = await db('tenant_ecommerce_integrations')
    .where({ tenant_id: tenantId, platform: 'shopify', shopify_plan: 'basic' })
    .first();
  if (!integration) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'NO_INTEGRATION',
        message: 'IMAP requires a Shopify Basic integration. Configure one via onboarding first.',
      },
    });
  }

  const existing = await db('tenant_imap_settings')
    .where({ tenant_id: tenantId, ecommerce_integration_id: integration.id })
    .first();

  // imap_password is optional on update — if blank, keep the current encrypted value.
  if (!existing && !imap_password) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'imap_password is required for first save' } });
  }

  const imapData: Record<string, any> = {
    tenant_id: tenantId,
    ecommerce_integration_id: integration.id,
    imap_host,
    imap_port: Number(imap_port),
    imap_username,
    imap_mailbox: imap_mailbox || 'INBOX',
    imap_use_ssl: imap_use_ssl !== false,
    polling_interval: polling_interval || 30000,
    batch_size: batch_size || 50,
  };

  if (imap_password) {
    imapData.encrypted_imap_password = encrypt(imap_password);
  }

  if (existing) {
    await db('tenant_imap_settings')
      .where({ id: existing.id })
      .update({ ...imapData, updated_at: new Date() });
  } else {
    await db('tenant_imap_settings').insert(imapData);
  }

  await db('tenant_ecommerce_integrations')
    .where({ id: integration.id })
    .update({ is_configured: true, updated_at: new Date() });

  log.info({ tenantId, host: imap_host, user: imap_username }, 'IMAP settings updated from dashboard');

  return res.status(200).json({
    success: true,
    data: { message: 'IMAP settings saved', is_configured: true },
  });
});

// DELETE /settings/imap - Remove IMAP credentials. Stops polling for this tenant.
router.delete('/imap', requirePermission('settings.imap.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  await db('tenant_imap_settings').where({ tenant_id: tenantId }).delete();

  log.info({ tenantId }, 'IMAP settings removed from dashboard');

  return res.status(200).json({ success: true, data: { message: 'IMAP settings removed' } });
});

// GET /settings/pudo - Get current PUDO settings (without secrets)
router.get('/pudo', requirePermission('settings.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const settings = await db('tenant_pudo_settings').where({ tenant_id: tenantId }).first();

  if (!settings) {
    return res.status(200).json({ success: true, data: { configured: false } });
  }

  return res.status(200).json({
    success: true,
    data: {
      configured: true,
      pudo_username: settings.pudo_username,
      updated_at: settings.updated_at,
    },
  });
});

// POST /settings/pudo - Upsert PUDO credentials post-onboarding.
// Used by the Settings page to fix or rotate PUDO creds (api key + login)
// without going back through onboarding.
router.post('/pudo', requirePermission('settings.pudo.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { pudo_username, pudo_password, pudo_api_key } = req.body;

  if (!pudo_username) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'pudo_username is required' } });
  }

  // Locate the courier integration row (created during onboarding when courier=pudo was picked).
  const courierIntegration = await db('tenant_courier_integrations')
    .where({ tenant_id: tenantId, courier: 'pudo' })
    .first();
  if (!courierIntegration) {
    return res.status(400).json({
      success: false,
      error: { code: 'NO_COURIER', message: 'PUDO courier integration not found. Pick PUDO as your courier in onboarding first.' },
    });
  }

  const existing = await db('tenant_pudo_settings')
    .where({ tenant_id: tenantId, courier_integration_id: courierIntegration.id })
    .first();

  // password + api_key are optional on update — blank means "keep current"
  if (!existing && (!pudo_password || !pudo_api_key)) {
    return res.status(400).json({
      success: false,
      error: { code: 'MISSING_FIELDS', message: 'pudo_password and pudo_api_key are required for first save' },
    });
  }

  const data: Record<string, any> = {
    tenant_id: tenantId,
    courier_integration_id: courierIntegration.id,
    pudo_username,
  };
  if (pudo_password) data.encrypted_pudo_password = encrypt(pudo_password);
  if (pudo_api_key) data.encrypted_pudo_api_key = encrypt(pudo_api_key);

  if (existing) {
    await db('tenant_pudo_settings').where({ id: existing.id }).update({ ...data, updated_at: new Date() });
  } else {
    await db('tenant_pudo_settings').insert(data);
  }

  await db('tenant_courier_integrations')
    .where({ id: courierIntegration.id })
    .update({ is_configured: true, updated_at: new Date() });

  log.info({ tenantId, user: pudo_username }, 'PUDO credentials updated from dashboard');

  return res.status(200).json({
    success: true,
    data: { message: 'PUDO credentials saved', is_configured: true },
  });
});

// DELETE /settings/pudo - Remove PUDO credentials. Stops fulfillment for this tenant.
router.delete('/pudo', requirePermission('settings.pudo.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  await db('tenant_pudo_settings').where({ tenant_id: tenantId }).delete();

  log.info({ tenantId }, 'PUDO credentials removed from dashboard');

  return res.status(200).json({ success: true, data: { message: 'PUDO credentials removed' } });
});

// GET /settings/collection-contact
router.get('/collection-contact', requirePermission('settings.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const settings = await db('tenant_collection_settings').where({ tenant_id: tenantId }).first();

  if (!settings) {
    return res.status(200).json({ success: true, data: { configured: false } });
  }

  return res.status(200).json({
    success: true,
    data: {
      configured: true,
      contact_name: settings.contact_name,
      contact_email: settings.contact_email,
      contact_phone: settings.contact_phone,
      special_instructions: settings.special_instructions,
      collection_terminal_id: settings.collection_terminal_id,
      collection_address: settings.collection_address || null,
      updated_at: settings.updated_at,
    },
  });
});

// POST /settings/collection-contact
router.post('/collection-contact', requirePermission('settings.collection.manage'), validateBody(collectionContactBodySchema), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { contact_name, contact_email, contact_phone, special_instructions, collection_terminal_id, collection_address } = req.body;

  const existing = await db('tenant_collection_settings').where({ tenant_id: tenantId }).first();
  const data = {
    tenant_id: tenantId,
    contact_name,
    contact_email,
    contact_phone,
    special_instructions: special_instructions || 'None',
    collection_terminal_id: collection_terminal_id || null,
    collection_address: collection_address ? JSON.stringify(collection_address) : null,
  };

  if (existing) {
    await db('tenant_collection_settings').where({ id: existing.id }).update({ ...data, updated_at: new Date() });
  } else {
    await db('tenant_collection_settings').insert(data);
  }

  log.info({ tenantId }, 'Collection contact settings updated');

  return res.status(200).json({ success: true, data: { message: 'Collection contact saved' } });
});

export default router;
