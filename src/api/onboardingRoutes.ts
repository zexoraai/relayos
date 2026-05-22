import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware } from './middleware';
import { getDb } from '../db/connection';
import { encrypt } from '../crypto';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'onboarding' });
const router = Router();

// All onboarding routes require auth
router.use(authMiddleware);

// GET /onboarding/status
router.get('/status', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const tenant = await db('tenants').where({ id: tenantId }).first();
  if (!tenant) {
    return res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Tenant not found' } });
  }

  const ecommerceIntegration = await db('tenant_ecommerce_integrations').where({ tenant_id: tenantId }).first();
  const courierIntegration = await db('tenant_courier_integrations').where({ tenant_id: tenantId }).first();

  const missing: string[] = [];
  if (!ecommerceIntegration?.is_configured) missing.push('ecommerce_integration');
  if (!courierIntegration?.is_configured) missing.push('courier_integration');

  return res.status(200).json({
    success: true,
    data: {
      status: tenant.status,
      onboarding_step: tenant.onboarding_step,
      ecommerce_platform: ecommerceIntegration?.platform || null,
      shopify_plan: ecommerceIntegration?.shopify_plan || null,
      ecommerce_configured: ecommerceIntegration?.is_configured || false,
      courier: courierIntegration?.courier || null,
      courier_configured: courierIntegration?.is_configured || false,
      onboarding_complete: tenant.status === 'active',
      missing_items: missing,
    },
  });
});

// POST /onboarding/ecommerce-platform
router.post('/ecommerce-platform', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { platform } = req.body;

  if (!platform) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'platform is required' } });
  }

  const validPlatforms = ['shopify', 'woocommerce'];
  if (!validPlatforms.includes(platform.toLowerCase())) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_PLATFORM', message: 'Unsupported ecommerce platform' } });
  }

  if (platform.toLowerCase() === 'woocommerce') {
    return res.status(200).json({
      success: true,
      data: { message: 'WooCommerce integration is coming soon. Please select Shopify for now.', platform_status: 'coming_soon' },
    });
  }

  // Upsert ecommerce integration
  const existing = await db('tenant_ecommerce_integrations').where({ tenant_id: tenantId }).first();
  if (existing) {
    await db('tenant_ecommerce_integrations').where({ id: existing.id }).update({
      platform: 'shopify',
      platform_status: 'active',
      is_configured: false,
      updated_at: new Date(),
    });
  } else {
    await db('tenant_ecommerce_integrations').insert({
      tenant_id: tenantId,
      platform: 'shopify',
      platform_status: 'active',
    });
  }

  await db('tenants').where({ id: tenantId }).update({ onboarding_step: 'ecommerce_platform_selected', updated_at: new Date() });
  await db('tenant_onboarding_events').insert({ tenant_id: tenantId, event_type: 'ecommerce_platform_selected', event_payload: JSON.stringify({ platform: 'shopify' }) });

  return res.status(200).json({ success: true, data: { platform: 'shopify', platform_status: 'active' } });
});

// POST /onboarding/shopify-plan
router.post('/shopify-plan', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { plan } = req.body;

  const validPlans = ['basic', 'grow', 'advanced', 'plus'];
  if (!plan || !validPlans.includes(plan.toLowerCase())) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_PLAN', message: 'Valid plans: basic, grow, advanced, plus' } });
  }

  const integration = await db('tenant_ecommerce_integrations').where({ tenant_id: tenantId, platform: 'shopify' }).first();
  if (!integration) {
    return res.status(400).json({ success: false, error: { code: 'NO_PLATFORM', message: 'Select Shopify as your ecommerce platform first' } });
  }

  const planLower = plan.toLowerCase();
  const integrationMethod = planLower === 'basic' ? 'imap' : 'api';

  await db('tenant_ecommerce_integrations').where({ id: integration.id }).update({
    shopify_plan: planLower,
    integration_method: integrationMethod,
    is_configured: false,
    updated_at: new Date(),
  });

  return res.status(200).json({ success: true, data: { plan: planLower, integration_method: integrationMethod } });
});

