# Requirements Document

## Introduction

A packer-role user reported seeing UI and data they should not have access to. Investigation surfaced four
defects in RelayOS's RBAC enforcement:

1. The `requirePermission` factory in `src/api/middleware.ts` treats any token with no `permissions` claim
   as a super admin (`if (!permissions) return next()`), so any pre-RBAC JWT bypasses authorization.
2. Most route files appear to rely on `authMiddleware` alone and do not declare per-endpoint permissions.
   Only `usersRoutes.ts`, `packerRoutes.ts`, and `manualRoutes.ts` are confirmed to call `requirePermission`.
3. The frontend sidebar in `public/index.html` is hardcoded; `switchTab` in `public/app.js` does not gate
   navigation by the user's permissions.
4. `src/auth/index.ts` backfills permission `*` for any legacy tenant on first login after RBAC shipped, so
   pre-RBAC tenants are silently super admins with no review prompt.

This feature audits and hardens RBAC end-to-end so a packer can only reach packer-allowed endpoints and
tabs, legacy tokens can no longer bypass authorization, and tenants get a controlled migration path.
The authoritative permission source remains `src/auth/permissions.ts` (`PERMISSIONS`, `ROLE_PRESETS`,
`hasPermission`).

## Glossary

- **Auth_Service**: Authentication logic in `src/auth/index.ts` plus `src/api/authRoutes.ts` (`/auth/login`,
  `/auth/me`, token generation, legacy backfill).
- **Auth_Middleware**: `authMiddleware` in `src/api/middleware.ts` that verifies the JWT and attaches
  `req.tenant`.
- **Permission_Middleware**: The `requirePermission(...required)` factory in `src/api/middleware.ts`.
- **Permission_Catalog**: `PERMISSIONS` constants, `ROLE_PRESETS`, and `hasPermission` in
  `src/auth/permissions.ts`.
- **API_Router**: Any Express router file under `src/api/*Routes.ts`.
- **JWT**: Signed token whose payload (`TenantPayload`) carries `tenantId`, `email`, optionally `userId`
  and `permissions: string[]`.
- **Legacy_Token**: A JWT issued before this feature deploys whose payload has no `permissions` field, or
  has `permissions === undefined`.
- **Legacy_Tenant**: A tenant whose `tenant_users` row was auto-created by the legacy fallback path in
  `loginTenant` and assigned permission `*`.
- **Frontend_Shell**: The dashboard chrome made of `public/index.html` (sidebar markup) and `public/app.js`
  (`switchTab`, `loadDashboard`, `init`).
- **Route_Permission_Map**: The reviewed mapping of every authenticated endpoint in `src/api/*Routes.ts` to
  the permission(s) required to call it, sourced from the Permission_Catalog.
- **Verification_Suite**: Automated tests added under this feature that exercise the Route_Permission_Map
  and the Frontend_Shell as a packer-role user.
- **Migration**: One-time data work and code change that converts existing Legacy_Tenants to the new RBAC
  model.

## Requirements

### Requirement 1: Close the legacy-token bypass in Permission_Middleware

**User Story:** As a security owner, I want `requirePermission` to deny requests whose token lacks a
`permissions` array, so old or forged tokens cannot bypass authorization.

#### Acceptance Criteria

1. WHEN the Permission_Middleware receives a request whose token payload has no `permissions` field, THE Permission_Middleware SHALL respond with HTTP 401 and error code `TOKEN_EXPIRED_REAUTH_REQUIRED`.
2. WHEN the Permission_Middleware receives a request whose token `permissions` array is empty, THE Permission_Middleware SHALL respond with HTTP 403 and error code `FORBIDDEN`.
3. WHEN the Permission_Middleware receives a request whose token `permissions` array contains no entry that satisfies `hasPermission` for any of the required permissions, THE Permission_Middleware SHALL respond with HTTP 403 and error code `FORBIDDEN`.
4. WHEN the Permission_Middleware receives a request whose token `permissions` array contains an entry that satisfies `hasPermission` for at least one of the required permissions, THE Permission_Middleware SHALL invoke the next handler.
5. THE Permission_Middleware SHALL include the required permission list in the body of every 403 response under `error.required`.

### Requirement 2: Comprehensive route-to-permission audit and enforcement

**User Story:** As a security owner, I want every protected API endpoint to declare a required permission
mapped to the Permission_Catalog so users cannot reach data outside their role.

#### Acceptance Criteria

