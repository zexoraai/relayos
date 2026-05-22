import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_attachments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('email_id').notNullable().references('id').inTable('ingested_emails').onDelete('CASCADE');
    table.string('filename', 512).nullable();
    table.string('filename_sanitized', 512).nullable();
    table.string('content_type', 256).nullable();
    table.bigInteger('size_bytes').nullable();
    table.string('checksum_sha256', 128).nullable();
    table.string('storage_key', 1024).nullable();
    table.string('status', 50).notNullable().defaultTo('pending');
    table.text('error_message').nullable();
    table.boolean('virus_scan_passed').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['email_id']);
    table.index(['checksum_sha256']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('email_attachments');
}
