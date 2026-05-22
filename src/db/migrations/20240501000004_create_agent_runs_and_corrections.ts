import { Knex } from 'knex';

/**
 * Agent run replay + corrections (few-shot retraining).
 *
 * agent_runs: Full snapshot of every LLM call — messages in, response out, tool calls, metadata.
 *             Enables "replay" in the dashboard: see exactly what the model saw and produced.
 *
 * agent_corrections: When a human reviews a run and says "this was wrong, here's the correct output",
 *                    we store the correction. Future calls for the same agent inject the N most recent
 *                    corrections as few-shot examples in the system prompt, teaching the model
 *                    the tenant's preferences without fine-tuning.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('agent_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
    table.string('agent', 50).notNullable();
    table.string('model', 50).notNullable();
    table.integer('prompt_version').nullable();
    table.jsonb('messages_in').notNullable();          // full message array sent to the model
    table.jsonb('response_out').notNullable();         // model's response (content + tool_calls)
    table.jsonb('tool_calls').notNullable().defaultTo('[]');
    table.jsonb('tool_results').notNullable().defaultTo('[]');
    table.string('finish_reason', 30).nullable();
    table.integer('prompt_tokens').notNullable().defaultTo(0);
    table.integer('completion_tokens').notNullable().defaultTo(0);
    table.decimal('cost_usd', 10, 6).notNullable().defaultTo(0);
    table.integer('latency_ms').notNullable().defaultTo(0);
    table.boolean('success').notNullable().defaultTo(true);
    table.string('error', 512).nullable();
    table.string('status', 20).notNullable().defaultTo('unreviewed'); // unreviewed | approved | corrected
    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'agent', 'created_at']);
    table.index(['agent', 'status']);
  });

  await knex.schema.createTable('agent_corrections', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
    table.uuid('run_id').notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
    table.string('agent', 50).notNullable();
    table.text('original_input').notNullable();         // the user message / email that triggered the run
    table.text('original_output').notNullable();        // what the model produced
    table.text('corrected_output').notNullable();       // what the human says it SHOULD have produced
    table.text('correction_note').nullable();           // optional explanation
    table.boolean('active').notNullable().defaultTo(true); // can be disabled without deleting
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['agent', 'active', 'created_at']);
    table.index(['tenant_id', 'agent']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('agent_corrections');
  await knex.schema.dropTableIfExists('agent_runs');
}
