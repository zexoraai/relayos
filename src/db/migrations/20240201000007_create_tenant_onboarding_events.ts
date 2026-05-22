import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenant_onboarding_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('event_type', 100).notNullable();
    table.jsonb('event_payload').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id']);
    table.index(['event_type']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tenant_onboarding_events');
}
