import type { Knex } from 'knex';

/**
 * Add `collection_point_type` to `packers`.
 *
 *   'locker' — the packer always drops at a PUDO locker; the door
 *              address is hidden in the UI and not used by the
 *              assigner. The terminal_id is the canonical pickup
 *              point.
 *   'door'   — the packer hands every parcel over at a fixed door
 *              address; the terminal_id is hidden and ignored.
 *   'both'   — accept either form. The assigner picks whichever
 *              field is set, matching previous behaviour.
 *
 * Default is 'both' so existing packers keep working without any
 * migration of their data.
 *
 * Idempotent — guarded by hasColumn so a re-run is a no-op.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('packers', 'collection_point_type');
  if (!has) {
    await knex.schema.alterTable('packers', (table) => {
      table.string('collection_point_type', 16).notNullable().defaultTo('both');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('packers', 'collection_point_type');
  if (has) {
    await knex.schema.alterTable('packers', (table) => {
      table.dropColumn('collection_point_type');
    });
  }
}
