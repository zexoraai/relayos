import { Knex } from 'knex';

/**
 * Extends WhatsApp templates so users can:
 *   - Map templates to one or more domain events (event_types array)
 *   - Submit templates to Meta for approval (meta_status lifecycle)
 *   - Define rich template content (header, footer, buttons)
 *
 * Adds `whatsapp_business_settings` table to store the Business Account ID
 * and System User token (separate from Cloud API token, needed for template management).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('whatsapp_templates', (table) => {
    // Event mapping - which domain events trigger this template
    table.jsonb('event_types').notNullable().defaultTo('[]');

    // Meta template lifecycle
    table.string('meta_category', 30).nullable();          // UTILITY, MARKETING, AUTHENTICATION
    table.string('meta_template_id', 100).nullable();       // ID returned by Meta after creation
    table.string('meta_status', 30).notNullable().defaultTo('DRAFT'); // DRAFT, PENDING, APPROVED, REJECTED, PAUSED, DISABLED
    table.string('meta_quality_score', 20).nullable();      // GREEN, YELLOW, RED
    table.text('meta_rejection_reason').nullable();
    table.timestamp('meta_submitted_at').nullable();
    table.timestamp('meta_approved_at').nullable();
    table.timestamp('meta_last_synced_at').nullable();

    // Rich content
    table.text('header_text').nullable();
    table.text('footer_text').nullable();
    table.jsonb('buttons').notNullable().defaultTo('[]');   // [{ type: 'URL'|'PHONE_NUMBER'|'QUICK_REPLY', text, url, phone_number }]
    table.jsonb('sample_values').notNullable().defaultTo('[]'); // sample values for each variable (Meta requires these)
  });

  // Backfill: derive event_types from existing purpose values for backwards compatibility
  await knex.raw(`
    UPDATE whatsapp_templates SET event_types = '["order.confirmed"]'::jsonb       WHERE purpose = 'order_confirmed';
    UPDATE whatsapp_templates SET event_types = '["order.in_transit"]'::jsonb      WHERE purpose = 'order_in_transit';
    UPDATE whatsapp_templates SET event_types = '["order.at_locker"]'::jsonb       WHERE purpose = 'order_at_locker';
    UPDATE whatsapp_templates SET event_types = '["order.out_for_delivery"]'::jsonb WHERE purpose = 'order_out_for_delivery';
    UPDATE whatsapp_templates SET event_types = '["order.delivered"]'::jsonb       WHERE purpose = 'order_delivered';
    UPDATE whatsapp_templates SET event_types = '["order.flagged"]'::jsonb         WHERE purpose = 'order_flagged';
  `);

  // Business Account credentials (separate from Cloud API access token)
  await knex.schema.createTable('whatsapp_business_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('business_account_id', 100).notNullable();
    table.text('encrypted_system_user_token').notNullable();  // for template management API
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('whatsapp_business_settings');
  await knex.schema.alterTable('whatsapp_templates', (table) => {
    table.dropColumn('sample_values');
    table.dropColumn('buttons');
    table.dropColumn('footer_text');
    table.dropColumn('header_text');
    table.dropColumn('meta_last_synced_at');
    table.dropColumn('meta_approved_at');
    table.dropColumn('meta_submitted_at');
    table.dropColumn('meta_rejection_reason');
    table.dropColumn('meta_quality_score');
    table.dropColumn('meta_status');
    table.dropColumn('meta_template_id');
    table.dropColumn('meta_category');
    table.dropColumn('event_types');
  });
}
