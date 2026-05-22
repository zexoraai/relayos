import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenant_shopify_api_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('ecommerce_integration_id').notNullable().references('id').inTable('tenant_ecommerce_integrations').onDelete('CASCADE');
    table.string('shopify_store', 512).notNullable();
    table.text('encrypted_access_token').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id']);
    table.unique(['tenant_id', 'ecommerce_integration_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tenant_shopify_api_settings');
}
