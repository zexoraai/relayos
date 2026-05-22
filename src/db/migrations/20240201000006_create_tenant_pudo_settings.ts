import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenant_pudo_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('courier_integration_id').notNullable().references('id').inTable('tenant_courier_integrations').onDelete('CASCADE');
    table.string('pudo_username', 256).notNullable();
    table.text('encrypted_pudo_password').notNullable();
    table.text('encrypted_pudo_api_key').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id']);
    table.unique(['tenant_id', 'courier_integration_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tenant_pudo_settings');
}
