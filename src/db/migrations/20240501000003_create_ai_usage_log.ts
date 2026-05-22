import { Knex } from 'knex';

/**
 * AI usage log — one row per LLM call.
 * Tracks tokens, cost, latency, model, agent, prompt version, and success/failure.
 * Enables: cost dashboards, per-tenant billing, prompt version comparison, anomaly detection.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ai_usage_log', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
    table.string('agent', 50).notNullable();              // data-extraction, caretaker-llm, intent-router, order-support, tenant-info
    table.string('model', 50).notNullable();              // gpt-4o-mini, gpt-4o, etc.
    table.integer('prompt_version').nullable();
    table.integer('prompt_tokens').notNullable().defaultTo(0);
    table.integer('completion_tokens').notNullable().defaultTo(0);
    table.integer('total_tokens').notNullable().defaultTo(0);
    table.decimal('cost_usd', 10, 6).notNullable().defaultTo(0);
    table.integer('latency_ms').notNullable().defaultTo(0);
    table.boolean('success').notNullable().defaultTo(true);
    table.boolean('cached').notNullable().defaultTo(false);  // from idempotency cache
    table.string('error', 512).nullable();
    table.jsonb('metadata').notNullable().defaultTo('{}');   // correlation_id, job_id, etc.
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'created_at']);
    table.index(['agent', 'created_at']);
    table.index(['model']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ai_usage_log');
}
