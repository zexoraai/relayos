import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Fulfillment jobs - one per order being tracked
  await knex.schema.createTable('fulfillment_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');
    table.string('waybill', 100).notNullable();
    table.string('current_stage', 100).notNullable().defaultTo('TRACKING_FETCHED');
    table.string('status', 50).notNullable().defaultTo('active');
    table.string('courier_status', 100).nullable();
    table.string('milestone', 100).nullable();
    table.integer('poll_count').notNullable().defaultTo(0);
    table.timestamp('last_polled_at').nullable();
    table.timestamp('next_poll_at').nullable();
    table.timestamp('completed_at').nullable();
    table.text('last_error').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['order_id']);
    table.index(['tenant_id']);
    table.index(['waybill']);
    table.index(['status']);
    table.index(['next_poll_at']);
  });

  // Stage results - audit trail for each stage execution
  await knex.schema.createTable('fulfillment_stage_results', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('fulfillment_job_id').notNullable().references('id').inTable('fulfillment_jobs').onDelete('CASCADE');
    table.string('stage', 100).notNullable();
    table.string('status', 50).notNullable();
    table.jsonb('output_data').nullable();
    table.text('error_message').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['fulfillment_job_id']);
    table.index(['stage']);
  });

  // Tracking events - all events from the courier API per order
  await knex.schema.createTable('fulfillment_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('fulfillment_job_id').notNullable().references('id').inTable('fulfillment_jobs').onDelete('CASCADE');
    table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');
    table.string('event_id', 100).nullable();
    table.string('status', 100).notNullable();
    table.text('message').nullable();
    table.string('source', 100).nullable();
    table.string('location', 256).nullable();
    table.timestamp('event_date').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['fulfillment_job_id', 'event_id']);
    table.index(['order_id']);
    table.index(['status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('fulfillment_events');
  await knex.schema.dropTableIfExists('fulfillment_stage_results');
  await knex.schema.dropTableIfExists('fulfillment_jobs');
}
