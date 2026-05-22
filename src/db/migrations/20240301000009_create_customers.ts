import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('customers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('phone', 50).notNullable();
    table.string('phone_normalized', 50).notNullable();
    table.string('name', 256).nullable();
    table.string('email', 256).nullable();
    table.integer('order_count').notNullable().defaultTo(0);
    table.timestamp('first_order_at').nullable();
    table.timestamp('last_order_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'phone_normalized']);
    table.index(['tenant_id']);
    table.index(['phone_normalized']);
  });

  // Add customer_id to orders
  await knex.schema.alterTable('orders', (table) => {
    table.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    table.index(['customer_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.dropColumn('customer_id');
  });
  await knex.schema.dropTableIfExists('customers');
}
