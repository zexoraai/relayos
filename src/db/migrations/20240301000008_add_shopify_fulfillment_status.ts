import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.string('shopify_fulfillment_status', 50).nullable(); // null, partial, fulfilled
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.dropColumn('shopify_fulfillment_status');
  });
}
