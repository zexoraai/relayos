import { Knex } from 'knex';

/**
 * Feedback on individual chat messages.
 * Thumbs up/down + optional correction text.
 * Used to:
 *   1. Track quality (% positive vs negative)
 *   2. Feed corrections into the few-shot system (agent_corrections)
 *   3. Future: fine-tuning dataset generation
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('chat_messages', (table) => {
    table.string('feedback', 10).nullable();          // 'up' | 'down' | null
    table.text('feedback_correction').nullable();      // what the AI should have said
    table.uuid('feedback_by').nullable();              // user who gave feedback
    table.timestamp('feedback_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('chat_messages', (table) => {
    table.dropColumn('feedback_at');
    table.dropColumn('feedback_by');
    table.dropColumn('feedback_correction');
    table.dropColumn('feedback');
  });
}
