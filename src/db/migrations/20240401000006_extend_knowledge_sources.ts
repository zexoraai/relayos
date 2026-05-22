import { Knex } from 'knex';

/**
 * Extends knowledge base to be more like Zipchat: each "source" can be a URL crawl,
 * a sitemap import, an uploaded file, or a Shopify product sync. Each source produces
 * one or more documents (1 per page / product / chunk).
 *
 *  - tenant_knowledge_sources: top-level "thing the tenant added" with sync state
 *  - tenant_knowledge_documents: gets source_id, source_url, source_title, content_hash, last_synced_at
 *
 * The chatbot already reads tenant_knowledge_documents — so retrieval doesn't need to change.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenant_knowledge_sources', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('source_type', 30).notNullable();   // url | sitemap | upload | shopify_products | manual
    table.string('label', 256).notNullable();         // display name
    table.text('source_url').nullable();              // for url / sitemap
    table.string('file_name', 256).nullable();        // for upload
    table.string('file_mime', 100).nullable();
    table.integer('file_size_bytes').nullable();
    table.integer('document_count').notNullable().defaultTo(0);
    table.string('status', 30).notNullable().defaultTo('pending'); // pending | syncing | completed | failed
    table.text('last_error').nullable();
    table.timestamp('last_synced_at').nullable();
    table.boolean('auto_resync').notNullable().defaultTo(false);
    table.jsonb('config').notNullable().defaultTo('{}'); // crawler depth, allowed paths, etc.
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'source_type']);
    table.index(['status']);
  });

  await knex.schema.alterTable('tenant_knowledge_documents', (table) => {
    table.uuid('source_id').nullable().references('id').inTable('tenant_knowledge_sources').onDelete('CASCADE');
    table.string('source_url', 1024).nullable();
    table.string('content_hash', 64).nullable();
    table.timestamp('last_synced_at').nullable();
    table.integer('chunk_index').notNullable().defaultTo(0); // for multi-chunk documents
    table.index(['source_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenant_knowledge_documents', (table) => {
    table.dropColumn('chunk_index');
    table.dropColumn('last_synced_at');
    table.dropColumn('content_hash');
    table.dropColumn('source_url');
    table.dropColumn('source_id');
  });
  await knex.schema.dropTableIfExists('tenant_knowledge_sources');
}
