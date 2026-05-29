import type { Knex } from 'knex';

/**
 * Phase 5: audit columns for packer assignment + reject/reassign.
 *
 * Two columns on `orders`:
 *
 *   assigned_packer_at (timestamptz, nullable)
 *     When the current `assigned_packer_id` was stamped. Resets to
 *     now() on every reassignment so we can age stale assignments.
 *     Null when assigned_packer_id is null.
 *
 *   assigned_packer_history (jsonb, nullable)
 *     Append-only array of every assignment + rejection on this
 *     order. Each entry shape:
 *       {
 *         packer_id: uuid,
 *         packer_email: string | null,
 *         assigned_at: ISO ts,
 *         rejected_at: ISO ts | null,    // null = current/active assignment
 *         reject_reason: string | null,  // null = current/active assignment
 *       }
 *     The currently-active assignment is always the LAST element with
 *     rejected_at = null. When a packer rejects, we set rejected_at +
 *     reject_reason on the last element and append a fresh entry for
 *     the new assignee (if reassignment succeeded).
 *
 * Idempotent (hasColumn checks) so a re-run is a no-op.
 */
export async function up(knex: Knex): Promise<void> {
  const hasAt = await knex.schema.hasColumn('orders', 'assigned_packer_at');
  if (!hasAt) {
    await knex.schema.alterTable('orders', (table) => {
      table.timestamp('assigned_packer_at').nullable();
    });
  }

  const hasHistory = await knex.schema.hasColumn('orders', 'assigned_packer_history');
  if (!hasHistory) {
    await knex.schema.alterTable('orders', (table) => {
      table.jsonb('assigned_packer_history').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasHistory = await knex.schema.hasColumn('orders', 'assigned_packer_history');
  if (hasHistory) {
    await knex.schema.alterTable('orders', (table) => {
      table.dropColumn('assigned_packer_history');
    });
  }

  const hasAt = await knex.schema.hasColumn('orders', 'assigned_packer_at');
  if (hasAt) {
    await knex.schema.alterTable('orders', (table) => {
      table.dropColumn('assigned_packer_at');
    });
  }
}
