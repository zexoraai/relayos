import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.string('waybill', 100).nullable();
    table.string('pincode', 20).nullable();
    table.string('collection_terminal_id', 50).nullable();
    table.jsonb('courier_response').nullable();
    table.float('rate').nullable();
    table.string('service_level_code', 50).nullable();
    table.string('service_level_name', 256).nullable();
    table.timestamp('estimated_collection').nullable();
    table.timestamp('estimated_delivery_from').nullable();
    table.timestamp('estimated_delivery_to').nullable();
    table.string('courier_status', 50).nullable();
    table.string('upload_type', 50).nullable();
    table.string('collection_method', 50).nullable();
    table.jsonb('line_items_enriched').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.dropColumn('waybill');
    table.dropColumn('pincode');
    table.dropColumn('collection_terminal_id');
    table.dropColumn('courier_response');
    table.dropColumn('rate');
    table.dropColumn('service_level_code');
    table.dropColumn('service_level_name');
    table.dropColumn('estimated_collection');
    table.dropColumn('estimated_delivery_from');
    table.dropColumn('estimated_delivery_to');
    table.dropColumn('courier_status');
    table.dropColumn('upload_type');
    table.dropColumn('collection_method');
    table.dropColumn('line_items_enriched');
  });
}
