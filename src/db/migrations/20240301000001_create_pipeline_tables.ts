import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Pipeline jobs - one per email entering the order pipeline
  await knex.schema.createTable('pipeline_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('email_id').notNullable().references('id').inTable('ingested_emails').onDelete('CASCADE');
    table.uuid('mailbox_id').notNullable();
    table.string('current_stage', 100).notNullable().defaultTo('EMAIL_RECEIVED');
    table.string('status', 50).notNullable().defaultTo('pending');
    table.string('correlation_id', 128).nullable();
    table.text('last_error').nullable();
    table.integer('retry_count').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id']);
    table.index(['email_id']);
    table.index(['status']);
    table.index(['current_stage']);
    table.unique(['email_id', 'tenant_id']);
  });

  // Stage results - audit trail for each stage execution
  await knex.schema.createTable('pipeline_stage_results', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('pipeline_job_id').notNullable().references('id').inTable('pipeline_jobs').onDelete('CASCADE');
    table.string('stage', 100).notNullable();
    table.string('status', 50).notNullable();
    table.jsonb('input_data').nullable();
    table.jsonb('output_data').nullable();
    table.text('error_message').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['pipeline_job_id']);
    table.index(['stage']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('pipeline_stage_results');
  await knex.schema.dropTableIfExists('pipeline_jobs');
}
