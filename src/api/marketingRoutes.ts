import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'marketing-api' });
const router = Router();

router.use(authMiddleware);

// ---- Campaigns CRUD ----

router.get('/campaigns', requirePermission('marketing.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const campaigns = await db('marketing_campaigns')
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'desc');

  // Hydrate step counts
  for (const c of campaigns) {
    const steps = await db('marketing_campaign_steps').where({ campaign_id: c.id }).orderBy('step_order');
    c.steps = steps;
    const enrollCount = await db('marketing_enrollments').where({ campaign_id: c.id }).count<{count:string}[]>('id as count');
    c.enrolled_count = parseInt(enrollCount[0]?.count || '0');
  }

  return res.status(200).json({ success: true, data: campaigns });
});

router.post('/campaigns', requirePermission('marketing.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { name, campaign_type, description, inactivity_days_trigger, abandon_hours_trigger, max_sends_per_customer, cooldown_days, steps } = req.body;

  if (!name || !campaign_type) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'name and campaign_type required' } });
  }
  if (!['win_back', 'abandoned_cart'].includes(campaign_type)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_TYPE', message: 'campaign_type must be win_back or abandoned_cart' } });
  }

  const [campaign] = await db('marketing_campaigns').insert({
    tenant_id: tenantId,
    name,
    campaign_type,
    description: description || null,
    inactivity_days_trigger: inactivity_days_trigger || null,
    abandon_hours_trigger: abandon_hours_trigger || null,
    max_sends_per_customer: max_sends_per_customer || 3,
    cooldown_days: cooldown_days || 30,
    enabled: true,
  }).returning('*');

  // Insert steps if provided
  if (Array.isArray(steps) && steps.length) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await db('marketing_campaign_steps').insert({
        campaign_id: campaign.id,
        step_order: i + 1,
        delay_days: s.delay_days || 0,
        delay_hours: s.delay_hours || 0,
        whatsapp_template_purpose: s.whatsapp_template_purpose || null,
        message_body: s.message_body || null,
        enabled: s.enabled !== false,
      });
    }
  }

  log.info({ tenantId, campaignId: campaign.id, type: campaign_type }, 'Marketing campaign created');
  return res.status(201).json({ success: true, data: campaign });
});

router.put('/campaigns/:id', requirePermission('marketing.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { name, description, enabled, inactivity_days_trigger, abandon_hours_trigger, max_sends_per_customer, cooldown_days } = req.body;

  const data: any = { updated_at: new Date() };
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description;
  if (enabled !== undefined) data.enabled = !!enabled;
  if (inactivity_days_trigger !== undefined) data.inactivity_days_trigger = inactivity_days_trigger;
  if (abandon_hours_trigger !== undefined) data.abandon_hours_trigger = abandon_hours_trigger;
  if (max_sends_per_customer !== undefined) data.max_sends_per_customer = max_sends_per_customer;
  if (cooldown_days !== undefined) data.cooldown_days = cooldown_days;

  const updated = await db('marketing_campaigns').where({ id, tenant_id: tenantId }).update(data);
  if (updated === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
  return res.status(200).json({ success: true, data: { message: 'Campaign updated' } });
});

router.delete('/campaigns/:id', requirePermission('marketing.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  await db('marketing_campaigns').where({ id, tenant_id: tenantId }).delete();
  return res.status(200).json({ success: true, data: { message: 'Campaign deleted' } });
});

// ---- Steps CRUD ----

router.post('/campaigns/:id/steps', requirePermission('marketing.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { delay_days, delay_hours, whatsapp_template_purpose, message_body } = req.body;

  const campaign = await db('marketing_campaigns').where({ id, tenant_id: tenantId }).first();
  if (!campaign) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

  const maxOrder = await db('marketing_campaign_steps').where({ campaign_id: id }).max('step_order as max').first();
  const nextOrder = (maxOrder?.max || 0) + 1;

  const [step] = await db('marketing_campaign_steps').insert({
    campaign_id: id,
    step_order: nextOrder,
    delay_days: delay_days || 0,
    delay_hours: delay_hours || 0,
    whatsapp_template_purpose: whatsapp_template_purpose || null,
    message_body: message_body || null,
    enabled: true,
  }).returning('*');

  return res.status(201).json({ success: true, data: step });
});

router.put('/campaigns/:campaignId/steps/:stepId', requirePermission('marketing.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const { campaignId, stepId } = req.params as { campaignId: string; stepId: string };
  const { delay_days, delay_hours, whatsapp_template_purpose, message_body, enabled } = req.body;

  const data: any = {};
  if (delay_days !== undefined) data.delay_days = delay_days;
  if (delay_hours !== undefined) data.delay_hours = delay_hours;
  if (whatsapp_template_purpose !== undefined) data.whatsapp_template_purpose = whatsapp_template_purpose || null;
  if (message_body !== undefined) data.message_body = message_body || null;
  if (enabled !== undefined) data.enabled = !!enabled;

  await db('marketing_campaign_steps').where({ id: stepId, campaign_id: campaignId }).update(data);
  return res.status(200).json({ success: true, data: { message: 'Step updated' } });
});

router.delete('/campaigns/:campaignId/steps/:stepId', requirePermission('marketing.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const { campaignId, stepId } = req.params as { campaignId: string; stepId: string };
  await db('marketing_campaign_steps').where({ id: stepId, campaign_id: campaignId }).delete();
  return res.status(200).json({ success: true, data: { message: 'Step deleted' } });
});

// ---- Stats ----

router.get('/stats', requirePermission('marketing.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const sends = await db('marketing_sends')
    .where({ tenant_id: tenantId })
    .select('status')
    .count<{status:string;count:string}[]>('id as count')
    .groupBy('status');

  const statusMap: Record<string, number> = {};
  sends.forEach((s: any) => { statusMap[s.status] = parseInt(s.count); });

  const enrollments = await db('marketing_enrollments')
    .where({ tenant_id: tenantId })
    .count<{count:string}[]>('id as count');

  return res.status(200).json({
    success: true,
    data: {
      total_enrollments: parseInt(enrollments[0]?.count || '0'),
      sends_by_status: statusMap,
    },
  });
});

export default router;
