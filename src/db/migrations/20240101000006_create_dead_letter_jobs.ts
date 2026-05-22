import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('dead_letter_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('email_id').notNullable().references('id').inTable('ingested_emails').onDelete('CASCADE');
    table.uuid('mailbox_id').notNullable().references('id').inTable('mailboxes').onDelete('CASCADE');
    table.string('original_queue', 256).notNullable();
    table.jsonb('job_data').nullable();
    table.text('final_error').nullable();
    table.string('final_error_type', 100).nullable();
    table.integer('total_attempts').notNullable().defaultTo(0);
    table.timestamp('first_attempted_at').nullable();
    table.timestamp('dead_lettered_at').notNullable().defaultTo(knex.fn.now());

    table.index(['email_id']);
    table.index(['mailbox_id']);
    table.index(['dead_lettered_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('dead_letter_jobs');
}
