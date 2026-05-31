import type { Knex } from 'knex';

/**
 * Per-packer toggle for the weekly rating digest.
 *
 *   weekly_digest_enabled (bool, default false)
 *     Opt-in. We default to false so existing packers don't get a
 *     surprise Sunday WhatsApp the first time the worker fires; the
 *     packer flips the toggle in their dashboard Profile tab.
 *
 *   last_digest_sent_at (timestamp, nullable)
 *     The worker reads this to decide whether to skip the packer this
 *     tick. Without it we'd keep firing during a long Sunday window.
 *
 * Idempotent — guarded by hasColumn so re-runs are no-ops.
 */
export async function up(knex: Knex): Promise<void> {
  const hasEnabled = await knex.schema.hasColumn('packers', 'weekly_digest_enabled');
  if (!hasEnabled) {
    await knex.schema.alterTable('packers', (table) => {
      table.boolean('weekly_digest_enabled').notNullable().defaultTo(false);
    });
  }
  const hasLast = await knex.schema.hasColumn('packers', 'last_digest_sent_at');
  if (!hasLast) {
    await knex.schema.alterTable('packers', (table) => {
      table.timestamp('last_digest_sent_at').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasLast = await knex.schema.hasColumn('packers', 'last_digest_sent_at');
  if (hasLast) {
    await knex.schema.alterTable('packers', (table) => {
      table.dropColumn('last_digest_sent_at');
    });
  }
  const hasEnabled = await knex.schema.hasColumn('packers', 'weekly_digest_enabled');
  if (hasEnabled) {
    await knex.schema.alterTable('packers', (table) => {
      table.dropColumn('weekly_digest_enabled');
    });
  }
}
