import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.string('shopify_order_id', 100).nullable();
    table.string('shopify_fulfillment_id', 100).nullable();
    table.string('shopify_fulfillment_order_id', 100).nullable();
    table.boolean('shopify_fulfilled').notNullable().defaultTo(false);
    table.timestamp('shopify_fulfilled_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.dropColumn('shopify_order_id');
    table.dropColumn('shopify_fulfillment_id');
    table.dropColumn('shopify_fulfillment_order_id');
    table.dropColumn('shopify_fulfilled');
    table.dropColumn('shopify_fulfilled_at');
  });
}
