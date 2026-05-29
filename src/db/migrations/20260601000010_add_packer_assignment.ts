import type { Knex } from 'knex';

/**
 * Phase 4: order assignment + collection-address override for independent packers.
 *
 * Two columns:
 *   orders.assigned_packer_id (uuid nullable, FK packers.id ON DELETE SET NULL)
 *     The independent packer this order is dispatched to. Stamped by the
 *     pipeline's PAYLOAD_CREATED stage when the tenant has packer
 *     assignment enabled. Null means "no independent packer — use the
 *     tenant's own collection address as before."
 *
 *   tenant_collection_settings.packer_assignment_mode (text not-null default 'off')
 *     Controls who picks up the order:
 *       'off'              - never assign to an independent packer (default,
 *                            keeps existing tenants on their current
 *                            behaviour after this migration runs).
 *       'independents_only'- always weighted-round-robin to a linked
 *                            independent packer; if no packer is available
 *                            fall back to the tenant's own collection
 *                            address (so the order doesn't get stuck).
 *       'split_evenly'     - reserved for future tie-breaking with
 *                            internal packing teams. Currently behaves the
 *                            same as 'independents_only'.
 *       'internal_first'   - reserved. Currently behaves the same as 'off'
 *                            until an internal-team weighting policy
 *                            exists.
 *
 * Idempotent — checks before adding so a re-run is a no-op.
 */
export async function up(knex: Knex): Promise<void> {
  const ordersHas = await knex.schema.hasColumn('orders', 'assigned_packer_id');
  if (!ordersHas) {
    await knex.schema.alterTable('orders', (table) => {
      table
        .uuid('assigned_packer_id')
        .nullable()
        .references('id')
        .inTable('packers')
        .onDelete('SET NULL');
      table.index(['assigned_packer_id'], 'orders_assigned_packer_id_idx');
    });
  }

  const settingsHas = await knex.schema.hasColumn(
    'tenant_collection_settings',
    'packer_assignment_mode',
  );
  if (!settingsHas) {
    await knex.schema.alterTable('tenant_collection_settings', (table) => {
      table.string('packer_assignment_mode', 30).notNullable().defaultTo('off');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const settingsHas = await knex.schema.hasColumn(
    'tenant_collection_settings',
    'packer_assignment_mode',
  );
  if (settingsHas) {
    await knex.schema.alterTable('tenant_collection_settings', (table) => {
      table.dropColumn('packer_assignment_mode');
    });
  }

  const ordersHas = await knex.schema.hasColumn('orders', 'assigned_packer_id');
  if (ordersHas) {
    await knex.schema.alterTable('orders', (table) => {
      table.dropIndex(['assigned_packer_id'], 'orders_assigned_packer_id_idx');
      table.dropColumn('assigned_packer_id');
    });
  }
}
