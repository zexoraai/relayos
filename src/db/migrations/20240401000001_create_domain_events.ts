import { Knex } from 'knex';

/**
 * Domain events table - the canonical record of "things that happened"
 * across the system. Subscribers (WhatsApp dispatcher, future webhooks)
 * read from here.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('domain_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('event_type', 100).notNullable();           // e.g. order.confirmed, order.in_transit
    table.string('aggregate_type', 50).notNullable();         // order, customer, fulfillment_job
    table.uuid('aggregate_id').notNullable();                 // FK target id (order id, customer id, etc.)
    table.string('correlation_id', 100).nullable();
    table.jsonb('payload').notNullable().defaultTo('{}');
    table.string('status', 30).notNullable().defaultTo('pending'); // pending | dispatched | failed
    table.integer('dispatch_attempts').notNullable().defaultTo(0);
    table.text('last_error').nullable();
    table.timestamp('dispatched_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'event_type']);
    table.index(['aggregate_type', 'aggregate_id']);
    table.index(['status', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('domain_events');
}