1. THE Route_Permission_Map SHALL list every endpoint in `src/api/*Routes.ts` that is mounted behind Auth_Middleware, together with the required permission drawn from the `PERMISSIONS` constants in the Permission_Catalog.
2. WHERE an authenticated endpoint is intentionally available to any logged-in user (for example `/auth/me`, `/auth/logout`), THE Route_Permission_Map SHALL mark the endpoint `auth-only` and SHALL include a written justification in the same row.
3. THE following routers SHALL apply Permission_Middleware to every endpoint they expose that is not marked `auth-only` in the Route_Permission_Map: `pipelineRoutes`, `fulfillmentRoutes`, `caretakerRoutes`, `customersRoutes`, `marketingRoutes`, `knowledgeRoutes`, `whatsappRoutes`, `manualRoutes`, `dlqRoutes`, `agentRunsRoutes`, `chatbotSettingsRoutes`, `idempotencyRoutes`, `usageRoutes`, `settingsRoutes`, `healthRoutes`, `usersRoutes`, `packerRoutes`.
4. THE required permission strings declared on every endpoint SHALL be values defined under the `PERMISSIONS` object or one of its module wildcards (for example `orders.*`); ad-hoc permission strings SHALL NOT appear in route declarations.
5. IF an endpoint receives a request from a user whose permission set does not satisfy the route's declared permission, THEN THE Permission_Middleware SHALL respond with HTTP 403 and error code `FORBIDDEN`; clauses 5 through 6 govern the Permission_Middleware only and SHALL NOT prevent route handlers from returning HTTP 403 for handler-level rules such as `CANNOT_DELETE_SELF`.
6. WHEN a user whose permission set is exactly `ROLE_PRESETS.super_admin` calls any endpoint covered by Route_Permission_Map, THE API SHALL respond with the same status that the same call would produce without Permission_Middleware in place.

### Requirement 3: Frontend obtains the user's permissions from the API

**User Story:** As the dashboard frontend, I need the current user's permission list so I can render only
the tabs and actions the user is allowed to use.

#### Acceptance Criteria

1. WHEN a client calls GET `/auth/me` with a valid non-Legacy_Token, THE Auth_Service SHALL include the authenticated user's current permissions array at `data.user.permissions` in the response body.
2. WHEN a client calls GET `/auth/me` with a Legacy_Token, THE Auth_Service SHALL respond with HTTP 401 and error code `TOKEN_EXPIRED_REAUTH_REQUIRED`.
3. WHEN GET `/auth/me` returns successfully, THE Frontend_Shell SHALL store the returned permissions array in a session-scoped variable accessible to `switchTab` and the sidebar render path.
4. THE Frontend_Shell SHALL re-fetch the permissions array from `/auth/me` on full page load and SHALL NOT cache the array in `localStorage` or any persistent storage.

### Requirement 4: Sidebar and tab navigation are permission-filtered

**User Story:** As a packer-role user, I want to see only the tabs I am allowed to use so the dashboard
matches my role.

#### Acceptance Criteria

1. THE Frontend_Shell SHALL maintain a mapping from sidebar tab id (for example `pipeline`, `fulfillment`, `customers`, `whatsapp`, `inbox`, `marketing`, `knowledge`, `agents`, `caretaker`, `chatbot-config`, `manual-upload`, `collections`, `usage`, `failed`, `health`, `settings`, `users`, `overview`, `packing`) to the Permission_Catalog permission(s) required to view the tab.
2. WHEN the Frontend_Shell renders the sidebar after login, THE Frontend_Shell SHALL hide every `.sidebar-item` whose mapped permission set is not satisfied by the user's permissions per `hasPermission`.
3. WHEN every `.sidebar-item` inside a `.nav-section` is hidden, THE Frontend_Shell SHALL also hide that section's header.
4. WHEN `switchTab(tab)` is invoked for a tab whose mapped permission is not satisfied by the user's permissions, THE Frontend_Shell SHALL leave the current tab unchanged and SHALL display a toast or empty state with the message `Not authorized for this view`.
5. WHERE a sidebar item maps to more than one acceptable permission, THE Frontend_Shell SHALL render the item if at least one mapped permission is satisfied per `hasAnyPermission`.
6. WHEN the user's permission set contains the wildcard `*`, THE Frontend_Shell SHALL render every sidebar item and section.
7. WHEN the user navigates directly to a tab via deep link or programmatic call and the tab is not permitted, THE Frontend_Shell SHALL render the empty state described in clause 4 instead of fetching tab data.

### Requirement 5: Migration path for legacy tenants currently holding permission `*`

**User Story:** As a tenant owner whose account predates RBAC, I want a controlled migration so my team is
not silently downgraded and so my organisation is prompted to right-size roles.

#### Acceptance Criteria

