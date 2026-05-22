import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ingested_emails', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('mailbox_id').notNullable().references('id').inTable('mailboxes').onDelete('CASCADE');
    table.bigInteger('uid').notNullable();
    table.string('message_id', 512).nullable();
    table.string('dedup_key', 512).notNullable();
    table.string('content_hash', 128).nullable();
    table.string('sender', 512).nullable();
    table.string('sender_normalized', 512).nullable();
    table.text('recipients').nullable();
    table.text('cc').nullable();
    table.text('bcc').nullable();
    table.string('subject', 1024).nullable();
    table.string('subject_normalized', 1024).nullable();
    table.timestamp('email_date').nullable();
    table.text('body_text').nullable();
    table.text('body_html').nullable();
    table.jsonb('headers_json').nullable();
    table.text('raw_source').nullable();
    table.string('status', 50).notNullable().defaultTo('fetched');
    table.integer('retry_count').notNullable().defaultTo(0);
    table.text('last_error').nullable();
    table.string('correlation_id', 128).nullable();
    table.timestamp('fetched_at').nullable();
    table.timestamp('queued_at').nullable();
    table.timestamp('processing_at').nullable();
    table.timestamp('processed_at').nullable();
    table.timestamp('failed_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['dedup_key']);
    table.index(['mailbox_id', 'uid']);
    table.index(['status']);
    table.index(['message_id']);
    table.index(['content_hash']);
    table.index(['correlation_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ingested_emails');
}
