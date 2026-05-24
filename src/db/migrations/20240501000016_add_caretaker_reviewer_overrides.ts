import type { Knex } from 'knex';

/**
 * When a human approves a flagged caretaker evaluation, they can override the
 * AI-extracted data (customer name, phone, address, delivery method, line items,
 * locker pick) before the pipeline resumes.
 *
 * - reviewer_overrides : JSON blob of fields to merge over the data the pipeline
 *                        produced. Empty {} means no overrides.
 * - reviewer_notes     : free-text shown on the timeline.
 *
 * The pipeline's CUSTOMER_DATA stage merges these on the next run; the
 * LOCKERS_RESOLVED stage uses an override locker if provided.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('caretaker_evaluations', (table) => {
    table.jsonb('reviewer_overrides').nullable();
    table.text('reviewer_notes').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('caretaker_evaluations', (table) => {
    table.dropColumn('reviewer_overrides');
    table.dropColumn('reviewer_notes');
  });
}
