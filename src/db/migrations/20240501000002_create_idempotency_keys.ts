import { Knex } from 'knex';

/**
 * Idempotency cache for outbound side-effects (PUDO shipments, Shopify fulfillments).
 *
 * Keyed by a deterministic string of the form:
 *   {action_type}:{tenant_id}:{business_key}
 *
 * The unique constraint on `key` is the lock — concurrent attempts to insert
 * the same key fail, forcing the second caller to read the cached result.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('idempotency_keys', (table) => {
    table.string('key', 256).primary();
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('action_type', 50).notNullable();        // pudo_shipment | shopify_fulfillment | etc.
    table.string('business_key', 200).notNullable();       // order_number, shopify_order_id, etc.
    table.string('status', 20).notNullable();              // in_progress | completed | failed
    table.jsonb('response').nullable();                    // cached upstream response
    table.integer('http_status').nullable();
    table.text('error').nullable();
    table.integer('attempt_count').notNullable().defaultTo(1);
    table.timestamp('expires_at').nullable();              // when the cached response stops being authoritative
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'action_type']);
    table.index(['expires_at']);
    table.index(['status', 'updated_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('idempotency_keys');
}
