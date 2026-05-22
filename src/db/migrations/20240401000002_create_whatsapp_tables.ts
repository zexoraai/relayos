import { Knex } from 'knex';

/**
 * WhatsApp Cloud API integration tables.
 *  - whatsapp_settings: per-tenant credentials (phone_number_id, encrypted access token, business id)
 *  - whatsapp_templates: per-tenant message templates keyed by purpose (order_confirmed, order_in_transit, etc.)
 *  - whatsapp_messages: outbound message log + inbound replies for chatbot routing
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('whatsapp_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('phone_number_id', 100).notNullable();
    table.string('business_account_id', 100).nullable();
    table.string('display_phone_number', 50).nullable();
    table.text('encrypted_access_token').notNullable();
    table.string('verify_token', 100).nullable();   // for webhook subscription
    table.boolean('enabled').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id']);
  });

  await knex.schema.createTable('whatsapp_templates', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('purpose', 100).notNullable();          // order_confirmed | order_in_transit | order_delivered | order_flagged
    table.string('template_name', 100).nullable();        // when using approved Meta template
    table.string('language_code', 20).notNullable().defaultTo('en');
    table.text('body_text').notNullable();                // free-text fallback / template body with {{1}} placeholders
    table.jsonb('variables').notNullable().defaultTo('[]'); // ["customer_name", "order_number", "waybill"]
    table.boolean('enabled').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'purpose']);
    table.index(['tenant_id']);
  });

  await knex.schema.createTable('whatsapp_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('direction', 20).notNullable();          // outbound | inbound
    table.string('phone_to', 50).notNullable();
    table.string('phone_from', 50).nullable();
    table.string('purpose', 100).nullable();              // matches template purpose for outbound
    table.text('body').notNullable();
    table.string('wa_message_id', 100).nullable();        // ID returned by Meta
    table.string('status', 30).notNullable().defaultTo('queued'); // queued | sent | delivered | read | failed | received
    table.uuid('order_id').nullable().references('id').inTable('orders').onDelete('SET NULL');
    table.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    table.uuid('domain_event_id').nullable().references('id').inTable('domain_events').onDelete('SET NULL');
    table.text('last_error').nullable();
    table.jsonb('meta').notNullable().defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'direction']);
    table.index(['phone_to']);
    table.index(['status']);
    table.index(['order_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('whatsapp_messages');
  await knex.schema.dropTableIfExists('whatsapp_templates');
  await knex.schema.dropTableIfExists('whatsapp_settings');
}
