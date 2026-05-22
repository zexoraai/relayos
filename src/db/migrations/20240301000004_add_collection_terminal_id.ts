import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenant_collection_settings', (table) => {
    table.string('collection_terminal_id', 50).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenant_collection_settings', (table) => {
    table.dropColumn('collection_terminal_id');
  });
}
