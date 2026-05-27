/**
 * Route_Permission_Map — canonical declaration of every authenticated endpoint
 * mounted by `createApiServer()`, the permission(s) that gate it, and the
 * justification for the few endpoints that are intentionally `auth-only`.
 *
 * The runtime decision is still `requirePermission(...)` on the router itself;
 * this map exists so:
 *   1. The CI lint (tests/rbac/routePermissionLint.test.ts, task 3.1) can
 *      assert every `router.<method>(...)` call in `src/api/*Routes.ts`
 *      either has a `requirePermission(...)` token or appears here as
 *      `auth-only` with a non-empty justification.
 *   2. The packer verification suite (tests/rbac/packerVerification.test.ts,
 *      task 4.1) can walk every entry, hit the endpoint with a packer JWT,
 *      and assert 401/403/2xx per the policy in design Property 2.
 *   3. Operators have a single document that names every endpoint and the
 *      permission it requires.
 *
 * Every non-`auth-only` permission value is sourced from the `PERMISSIONS`
 * catalog in `src/auth/permissions.ts`. No bare string literals.
 *
 * Discrepancies between the design's Route_Permission_Map tables and the
 * actual router files (resolved in favor of the live code, since the lint
 * walks the source files):
 *   - `caretakerRoutes.ts` — the design lists `/caretaker/queue` and
 *     `/caretaker/queue/:id/{approve,reject}`. The live router exposes the
 *     same intent under `/caretaker/evaluations` and
 *     `/caretaker/evaluations/:id/{resolve,reopen}`. The map mirrors the
 *     actual paths and uses the design's caretaker.* permissions.
 *   - `customersRoutes.ts` — the design lists POST/PUT/DELETE on `/customers`
 *     plus `GET /customers/:id/orders`. None exist in the live router; it
 *     has `GET /customers/lookup/:phone` instead. The map mirrors the actual
 *     endpoints.
 *   - `chatbotSettingsRoutes.ts` — the design lists `PUT /chatbot-settings`
 *     and three `/chatbot-settings/prompts*` endpoints. The live router
 *     exposes `GET /` and `POST /` only. The map mirrors the actual paths
 *     and uses the design's prompts.* permissions.
 *   - `knowledgeRoutes.ts` — the live router has many more endpoints than
 *     the design table (sources/url, sources/sitemap, sources/upload,
 *     sources/shopify-products, sources/:id/resync, conversations, health).
 *     All are listed here with the closest matching catalog permission.
 *   - `agentRunsRoutes.ts` — adds `POST /:id/approve` (replay-class action)
 *     and `GET|DELETE /corrections/*` (correct-class) beyond the design.
 *   - `settingsRoutes.ts` — adds `/settings/collection-contact` beyond the
 *     design table; uses `settings.view` for GET and
 *     `settings.collection.manage` for POST per task 1.3.12.
 */

import { PERMISSIONS } from '../auth/permissions';

export type RouteSpec = {
  router: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  permission: string | string[] | 'auth-only';
  justification?: string; // required when permission === 'auth-only'
};

/**
 * Normalize a `RouteSpec.permission` into a `string[]` of catalog values.
 *
 * The verification suite (task 4.1) calls this to feed
 * `hasAnyPermission(role, normalizeRequired(entry.permission))`. Callers MUST
 * filter out `'auth-only'` entries before invoking this helper — passing
 * `'auth-only'` throws because there is no role-relative answer for it
 * (those endpoints accept any authenticated user).
 */
export function normalizeRequired(p: RouteSpec['permission']): string[] {
  if (p === 'auth-only') {
    throw new Error(
      'normalizeRequired: cannot normalize an `auth-only` route; filter these out before calling',
    );
  }
  return Array.isArray(p) ? p : [p];
}

