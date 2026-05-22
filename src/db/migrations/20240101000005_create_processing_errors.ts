import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('processing_errors', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('email_id').notNullable().references('id').inTable('ingested_emails').onDelete('CASCADE');
    table.string('error_type', 100).notNullable();
    table.text('error_message').notNullable();
    table.text('stack_trace').nullable();
    table.jsonb('context_json').nullable();
    table.integer('attempt_number').notNullable().defaultTo(1);
    table.timestamp('occurred_at').notNullable().defaultTo(knex.fn.now());

    table.index(['email_id']);
    table.index(['error_type']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('processing_errors');
}
