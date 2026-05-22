import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenants', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email', 512).notNullable().unique();
    table.text('password_hash').notNullable();
    table.string('status', 50).notNullable().defaultTo('pending_onboarding');
    table.string('onboarding_step', 100).notNullable().defaultTo('account_created');
    table.timestamp('onboarding_completed_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['status']);
    table.index(['email']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tenants');
}
