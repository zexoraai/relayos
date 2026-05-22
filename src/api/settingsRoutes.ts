import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware } from './middleware';
import { validateBody } from './validate';
import { shopifyApiBodySchema, collectionContactBodySchema } from '../schemas/settings';
import { getDb } from '../db/connection';
import { encrypt } from '../crypto';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'settings-api' });
const router = Router();

router.use(authMiddleware);

// GET /settings/shopify-api - Get current Shopify API settings (without the token)
router.get('/shopify-api', async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/shopify-api', validateBody(shopifyApiBodySchema), async (req: AuthenticatedRequest, res: Response) => {
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
router.delete('/shopify-api', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  await db('tenant_shopify_api_settings').where({ tenant_id: tenantId }).delete();

  log.info({ tenantId }, 'Shopify API credentials removed');

  return res.status(200).json({ success: true, data: { message: 'Shopify API credentials removed' } });
});

// GET /settings/imap - Get current IMAP settings (without the password)
router.get('/imap', async (req: AuthenticatedRequest, res: Response) => {
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

// GET /settings/pudo - Get current PUDO settings (without secrets)
router.get('/pudo', async (req: AuthenticatedRequest, res: Response) => {
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

// GET /settings/collection-contact
router.get('/collection-contact', async (req: AuthenticatedRequest, res: Response) => {
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
      updated_at: settings.updated_at,
    },
  });
});

// POST /settings/collection-contact
router.post('/collection-contact', validateBody(collectionContactBodySchema), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { contact_name, contact_email, contact_phone, special_instructions, collection_terminal_id } = req.body;

  const existing = await db('tenant_collection_settings').where({ tenant_id: tenantId }).first();
  const data = {
    tenant_id: tenantId,
    contact_name,
    contact_email,
    contact_phone,
    special_instructions: special_instructions || 'None',
    collection_terminal_id: collection_terminal_id || null,
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
