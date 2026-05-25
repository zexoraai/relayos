/**
 * Request-body fixtures for the RBAC verification suite (task 4.1).
 *
 * Keyed by `${method} ${path}` using the path AS DECLARED IN
 * `ROUTE_PERMISSION_MAP` (URL params still present, e.g. `:id`). Used by
 * `tests/rbac/packerVerification.test.ts` to send a minimally-valid body
 * for every POST/PUT/DELETE entry the suite walks.
 *
 * For the packer-role smoke test specifically, every write endpoint is
 * permission-denied (packer holds only `orders.view` / `fulfillment.view` /
 * `customers.view`), so `requirePermission` short-circuits with HTTP 403
 * before the route handler — and therefore before any zod / multer
 * validation — is reached. The bodies below are still chosen to be
 * minimally valid against the route's documented schema so that the same
 * fixture map can drive future role-based suites (operations, marketing,
 * etc.) where the request DOES reach the handler.
 *
 * Routes whose required body is genuinely empty use `{}`.
 */

export const REQUEST_BODIES: Record<string, unknown> = {
  // pipelineRoutes.ts
  'POST /pipeline/trigger/:emailId': {},
  'POST /pipeline/jobs/:id/reprocess': {},

  // fulfillmentRoutes.ts
  'POST /fulfillment/poll/:id': {},
  'POST /fulfillment/jobs/:id/cancel': { scope: 'pudo', reason: 'verification test' },

  // caretakerRoutes.ts
  'POST /caretaker/rules': { enabled: true, mode: 'shadow' },
  'POST /caretaker/evaluations/:id/resolve': { resolution: 'approved' },
  'POST /caretaker/evaluations/:id/reopen': {},

  // marketingRoutes.ts
  'POST /marketing/campaigns': { name: 'verification-test', campaign_type: 'win_back' },
  'PUT /marketing/campaigns/:id': { enabled: false },
  'DELETE /marketing/campaigns/:id': {},
  'POST /marketing/campaigns/:id/steps': { delay_days: 1 },
  'PUT /marketing/campaigns/:campaignId/steps/:stepId': { enabled: false },
  'DELETE /marketing/campaigns/:campaignId/steps/:stepId': {},

  // knowledgeRoutes.ts
  'POST /knowledge/sources/url': { url: 'https://example.com', label: 'verification-test' },
  'POST /knowledge/sources/sitemap': {
    sitemap_url: 'https://example.com/sitemap.xml',
    label: 'verification-test',
  },
  // POST /knowledge/sources/upload — multipart only, suite skips this entry.
  'POST /knowledge/sources/shopify-products': { max_products: 1 },
  'POST /knowledge/sources/:id/resync': {},
  'DELETE /knowledge/sources/:id': {},
  'POST /knowledge': { title: 'verification-test', body: 'verification-test body' },
  'PUT /knowledge/:id': { title: 'verification-test' },
  'DELETE /knowledge/:id': {},
  'POST /knowledge/__conversations/:convId/messages/:msgId/feedback': { feedback: 'up' },

  // whatsappRoutes.ts
  'POST /whatsapp/settings': {
    phone_number_id: 'verification-phone',
    access_token: 'verification-access-token-1234567890',
  },
  'DELETE /whatsapp/settings': {},
  'PUT /whatsapp/templates/:purpose': { body_text: 'Hello {{customer_name}}' },
  'POST /whatsapp/templates': {
    purpose: 'order_confirmed',
    body_text: 'Hello {{customer_name}}',
  },
  'DELETE /whatsapp/templates/:purpose': {},
  'POST /whatsapp/business-settings': {
    business_account_id: 'verification-baid',
    system_user_token: 'verification-token-1234567890',
  },
  'POST /whatsapp/templates/:purpose/submit-to-meta': {},
  'POST /whatsapp/templates/:purpose/sync-from-meta': {},
  'POST /whatsapp/test': { to: '+27000000000' },

  // manualRoutes.ts
  'POST /manual/upload-queue/:id/complete': { waybill: 'WB-VERIFY-1', pincode: '0000' },
  'POST /manual/collection-queue/:id/confirm': { note: 'verification-test' },

  // dlqRoutes.ts
  'POST /dlq/:queue/retry': { job_id: 'verification-job-1' },
  'POST /dlq/:queue/discard': { job_id: 'verification-job-1' },
  'POST /dlq/outbox/retry': { event_id: '00000000-0000-0000-0000-000000000000' },
  'POST /dlq/outbox/discard': { event_id: '00000000-0000-0000-0000-000000000000' },

  // agentRunsRoutes.ts
  'POST /agent-runs/:id/approve': {},
  'POST /agent-runs/:id/correct': { corrected_output: 'verification-corrected-output' },
  'DELETE /agent-runs/corrections/:id': {},

  // chatbotSettingsRoutes.ts
  'POST /chatbot-settings': { bot_name: 'VerifyBot' },

  // idempotencyRoutes.ts
  'DELETE /idempotency/:key': {},

  // settingsRoutes.ts
  'POST /settings/shopify-api': {
    shopify_store: 'verification.myshopify.com',
    shopify_access_token: 'shpat_verification_test_token_123456789',
  },
  'DELETE /settings/shopify-api': {},
  'POST /settings/imap': {
    imap_host: 'imap.example.com',
    imap_port: 993,
    imap_username: 'verify@example.com',
    imap_password: 'verification-password',
  },
  'DELETE /settings/imap': {},
  'POST /settings/pudo': {
    pudo_username: 'verify@example.com',
    pudo_password: 'verification-password',
    pudo_api_key: 'verification-api-key',
  },
  'DELETE /settings/pudo': {},
  'POST /settings/collection-contact': {
    contact_name: 'Verification Contact',
    contact_email: 'verify@example.com',
    contact_phone: '+27000000000',
    special_instructions: 'None',
  },

  // healthRoutes.ts
  'POST /health/check': {},

  // usersRoutes.ts
  'POST /users/invite': {
    email: 'verify-new-user@example.com',
    password: 'verification-password-123',
    role: 'viewer',
  },
  'PUT /users/:id/permissions': { permissions: ['orders.view'] },
  'PUT /users/:id': { display_name: 'verification-display-name' },
  'DELETE /users/:id': {},

  // packerRoutes.ts
  'POST /packer/orders/:id/mark-packed': { note: 'verification-test' },
  'POST /packer/orders/:id/mark-dropped-off': { note: 'verification-test' },
  'POST /packer/orders/:id/revert': {},
};
