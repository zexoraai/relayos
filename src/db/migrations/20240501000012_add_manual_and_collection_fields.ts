import { Knex } from 'knex';

/**
 * Extends orders to support manual upload queue and collection queue.
 *
 * routing_status: how the order was routed
 *   - automatic: went through COURIER_SUBMITTED normally
 *   - manual_upload: needs human to upload to courier platform and provide waybill/pin
 *   - collection: customer picks up, no courier needed
 *
 * manual_upload_reason: why it was routed to manual (distance, caretaker, error, etc.)
 * collected_at / collected_by: when/who confirmed collection
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.string('routing_status', 30).notNullable().defaultTo('automatic');
    table.string('manual_upload_reason', 256).nullable();
    table.timestamp('manual_uploaded_at').nullable();
    table.uuid('manual_uploaded_by').nullable();
    table.timestamp('collected_at').nullable();
    table.uuid('collected_by').nullable();
    table.text('collection_note').nullable();

    table.index(['tenant_id', 'routing_status']);
  });

  // Backfill existing orders
  await knex.raw(`UPDATE orders SET routing_status = 'automatic' WHERE waybill IS NOT NULL AND routing_status = 'automatic'`);
  await knex.raw(`UPDATE orders SET routing_status = 'manual_upload' WHERE upload_type = 'manual' AND waybill IS NULL`);
  await knex.raw(`UPDATE orders SET routing_status = 'collection' WHERE collection_method = 'collection'`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.dropColumn('collection_note');
    table.dropColumn('collected_by');
    table.dropColumn('collected_at');
    table.dropColumn('manual_uploaded_by');
    table.dropColumn('manual_uploaded_at');
    table.dropColumn('manual_upload_reason');
    table.dropColumn('routing_status');
  });
}
