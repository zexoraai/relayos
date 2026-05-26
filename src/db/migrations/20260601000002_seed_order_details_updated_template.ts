import { Knex } from 'knex';

/**
 * Backfill the `order_details_updated` WhatsApp template for every tenant
 * that already has at least one template seeded.
 *
 * Why: the new template was added to DEFAULT_TEMPLATES (used at first-time
 * WhatsApp configuration), so any tenant that configured WhatsApp before
 * this commit doesn't have it yet. Without this row, the
 * "Notify customer via WhatsApp" checkbox in the caretaker review modal
 * would silently no-op because dispatchByPurpose() can't find the template.
 *
 * Idempotent: ON CONFLICT (tenant_id, purpose) DO NOTHING. Operators who
 * already crafted their own copy of this template are not overwritten.
 *
 * Scoped to tenants that have any existing whatsapp_template row, so we
 * don't pre-seed empty-state tenants that haven't configured WhatsApp at all.
 */

const TEMPLATE = {
  purpose: 'order_details_updated',
  language_code: 'en',
  body_text:
    'Hi {{customer_name}}, we updated the delivery details for your order #{{order_number}}. {{change_summary}} If anything looks wrong, please reply to this message.',
  variables: ['customer_name', 'order_number', 'change_summary'],
};

export async function up(knex: Knex): Promise<void> {
  // Only target tenants that already have at least one template — those are
  // the ones who've completed WhatsApp onboarding and would otherwise be
  // missing this row.
  const tenants = await knex('whatsapp_templates')
    .distinct('tenant_id')
    .pluck('tenant_id');

  if (tenants.length === 0) return;

  const rows = tenants.map((tenant_id: string) => ({
    tenant_id,
    purpose: TEMPLATE.purpose,
    language_code: TEMPLATE.language_code,
    body_text: TEMPLATE.body_text,
    variables: JSON.stringify(TEMPLATE.variables),
    enabled: true,
  }));

  await knex('whatsapp_templates')
    .insert(rows)
    .onConflict(['tenant_id', 'purpose'])
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex('whatsapp_templates').where({ purpose: TEMPLATE.purpose }).delete();
}