export const ROUTE_PERMISSION_MAP: RouteSpec[] = [
  // ------------------------------------------------------------------
  // authRoutes.ts (mounted at /auth) — exempt from requirePermission
  // ------------------------------------------------------------------
  {
    router: 'authRoutes',
    method: 'POST',
    path: '/auth/register',
    permission: 'auth-only',
    justification: 'public registration endpoint — runs before any tenant exists',
  },
  {
    router: 'authRoutes',
    method: 'POST',
    path: '/auth/login',
    permission: 'auth-only',
    justification: 'public token issuance — caller has no JWT yet',
  },
  {
    router: 'authRoutes',
    method: 'POST',
    path: '/auth/logout',
    permission: 'auth-only',
    justification: 'any authenticated user can revoke their own session',
  },
  {
    router: 'authRoutes',
    method: 'GET',
    path: '/auth/me',
    permission: 'auth-only',
    justification:
      'returns the caller their own permissions; gating it on a permission would be circular',
  },

  // ------------------------------------------------------------------
  // packerAuthRoutes.ts (mounted at /packer-auth) — packer identity, separate JWT audience
  // ------------------------------------------------------------------
  {
    router: 'packerAuthRoutes',
    method: 'POST',
    path: '/packer-auth/signup',
    permission: 'auth-only',
    justification: 'public packer registration — runs before any packer JWT exists',
  },
  {
    router: 'packerAuthRoutes',
    method: 'POST',
    path: '/packer-auth/login',
    permission: 'auth-only',
    justification: 'public token issuance for packers — caller has no JWT yet',
  },
  {
    router: 'packerAuthRoutes',
    method: 'POST',
    path: '/packer-auth/accept',
    permission: 'auth-only',
    justification: 'gated by packerAuthMiddleware (separate JWT audience), not by tenant permissions',
  },
  {
    router: 'packerAuthRoutes',
    method: 'GET',
    path: '/packer-auth/me',
    permission: 'auth-only',
    justification: 'gated by packerAuthMiddleware (separate JWT audience), not by tenant permissions',
  },
  {
    router: 'packerAuthRoutes',
    method: 'POST',
    path: '/packer-auth/logout',
    permission: 'auth-only',
    justification: 'stateless logout — any holder of a packer JWT may invoke',
  },

  // ------------------------------------------------------------------
  // pipelineRoutes.ts (mounted at /pipeline)
  // ------------------------------------------------------------------
  { router: 'pipelineRoutes', method: 'GET', path: '/pipeline/jobs', permission: PERMISSIONS.PIPELINE.VIEW },
  { router: 'pipelineRoutes', method: 'GET', path: '/pipeline/jobs/:id', permission: PERMISSIONS.PIPELINE.VIEW },
  { router: 'pipelineRoutes', method: 'GET', path: '/pipeline/stats', permission: PERMISSIONS.PIPELINE.VIEW },
  { router: 'pipelineRoutes', method: 'POST', path: '/pipeline/trigger/:emailId', permission: PERMISSIONS.PIPELINE.MANAGE },
  { router: 'pipelineRoutes', method: 'POST', path: '/pipeline/jobs/:id/reprocess', permission: PERMISSIONS.PIPELINE.MANAGE },
  { router: 'pipelineRoutes', method: 'POST', path: '/pipeline/jobs/:id/address', permission: PERMISSIONS.PIPELINE.MANAGE },

  // ------------------------------------------------------------------
  // fulfillmentRoutes.ts (mounted at /fulfillment)
  // ------------------------------------------------------------------
  { router: 'fulfillmentRoutes', method: 'GET', path: '/fulfillment/jobs', permission: PERMISSIONS.FULFILLMENT.VIEW },
  { router: 'fulfillmentRoutes', method: 'GET', path: '/fulfillment/jobs/:id', permission: PERMISSIONS.FULFILLMENT.VIEW },
  { router: 'fulfillmentRoutes', method: 'GET', path: '/fulfillment/jobs/:id/notifications', permission: PERMISSIONS.FULFILLMENT.VIEW },
  { router: 'fulfillmentRoutes', method: 'GET', path: '/fulfillment/stats', permission: PERMISSIONS.FULFILLMENT.VIEW },
  { router: 'fulfillmentRoutes', method: 'POST', path: '/fulfillment/poll/:id', permission: PERMISSIONS.FULFILLMENT.POLL },
  { router: 'fulfillmentRoutes', method: 'POST', path: '/fulfillment/jobs/:id/cancel', permission: PERMISSIONS.FULFILLMENT.CANCEL },

  // ------------------------------------------------------------------
  // customersRoutes.ts (mounted at /customers)
  // ------------------------------------------------------------------
  { router: 'customersRoutes', method: 'GET', path: '/customers', permission: PERMISSIONS.CUSTOMERS.VIEW },
  { router: 'customersRoutes', method: 'GET', path: '/customers/:id', permission: PERMISSIONS.CUSTOMERS.VIEW },
  { router: 'customersRoutes', method: 'GET', path: '/customers/lookup/:phone', permission: PERMISSIONS.CUSTOMERS.VIEW },

  // ------------------------------------------------------------------
  // caretakerRoutes.ts (mounted at /caretaker)
  // Live router uses /evaluations rather than the design's /queue naming.
  // ------------------------------------------------------------------
  { router: 'caretakerRoutes', method: 'GET', path: '/caretaker/rules', permission: PERMISSIONS.CARETAKER.VIEW },
  { router: 'caretakerRoutes', method: 'POST', path: '/caretaker/rules', permission: PERMISSIONS.CARETAKER.RULES_MANAGE },
  { router: 'caretakerRoutes', method: 'GET', path: '/caretaker/evaluations', permission: PERMISSIONS.CARETAKER.VIEW },
  { router: 'caretakerRoutes', method: 'GET', path: '/caretaker/evaluations/:id', permission: PERMISSIONS.CARETAKER.VIEW },
  {
    router: 'caretakerRoutes',
    method: 'POST',
    path: '/caretaker/evaluations/:id/resolve',
    permission: [PERMISSIONS.CARETAKER.REVIEW_APPROVE, PERMISSIONS.CARETAKER.REVIEW_REJECT],
  },
  {
    router: 'caretakerRoutes',
    method: 'POST',
    path: '/caretaker/evaluations/:id/reopen',
    permission: PERMISSIONS.CARETAKER.REVIEW_APPROVE,
  },

  // ------------------------------------------------------------------
  // marketingRoutes.ts (mounted at /marketing)
  // ------------------------------------------------------------------
  { router: 'marketingRoutes', method: 'GET', path: '/marketing/campaigns', permission: PERMISSIONS.MARKETING.VIEW },
  { router: 'marketingRoutes', method: 'POST', path: '/marketing/campaigns', permission: PERMISSIONS.MARKETING.MANAGE },
  { router: 'marketingRoutes', method: 'PUT', path: '/marketing/campaigns/:id', permission: PERMISSIONS.MARKETING.MANAGE },
  { router: 'marketingRoutes', method: 'DELETE', path: '/marketing/campaigns/:id', permission: PERMISSIONS.MARKETING.MANAGE },
  { router: 'marketingRoutes', method: 'POST', path: '/marketing/campaigns/:id/steps', permission: PERMISSIONS.MARKETING.MANAGE },
  { router: 'marketingRoutes', method: 'PUT', path: '/marketing/campaigns/:campaignId/steps/:stepId', permission: PERMISSIONS.MARKETING.MANAGE },
  { router: 'marketingRoutes', method: 'DELETE', path: '/marketing/campaigns/:campaignId/steps/:stepId', permission: PERMISSIONS.MARKETING.MANAGE },
  { router: 'marketingRoutes', method: 'GET', path: '/marketing/stats', permission: PERMISSIONS.MARKETING.VIEW },

  // ------------------------------------------------------------------
  // knowledgeRoutes.ts (mounted at /knowledge)
  // ------------------------------------------------------------------
  // Sources
  { router: 'knowledgeRoutes', method: 'GET', path: '/knowledge/sources', permission: PERMISSIONS.KNOWLEDGE.VIEW },
  { router: 'knowledgeRoutes', method: 'POST', path: '/knowledge/sources/url', permission: PERMISSIONS.KNOWLEDGE.SOURCES_MANAGE },
  { router: 'knowledgeRoutes', method: 'POST', path: '/knowledge/sources/sitemap', permission: PERMISSIONS.KNOWLEDGE.SOURCES_MANAGE },
  { router: 'knowledgeRoutes', method: 'POST', path: '/knowledge/sources/upload', permission: PERMISSIONS.KNOWLEDGE.SOURCES_MANAGE },
  { router: 'knowledgeRoutes', method: 'POST', path: '/knowledge/sources/shopify-products', permission: PERMISSIONS.KNOWLEDGE.SOURCES_MANAGE },
  { router: 'knowledgeRoutes', method: 'POST', path: '/knowledge/sources/:id/resync', permission: PERMISSIONS.KNOWLEDGE.SOURCES_MANAGE },
  { router: 'knowledgeRoutes', method: 'DELETE', path: '/knowledge/sources/:id', permission: PERMISSIONS.KNOWLEDGE.SOURCES_MANAGE },
  // Documents
  { router: 'knowledgeRoutes', method: 'GET', path: '/knowledge', permission: PERMISSIONS.KNOWLEDGE.VIEW },
  { router: 'knowledgeRoutes', method: 'POST', path: '/knowledge', permission: PERMISSIONS.KNOWLEDGE.DOCS_MANAGE },
  { router: 'knowledgeRoutes', method: 'PUT', path: '/knowledge/:id', permission: PERMISSIONS.KNOWLEDGE.DOCS_MANAGE },
  { router: 'knowledgeRoutes', method: 'DELETE', path: '/knowledge/:id', permission: PERMISSIONS.KNOWLEDGE.DOCS_MANAGE },
  // Conversations (chatbot inbox)
  { router: 'knowledgeRoutes', method: 'GET', path: '/knowledge/__conversations', permission: PERMISSIONS.INBOX.VIEW },
  { router: 'knowledgeRoutes', method: 'GET', path: '/knowledge/__conversations/:id/messages', permission: PERMISSIONS.INBOX.VIEW },
  { router: 'knowledgeRoutes', method: 'POST', path: '/knowledge/__conversations/:convId/messages/:msgId/feedback', permission: PERMISSIONS.INBOX.REPLY },
  // Health
  { router: 'knowledgeRoutes', method: 'GET', path: '/knowledge/health', permission: PERMISSIONS.KNOWLEDGE.VIEW },

  // ------------------------------------------------------------------
  // whatsappRoutes.ts (mounted at /whatsapp, after webhook routes)
  // ------------------------------------------------------------------
  { router: 'whatsappRoutes', method: 'GET', path: '/whatsapp/settings', permission: PERMISSIONS.WHATSAPP.VIEW },
  { router: 'whatsappRoutes', method: 'POST', path: '/whatsapp/settings', permission: PERMISSIONS.WHATSAPP.SETTINGS_MANAGE },
  { router: 'whatsappRoutes', method: 'DELETE', path: '/whatsapp/settings', permission: PERMISSIONS.WHATSAPP.SETTINGS_MANAGE },
  { router: 'whatsappRoutes', method: 'GET', path: '/whatsapp/templates', permission: PERMISSIONS.WHATSAPP.VIEW },
  { router: 'whatsappRoutes', method: 'PUT', path: '/whatsapp/templates/:purpose', permission: PERMISSIONS.WHATSAPP.TEMPLATES_MANAGE },
  { router: 'whatsappRoutes', method: 'POST', path: '/whatsapp/templates', permission: PERMISSIONS.WHATSAPP.TEMPLATES_MANAGE },
  { router: 'whatsappRoutes', method: 'GET', path: '/whatsapp/event-types', permission: PERMISSIONS.WHATSAPP.VIEW },
  { router: 'whatsappRoutes', method: 'DELETE', path: '/whatsapp/templates/:purpose', permission: PERMISSIONS.WHATSAPP.TEMPLATES_MANAGE },
  { router: 'whatsappRoutes', method: 'GET', path: '/whatsapp/business-settings', permission: PERMISSIONS.WHATSAPP.VIEW },
  { router: 'whatsappRoutes', method: 'POST', path: '/whatsapp/business-settings', permission: PERMISSIONS.WHATSAPP.SETTINGS_MANAGE },
  { router: 'whatsappRoutes', method: 'POST', path: '/whatsapp/templates/:purpose/submit-to-meta', permission: PERMISSIONS.WHATSAPP.TEMPLATES_MANAGE },
  { router: 'whatsappRoutes', method: 'POST', path: '/whatsapp/templates/:purpose/sync-from-meta', permission: PERMISSIONS.WHATSAPP.TEMPLATES_MANAGE },
  { router: 'whatsappRoutes', method: 'GET', path: '/whatsapp/templates/meta', permission: PERMISSIONS.WHATSAPP.TEMPLATES_MANAGE },
  { router: 'whatsappRoutes', method: 'POST', path: '/whatsapp/templates/meta/import', permission: PERMISSIONS.WHATSAPP.TEMPLATES_MANAGE },
  { router: 'whatsappRoutes', method: 'POST', path: '/whatsapp/templates/meta/import-all', permission: PERMISSIONS.WHATSAPP.TEMPLATES_MANAGE },
  { router: 'whatsappRoutes', method: 'GET', path: '/whatsapp/messages', permission: PERMISSIONS.WHATSAPP.VIEW },
  { router: 'whatsappRoutes', method: 'POST', path: '/whatsapp/test', permission: PERMISSIONS.WHATSAPP.SEND_TEST },

  // ------------------------------------------------------------------
  // manualRoutes.ts (mounted at /manual)
  // ------------------------------------------------------------------
  { router: 'manualRoutes', method: 'GET', path: '/manual/upload-queue', permission: PERMISSIONS.ORDERS.VIEW },
  { router: 'manualRoutes', method: 'POST', path: '/manual/upload-queue/:id/complete', permission: PERMISSIONS.ORDERS.MANAGE },
  { router: 'manualRoutes', method: 'GET', path: '/manual/collection-queue', permission: PERMISSIONS.ORDERS.VIEW },
  { router: 'manualRoutes', method: 'POST', path: '/manual/collection-queue/:id/confirm', permission: PERMISSIONS.ORDERS.MANAGE },

  // ------------------------------------------------------------------
  // dlqRoutes.ts (mounted at /dlq)
  // ------------------------------------------------------------------
  { router: 'dlqRoutes', method: 'GET', path: '/dlq/summary', permission: PERMISSIONS.SYSTEM.DLQ_VIEW },
  { router: 'dlqRoutes', method: 'GET', path: '/dlq/:queue/failed', permission: PERMISSIONS.SYSTEM.DLQ_VIEW },
  { router: 'dlqRoutes', method: 'POST', path: '/dlq/:queue/retry', permission: PERMISSIONS.SYSTEM.DLQ_MANAGE },
  { router: 'dlqRoutes', method: 'POST', path: '/dlq/:queue/discard', permission: PERMISSIONS.SYSTEM.DLQ_MANAGE },
  { router: 'dlqRoutes', method: 'GET', path: '/dlq/outbox', permission: PERMISSIONS.SYSTEM.DLQ_VIEW },
  { router: 'dlqRoutes', method: 'POST', path: '/dlq/outbox/retry', permission: PERMISSIONS.SYSTEM.DLQ_MANAGE },
  { router: 'dlqRoutes', method: 'POST', path: '/dlq/outbox/discard', permission: PERMISSIONS.SYSTEM.DLQ_MANAGE },

  // ------------------------------------------------------------------
  // agentRunsRoutes.ts (mounted at /agent-runs)
  // ------------------------------------------------------------------
  { router: 'agentRunsRoutes', method: 'GET', path: '/agent-runs', permission: PERMISSIONS.AGENTS.RUNS_VIEW },
  { router: 'agentRunsRoutes', method: 'GET', path: '/agent-runs/:id', permission: PERMISSIONS.AGENTS.RUNS_VIEW },
  { router: 'agentRunsRoutes', method: 'POST', path: '/agent-runs/:id/approve', permission: PERMISSIONS.AGENTS.RUNS_REPLAY },
  { router: 'agentRunsRoutes', method: 'POST', path: '/agent-runs/:id/correct', permission: PERMISSIONS.AGENTS.RUNS_CORRECT },
  { router: 'agentRunsRoutes', method: 'GET', path: '/agent-runs/corrections/list', permission: PERMISSIONS.AGENTS.RUNS_VIEW },
  { router: 'agentRunsRoutes', method: 'DELETE', path: '/agent-runs/corrections/:id', permission: PERMISSIONS.AGENTS.RUNS_CORRECT },

  // ------------------------------------------------------------------
  // chatbotSettingsRoutes.ts (mounted at /chatbot-settings)
  // ------------------------------------------------------------------
  { router: 'chatbotSettingsRoutes', method: 'GET', path: '/chatbot-settings', permission: PERMISSIONS.PROMPTS.VIEW },
  { router: 'chatbotSettingsRoutes', method: 'POST', path: '/chatbot-settings', permission: PERMISSIONS.PROMPTS.MANAGE },

  // ------------------------------------------------------------------
  // idempotencyRoutes.ts (mounted at /idempotency)
  // ------------------------------------------------------------------
  { router: 'idempotencyRoutes', method: 'GET', path: '/idempotency', permission: PERMISSIONS.SYSTEM.IDEMPOTENCY_VIEW },
  { router: 'idempotencyRoutes', method: 'DELETE', path: '/idempotency/:key', permission: PERMISSIONS.SYSTEM.IDEMPOTENCY_MANAGE },

  // ------------------------------------------------------------------
  // usageRoutes.ts (mounted at /usage)
  // ------------------------------------------------------------------
  { router: 'usageRoutes', method: 'GET', path: '/usage/summary', permission: PERMISSIONS.AGENTS.USAGE_VIEW },
  { router: 'usageRoutes', method: 'GET', path: '/usage/recent', permission: PERMISSIONS.AGENTS.USAGE_VIEW },

  // ------------------------------------------------------------------
  // settingsRoutes.ts (mounted at /settings)
  // ------------------------------------------------------------------
  { router: 'settingsRoutes', method: 'GET', path: '/settings/shopify-api', permission: PERMISSIONS.SETTINGS.VIEW },
  { router: 'settingsRoutes', method: 'POST', path: '/settings/shopify-api', permission: PERMISSIONS.SETTINGS.SHOPIFY_MANAGE },
  { router: 'settingsRoutes', method: 'DELETE', path: '/settings/shopify-api', permission: PERMISSIONS.SETTINGS.SHOPIFY_MANAGE },
  { router: 'settingsRoutes', method: 'GET', path: '/settings/imap', permission: PERMISSIONS.SETTINGS.VIEW },
  { router: 'settingsRoutes', method: 'POST', path: '/settings/imap', permission: PERMISSIONS.SETTINGS.IMAP_MANAGE },
  { router: 'settingsRoutes', method: 'DELETE', path: '/settings/imap', permission: PERMISSIONS.SETTINGS.IMAP_MANAGE },
  { router: 'settingsRoutes', method: 'GET', path: '/settings/pudo', permission: PERMISSIONS.SETTINGS.VIEW },
  { router: 'settingsRoutes', method: 'POST', path: '/settings/pudo', permission: PERMISSIONS.SETTINGS.PUDO_MANAGE },
  { router: 'settingsRoutes', method: 'DELETE', path: '/settings/pudo', permission: PERMISSIONS.SETTINGS.PUDO_MANAGE },
  { router: 'settingsRoutes', method: 'GET', path: '/settings/collection-contact', permission: PERMISSIONS.SETTINGS.VIEW },
  { router: 'settingsRoutes', method: 'POST', path: '/settings/collection-contact', permission: PERMISSIONS.SETTINGS.COLLECTION_MANAGE },

  // ------------------------------------------------------------------
  // healthRoutes.ts (mounted at /health)
  // ------------------------------------------------------------------
  { router: 'healthRoutes', method: 'POST', path: '/health/check', permission: PERMISSIONS.SYSTEM.HEALTH_VIEW },

  // ------------------------------------------------------------------
  // usersRoutes.ts (mounted at /users)
  // ------------------------------------------------------------------
  { router: 'usersRoutes', method: 'GET', path: '/users', permission: PERMISSIONS.USERS.VIEW },
  { router: 'usersRoutes', method: 'GET', path: '/users/permissions/catalog', permission: PERMISSIONS.USERS.VIEW },
  { router: 'usersRoutes', method: 'POST', path: '/users/invite', permission: PERMISSIONS.USERS.INVITE },
  { router: 'usersRoutes', method: 'PUT', path: '/users/:id/permissions', permission: PERMISSIONS.USERS.MANAGE },
  { router: 'usersRoutes', method: 'PUT', path: '/users/:id', permission: PERMISSIONS.USERS.MANAGE },
  { router: 'usersRoutes', method: 'DELETE', path: '/users/:id', permission: PERMISSIONS.USERS.MANAGE },

  // ------------------------------------------------------------------
  // packerRoutes.ts (mounted at /packer)
  // ------------------------------------------------------------------
  { router: 'packerRoutes', method: 'GET', path: '/packer/queue', permission: PERMISSIONS.ORDERS.VIEW },
  { router: 'packerRoutes', method: 'POST', path: '/packer/orders/:id/mark-packed', permission: PERMISSIONS.ORDERS.MANAGE },
  { router: 'packerRoutes', method: 'POST', path: '/packer/orders/:id/mark-dropped-off', permission: PERMISSIONS.ORDERS.MANAGE },
  { router: 'packerRoutes', method: 'POST', path: '/packer/orders/:id/revert', permission: PERMISSIONS.ORDERS.MANAGE },

  // ------------------------------------------------------------------
  // packersRoutes.ts (mounted at /packers) — independent-packer linkage
  // ------------------------------------------------------------------
  { router: 'packersRoutes', method: 'GET', path: '/packers/links', permission: PERMISSIONS.PACKERS.VIEW },
  { router: 'packersRoutes', method: 'POST', path: '/packers/invites', permission: PERMISSIONS.PACKERS.INVITE },
  { router: 'packersRoutes', method: 'POST', path: '/packers/invites/:id/revoke', permission: PERMISSIONS.PACKERS.INVITE },
  { router: 'packersRoutes', method: 'PUT', path: '/packers/links/:id', permission: PERMISSIONS.PACKERS.MANAGE },
  { router: 'packersRoutes', method: 'POST', path: '/packers/links/:id/unlink', permission: PERMISSIONS.PACKERS.MANAGE },

  // ------------------------------------------------------------------
  // ordersRoutes.ts (mounted at /orders)
  // ------------------------------------------------------------------
  { router: 'ordersRoutes', method: 'GET', path: '/orders', permission: PERMISSIONS.ORDERS.VIEW },
  { router: 'ordersRoutes', method: 'GET', path: '/orders/:id', permission: PERMISSIONS.ORDERS.VIEW },
];
