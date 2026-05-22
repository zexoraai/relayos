import { Knex } from 'knex';

/**
 * Chatbot tables.
 *  - chat_conversations: one per (tenant, customer_phone). Holds intent + state.
 *  - chat_messages: full message history (user + assistant + tool results) for each conversation.
 *  - tenant_knowledge_documents: tenant-supplied FAQ / policy docs that the Tenant Info Chatbot can answer from.
 *
 * Note: we deliberately do NOT use pgvector here yet — the corpus is small and the runtime is a single
 * tenant, so a simple keyword + LLM-rerank approach is sufficient and avoids the pgvector extension dependency.
 * The schema leaves room for embedding columns later.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('chat_conversations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('channel', 30).notNullable().defaultTo('whatsapp');
    table.string('customer_phone_normalized', 50).notNullable();
    table.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    table.string('current_intent', 50).nullable();    // order_support | tenant_info | small_talk | unknown
    table.string('status', 30).notNullable().defaultTo('open'); // open | closed | escalated
    table.timestamp('last_message_at').nullable();
    table.timestamp('escalated_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'channel', 'customer_phone_normalized']);
    table.index(['tenant_id', 'status']);
  });

  await knex.schema.createTable('chat_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('conversation_id').notNullable().references('id').inTable('chat_conversations').onDelete('CASCADE');
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('role', 20).notNullable();          // user | assistant | tool | system
    table.text('content').nullable();
    table.string('intent', 50).nullable();
    table.string('agent', 50).nullable();            // order_support | tenant_info | router
    table.jsonb('tool_calls').notNullable().defaultTo('[]');
    table.jsonb('tool_result').nullable();
    table.string('wa_message_id', 100).nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['conversation_id']);
    table.index(['tenant_id', 'created_at']);
  });

  await knex.schema.createTable('tenant_knowledge_documents', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('title', 256).notNullable();
    table.string('category', 50).nullable();         // faq | policy | shipping | returns | other
    table.text('body').notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'enabled']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tenant_knowledge_documents');
  await knex.schema.dropTableIfExists('chat_messages');
  await knex.schema.dropTableIfExists('chat_conversations');
}
