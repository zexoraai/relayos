import { Knex } from 'knex';

/**
 * Add embedding column to knowledge documents.
 * Stores the text-embedding-3-small vector as a JSON array of floats.
 * We use a simple JSON column (not pgvector) to avoid the extension dependency.
 * Cosine similarity is computed in application code — fast enough for <10K docs per tenant.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenant_knowledge_documents', (table) => {
    table.jsonb('embedding').nullable();
    table.boolean('embedding_dirty').notNullable().defaultTo(true); // needs re-embedding
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenant_knowledge_documents', (table) => {
    table.dropColumn('embedding_dirty');
    table.dropColumn('embedding');
  });
}
