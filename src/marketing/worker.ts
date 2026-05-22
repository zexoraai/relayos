import { getDb } from '../db/connection';
import { dispatchByPurpose, sendFreeText } from '../whatsapp';
import { embedDirtyDocuments } from '../knowledge/embeddings';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'marketing-worker' });

let interval: NodeJS.Timeout | null = null;
const TICK_MS = parseInt(process.env.MARKETING_WORKER_TICK_MS || '60000'); // 1 min default

/**
 * Marketing automation worker.
 *
 * Two jobs on each tick:
 *   1. Enroll eligible customers into active campaigns (win-back: check last_order_at)
 *   2. Fire pending sends whose scheduled_at has passed
 */

export function startMarketingWorker(): void {
  if (interval) return;
  log.info({ tickMs: TICK_MS }, 'Marketing worker started');
  interval = setInterval(() => tick().catch((e) => log.error({ error: e.message }, 'Marketing tick failed')), TICK_MS);
  // Run immediately
  tick().catch(() => {});
}

export function stopMarketingWorker(): void {
  if (interval) { clearInterval(interval); interval = null; log.info('Marketing worker stopped'); }
}

async function tick(): Promise<void> {
  await enrollEligibleCustomers();
  await firePendingSends();
  // Also embed any new/dirty knowledge documents
  await embedDirtyDocuments(10).catch((e) => log.debug({ error: e.message }, 'Embedding tick skipped'));
}

/**
 * Find customers eligible for win-back campaigns and enroll them.
 * Eligibility: last_order_at older than campaign.inactivity_days_trigger AND not already enrolled (or cooldown expired).
 */
async function enrollEligibleCustomers(): Promise<void> {
  const db = getDb();

  const campaigns = await db('marketing_campaigns')
    .where({ campaign_type: 'win_back', enabled: true })
    .whereNotNull('inactivity_days_trigger');

  for (const campaign of campaigns) {
    const cutoff = new Date(Date.now() - campaign.inactivity_days_trigger * 24 * 60 * 60 * 1000);
    const cooldownCutoff = new Date(Date.now() - campaign.cooldown_days * 24 * 60 * 60 * 1000);

    // Find customers who haven't ordered since the cutoff and aren't already enrolled recently
    const eligible = await db('customers')
      .where({ tenant_id: campaign.tenant_id })
      .where('last_order_at', '<', cutoff)
      .whereNotNull('phone_normalized')
      .whereNotExists(function() {
        this.select('id').from('marketing_enrollments')
          .where('campaign_id', campaign.id)
          .whereRaw('customer_id = customers.id')
          .where('enrolled_at', '>', cooldownCutoff);
      })
      .limit(50); // batch size per tick

    for (const customer of eligible) {
      // Enroll
      await db('marketing_enrollments').insert({
        tenant_id: campaign.tenant_id,
        campaign_id: campaign.id,
        customer_id: customer.id,
        status: 'active',
      }).onConflict(['campaign_id', 'customer_id']).ignore();

      // Schedule all steps
      const steps = await db('marketing_campaign_steps')
        .where({ campaign_id: campaign.id, enabled: true })
        .orderBy('step_order');

      for (const step of steps) {
        const delayMs = (step.delay_days * 24 * 60 * 60 * 1000) + (step.delay_hours * 60 * 60 * 1000);
        const scheduledAt = new Date(Date.now() + delayMs);

        await db('marketing_sends').insert({
          tenant_id: campaign.tenant_id,
          campaign_id: campaign.id,
          step_id: step.id,
          customer_id: customer.id,
          phone: customer.phone_normalized,
          status: 'pending',
          scheduled_at: scheduledAt,
        }).onConflict().ignore();
      }

      log.debug({ campaignId: campaign.id, customerId: customer.id, steps: steps.length }, 'Customer enrolled in campaign');
    }
  }
}

/**
 * Fire sends whose scheduled_at has passed and status is pending.
 */
async function firePendingSends(): Promise<void> {
  const db = getDb();
  const now = new Date();

  const pending = await db('marketing_sends')
    .where({ status: 'pending' })
    .where('scheduled_at', '<=', now)
    .limit(20); // batch

  for (const send of pending) {
    try {
      const step = await db('marketing_campaign_steps').where({ id: send.step_id }).first();
      if (!step) { await db('marketing_sends').where({ id: send.id }).update({ status: 'skipped' }); continue; }

      // Check if customer has ordered since enrollment (cancel the campaign for them)
      const customer = await db('customers').where({ id: send.customer_id }).first();
      const enrollment = await db('marketing_enrollments').where({ campaign_id: send.campaign_id, customer_id: send.customer_id }).first();
      if (customer && enrollment && customer.last_order_at && new Date(customer.last_order_at) > new Date(enrollment.enrolled_at)) {
        // Customer ordered! Cancel remaining sends
        await db('marketing_sends').where({ campaign_id: send.campaign_id, customer_id: send.customer_id, status: 'pending' }).update({ status: 'skipped' });
        await db('marketing_enrollments').where({ id: enrollment.id }).update({ status: 'completed', completed_at: new Date() });
        log.info({ campaignId: send.campaign_id, customerId: send.customer_id }, 'Customer ordered — campaign cancelled');
        continue;
      }

      // Send the message
      if (step.whatsapp_template_purpose) {
        await dispatchByPurpose({
          tenantId: send.tenant_id,
          purpose: step.whatsapp_template_purpose,
          toPhone: send.phone,
          variables: {
            customer_name: customer?.name || '',
            order_number: '',
            waybill: '',
            pincode: '',
          },
        });
      } else if (step.message_body) {
        await sendFreeText({
          tenantId: send.tenant_id,
          toPhone: send.phone,
          body: step.message_body,
        });
      }

      await db('marketing_sends').where({ id: send.id }).update({ status: 'sent', sent_at: new Date() });
      await db('marketing_enrollments').where({ campaign_id: send.campaign_id, customer_id: send.customer_id }).update({
        sends_count: db.raw('sends_count + 1'),
        last_sent_at: new Date(),
      });

      log.info({ sendId: send.id, phone: send.phone, step: step.step_order }, 'Marketing message sent');
    } catch (err: any) {
      await db('marketing_sends').where({ id: send.id }).update({ status: 'failed', error: err.message });
      log.warn({ sendId: send.id, error: err.message }, 'Marketing send failed');
    }
  }
}
