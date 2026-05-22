import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('chatbot_settings', (table) => {
    table.jsonb('distilled_rules').nullable(); // { "order_support": { rules: "...", correction_count: N } }
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('chatbot_settings', (table) => {
    table.dropColumn('distilled_rules');
  });
}
