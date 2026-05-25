/**
 * Verify that `public/permissions.js` `applySidebarFilter` produces the
 * expected visible/hidden partition over the sidebar elements declared in
 * `public/index.html`.
 *
 * This test is the DOM-layer twin of the packer route-coverage test in
 * `tests/rbac/packerVerification.test.ts`. It loads the production HTML and
 * the production permissions module into a JSDOM window, runs
 * `applySidebarFilter(...)` against `ROLE_PRESETS.packer` and
 * `ROLE_PRESETS.super_admin`, and asserts the exact visibility properties the
 * design's Property 3 calls out.
 *
 * Validates: Requirements 4.2, 4.3, 4.5, 4.6, 7.4
 * Design:    §Testing Strategy > DOM tests; §Correctness Properties > Property 3
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ROLE_PRESETS } from '../../src/auth/permissions';

// Read the production assets once at module load. We deliberately re-evaluate
// `permissions.js` per JSDOM instance (each test gets a fresh window) so the
// `(function () { ... window.RelayPermissions = ... })()` IIFE can re-attach
// against an isolated DOM.
const PUBLIC_DIR = resolve(__dirname, '..', '..', 'public');
const INDEX_HTML = readFileSync(resolve(PUBLIC_DIR, 'index.html'), 'utf8');
const PERMISSIONS_JS = readFileSync(resolve(PUBLIC_DIR, 'permissions.js'), 'utf8');

/**
 * Surface of `window.RelayPermissions` we depend on. Mirrors the exports of
 * `public/permissions.js`. Typed loosely because the module is plain JS.
 */
interface RelayPermissionsSurface {
  TAB_PERMISSIONS: Record<string, string | string[] | null | undefined>;
  hasPermission(userPerms: string[], required: string): boolean;
  hasAnyPermission(userPerms: string[], required: string[]): boolean;
  canSeeTab(userPerms: string[], tabId: string): boolean;
  applySidebarFilter(userPerms: string[]): void;
}

/**
 * Build a fresh JSDOM with the production sidebar HTML and evaluate
 * `permissions.js` inside it so `window.RelayPermissions` is attached.
 *
 * `runScripts: 'outside-only'` lets us call `window.eval(...)` ourselves
 * without auto-executing any `<script>` tags from `index.html` (those would
 * try to load `app.js`, `permissions.js`, lucide CDN, etc. and noisily fail).
 */
function loadSidebarDom(): { dom: JSDOM; relay: RelayPermissionsSurface } {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'outside-only' });
  dom.window.eval(PERMISSIONS_JS);
  const relay = (dom.window as unknown as { RelayPermissions?: RelayPermissionsSurface })
    .RelayPermissions;
  if (!relay) {
    throw new Error(
      'permissions.js did not attach window.RelayPermissions (did the IIFE throw?)',
    );
  }
  return { dom, relay };
}

/**
 * Resolve the tab id for a `.sidebar-item`, mirroring the parser in
 * `applySidebarFilter`: prefer `data-tab` if present, otherwise parse the
 * literal first argument of the `switchTab('<id>')` call in `onclick`.
 */
function resolveTabId(item: Element): string | null {
  const dataTab = (item as HTMLElement).dataset?.tab;
  if (dataTab) return dataTab;
  const onclick = item.getAttribute('onclick') || '';
  const match = onclick.match(/switchTab\('([^']+)'\)/);
  return match ? match[1] : null;
}

describe('public/permissions.js — applySidebarFilter against role presets', () => {
  it('packer: each .sidebar-item is hidden iff canSeeTab(packer, tabId) is false', () => {
    const { dom, relay } = loadSidebarDom();
    const packer = ROLE_PRESETS.packer;

    relay.applySidebarFilter(packer);

    const items = Array.from(
      dom.window.document.querySelectorAll('.sidebar-item'),
    );
    expect(items.length, 'sidebar must contain at least one .sidebar-item').toBeGreaterThan(0);

    let visibleCount = 0;
    let hiddenCount = 0;

    for (const item of items) {
      const tabId = resolveTabId(item);
      expect(tabId, 'every .sidebar-item must encode a tab id via data-tab or onclick').toBeTruthy();

      const expectedVisible = relay.canSeeTab(packer, tabId as string);
      const isHidden = item.classList.contains('hidden');

      expect(
        isHidden,
        `tab='${tabId}' hidden=${isHidden} but canSeeTab(packer,'${tabId}')=${expectedVisible}`,
      ).toBe(!expectedVisible);

      if (expectedVisible) visibleCount += 1;
      else hiddenCount += 1;
    }

    // Sanity: the packer preset should produce a non-trivial partition (at
    // least one item visible, at least one item hidden). If either side is 0
    // we have a configuration regression that would silently pass the
    // per-item check above.
    expect(visibleCount, 'packer must have at least one visible tab').toBeGreaterThan(0);
    expect(hiddenCount, 'packer must have at least one hidden tab').toBeGreaterThan(0);
  });

  it('packer: each .nav-section is hidden iff every contained .sidebar-item is hidden', () => {
    const { dom, relay } = loadSidebarDom();
    relay.applySidebarFilter(ROLE_PRESETS.packer);

    const sections = Array.from(
      dom.window.document.querySelectorAll('.nav-section'),
    );
    expect(sections.length, 'sidebar must contain at least one .nav-section').toBeGreaterThan(0);

    for (const section of sections) {
      const sectionItems = Array.from(section.querySelectorAll('.sidebar-item'));
      // A section that has no items is excluded from the iff: skip it (the
      // production sidebar always populates each .nav-section, but guard
      // anyway so a future empty-by-design header doesn't break the test).
      if (sectionItems.length === 0) continue;

      const allHidden = sectionItems.every((i) => i.classList.contains('hidden'));
      const sectionHidden = section.classList.contains('hidden');

      expect(
        sectionHidden,
        `section hidden=${sectionHidden} but allItemsHidden=${allHidden}`,
      ).toBe(allHidden);
    }
  });

  it('super_admin: every .sidebar-item and every .nav-section is visible', () => {
    const { dom, relay } = loadSidebarDom();
    const superAdmin = ROLE_PRESETS.super_admin;

    relay.applySidebarFilter(superAdmin);

    const items = Array.from(
      dom.window.document.querySelectorAll('.sidebar-item'),
    );
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      const tabId = resolveTabId(item);
      expect(tabId).toBeTruthy();
      expect(
        relay.canSeeTab(superAdmin, tabId as string),
        `super_admin must see tab '${tabId}'`,
      ).toBe(true);
      expect(
        item.classList.contains('hidden'),
        `super_admin tab '${tabId}' must not be hidden`,
      ).toBe(false);
    }

    const sections = Array.from(
      dom.window.document.querySelectorAll('.nav-section'),
    );
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(
        section.classList.contains('hidden'),
        'super_admin must not hide any .nav-section',
      ).toBe(false);
    }
  });
});
