import { Knex } from 'knex';

/**
 * Packing workflow:
 *   awaiting_packing → packed → dropped_off
 *
 * Tracked separately from courier_status so packers have their own queue and the
 * pipeline / fulfillment workflows are unaffected. Existing orders default to
 * 'awaiting_packing' so the queue immediately shows everything that needs attention.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.string('packing_status', 30).notNullable().defaultTo('awaiting_packing');
    table.timestamp('packed_at').nullable();
    table.uuid('packed_by').nullable();
    table.timestamp('dropped_off_at').nullable();
    table.uuid('dropped_off_by').nullable();
    table.text('packing_note').nullable();

    table.index(['tenant_id', 'packing_status']);
  });

  // Backfill — already-cancelled or already-delivered orders skip the queue
  await knex.raw(`
    UPDATE orders SET packing_status = 'dropped_off',
      dropped_off_at = COALESCE(dropped_off_at, updated_at)
    WHERE status IN ('delivered', 'collected', 'in_transit', 'at_locker', 'out_for_delivery')
  `);
  await knex.raw(`UPDATE orders SET packing_status = 'cancelled' WHERE status = 'cancelled'`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.dropColumn('packing_note');
    table.dropColumn('dropped_off_by');
    table.dropColumn('dropped_off_at');
    table.dropColumn('packed_by');
    table.dropColumn('packed_at');
    table.dropColumn('packing_status');
  });
}
