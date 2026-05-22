import { Knex } from 'knex';

/**
 * AI Caretaker tables.
 * The caretaker reviews each PUDO payload before COURIER_SUBMITTED runs.
 *  - caretaker_rules: per-tenant rule configuration (rate limits, address sanity, name/phone checks)
 *  - caretaker_evaluations: one row per pipeline_job evaluation, with verdict (approve | review | reject)
 *
 * Verdict semantics:
 *   approve - pipeline continues to COURIER_SUBMITTED automatically
 *   review  - pipeline pauses; human approves/rejects from dashboard
 *   reject  - pipeline halts and emits order.flagged event
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('caretaker_rules', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.boolean('enabled').notNullable().defaultTo(true);

    // Threshold rules (sensible defaults inserted by app code, not migration)
    table.decimal('max_rate_per_order', 10, 2).nullable();          // null = unlimited
    table.integer('max_distance_km').nullable();                    // null = no cap
    table.boolean('require_phone').notNullable().defaultTo(true);
    table.boolean('require_customer_name').notNullable().defaultTo(true);
    table.boolean('require_line_items').notNullable().defaultTo(true);
    table.boolean('block_duplicate_order_number').notNullable().defaultTo(true);
    table.boolean('block_repeat_phone_within_minutes').notNullable().defaultTo(false);
    table.integer('repeat_phone_window_minutes').notNullable().defaultTo(30);

    // Mode: shadow (log only), advisory (review on flag), strict (reject on flag)
    table.string('mode', 30).notNullable().defaultTo('advisory');

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id']);
  });

  await knex.schema.createTable('caretaker_evaluations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('pipeline_job_id').notNullable().references('id').inTable('pipeline_jobs').onDelete('CASCADE');
    table.uuid('order_id').nullable().references('id').inTable('orders').onDelete('SET NULL');
    table.string('verdict', 20).notNullable();          // approve | review | reject
    table.string('mode', 30).notNullable();             // shadow | advisory | strict (snapshot at evaluation time)
    table.jsonb('checks').notNullable().defaultTo('[]'); // [{ check: 'max_rate', passed: false, message: '...' }]
    table.jsonb('flags').notNullable().defaultTo('[]'); // ['high_rate', 'missing_phone']
    table.text('summary').nullable();
    table.string('resolved_by', 256).nullable();         // user email when manually approved/rejected
    table.string('resolution', 30).nullable();           // approved | rejected
    table.timestamp('resolved_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id']);
    table.index(['verdict']);
    table.index(['pipeline_job_id']);
  });

  // Track caretaker state on the pipeline job
  await knex.schema.alterTable('pipeline_jobs', (table) => {
    table.string('caretaker_verdict', 20).nullable();
    table.uuid('caretaker_evaluation_id').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('pipeline_jobs', (table) => {
    table.dropColumn('caretaker_evaluation_id');
    table.dropColumn('caretaker_verdict');
  });
  await knex.schema.dropTableIfExists('caretaker_evaluations');
  await knex.schema.dropTableIfExists('caretaker_rules');
}
