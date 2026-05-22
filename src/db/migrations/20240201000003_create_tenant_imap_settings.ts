import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenant_imap_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('ecommerce_integration_id').notNullable().references('id').inTable('tenant_ecommerce_integrations').onDelete('CASCADE');
    table.string('imap_host', 512).notNullable();
    table.integer('imap_port').notNullable().defaultTo(993);
    table.string('imap_username', 512).notNullable();
    table.text('encrypted_imap_password').notNullable();
    table.string('imap_mailbox', 256).notNullable().defaultTo('INBOX');
    table.boolean('imap_use_ssl').notNullable().defaultTo(true);
    table.integer('polling_interval').notNullable().defaultTo(30000);
    table.integer('batch_size').notNullable().defaultTo(50);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id']);
    table.unique(['tenant_id', 'ecommerce_integration_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tenant_imap_settings');
}
