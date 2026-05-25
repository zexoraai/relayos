import { Knex } from 'knex';

/**
 * Adds `collection_address` (jsonb) to `tenant_collection_settings`.
 *
 * For door collection methods (door-to-locker, door-to-door) the PUDO payload
 * needs a full street address on the collection side, in the same shape PUDO
 * expects on `delivery_address` for door services:
 *   {
 *     lat, lng,
 *     street_address, local_area, suburb, city, code, zone, country,
 *     type: 'business' | 'residential'
 *   }
 *
 * Locker methods (locker-to-door, locker-to-locker) keep using the existing
 * `collection_terminal_id` column. The new column is optional and only
 * referenced when the order's `delivery_method` starts with `door-`.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenant_collection_settings', (table) => {
    table.jsonb('collection_address').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenant_collection_settings', (table) => {
    table.dropColumn('collection_address');
  });
}