// POST /onboarding/shopify-basic/imap-settings
router.post('/shopify-basic/imap-settings', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { imap_host, imap_port, imap_username, imap_password, imap_mailbox, imap_use_ssl, polling_interval, batch_size } = req.body;

  // Validation
  if (!imap_host) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'imap_host is required' } });
  if (!imap_port || isNaN(Number(imap_port))) return res.status(400).json({ success: false, error: { code: 'INVALID_PORT', message: 'imap_port is required and must be numeric' } });
  if (!imap_username) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'imap_username is required' } });
  if (!imap_password) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'imap_password is required' } });

  const integration = await db('tenant_ecommerce_integrations').where({ tenant_id: tenantId, platform: 'shopify', shopify_plan: 'basic' }).first();
  if (!integration) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STEP', message: 'Select Shopify Basic plan first' } });
  }

  const encryptedPassword = encrypt(imap_password);

  // Upsert IMAP settings
  const existing = await db('tenant_imap_settings').where({ tenant_id: tenantId, ecommerce_integration_id: integration.id }).first();
  const imapData = {
    tenant_id: tenantId,
    ecommerce_integration_id: integration.id,
    imap_host,
    imap_port: Number(imap_port),
    imap_username,
    encrypted_imap_password: encryptedPassword,
    imap_mailbox: imap_mailbox || 'INBOX',
    imap_use_ssl: imap_use_ssl !== false,
    polling_interval: polling_interval || 30000,
    batch_size: batch_size || 50,
  };

  if (existing) {
    await db('tenant_imap_settings').where({ id: existing.id }).update({ ...imapData, updated_at: new Date() });
  } else {
    await db('tenant_imap_settings').insert(imapData);
  }

  // Mark integration as configured
  await db('tenant_ecommerce_integrations').where({ id: integration.id }).update({ is_configured: true, updated_at: new Date() });
  await db('tenants').where({ id: tenantId }).update({ onboarding_step: 'ecommerce_integration_configured', updated_at: new Date() });
  await db('tenant_onboarding_events').insert({ tenant_id: tenantId, event_type: 'ecommerce_integration_configured', event_payload: JSON.stringify({ method: 'imap', host: imap_host }) });

  log.info({ tenantId }, 'Shopify Basic IMAP settings saved');

  return res.status(200).json({ success: true, data: { message: 'IMAP settings saved', is_configured: true } });
});

// POST /onboarding/shopify-api/settings
router.post('/shopify-api/settings', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { shopify_store, shopify_access_token } = req.body;

  if (!shopify_store) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'shopify_store is required' } });
  if (!shopify_access_token) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'shopify_access_token is required' } });

  // Allow any Shopify plan (Basic uses it for enrichment, Grow+ uses it as primary integration)
  const integration = await db('tenant_ecommerce_integrations').where({ tenant_id: tenantId, platform: 'shopify' }).first();
  if (!integration) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STEP', message: 'Select Shopify as your platform first' } });
  }

  const isBasic = integration.shopify_plan === 'basic';
  const encryptedToken = encrypt(shopify_access_token);

  const existing = await db('tenant_shopify_api_settings').where({ tenant_id: tenantId, ecommerce_integration_id: integration.id }).first();
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

  // For Grow+ plans, this is the primary integration so mark as configured
  // For Basic, IMAP is primary; this is just enrichment, don't change ecommerce_configured
  if (!isBasic) {
    await db('tenant_ecommerce_integrations').where({ id: integration.id }).update({ is_configured: true, updated_at: new Date() });
    await db('tenants').where({ id: tenantId }).update({ onboarding_step: 'ecommerce_integration_configured', updated_at: new Date() });
  }

  await db('tenant_onboarding_events').insert({
    tenant_id: tenantId,
    event_type: isBasic ? 'shopify_enrichment_configured' : 'ecommerce_integration_configured',
    event_payload: JSON.stringify({ method: 'api', store: shopify_store, plan: integration.shopify_plan }),
  });

  return res.status(200).json({ success: true, data: { message: 'Shopify API settings saved', is_configured: true, enrichment: isBasic } });
});

// POST /onboarding/courier
router.post('/courier', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { courier } = req.body;

  const validCouriers = ['pudo', 'the_courier_guy', 'dhl', 'aramex'];
  if (!courier || !validCouriers.includes(courier.toLowerCase())) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_COURIER', message: 'Valid couriers: pudo, the_courier_guy, dhl, aramex' } });
  }

  const courierLower = courier.toLowerCase();
  const inactiveCouriers = ['the_courier_guy', 'dhl', 'aramex'];

  if (inactiveCouriers.includes(courierLower)) {
    return res.status(200).json({
      success: true,
      data: { message: `${courier} integration is coming soon. Please select PUDO for now.`, courier_status: 'coming_soon' },
    });
  }

  // Upsert courier integration
  const existing = await db('tenant_courier_integrations').where({ tenant_id: tenantId }).first();
  if (existing) {
    await db('tenant_courier_integrations').where({ id: existing.id }).update({
      courier: 'pudo',
      courier_status: 'active',
      is_configured: false,
      updated_at: new Date(),
    });
  } else {
    await db('tenant_courier_integrations').insert({
      tenant_id: tenantId,
      courier: 'pudo',
      courier_status: 'active',
    });
  }

  await db('tenants').where({ id: tenantId }).update({ onboarding_step: 'courier_selected', updated_at: new Date() });
  await db('tenant_onboarding_events').insert({ tenant_id: tenantId, event_type: 'courier_selected', event_payload: JSON.stringify({ courier: 'pudo' }) });

  return res.status(200).json({ success: true, data: { courier: 'pudo', courier_status: 'active' } });
});

