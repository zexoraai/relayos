// ============================================================
// RelayOS Frontend Permission Module
//
// Mirrors src/auth/permissions.ts. The server is the source of truth — this
// file just decides which UI elements to show. Server-side requirePermission
// enforces real authorization.
//
// ------------------------------------------------------------
// TAB_PERMISSIONS audit log
// ------------------------------------------------------------
// Spec: .kiro/specs/rbac-enforcement-audit (task 2.1).
//
// Audited inputs (sources from which the canonical tab id set is derived):
//   - public/index.html           (sidebar `onclick="switchTab('<id>')"` calls)
//   - public/app.js               (literal `switchTab('<id>')` calls in handlers)
//   - public/legacy.html          (legacy sidebar `switchTab('<id>')` calls)
//
// No `data-tab="<id>"` attributes exist in either HTML file at audit time;
// tab ids are encoded exclusively as the literal first argument to
// `switchTab(...)`. If `data-tab` attributes are introduced later, re-run
// the audit and add them to this list.
//
// Catalog source of truth: src/auth/permissions.ts `PERMISSIONS` /
// `listAllPermissions()`. Every non-null value below is one of:
//   - a string returned by `listAllPermissions()`, or
//   - a `<module>.*` wildcard whose prefix is a defined PERMISSIONS module, or
//   - the universal `'*'` wildcard, or
//   - an array of any of the above.
// `null` is the documented "any authenticated user" sentinel and is reserved
// for `'overview'`.
//
// Tab ids covered (union of the three audited inputs, 19 total):
//   overview, pipeline, packing, manual-upload, collections, fulfillment,
//   customers, agents, chatbot-config, caretaker, whatsapp, marketing,
//   inbox, knowledge, users, settings, usage, failed, health.
// ============================================================

(function () {
  'use strict';

  /**
   * Tab id → required permission(s). When an array is supplied, ANY match is
   * sufficient (hasAnyPermission). Tabs not in this map are visible to all
   * authenticated users (e.g. overview).
   */
  const TAB_PERMISSIONS = {
    overview: 'dashboard.view',
    orders: 'orders.view',
    pipeline: 'pipeline.view',
    packing: 'orders.view',
    'manual-upload': 'orders.view',
    collections: 'orders.view',
    fulfillment: 'fulfillment.view',
    customers: 'customers.view',
    agents: ['agents.view', 'agents.runs.view'],
    'chatbot-config': ['prompts.view', 'prompts.manage', 'settings.view'],
    caretaker: 'caretaker.view',
    whatsapp: 'whatsapp.view',
    marketing: 'marketing.view',
    inbox: 'inbox.view',
    knowledge: 'knowledge.view',
    users: 'users.view',
    settings: 'settings.view',
    usage: 'agents.usage.view',
    failed: 'dlq.view',
    health: 'health.view',
  };

  /**
   * Match a single permission against a user's permission array.
   * Supports '*' (super admin), exact match, and 'module.*' wildcards.
   */
  function hasPermission(userPerms, required) {
    if (!Array.isArray(userPerms) || userPerms.length === 0) return false;
    if (!required) return true; // null required = no restriction
    for (const p of userPerms) {
      if (p === '*') return true;
      if (p === required) return true;
      if (p.endsWith('.*')) {
        const prefix = p.slice(0, -2);
        if (required.startsWith(prefix + '.')) return true;
      }
    }
    return false;
  }

  function hasAnyPermission(userPerms, requiredList) {
    return requiredList.some((p) => hasPermission(userPerms, p));
  }

  /**
   * Decide whether a tab id is visible to a user with the given permissions.
   */
  function canSeeTab(userPerms, tabId) {
    const req = TAB_PERMISSIONS[tabId];
    if (req === undefined) return true;       // unknown tab: don't gate
    if (req === null) return true;            // explicitly any-authenticated
    return Array.isArray(req)
      ? hasAnyPermission(userPerms, req)
      : hasPermission(userPerms, req);
  }

  /**
   * Walk every .sidebar-item and hide the ones the user can't access.
   * Each item is identified by parsing the switchTab('xxx') argument from
   * its onclick attribute. A .nav-section with zero visible items is hidden too.
   */
  function applySidebarFilter(userPerms) {
    if (!Array.isArray(userPerms)) return;
    const items = document.querySelectorAll('.sidebar-item');
    items.forEach((li) => {
      const onclick = li.getAttribute('onclick') || '';
      const match = onclick.match(/switchTab\('([^']+)'\)/);
      if (!match) return;
      const tabId = match[1];
      if (canSeeTab(userPerms, tabId)) {
        li.classList.remove('hidden');
      } else {
        li.classList.add('hidden');
      }
    });

    // Hide nav sections whose items are all hidden
    document.querySelectorAll('.nav-section').forEach((section) => {
      const visible = section.querySelectorAll('.sidebar-item:not(.hidden)');
      if (visible.length === 0) {
        section.classList.add('hidden');
      } else {
        section.classList.remove('hidden');
      }
    });
  }

  // Expose globally
  window.RelayPermissions = {
    TAB_PERMISSIONS,
    hasPermission,
    hasAnyPermission,
    canSeeTab,
    applySidebarFilter,
  };
})();
