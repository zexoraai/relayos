import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('orders', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('email_id').nullable().references('id').inTable('ingested_emails').onDelete('SET NULL');
    table.uuid('pipeline_job_id').nullable().references('id').inTable('pipeline_jobs').onDelete('SET NULL');
    table.string('order_number', 100).notNullable();
    table.string('customer_name', 512).nullable();
    table.string('customer_phone', 50).nullable();
    table.string('delivery_method', 50).nullable();
    table.jsonb('delivery_address').nullable();
    table.jsonb('line_items').nullable();
    table.text('raw_shipping_address').nullable();
    table.string('terminal_id', 50).nullable();
    table.string('nearest_locker_name', 256).nullable();
    table.float('distance_km').nullable();
    table.string('status', 50).notNullable().defaultTo('created');
    table.jsonb('courier_payload').nullable();
    table.string('courier_tracking_reference', 256).nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id']);
    table.index(['order_number']);
    table.index(['status']);
    table.unique(['tenant_id', 'order_number']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('orders');
}