// POST /onboarding/courier/pudo-settings
router.post('/courier/pudo-settings', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { pudo_username, pudo_password, pudo_api_key } = req.body;

  if (!pudo_username) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'pudo_username is required' } });
  if (!pudo_password) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'pudo_password is required' } });
  if (!pudo_api_key) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'pudo_api_key is required' } });

  const courierIntegration = await db('tenant_courier_integrations').where({ tenant_id: tenantId, courier: 'pudo' }).first();
  if (!courierIntegration) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STEP', message: 'Select PUDO as your courier first' } });
  }

  const encryptedPassword = encrypt(pudo_password);
  const encryptedApiKey = encrypt(pudo_api_key);

  const existing = await db('tenant_pudo_settings').where({ tenant_id: tenantId, courier_integration_id: courierIntegration.id }).first();
  const pudoData = {
    tenant_id: tenantId,
    courier_integration_id: courierIntegration.id,
    pudo_username,
    encrypted_pudo_password: encryptedPassword,
    encrypted_pudo_api_key: encryptedApiKey,
  };

  if (existing) {
    await db('tenant_pudo_settings').where({ id: existing.id }).update({ ...pudoData, updated_at: new Date() });
  } else {
    await db('tenant_pudo_settings').insert(pudoData);
  }

  await db('tenant_courier_integrations').where({ id: courierIntegration.id }).update({ is_configured: true, updated_at: new Date() });
  await db('tenants').where({ id: tenantId }).update({ onboarding_step: 'courier_configured', updated_at: new Date() });
  await db('tenant_onboarding_events').insert({ tenant_id: tenantId, event_type: 'courier_configured', event_payload: JSON.stringify({ courier: 'pudo' }) });

  log.info({ tenantId }, 'PUDO settings saved');

  return res.status(200).json({ success: true, data: { message: 'PUDO settings saved', is_configured: true } });
});

// POST /onboarding/complete
router.post('/complete', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const ecommerceIntegration = await db('tenant_ecommerce_integrations').where({ tenant_id: tenantId, is_configured: true }).first();
  if (!ecommerceIntegration) {
    return res.status(400).json({ success: false, error: { code: 'INCOMPLETE_ONBOARDING', message: 'Ecommerce integration must be configured before completing onboarding' } });
  }

  // Block WooCommerce completion
  if (ecommerceIntegration.platform === 'woocommerce') {
    return res.status(400).json({ success: false, error: { code: 'PLATFORM_UNAVAILABLE', message: 'WooCommerce integration is not yet available' } });
  }

  const courierIntegration = await db('tenant_courier_integrations').where({ tenant_id: tenantId, is_configured: true }).first();
  if (!courierIntegration) {
    return res.status(400).json({ success: false, error: { code: 'INCOMPLETE_ONBOARDING', message: 'Courier integration must be configured before completing onboarding' } });
  }

  // Block inactive couriers
  if (['the_courier_guy', 'dhl', 'aramex'].includes(courierIntegration.courier)) {
    return res.status(400).json({ success: false, error: { code: 'COURIER_UNAVAILABLE', message: `${courierIntegration.courier} integration is not yet available` } });
  }

  // Complete onboarding
  await db('tenants').where({ id: tenantId }).update({
    status: 'active',
    onboarding_step: 'completed',
    onboarding_completed_at: new Date(),
    updated_at: new Date(),
  });

  await db('tenant_onboarding_events').insert({ tenant_id: tenantId, event_type: 'onboarding_completed', event_payload: JSON.stringify({}) });

  log.info({ tenantId }, 'Tenant onboarding completed');

  return res.status(200).json({ success: true, data: { message: 'Onboarding complete', status: 'active' } });
});

export default router;
