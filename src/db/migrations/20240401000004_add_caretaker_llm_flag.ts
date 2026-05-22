import { Knex } from 'knex';

/**
 * Adds a per-tenant toggle for the LLM caretaker pass.
 * When enabled, an OpenAI reasoning step runs after the rules check
 * and may escalate (but never relax) the verdict.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('caretaker_rules', (table) => {
    table.boolean('llm_enabled').notNullable().defaultTo(false);
  });

  await knex.schema.alterTable('caretaker_evaluations', (table) => {
    table.boolean('llm_ran').notNullable().defaultTo(false);
    table.string('llm_verdict', 20).nullable();
    table.decimal('llm_confidence', 4, 3).nullable();
    table.jsonb('llm_reasons').notNullable().defaultTo('[]');
    table.jsonb('llm_flags').notNullable().defaultTo('[]');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('caretaker_evaluations', (table) => {
    table.dropColumn('llm_flags');
    table.dropColumn('llm_reasons');
    table.dropColumn('llm_confidence');
    table.dropColumn('llm_verdict');
    table.dropColumn('llm_ran');
  });
  await knex.schema.alterTable('caretaker_rules', (table) => {
    table.dropColumn('llm_enabled');
  });
}
