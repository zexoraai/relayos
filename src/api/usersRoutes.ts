import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { hashPassword } from '../auth';
import { ROLE_PRESETS, listAllPermissions, hasPermission } from '../auth/permissions';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'users-api' });
const router = Router();

router.use(authMiddleware);

/**
 * GET /users - list all users in the tenant
 */
router.get('/', requirePermission('users.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const users = await db('tenant_users')
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'asc')
    .select('id', 'email', 'display_name', 'status', 'invited_at', 'last_login_at', 'created_at');

  // Hydrate permissions for each user
  const userIds = users.map((u: any) => u.id);
  const perms = userIds.length
    ? await db('user_permissions').whereIn('user_id', userIds).select('user_id', 'permission')
    : [];
  const permsByUser: Record<string, string[]> = {};
  perms.forEach((p: any) => {
    if (!permsByUser[p.user_id]) permsByUser[p.user_id] = [];
    permsByUser[p.user_id].push(p.permission);
  });

  return res.status(200).json({
    success: true,
    data: users.map((u: any) => ({ ...u, permissions: permsByUser[u.id] || [] })),
  });
});

/**
 * GET /users/permissions/catalog - list all available permissions and role presets
 */
router.get('/permissions/catalog', requirePermission('users.view'), async (_req: AuthenticatedRequest, res: Response) => {
  return res.status(200).json({
    success: true,
    data: {
      permissions: listAllPermissions(),
      role_presets: ROLE_PRESETS,
    },
  });
});

/**
 * POST /users/invite - create a new user
 * Body: { email, password, display_name?, role? (preset) | permissions? (custom array) }
 */
router.post('/invite', requirePermission('users.invite'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const inviterUserId = req.tenant!.userId;
  const { email, password, display_name, role, permissions } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'email and password are required' } });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' } });
  }

  const normalized = String(email).toLowerCase().trim();

  // Check duplicate
  const existing = await db('tenant_users').where({ tenant_id: tenantId, email: normalized }).first();
  if (existing) {
    return res.status(409).json({ success: false, error: { code: 'DUPLICATE_EMAIL', message: 'A user with this email already exists in this tenant' } });
  }

  // Resolve permissions: explicit array wins, otherwise use role preset, otherwise viewer
  let finalPerms: string[];
  if (Array.isArray(permissions) && permissions.length) {
    finalPerms = permissions.filter((p: any) => typeof p === 'string');
  } else if (role && ROLE_PRESETS[role]) {
    finalPerms = [...ROLE_PRESETS[role]];
  } else {
    finalPerms = [...ROLE_PRESETS.viewer];
  }

  // Don't allow non-super-admins to assign '*' (super admin)
  const callerPerms = req.tenant!.permissions || [];
  if (finalPerms.includes('*') && !hasPermission(callerPerms, '*')) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only super admins can assign the super admin role' } });
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db('tenant_users').insert({
    tenant_id: tenantId,
    email: normalized,
    password_hash: passwordHash,
    display_name: display_name || normalized,
    status: 'active',
    invited_by: inviterUserId || null,
    invited_at: new Date(),
  }).returning(['id', 'email', 'display_name', 'status', 'created_at']);

  // Insert permissions
  if (finalPerms.length) {
    await db('user_permissions').insert(finalPerms.map((p) => ({ user_id: user.id, permission: p })));
  }

  log.info({ tenantId, newUserId: user.id, by: req.tenant?.email, perms: finalPerms.length }, 'User invited');
  return res.status(201).json({ success: true, data: { ...user, permissions: finalPerms } });
});

/**
 * PUT /users/:id/permissions - replace a user's permissions
 * Body: { permissions: string[] } or { role: 'super_admin' | ... }
 */
router.put('/:id/permissions', requirePermission('users.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { permissions, role } = req.body;

  // Resolve target permissions
  let finalPerms: string[];
  if (Array.isArray(permissions)) {
    finalPerms = permissions.filter((p: any) => typeof p === 'string');
  } else if (role && ROLE_PRESETS[role]) {
    finalPerms = [...ROLE_PRESETS[role]];
  } else {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'Provide permissions array or role preset' } });
  }

  // Check user belongs to tenant
  const user = await db('tenant_users').where({ id, tenant_id: tenantId }).first();
  if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });

  // Don't allow non-super-admins to grant '*'
  const callerPerms = req.tenant!.permissions || [];
  if (finalPerms.includes('*') && !hasPermission(callerPerms, '*')) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only super admins can assign the super admin role' } });
  }

  // Replace permissions in a transaction
  await db.transaction(async (trx) => {
    await trx('user_permissions').where({ user_id: id }).delete();
    if (finalPerms.length) {
      await trx('user_permissions').insert(finalPerms.map((p) => ({ user_id: id, permission: p })));
    }
  });

  log.info({ tenantId, userId: id, by: req.tenant?.email, perms: finalPerms }, 'User permissions updated');
  return res.status(200).json({ success: true, data: { id, permissions: finalPerms } });
});

/**
 * PUT /users/:id - update display_name or status (active/disabled)
 */
router.put('/:id', requirePermission('users.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { display_name, status } = req.body;

  const update: any = { updated_at: new Date() };
  if (display_name !== undefined) update.display_name = display_name;
  if (status && ['active', 'disabled'].includes(status)) update.status = status;

  const updated = await db('tenant_users').where({ id, tenant_id: tenantId }).update(update);
  if (updated === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });

  return res.status(200).json({ success: true, data: { message: 'User updated' } });
});

/**
 * DELETE /users/:id - permanently delete a user
 */
router.delete('/:id', requirePermission('users.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };

  // Don't allow self-delete
  if (id === req.tenant!.userId) {
    return res.status(400).json({ success: false, error: { code: 'CANNOT_DELETE_SELF', message: 'You cannot delete your own account' } });
  }

  const deleted = await db('tenant_users').where({ id, tenant_id: tenantId }).delete();
  if (deleted === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });

  log.info({ tenantId, deletedUserId: id, by: req.tenant?.email }, 'User deleted');
  return res.status(200).json({ success: true, data: { message: 'User deleted' } });
});

export default router;
