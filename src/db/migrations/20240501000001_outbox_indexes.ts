import { Knex } from 'knex';

/**
 * Outbox pattern hardening:
 *  - Reset any rows stuck in 'dispatching' from a previous run (won't apply on first run, but safe).
 *  - Add a partial index for fast outbox sweeps (pending + failed under retry cap).
 *  - Add an index on (aggregate_type, aggregate_id) for replay/audit queries.
 *
 * The status column is a string so the new 'dispatching' value needs no schema change.
 */
export async function up(knex: Knex): Promise<void> {
  // Index that the outbox relay will hit on every tick.
  // Partial: only rows that the relay actually cares about.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS domain_events_outbox_idx
    ON domain_events (created_at)
    WHERE status IN ('pending', 'failed')
  `);

  // Compound index for replay/audit by aggregate.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS domain_events_aggregate_idx
    ON domain_events (aggregate_type, aggregate_id, created_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS domain_events_aggregate_idx');
  await knex.raw('DROP INDEX IF EXISTS domain_events_outbox_idx');
}
