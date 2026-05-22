import { Knex } from 'knex';

/**
 * RBAC: users + roles + permissions.
 *
 * Model:
 *   - tenant_users: individuals who can log in. Many users per tenant.
 *   - user_permissions: list of permission strings for each user.
 *
 * The existing tenants table keeps email + password_hash as the "owner" account
 * for backwards compatibility. We migrate the existing tenant.email into
 * tenant_users as a super admin.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenant_users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('email', 256).notNullable();
    table.string('password_hash', 256).notNullable();
    table.string('display_name', 256).nullable();
    table.string('status', 30).notNullable().defaultTo('active'); // active | invited | disabled
    table.uuid('invited_by').nullable();
    table.timestamp('invited_at').nullable();
    table.timestamp('last_login_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'email']);
    table.index(['email']);
  });

  await knex.schema.createTable('user_permissions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('tenant_users').onDelete('CASCADE');
    table.string('permission', 100).notNullable(); // e.g. "orders.view", "caretaker.*", "*"
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['user_id', 'permission']);
    table.index(['user_id']);
  });

  // Backfill: copy existing tenants into tenant_users as super admins
  await knex.raw(`
    INSERT INTO tenant_users (id, tenant_id, email, password_hash, display_name, status, created_at, updated_at)
    SELECT gen_random_uuid(), id, email, password_hash, email, 'active', created_at, updated_at
    FROM tenants
    WHERE email IS NOT NULL AND password_hash IS NOT NULL
    ON CONFLICT (tenant_id, email) DO NOTHING
  `);

  await knex.raw(`
    INSERT INTO user_permissions (user_id, permission)
    SELECT id, '*' FROM tenant_users
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_permissions');
  await knex.schema.dropTableIfExists('tenant_users');
}
