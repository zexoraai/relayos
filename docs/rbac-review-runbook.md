# RBAC Review Required — Operator Runbook

This runbook explains how an operator handles `rbac_review_required` events emitted
by the tenant onboarding pipeline. These events are produced when the system
cannot unambiguously determine which user in a tenant should hold the
super-admin (`'*'`) permission — typically a legacy tenant where multiple
users were granted broad permissions before the RBAC enforcement audit.

Related spec: `.kiro/specs/rbac-enforcement-audit/`
Requirements covered: 5.4, 5.5

---

## 1. Find tenants that need review

Run the following SQL against the application database to list every tenant
that currently has an open `rbac_review_required` event, newest first:

```sql
SELECT tenant_id, event_payload
FROM tenant_onboarding_events
WHERE event_type = 'rbac_review_required'
ORDER BY created_at DESC;
```

Each row in the result corresponds to one tenant that needs a human decision
about which user should remain the super-admin.

---

## 2. Interpret `event_payload`

`event_payload` is a JSON object with the shape defined in
`.kiro/specs/rbac-enforcement-audit/design.md` § Data Models:

```json
{
  "tenant_id": "uuid",
  "candidate_user_ids": ["uuid", ...],
  "tenant_email": "owner@example.com",
  "reason": "ambiguous_legacy_super_admin"
}
```

Field guide:

- `tenant_id` — the tenant that needs review.
- `candidate_user_ids` — the set of users in this tenant who currently hold
  the `'*'` permission. Exactly one of these should remain the super-admin
  after resolution; the rest must be demoted.
- `tenant_email` — the owner contact for the tenant. Use this address when
  reaching out to confirm which user should keep super-admin.
- `reason` — currently always `"ambiguous_legacy_super_admin"`. This signals
  the event was opened because the legacy data did not encode a single owner.

---

## 3. Resolution workflow

Once you know which user should remain the super-admin (typically by
contacting `tenant_email`):

1. Log in as a tenant owner for the affected tenant. If no owner login is
   available, use an admin override to assume the tenant context.
2. Open the **Team & Roles** tab in the dashboard.
3. For every user listed in `candidate_user_ids` *except* the chosen
   super-admin, click the **Edit** button on that user's row. The button is
   wired to the existing `PUT /users/:id/permissions` endpoint — submitting
   the form with a non-`'*'` permission set demotes the user.
4. Repeat step 3 until exactly one user in the tenant holds `'*'`.
5. Ask the affected tenant to retry login. They will now hit the multi-user
   path in `loginTenant` (since the tenant has more than one user and a
   single unambiguous super-admin) and the login will succeed.

There is no separate "resolve event" action — the event becomes informational
once the underlying ambiguity is gone. Closing or archiving the row in
`tenant_onboarding_events` is optional and follows the team's normal
retention policy.

---

## 4. UI banner behavior

The dashboard shows a **"Review super-admin assignments"** banner on the
Team & Roles tab whenever the current tenant has more than one user holding
`'*'` (added by task 2.3 in `public/app.js`).

You do not need to dismiss the banner manually. Once you complete step 3
above and zero (or one) users in the tenant hold `'*'`, the banner
disappears automatically: `renderUsers` overwrites the tab's content on
every render, so re-rendering the Team & Roles tab — which happens after
each permission edit — removes the banner along with the rest of the
previous DOM.

If the banner still shows after edits, refresh the page or switch tabs and
return; this forces `renderUsers` to run again with the latest user data.