1. THE Auth_Service SHALL stop auto-assigning permission `*` to legacy tenants during the login backfill path; THE backfill SHALL instead assign the permission set defined by `ROLE_PRESETS.super_admin` only when clause 2 applies.
2. WHERE a Legacy_Tenant has a single `tenant_users` row whose `email` equals the `tenants.email` value, THE Migration SHALL preserve that row's permission `*` so the original tenant owner retains super-admin access.
3. WHERE a tenant has more than one `tenant_users` row holding permission `*`, THE Migration SHALL include those users in a per-tenant review report and SHALL NOT change their permissions automatically.
4. THE Migration SHALL insert one `tenant_onboarding_events` row per tenant covered by clause 3, with `event_type = 'rbac_review_required'` and `event_payload` listing the affected `tenant_users.id` values.
5. WHILE a tenant has at least one `tenant_users` row holding permission `*`, THE Frontend_Shell SHALL display a banner on the Team & Roles tab that reads `Review super-admin assignments` with a link that scrolls to the affected users.
6. WHEN a tenant owner reduces a user's permissions away from `*` via the existing `PUT /users/:id/permissions` endpoint, THE Auth_Service SHALL invalidate any prior tokens for that user by requiring the user's next request to pass the Permission_Middleware against the new permission set.

### Requirement 6: Behaviour for in-flight JWTs after the fix deploys

**User Story:** As a user holding a JWT issued before the fix, I want a predictable transition so I am not
silently denied without explanation.

#### Acceptance Criteria

1. WHEN any request authenticated by a Legacy_Token reaches Permission_Middleware, THE Permission_Middleware SHALL respond with HTTP 401 and error code `TOKEN_EXPIRED_REAUTH_REQUIRED`.
2. WHEN the Frontend_Shell receives any HTTP 401 response with error code `TOKEN_EXPIRED_REAUTH_REQUIRED`, THE Frontend_Shell SHALL discard the stored token, clear in-memory permissions, and redirect to the login page.
3. THE Auth_Service SHALL include a `permissions` array on every JWT it issues after the fix deploys, even when the array is empty.
4. THE Auth_Service SHALL keep the JWT expiry value sourced from `JWT_EXPIRES_IN` unchanged so users are not forced to re-authenticate more frequently than the current policy.
5. WHEN a request authenticated by a non-Legacy_Token whose `permissions` array is empty reaches a non-`auth-only` endpoint, THE Permission_Middleware SHALL respond with HTTP 403 and error code `FORBIDDEN`.

### Requirement 7: Audit verification with a packer-role user

**User Story:** As QA, I want an automated verification that a packer-role user can only reach packer
endpoints and tabs so the reported defect cannot regress.

#### Acceptance Criteria

1. THE Verification_Suite SHALL include an automated test that authenticates a `tenant_users` row whose `user_permissions` rows equal `ROLE_PRESETS.packer` exactly.
2. WHEN the packer-role user from clause 1 sends an HTTP request to every endpoint in the Route_Permission_Map whose required permission is NOT satisfied by `ROLE_PRESETS.packer`, THE API SHALL respond with HTTP 403 and error code `FORBIDDEN`.
3. WHEN the packer-role user from clause 1 sends an HTTP request to every endpoint in the Route_Permission_Map whose required permission IS satisfied by `ROLE_PRESETS.packer`, THE API SHALL respond with a status that is not 401 or 403.
4. WHEN the packer-role user loads the Frontend_Shell, THE rendered DOM SHALL contain only the `.sidebar-item` elements whose mapped permission is satisfied by `ROLE_PRESETS.packer`.
5. WHEN `switchTab` is called with a disallowed tab id during the test from clause 4, THE Frontend_Shell SHALL not change the active tab and SHALL surface the empty state defined in Requirement 4 clause 4.
6. THE Verification_Suite SHALL run on the rbac-enforcement-audit feature branch in CI before the branch can be merged.

### Requirement 8: Authoritative permission source and drift prevention

**User Story:** As an engineer adding a new route, I want one source of truth for permissions so server,
presets, and UI cannot drift apart.

#### Acceptance Criteria

1. THE Permission_Catalog in `src/auth/permissions.ts` SHALL remain the single source of truth for permission strings, role presets, and the matcher used by Permission_Middleware and the Frontend_Shell.
2. WHEN any router file under `src/api/*Routes.ts` other than `authRoutes.ts` declares an authenticated endpoint that is not marked `auth-only` in the Route_Permission_Map, THE Verification_Suite SHALL include a CI lint check that fails the build if the endpoint declaration does not include a `requirePermission(...)` call on the same route.
3. WHEN a permission string referenced by a route declaration or by the Frontend_Shell tab map is not present in the values produced by `listAllPermissions()` and is not a valid wildcard form (for example `orders.*` or `*`), THE build SHALL fail with an error identifying the offending reference.
4. IF a router file under `src/api/*Routes.ts` other than `authRoutes.ts` defines authenticated endpoints and references no values from the Permission_Catalog at all, THEN the CI lint check from clause 2 SHALL fail the build with a message naming the router file.
5. THE Frontend_Shell tab-to-permission mapping SHALL live in a single module and SHALL be imported by both the sidebar render path and the `switchTab` guard.
