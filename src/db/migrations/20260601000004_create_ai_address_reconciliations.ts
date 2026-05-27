import { Knex } from 'knex';

/**
 * Audit log for the AI address reconciliation stage. Every time
 * LOCATION_RECONCILED fires (i.e. the geocoder dropped vital fields),
 * we write one row capturing what we tried and what we ended up with.
 *
 * Why a dedicated table:
 *   - tunable thresholds: after N days we can pull stats per tenant on
 *     auto_merged_high vs auto_merged_low vs flagged hit rates and
 *     dial confidence cutoffs against real data instead of guessing.
 *   - false-accept analysis: when a reviewer reopens an order that was
 *     auto-merged, we can join to this table to find the original AI
 *     suggestion and learn which patterns led to bad merges.
 *   - cost tracking: AI calls are only made when ai_used=true; counting
 *     this column gives a precise per-tenant LLM spend on this stage.
 *
 * No FK on pipeline_job_id — pipeline_jobs rows can be deleted by
 * reprocess; we want the reconciliation history to outlive that.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ai_address_reconciliations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('pipeline_job_id').notNullable();
    table.text('entered_address').notNullable();
    table.jsonb('geocoded').notNullable();
    table.jsonb('ai_suggestion').nullable();
    table.text('ai_reasoning').nullable();
    table.jsonb('reconciled').notNullable();

    // 'skipped' | 'auto_merged_high' | 'auto_merged_low' | 'flagged'
    table.string('decision', 30).notNullable();

    // 'unchanged' | 'normalized_regeocode' | 'ai_validated' | 'ai_unverified'
    table.string('source', 40).notNullable();

    table.decimal('confidence', 4, 3).notNullable().defaultTo(0);
    table.jsonb('missing_before').notNullable().defaultTo('[]');
    table.jsonb('missing_after').notNullable().defaultTo('[]');
    table.boolean('ai_used').notNullable().defaultTo(false);

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'created_at']);
    table.index(['pipeline_job_id']);
    table.index(['decision']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ai_address_reconciliations');
}
