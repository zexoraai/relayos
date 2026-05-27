import { Knex } from 'knex';

/**
 * Independent packers — top-level entities that exist outside any
 * single tenant. They sign up themselves, fill in collection details
 * (locker terminal, door pickup address, contact info) and wait for
 * tenant invitations.
 *
 * Three tables:
 *
 *   1. packers
 *      Identity + profile. Email/password auth lives here, separate
 *      from tenant_users so the two auth systems never collide.
 *      Status: 'active' | 'paused' | 'disabled'.
 *
 *   2. packer_invites
 *      A tenant clicks "Invite packer" with an email address. We mint
 *      a token, email it to the packer, set status='pending'. The
 *      packer clicks the link, signs up (or logs in if their email
 *      already maps to a packer row), and the invite gets converted
 *      into a packer_tenant_links row.
 *
 *   3. packer_tenant_links
 *      Many-to-many: which tenants does this packer accept work
 *      from. Each row carries:
 *        - status            : 'active' | 'paused' | 'left' | 'kicked'
 *        - load_weight       : tenant-controlled relative weight for
 *                              the round-robin (default 1; bump to 2
 *                              for a packer with double capacity).
 *                              Phase 2 uses this for assignment.
 *        - linked_at         : when the link became active.
 *        - last_assigned_at  : populated by Phase 2 to track round-robin
 *                              cursors per (tenant, packer).
 *
 *
 * Phase 2 (separate commit) will add `assigned_packer_id` to orders
 * and the assignment logic. Phase 3 wires the packer dashboard.
 * Phase 4 overrides courier collection address from the packer's
 * profile.
 */
export async function up(knex: Knex): Promise<void> {
  // ------------------------------------------------------------------
  // packers
  // ------------------------------------------------------------------
  await knex.schema.createTable('packers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Identity
    table.string('email', 320).notNullable().unique();
    table.text('encrypted_password').notNullable();
    table.string('full_name', 256).nullable();
    table.string('business_name', 256).nullable();
    table.string('phone', 50).nullable();

    // Collection details — these are the values that override the
    // tenant's collection_address on the courier payload in Phase 4.
    // We store both a locker terminal and a door address so the
    // packer can serve locker-to-locker AND door-collection orders.
    table.string('collection_terminal_id', 50).nullable();
    table.string('collection_locker_name', 256).nullable();
    table.jsonb('collection_door_address').nullable();   // { street, suburb, city, province, postal_code, country, lat, lng }
    table.string('collection_contact_name', 256).nullable();
    table.string('collection_contact_phone', 50).nullable();
    table.string('collection_contact_email', 320).nullable();

    // Account state
    table.string('status', 30).notNullable().defaultTo('active'); // active | paused | disabled
    table.timestamp('email_verified_at').nullable();
    table.timestamp('last_login_at').nullable();

    // Bookkeeping
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['status']);
  });

  // ------------------------------------------------------------------
  // packer_invites
  // ------------------------------------------------------------------
  await knex.schema.createTable('packer_invites', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');

    // Who the tenant invited (free-text email — the packer might not
    // have an account yet). Token lives client-side in the invite link.
    table.string('email', 320).notNullable();
    table.string('token', 128).notNullable().unique();

    // Lifecycle: pending -> accepted | declined | expired | revoked
    table.string('status', 30).notNullable().defaultTo('pending');

    // Tenant-side fields they can pre-set when sending the invite so
    // the link goes active with the right load weight.
    table.integer('load_weight').notNullable().defaultTo(1);
    table.text('note').nullable();

    table.uuid('invited_by_user_id').nullable();   // tenant_users.id (no FK, we don't want to leak removals)
    table.uuid('packer_id').nullable().references('id').inTable('packers').onDelete('SET NULL');
    table.timestamp('accepted_at').nullable();
    table.timestamp('expires_at').notNullable();

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'status']);
    table.index(['email']);
  });

  // ------------------------------------------------------------------
  // packer_tenant_links
  // ------------------------------------------------------------------
  await knex.schema.createTable('packer_tenant_links', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('packer_id').notNullable().references('id').inTable('packers').onDelete('CASCADE');

    table.string('status', 30).notNullable().defaultTo('active'); // active | paused | left | kicked

    // Relative weight in the round-robin pool. Default 1.
    // A packer with weight 2 gets twice as many orders as weight-1
    // peers. Tenants control this from the Packers tab.
    table.integer('load_weight').notNullable().defaultTo(1);
    table.text('note').nullable();

    // Round-robin cursor (set by Phase 2). NULL until first assignment.
    table.timestamp('last_assigned_at').nullable();
    table.integer('orders_assigned_count').notNullable().defaultTo(0);

    // Lifecycle audit
    table.uuid('linked_via_invite_id').nullable().references('id').inTable('packer_invites').onDelete('SET NULL');
    table.timestamp('linked_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('paused_at').nullable();
    table.timestamp('unlinked_at').nullable();
    table.string('unlink_reason', 30).nullable(); // 'left_by_packer' | 'kicked_by_tenant'

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'packer_id']);
    table.index(['tenant_id', 'status']);
    table.index(['packer_id', 'status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('packer_tenant_links');
  await knex.schema.dropTableIfExists('packer_invites');
  await knex.schema.dropTableIfExists('packers');
}
