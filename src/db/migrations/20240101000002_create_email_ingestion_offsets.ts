import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_ingestion_offsets', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('mailbox_id').notNullable().references('id').inTable('mailboxes').onDelete('CASCADE');
    table.bigInteger('last_uid').notNullable().defaultTo(0);
    table.bigInteger('uid_validity').nullable();
    table.timestamp('last_poll_at').nullable();
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['mailbox_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('email_ingestion_offsets');
}
