import { Knex } from 'knex';

/**
 * Per-tenant chatbot configuration.
 * Controls personality, escalation targets, auto-responses, and boundaries.
 * Injected into agent prompts at runtime so tenants can customize without code changes.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('chatbot_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');

    // Personality
    table.string('bot_name', 100).notNullable().defaultTo('Muti AI');
    table.string('tone', 30).notNullable().defaultTo('friendly');  // friendly | professional | casual
    table.string('language', 10).notNullable().defaultTo('en');
    table.text('custom_instructions').nullable();  // free-text appended to system prompt

    // Escalation
    table.string('escalation_phone', 50).nullable();     // WhatsApp number of human agent
    table.string('escalation_email', 256).nullable();
    table.string('escalation_name', 100).nullable();     // "Sarah from support"
    table.text('escalation_message').nullable();          // what to tell the customer when escalating

    // Auto-responses
    table.text('greeting_message').nullable();            // override the default greeting
    table.text('unknown_intent_message').nullable();      // when bot can't classify
    table.text('outside_hours_message').nullable();       // if business hours are set

    // Boundaries
    table.jsonb('blocked_topics').notNullable().defaultTo('[]');  // ["refunds", "pricing"] — redirect to human
    table.text('blocked_topic_response').nullable();              // what to say when a blocked topic is detected

    // Business hours (optional)
    table.string('timezone', 50).nullable();              // e.g. "Africa/Johannesburg"
    table.string('hours_start', 5).nullable();            // "08:00"
    table.string('hours_end', 5).nullable();              // "17:00"
    table.jsonb('active_days').notNullable().defaultTo('[1,2,3,4,5]'); // 0=Sun, 1=Mon...6=Sat

    table.boolean('enabled').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('chatbot_settings');
}
