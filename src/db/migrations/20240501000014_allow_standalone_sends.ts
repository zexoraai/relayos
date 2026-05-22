import { Knex } from 'knex';

/**
 * Allow marketing_sends to have null campaign_id and step_id
 * so we can use the same table for standalone scheduled sends
 * (like delivery follow-ups) without requiring a campaign.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('marketing_sends', (table) => {
    table.uuid('campaign_id').nullable().alter();
    table.uuid('step_id').nullable().alter();
    table.jsonb('metadata').notNullable().defaultTo('{}');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Can't easily revert nullable to not-null with data
}
