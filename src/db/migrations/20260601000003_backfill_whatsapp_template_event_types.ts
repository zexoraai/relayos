import { Knex } from 'knex';

/**
 * Backfill `whatsapp_templates.event_types` for existing rows that were
 * seeded with the empty default `[]`.
 *
 * Background — without event_types populated, the
 * whatsappEventSubscriber's `event_types::jsonb @> [event_type]::jsonb`
 * predicate matches nothing, so the milestone notifications
 * (order_in_transit, order_at_locker, order_out_for_delivery,
 * order_delivered, order_confirmed, order_flagged) silently never fire.
 *
 * The 2024-05-01 extend_whatsapp_templates migration already runs the
 * same UPDATE for rows that existed at that time. This migration covers
 * tenants whose templates were created later (post-2024-05-01) by the
 * default-seed code in `src/whatsapp/index.ts` — that code path was
 * patched to write event_types at insert time, but rows it created
 * before the patch still need this one-shot fix.
 *
 * Idempotent: only updates rows where event_types is the empty array.
 * Existing tenant customizations (event_types containing values) are
 * preserved.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE whatsapp_templates SET event_types = '["order.confirmed"]'::jsonb
      WHERE purpose = 'order_confirmed'
        AND (event_types IS NULL OR event_types::jsonb = '[]'::jsonb);
  `);
  await knex.raw(`
    UPDATE whatsapp_templates SET event_types = '["order.in_transit"]'::jsonb
      WHERE purpose = 'order_in_transit'
        AND (event_types IS NULL OR event_types::jsonb = '[]'::jsonb);
  `);
  await knex.raw(`
    UPDATE whatsapp_templates SET event_types = '["order.at_locker"]'::jsonb
      WHERE purpose = 'order_at_locker'
        AND (event_types IS NULL OR event_types::jsonb = '[]'::jsonb);
  `);
  await knex.raw(`
    UPDATE whatsapp_templates SET event_types = '["order.out_for_delivery"]'::jsonb
      WHERE purpose = 'order_out_for_delivery'
        AND (event_types IS NULL OR event_types::jsonb = '[]'::jsonb);
  `);
  await knex.raw(`
    UPDATE whatsapp_templates SET event_types = '["order.delivered"]'::jsonb
      WHERE purpose = 'order_delivered'
        AND (event_types IS NULL OR event_types::jsonb = '[]'::jsonb);
  `);
  await knex.raw(`
    UPDATE whatsapp_templates SET event_types = '["order.flagged"]'::jsonb
      WHERE purpose = 'order_flagged'
        AND (event_types IS NULL OR event_types::jsonb = '[]'::jsonb);
  `);
  // order_details_updated stays empty: it is dispatched explicitly from
  // the caretaker resolve handler when a reviewer chooses "notify
  // customer", not via a domain event.
}

export async function down(_knex: Knex): Promise<void> {
  // Backfill is idempotent and conservative; no-op on rollback.
}
