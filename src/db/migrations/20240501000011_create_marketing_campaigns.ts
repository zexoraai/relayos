import { Knex } from 'knex';

/**
 * Marketing automation: campaigns + steps + execution log.
 *
 * campaign_types:
 *   - win_back: triggers when customer.last_order_at is older than X days
 *   - abandoned_cart: triggers when a Shopify checkout is created but no order follows within X hours
 *
 * Each campaign has ordered steps, each step fires a WhatsApp template after a delay.
 * A worker polls daily (or hourly for abandoned carts) and enqueues eligible sends.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('marketing_campaigns', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('name', 256).notNullable();
    table.string('campaign_type', 30).notNullable();     // win_back | abandoned_cart
    table.boolean('enabled').notNullable().defaultTo(true);
    table.text('description').nullable();

    // Win-back config
    table.integer('inactivity_days_trigger').nullable();  // e.g. 21 — first step fires after 21 days of no purchase

    // Abandoned cart config
    table.integer('abandon_hours_trigger').nullable();    // e.g. 1 — first step fires 1 hour after checkout with no order

    // Limits
    table.integer('max_sends_per_customer').notNullable().defaultTo(3);  // don't spam
    table.integer('cooldown_days').notNullable().defaultTo(30);          // don't re-enter same customer for 30 days

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'campaign_type', 'enabled']);
  });

  await knex.schema.createTable('marketing_campaign_steps', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('campaign_id').notNullable().references('id').inTable('marketing_campaigns').onDelete('CASCADE');
    table.integer('step_order').notNullable();            // 1, 2, 3...
    table.integer('delay_days').notNullable();            // days after trigger (or after previous step)
    table.integer('delay_hours').notNullable().defaultTo(0); // for abandoned cart (hours precision)
    table.string('whatsapp_template_purpose', 100).nullable(); // links to whatsapp_templates.purpose
    table.text('message_body').nullable();                // fallback free-text if no template
    table.boolean('enabled').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['campaign_id', 'step_order']);
    table.index(['campaign_id']);
  });

  await knex.schema.createTable('marketing_sends', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('campaign_id').notNullable().references('id').inTable('marketing_campaigns').onDelete('CASCADE');
    table.uuid('step_id').notNullable().references('id').inTable('marketing_campaign_steps').onDelete('CASCADE');
    table.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    table.string('phone', 50).notNullable();
    table.string('status', 20).notNullable().defaultTo('pending'); // pending | sent | failed | skipped
    table.timestamp('scheduled_at').notNullable();        // when this send should fire
    table.timestamp('sent_at').nullable();
    table.uuid('whatsapp_message_id').nullable();
    table.text('error').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'status', 'scheduled_at']);
    table.index(['customer_id']);
    table.index(['campaign_id']);
  });

  // Track which customers have entered which campaigns (for cooldown + max sends)
  await knex.schema.createTable('marketing_enrollments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('campaign_id').notNullable().references('id').inTable('marketing_campaigns').onDelete('CASCADE');
    table.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    table.integer('sends_count').notNullable().defaultTo(0);
    table.timestamp('enrolled_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_sent_at').nullable();
    table.timestamp('completed_at').nullable();           // all steps sent
    table.string('status', 20).notNullable().defaultTo('active'); // active | completed | cancelled

    table.unique(['campaign_id', 'customer_id']);
    table.index(['tenant_id', 'campaign_id', 'status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('marketing_enrollments');
  await knex.schema.dropTableIfExists('marketing_sends');
  await knex.schema.dropTableIfExists('marketing_campaign_steps');
  await knex.schema.dropTableIfExists('marketing_campaigns');
}
