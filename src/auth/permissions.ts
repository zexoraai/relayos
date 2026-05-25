/**
 * RBAC permission catalog and matcher.
 *
 * A permission is a dot-separated string: "module.action" or "module.subresource.action".
 * Wildcards are supported: "*" matches everything, "module.*" matches everything in a module.
 *
 * Permissions stored in user_permissions are looked up at request time.
 */

export const PERMISSIONS = {
  DASHBOARD: {
    VIEW: 'dashboard.view',
  },
  PIPELINE: {
    VIEW: 'pipeline.view',
    MANAGE: 'pipeline.manage',
  },
  ORDERS: {
    VIEW: 'orders.view',
    MANAGE: 'orders.manage',
    EXPORT: 'orders.export',
  },
  FULFILLMENT: {
    VIEW: 'fulfillment.view',
    POLL: 'fulfillment.poll',
    CANCEL: 'fulfillment.cancel',
  },
  CUSTOMERS: {
    VIEW: 'customers.view',
    MANAGE: 'customers.manage',
  },
  AGENTS: {
    VIEW: 'agents.view',
    RUNS_VIEW: 'agents.runs.view',
    RUNS_REPLAY: 'agents.runs.replay',
    RUNS_CORRECT: 'agents.runs.correct',
    USAGE_VIEW: 'agents.usage.view',
  },
  CARETAKER: {
    VIEW: 'caretaker.view',
    RULES_MANAGE: 'caretaker.rules.manage',
    REVIEW_APPROVE: 'caretaker.review.approve',
    REVIEW_REJECT: 'caretaker.review.reject',
  },
  WHATSAPP: {
    VIEW: 'whatsapp.view',
    SETTINGS_MANAGE: 'whatsapp.settings.manage',
    TEMPLATES_MANAGE: 'whatsapp.templates.manage',
    SEND_TEST: 'whatsapp.send.test',
  },
  INBOX: {
    VIEW: 'inbox.view',
    REPLY: 'inbox.reply',
  },
  KNOWLEDGE: {
    VIEW: 'knowledge.view',
    SOURCES_MANAGE: 'knowledge.sources.manage',
    DOCS_MANAGE: 'knowledge.docs.manage',
  },
  PROMPTS: {
    VIEW: 'prompts.view',
    MANAGE: 'prompts.manage',
    EVAL_RUN: 'prompts.eval.run',
  },
  MARKETING: {
    VIEW: 'marketing.view',
    MANAGE: 'marketing.manage',
  },
  SETTINGS: {
    VIEW: 'settings.view',
    SHOPIFY_MANAGE: 'settings.shopify.manage',
    IMAP_MANAGE: 'settings.imap.manage',
    PUDO_MANAGE: 'settings.pudo.manage',
    COLLECTION_MANAGE: 'settings.collection.manage',
  },
  USERS: {
    VIEW: 'users.view',
    INVITE: 'users.invite',
    MANAGE: 'users.manage',
  },
  SYSTEM: {
    HEALTH_VIEW: 'health.view',
    DLQ_VIEW: 'dlq.view',
    DLQ_MANAGE: 'dlq.manage',
    IDEMPOTENCY_VIEW: 'idempotency.view',
    IDEMPOTENCY_MANAGE: 'idempotency.manage',
  },
  WILDCARD: '*',
} as const;

/**
 * Check if a user's permission set grants the required permission.
 * Wildcards: "*" matches anything; "module.*" matches anything starting with "module.".
 */
export function hasPermission(userPermissions: string[], required: string): boolean {
  if (!userPermissions || userPermissions.length === 0) return false;

  for (const perm of userPermissions) {
    // Super admin
    if (perm === '*') return true;
    // Exact match
    if (perm === required) return true;
    // Module wildcard: "orders.*" matches "orders.view", "orders.manage", etc.
    if (perm.endsWith('.*')) {
      const prefix = perm.slice(0, -2); // strip the .*
      if (required.startsWith(prefix + '.')) return true;
    }
  }
  return false;
}

/**
 * Check ANY of the listed permissions.
 */
export function hasAnyPermission(userPermissions: string[], required: string[]): boolean {
  return required.some((p) => hasPermission(userPermissions, p));
}

/**
 * Role presets. Used as starting points when inviting a user.
 * The actual permissions are stored per-user in user_permissions, so editing a user
 * doesn't affect others with the same starting role.
 */
export const ROLE_PRESETS: Record<string, string[]> = {
  super_admin: ['*'],
  operations: [
    'dashboard.view',
    'pipeline.*',
    'orders.*',
    'fulfillment.*',
    'customers.*',
    'caretaker.*',
    'agents.view',
    'agents.runs.view',
    'agents.usage.view',
    'health.view',
    'dlq.view',
    'dlq.manage',
  ],
  packer: [
    'orders.view',
    'fulfillment.view',
    'customers.view',
  ],
  customer_support: [
    'orders.view',
    'customers.view',
    'customers.manage',
    'inbox.view',
    'inbox.reply',
    'knowledge.view',
    'fulfillment.view',
    'fulfillment.poll',
  ],
  marketing: [
    'knowledge.*',
    'whatsapp.view',
    'whatsapp.templates.manage',
    'inbox.view',
    'marketing.view',
    'marketing.manage',
  ],
  viewer: [
    'dashboard.view',
    'pipeline.view',
    'orders.view',
    'fulfillment.view',
    'customers.view',
    'agents.view',
    'caretaker.view',
    'whatsapp.view',
    'inbox.view',
    'knowledge.view',
    'settings.view',
    'health.view',
    'marketing.view',
  ],
};

/**
 * Flat list of all known permission strings (for the UI permissions picker).
 */
export function listAllPermissions(): string[] {
  const out: string[] = [];
  function walk(obj: any) {
    for (const key in obj) {
      const v = obj[key];
      if (typeof v === 'string') out.push(v);
      else if (typeof v === 'object') walk(v);
    }
  }
  walk(PERMISSIONS);
  return out.filter((p) => p !== '*').sort();
}
