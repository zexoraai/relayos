import type { Knex } from 'knex';

/**
 * `packer_ratings` — a tenant-side rating left on a packer for a
 * specific order they delivered.
 *
 * Each row is one rating event; a tenant can rate a (packer, order)
 * pair at most once thanks to the unique key. The rater can edit
 * later via update (the API does an upsert).
 *
 * Visibility model:
 *   - The tenant who wrote the rating sees their own rows + the
 *     packer-level aggregate.
 *   - Other tenants linked to the same packer see only the
 *     aggregate (average across all tenants).
 *   - The packer sees the aggregate (per-criterion averages and
 *     count of ratings) on their own /packer-auth/ratings endpoint
 *     but NOT individual rows or comments. This avoids retaliation
 *     loops.
 *
 * Criteria are 1..5 smallints. Aggregate average is computed live
 * (no denormalisation) — the table stays small enough that this is
 * fine for the foreseeable future.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('packer_ratings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('packer_id').notNullable().references('id').inTable('packers').onDelete('CASCADE');
    table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');

    // Audit trail: which tenant_users.id submitted the rating. We
    // intentionally don't FK-constrain it so user deletion doesn't
    // erase the rating.
    table.uuid('rated_by_user_id').nullable();

    // Per-criterion scores 1..5. Postgres CHECK constraints enforce
    // the range so a buggy client can't write 0 or 7.
    table.smallint('packing_quality').notNullable();
    table.smallint('speed').notNullable();
    table.smallint('communication').notNullable();
    table.smallint('reliability').notNullable();

    table.text('comment').nullable();

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    // One rating per (tenant, packer, order). Re-rating updates the
    // existing row instead of inserting a duplicate.
    table.unique(['tenant_id', 'packer_id', 'order_id']);
    table.index(['packer_id']);
    table.index(['tenant_id', 'packer_id']);
  });

  // CHECK constraints (Knex doesn't have a portable helper for this
  // shape; raw SQL is cleanest).
  await knex.raw(`
    ALTER TABLE packer_ratings
      ADD CONSTRAINT packer_ratings_packing_quality_check CHECK (packing_quality BETWEEN 1 AND 5),
      ADD CONSTRAINT packer_ratings_speed_check           CHECK (speed BETWEEN 1 AND 5),
      ADD CONSTRAINT packer_ratings_communication_check   CHECK (communication BETWEEN 1 AND 5),
      ADD CONSTRAINT packer_ratings_reliability_check     CHECK (reliability BETWEEN 1 AND 5)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('packer_ratings');
}
