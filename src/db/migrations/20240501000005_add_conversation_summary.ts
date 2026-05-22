import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('chat_conversations', (table) => {
    table.text('summary').nullable();
    table.timestamp('summary_covers_until').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('chat_conversations', (table) => {
    table.dropColumn('summary_covers_until');
    table.dropColumn('summary');
  });
}
