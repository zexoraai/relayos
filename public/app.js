// ============================================================
// RelayOS Dashboard — app.js
// ============================================================

const API = '';
let token = localStorage.getItem('token');
let currentTab = 'overview';
let currentUserPermissions = []; // populated on /auth/me; gates sidebar + switchTab
let pipelineJobs = [];
let fulfillmentJobs = [];

// ---- Helpers ----

function toast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const colors = { success: 'bg-green-500', error: 'bg-red-500', info: 'bg-indigo-500', warning: 'bg-amber-500' };
  const el = document.createElement('div');
  el.className = `${colors[type] || colors.info} text-white px-5 py-3 rounded-2xl text-sm font-medium shadow-lg animate-fadeUp max-w-sm`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
}

function openModal(title, bodyHtml, footerHtml = '') {
  // The `modal-mobile-sheet` class transforms the modal into a bottom-sheet
  // on screens narrower than 768px (rule lives in public/index.html <style>).
  // On desktop it has no visual effect — the centered card layout wins.
  document.getElementById('modal-root').innerHTML = `
    <div class="fixed inset-0 bg-black/40 modal-backdrop z-[1000] flex items-center justify-center p-4 modal-mobile-sheet" onclick="closeModal(event)">
      <div class="bg-white rounded-3xl shadow-elevated w-full max-w-lg max-h-[85vh] overflow-y-auto animate-fadeUp" onclick="event.stopPropagation()">
        <!-- Drag handle (mobile bottom-sheet affordance) -->
        <div class="md:hidden w-12 h-1.5 bg-gray-300 rounded-full mx-auto mt-3"></div>
        <div class="flex items-center justify-between p-4 md:p-6 md:border-b border-gray-100">
          <h2 class="text-lg font-bold">${title}</h2>
          <button onclick="closeModal()" aria-label="Close" class="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 active:scale-95 flex items-center justify-center text-gray-600 text-lg transition-all">&times;</button>
        </div>
        <div class="px-4 pb-4 md:p-6 md:pt-0">${bodyHtml}</div>
        ${footerHtml ? `<div class="flex flex-col-reverse md:flex-row md:justify-end gap-2 px-4 pb-4 md:p-6 md:pt-0">${footerHtml}</div>` : ''}
      </div>
    </div>`;
}
function closeModal(e) {
  if (e && e.target && !e.target.classList.contains('modal-backdrop')) return;
  document.getElementById('modal-root').innerHTML = '';
}

function escapeHtml(str) { return (str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/**
 * Mobile-responsive table decorator.
 *
 * Tables in this app are rendered ad-hoc by a couple dozen tab functions and
 * we don't want to touch every renderer. Instead, watch #tab-content for
 * mutations and on every new <table>:
 *   1. Add the `responsive-table` class so the mobile CSS can transform
 *      rows into card stacks below 768px.
 *   2. Copy each <th>'s text into `data-label` on the matching <td> so the
 *      stacked card view shows column labels next to values.
 * Idempotent: skips tables already decorated.
 */
function decorateResponsiveTable(table) {
  if (!table || table.dataset.respDone === '1') return;
  table.classList.add('responsive-table');
  const headers = Array.from(table.querySelectorAll('thead th')).map((th) =>
    (th.textContent || '').trim(),
  );
  if (headers.length > 0) {
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const cells = tr.querySelectorAll('td');
      cells.forEach((td, i) => {
        if (!td.hasAttribute('data-label') && headers[i]) {
          td.setAttribute('data-label', headers[i]);
        }
      });
    });
  }
  table.dataset.respDone = '1';
}

function _installResponsiveTableObserver() {
  const root = document.getElementById('tab-content');
  if (!root) {
    // tab-content isn't in the DOM yet (login screen). Try again later.
    setTimeout(_installResponsiveTableObserver, 250);
    return;
  }
  const decorateAll = () => root.querySelectorAll('table').forEach(decorateResponsiveTable);
  decorateAll();
  new MutationObserver(decorateAll).observe(root, { childList: true, subtree: true });
}
document.addEventListener('DOMContentLoaded', _installResponsiveTableObserver);
// In case the script runs after DOMContentLoaded (defer/async):
if (document.readyState !== 'loading') _installResponsiveTableObserver();

/* ============================================================
   Mobile accordions and list/detail flow.
   ============================================================ */

// Click handler for [data-mobile-accordion] cards. Toggles `.expanded`.
// Wired once globally so dynamically-rendered cards inherit it.
document.addEventListener('click', (ev) => {
  if (window.innerWidth >= 768) return;
  const card = ev.target.closest('[data-mobile-accordion]');
  if (!card) return;
  const trigger = card.querySelector(':scope > h3');
  // Only toggle when the click landed on the heading (or its pseudo arrow).
  // Clicking inputs / buttons inside the card while expanded must NOT collapse.
  if (!trigger || !trigger.contains(ev.target)) return;
  card.classList.toggle('expanded');
});

/**
 * Open the detail pane on mobile.
 * - panelId: the id of the detail pane element (e.g. 'customer-detail-panel')
 * Adds body.detail-open which hides every other top-level grid child via CSS,
 * and reveals the back button. No-op on desktop.
 */
function openMobileDetail(panelId) {
  if (window.innerWidth >= 768) return;
  const panel = document.getElementById(panelId);
  if (!panel) return;
  // Tag this panel so the CSS rule keeps it visible while siblings hide.
  panel.setAttribute('data-mobile-detail', '1');
  document.body.classList.add('detail-open');
  // Scroll detail pane into view (handles cases where the user was deep-scrolled in the list).
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

function closeMobileDetail() {
  document.body.classList.remove('detail-open');
}

/**
 * Auto-tag Settings cards (and any other section explicitly marked) as
 * accordions on mobile. Runs whenever #tab-content changes.
 */
function _decorateMobileEnhancements(root) {
  // Settings tab: every direct child card with a leading <h3> becomes an accordion.
  // We detect via a sentinel attribute or by being in the Settings tab's grid.
  // Easiest signal: the container holding those cards has class chain
  // `grid grid-cols-1 md:grid-cols-2 gap-6` and immediate-child <div class="bg-white rounded-3xl ...">
  // Instead of guessing, the Settings renderer can opt-in by tagging the wrapper
  // — but for backwards compatibility we also do best-effort detection via
  // a stable Settings marker: the presence of #set-shop-store input.
  if (root.querySelector('#set-shop-store')) {
    root.querySelectorAll('.bg-white.rounded-3xl.shadow-card').forEach((card, idx) => {
      if (card.dataset.mobileAccordion) return;
      // Only cards with a leading <h3> are real sections.
      const firstHeading = card.querySelector(':scope > h3');
      if (!firstHeading) return;
      card.setAttribute('data-mobile-accordion', '1');
      // First card defaults to expanded so users land on something useful.
      if (idx === 0) card.classList.add('expanded');
    });
  }
}

function _installMobileEnhancementsObserver() {
  const root = document.getElementById('tab-content');
  if (!root) { setTimeout(_installMobileEnhancementsObserver, 250); return; }
  // Whenever tab content swaps, re-decorate and reset detail-pane state so
  // the mobile back button never appears stuck after a tab change.
  const tick = () => {
    document.body.classList.remove('detail-open');
    _decorateMobileEnhancements(root);
  };
  tick();
  new MutationObserver(tick).observe(root, { childList: true });
}
document.addEventListener('DOMContentLoaded', _installMobileEnhancementsObserver);
if (document.readyState !== 'loading') _installMobileEnhancementsObserver();

function showPage(page) {
  document.getElementById('auth-container').classList.remove('hidden');
  document.getElementById('app-layout').classList.add('hidden');
  document.querySelectorAll('[id^="page-"]').forEach(el => el.classList.add('hidden'));
  document.getElementById('page-' + page).classList.remove('hidden');
}
function showApp() {
  document.getElementById('auth-container').classList.add('hidden');
  document.getElementById('app-layout').classList.remove('hidden');
}
function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(API + path, opts);
    const data = await res.json();
    if (res.status === 401) {
      // Force re-login on legacy / expired tokens
      const code = data && data.error && data.error.code;
      if (code === 'TOKEN_EXPIRED_REAUTH_REQUIRED' || code === 'INVALID_TOKEN' || code === 'UNAUTHORIZED') {
        token = null; currentUserPermissions = [];
        localStorage.removeItem('token');
        showPage('login');
        if (code === 'TOKEN_EXPIRED_REAUTH_REQUIRED') {
          toast('Session expired — please log in again', 'warning', 5000);
        }
      } else {
        token = null; localStorage.removeItem('token'); showPage('login');
      }
    }
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: { success: false, error: { message: e.message } } }; }
}

// ---- Auth ----

async function doRegister() {
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;
  const confirm_password = document.getElementById('reg-confirm').value;
  const { data } = await api('POST', '/auth/register', { email, password, confirm_password });
  if (!data.success) return showError('reg-error', data.error.message);
  const login = await api('POST', '/auth/login', { email, password });
  if (login.data.success) { token = login.data.data.token; localStorage.setItem('token', token); loadOnboarding(); }
}
async function doLogin() {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const { data } = await api('POST', '/auth/login', { email, password });
  if (!data.success) return showError('login-error', data.error.message);
  token = data.data.token; localStorage.setItem('token', token);
  if (data.data.tenant.status === 'active') loadDashboard(); else loadOnboarding();
}
function doLogout() { token = null; currentUserPermissions = []; localStorage.removeItem('token'); showPage('login'); }

// ---- Onboarding ----

async function loadOnboarding() {
  showPage('onboarding');
  const { data } = await api('GET', '/onboarding/status');
  if (!data.success) return showPage('login');
  if (data.data.status === 'active') return loadDashboard();
  renderOnboardingStep(data.data);
}
function renderOnboardingStep(s) {
  const steps = ['ecommerce_platform_selected','ecommerce_integration_configured','courier_selected','courier_configured','completed'];
  const idx = steps.indexOf(s.onboarding_step);
  for (let i=0;i<5;i++) {
    const el = document.getElementById('step-'+(i+1));
    el.className = 'flex-1 h-1 rounded-full transition-all ' + (i<idx ? 'bg-green-400' : i===idx||(idx===-1&&i===0) ? 'bg-brand-400' : 'bg-gray-200');
  }
  const c = document.getElementById('onboarding-content');
  const skippedEnrichment = localStorage.getItem('skipped_enrichment') === 'true';
  if (!s.ecommerce_platform||s.onboarding_step==='account_created') c.innerHTML=renderPlatformSelection();
  else if (s.ecommerce_platform==='shopify'&&!s.shopify_plan) c.innerHTML=renderShopifyPlanSelection();
  else if (!s.ecommerce_configured) c.innerHTML=s.shopify_plan==='basic'?renderImapForm():renderShopifyApiForm();
  else if (s.shopify_plan==='basic' && !skippedEnrichment && !window._shopifyApiConfigured) c.innerHTML = renderShopifyBasicEnrichmentPrompt();
  else if (!s.courier) c.innerHTML=renderCourierSelection();
  else if (!s.courier_configured) c.innerHTML=renderPudoForm();
  else c.innerHTML=renderComplete();
}
function skipShopifyEnrichment() { localStorage.setItem('skipped_enrichment', 'true'); loadOnboarding(); }
function renderPlatformSelection(){return `<h2 class="text-lg font-bold mb-4">Choose platform</h2><div class="grid grid-cols-2 gap-3"><div class="border-2 border-gray-200 rounded-2xl p-5 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-all" onclick="selectPlatform('shopify')"><div class="font-semibold">Shopify</div><div class="text-xs text-gray-400 mt-1">Active</div></div><div class="border-2 border-gray-200 rounded-2xl p-5 text-center opacity-40 cursor-not-allowed"><div class="font-semibold">WooCommerce</div><div class="text-xs text-amber-500 mt-1">Coming Soon</div></div></div>`;}
function renderShopifyPlanSelection(){return `<h2 class="text-lg font-bold mb-4">Shopify plan</h2><div class="grid grid-cols-2 gap-3"><div class="border-2 border-gray-200 rounded-2xl p-5 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-all" onclick="selectPlan('basic')"><div class="font-semibold">Basic</div><div class="text-xs text-gray-400 mt-1">Email</div></div><div class="border-2 border-gray-200 rounded-2xl p-5 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-all" onclick="selectPlan('grow')"><div class="font-semibold">Grow</div><div class="text-xs text-gray-400 mt-1">API</div></div><div class="border-2 border-gray-200 rounded-2xl p-5 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-all" onclick="selectPlan('advanced')"><div class="font-semibold">Advanced</div><div class="text-xs text-gray-400 mt-1">API</div></div><div class="border-2 border-gray-200 rounded-2xl p-5 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-all" onclick="selectPlan('plus')"><div class="font-semibold">Plus</div><div class="text-xs text-gray-400 mt-1">API</div></div></div>`;}
function renderImapForm(){return `<h2 class="text-lg font-bold mb-1">IMAP Settings</h2><p class="text-sm text-gray-400 mb-5">For Shopify order email ingestion</p><div class="space-y-3"><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Host</label><input id="imap-host" placeholder="imap.gmail.com" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Port</label><input id="imap-port" value="993" type="number" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Username</label><input id="imap-user" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Password</label><input id="imap-pass" type="password" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Mailbox</label><input id="imap-mailbox" value="INBOX" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div></div><button onclick="saveImapSettings()" class="w-full mt-5 py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Save and Continue</button>`;}
function renderShopifyApiForm(){return `<h2 class="text-lg font-bold mb-1">Shopify API</h2><p class="text-sm text-gray-400 mb-5">Required for Grow/Advanced/Plus</p><div class="space-y-3"><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Store URL</label><input id="shopify-store" placeholder="yourstore.myshopify.com" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Access Token</label><input id="shopify-token" type="password" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div></div><button onclick="saveShopifyApi()" class="w-full mt-5 py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Save</button>`;}
function renderShopifyBasicEnrichmentPrompt(){return `<h2 class="text-lg font-bold mb-1">Optional: Shopify API</h2><p class="text-sm text-gray-400 mb-5">Enrich orders with line items. Skip to add later.</p><div class="space-y-3"><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Store URL</label><input id="shopify-store" placeholder="yourstore.myshopify.com" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Access Token</label><input id="shopify-token" type="password" placeholder="shpat_..." class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div></div><div class="flex gap-3 mt-5"><button onclick="saveShopifyApi()" class="flex-1 py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Save</button><button onclick="skipShopifyEnrichment()" class="flex-1 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full transition-all">Skip</button></div>`;}
function renderCourierSelection(){return `<h2 class="text-lg font-bold mb-4">Choose courier</h2><div class="grid grid-cols-2 gap-3"><div class="border-2 border-gray-200 rounded-2xl p-5 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-all" onclick="selectCourier('pudo')"><div class="font-semibold">PUDO</div><div class="text-xs text-gray-400 mt-1">Active</div></div><div class="border-2 border-gray-200 rounded-2xl p-5 text-center opacity-40 cursor-not-allowed"><div class="font-semibold">The Courier Guy</div><div class="text-xs text-amber-500 mt-1">Coming Soon</div></div><div class="border-2 border-gray-200 rounded-2xl p-5 text-center opacity-40 cursor-not-allowed"><div class="font-semibold">DHL</div><div class="text-xs text-amber-500 mt-1">Coming Soon</div></div><div class="border-2 border-gray-200 rounded-2xl p-5 text-center opacity-40 cursor-not-allowed"><div class="font-semibold">Aramex</div><div class="text-xs text-amber-500 mt-1">Coming Soon</div></div></div>`;}
function renderPudoForm(){return `<h2 class="text-lg font-bold mb-1">PUDO Credentials</h2><p class="text-sm text-gray-400 mb-5">Connect your PUDO account</p><div class="space-y-3"><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Email</label><input id="pudo-user" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Password</label><input id="pudo-pass" type="password" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div><div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">API Key</label><input id="pudo-key" type="password" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm focus:ring-2 focus:ring-brand-400 border-0"></div></div><button onclick="savePudoSettings()" class="w-full mt-5 py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Save</button>`;}
function renderComplete(){return `<div class="text-center py-8"><div class="text-4xl mb-3">&#10003;</div><h2 class="text-lg font-bold mb-2">All set</h2><p class="text-sm text-gray-400 mb-6">Your account is configured and ready.</p><button onclick="completeOnboarding()" class="py-3 px-8 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Launch Dashboard</button></div>`;}

async function selectPlatform(p){const{data}=await api('POST','/onboarding/ecommerce-platform',{platform:p});if(!data.success)return showError('onboarding-error',data.error?.message);if(data.data.platform_status==='coming_soon')return showError('onboarding-error',data.data.message);loadOnboarding();}
async function selectPlan(p){const{data}=await api('POST','/onboarding/shopify-plan',{plan:p});if(!data.success)return showError('onboarding-error',data.error.message);loadOnboarding();}
async function saveImapSettings(){const b={imap_host:document.getElementById('imap-host').value,imap_port:document.getElementById('imap-port').value,imap_username:document.getElementById('imap-user').value,imap_password:document.getElementById('imap-pass').value,imap_mailbox:document.getElementById('imap-mailbox').value};const{data}=await api('POST','/onboarding/shopify-basic/imap-settings',b);if(!data.success)return showError('onboarding-error',data.error.message);loadOnboarding();}
async function saveShopifyApi(){const b={shopify_store:document.getElementById('shopify-store').value,shopify_access_token:document.getElementById('shopify-token').value};const{data}=await api('POST','/onboarding/shopify-api/settings',b);if(!data.success)return showError('onboarding-error',data.error.message);window._shopifyApiConfigured=true;localStorage.setItem('skipped_enrichment','true');loadOnboarding();}
async function selectCourier(c){const{data}=await api('POST','/onboarding/courier',{courier:c});if(!data.success)return showError('onboarding-error',data.error?.message);if(data.data.courier_status==='coming_soon')return showError('onboarding-error',data.data.message);loadOnboarding();}
async function savePudoSettings(){const b={pudo_username:document.getElementById('pudo-user').value,pudo_password:document.getElementById('pudo-pass').value,pudo_api_key:document.getElementById('pudo-key').value};const{data}=await api('POST','/onboarding/courier/pudo-settings',b);if(!data.success)return showError('onboarding-error',data.error.message);loadOnboarding();}
async function completeOnboarding(){const{data}=await api('POST','/onboarding/complete');if(!data.success)return showError('onboarding-error',data.error.message);loadDashboard();}

// ---- Dashboard ----

async function loadDashboard() {
  // Refresh permissions from server before showing the app shell. /auth/me
  // returns the live permission list (not the JWT snapshot), so freshly-edited
  // roles take effect on the next page load.
  const meRes = await api('GET', '/auth/me');
  if (meRes.status === 200 && meRes.data && meRes.data.success) {
    currentUserPermissions = (meRes.data.data.user && meRes.data.data.user.permissions) || [];
  } else {
    // /auth/me failed — api() already redirected to login on 401
    return;
  }
  showApp();
  if (window.RelayPermissions) window.RelayPermissions.applySidebarFilter(currentUserPermissions);
  // Pick a tab the user can actually see (defaults to overview)
  const firstAllowedTab = pickFirstAllowedTab();
  switchTab(firstAllowedTab);
}

function pickFirstAllowedTab() {
  if (!window.RelayPermissions) return 'overview';
  if (window.RelayPermissions.canSeeTab(currentUserPermissions, 'overview')) return 'overview';
  // Try the tabs in display order
  const order = ['pipeline','packing','manual-upload','collections','fulfillment','customers','agents','chatbot-config','caretaker','whatsapp','marketing','inbox','knowledge','users','settings','usage','failed','health'];
  for (const t of order) {
    if (window.RelayPermissions.canSeeTab(currentUserPermissions, t)) return t;
  }
  return 'overview';
}

/**
 * Render a stable empty-state panel into `container` when the current user
 * is not allowed to see `tab`. Idempotent: calling it twice with the same
 * arguments produces the same DOM (the inner `#forbidden-state` panel is
 * reused if it already exists, otherwise the container is cleared and the
 * panel is appended).
 *
 * The secondary line names the missing permission set, sourced from
 * RelayPermissions.TAB_PERMISSIONS so the explanation matches the check
 * performed in canSeeTab. Designed to render into the active content area
 * (e.g. #tab-content), not document.body, so deep-link / hash-routing
 * invocations of switchTab still produce the panel inline.
 */
function renderForbiddenState(container, tab) {
  if (!container) return;
  const tabPerms = (window.RelayPermissions && window.RelayPermissions.TAB_PERMISSIONS) || {};
  const required = tabPerms[tab];
  let detail = '';
  if (Array.isArray(required)) {
    if (required.length > 0) detail = 'Requires permission: ' + required.join(' or ');
  } else if (typeof required === 'string' && required) {
    detail = 'Requires permission: ' + required;
  }

  let panel = container.querySelector('#forbidden-state');
  if (!panel) {
    container.innerHTML = '';
    panel = document.createElement('div');
    panel.id = 'forbidden-state';
    panel.className = 'flex flex-col items-center justify-center py-20 text-center';
    container.appendChild(panel);
  }
  panel.innerHTML =
    '<div class="text-4xl opacity-20 mb-3">&#128274;</div>' +
    '<h3 class="font-semibold text-base mb-1">Not authorized for this view</h3>' +
    (detail
      ? '<p class="text-sm text-gray-400 max-w-xs mx-auto">' + escapeHtml(detail) + '</p>'
      : '');
}

function switchTab(tab) {
  // Frontend guard. Server-side requirePermission is the real enforcement —
  // this just keeps the UI from showing forbidden views to the user.
  if (window.RelayPermissions && !window.RelayPermissions.canSeeTab(currentUserPermissions, tab)) {
    // Do NOT mutate currentTab and do NOT call the per-tab loader. Render a
    // stable empty-state panel into the currently-active content area so a
    // direct deep link to a forbidden tab leaves a clear explanation in
    // place of the previous view.
    const activeContainer = document.getElementById('tab-content');
    renderForbiddenState(activeContainer, tab);
    return;
  }
  currentTab = tab;
  document.getElementById('page-title').textContent = tab.charAt(0).toUpperCase() + tab.slice(1);
  const subtitles = { overview:'Welcome back', pipeline:'Order ingestion pipeline', packing:'Pack and drop off orders', fulfillment:'Tracking & delivery', agents:'AI agent configuration', 'chatbot-config':'Chatbot personality and behavior', caretaker:'Order review rules', whatsapp:'Messaging & notifications', inbox:'Customer conversations', knowledge:'Knowledge base', customers:'Customer directory', users:'Team members and permissions', usage:'AI token & cost tracking', failed:'Dead-letter queues', health:'System status', settings:'Account configuration' };
  document.getElementById('page-subtitle').textContent = subtitles[tab] || '';
  document.querySelectorAll('.sidebar-item').forEach(li => li.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(li => { const txt = li.querySelector('span'); if(txt && txt.textContent.toLowerCase()===tab) li.classList.add('active'); });
  document.getElementById('tab-content').innerHTML = '<div class="flex items-center justify-center py-20"><div class="w-6 h-6 border-2 border-brand-400 border-t-transparent rounded-full animate-spin"></div></div>';
  if (tab === 'overview') renderOverview();
  else if (tab === 'pipeline') renderPipeline();
  else if (tab === 'packing') renderPacking();
  else if (tab === 'manual-upload') renderManualUpload();
  else if (tab === 'collections') renderCollections();
  else if (tab === 'fulfillment') renderFulfillment();
  else if (tab === 'agents') renderAgents();
  else if (tab === 'chatbot-config') renderChatbotConfig();
  else if (tab === 'caretaker') renderCaretaker();
  else if (tab === 'whatsapp') renderWhatsApp();
  else if (tab === 'marketing') renderMarketing();
  else if (tab === 'inbox') renderInbox();
  else if (tab === 'knowledge') renderKnowledge();
  else if (tab === 'customers') renderCustomers();
  else if (tab === 'users') renderUsers();
  else if (tab === 'usage') renderUsage();
  else if (tab === 'failed') renderFailed();
  else if (tab === 'health') renderHealth();
  else if (tab === 'settings') renderSettings();
}


// ---- Overview ----

async function renderOverview() {
  const [statusRes, statsRes, jobsRes, fulfillRes] = await Promise.all([
    api('GET','/onboarding/status'), api('GET','/pipeline/stats'),
    api('GET','/pipeline/jobs?limit=6'), api('GET','/fulfillment/jobs?limit=5'),
  ]);
  const s = statusRes.data.success ? statusRes.data.data : {};
  const st = statsRes.data.success ? statsRes.data.data : {total:0,by_status:{}};
  const jobs = jobsRes.data.success ? jobsRes.data.data.jobs : [];
  const fJobs = fulfillRes.data.success ? fulfillRes.data.data.jobs : [];

  let html = '';
  // Stats row
  html += `<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">`;
  html += statCard('Total Orders', st.total, 'text-gray-900');
  html += statCard('Completed', st.by_status.completed||0, 'text-green-600');
  html += statCard('Processing', st.by_status.processing||0, 'text-blue-600');
  html += statCard('Failed', st.by_status.failed||0, 'text-red-500');
  html += `</div>`;

  // Two column
  html += `<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">`;

  // Left: Activity
  html += `<div class="lg:col-span-2">`;
  html += `<div class="bg-white rounded-3xl shadow-card p-6">`;
  html += `<div class="flex items-center justify-between mb-5"><h3 class="font-bold text-base">Recent Activity</h3><button onclick="switchTab('pipeline')" class="text-xs text-brand-600 font-semibold hover:underline">View all</button></div>`;
  if (jobs.length === 0) {
    html += emptyState('No activity yet', 'Send an order email to trigger the pipeline.');
  } else {
    html += `<div class="space-y-3">`;
    jobs.forEach(j => {
      const time = new Date(j.created_at).toLocaleString();
      const stage = j.current_stage.replace(/_/g, ' ').toLowerCase();
      html += `<div class="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">`;
      html += `<div><div class="text-sm font-medium capitalize">${stage}</div><div class="text-xs text-gray-400">${time}</div></div>`;
      html += badge(j.status);
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div></div>`;

  // Right column
  html += `<div class="space-y-6">`;
  // Account card
  html += `<div class="bg-white rounded-3xl shadow-card p-6">`;
  html += `<h3 class="font-bold text-base mb-4">Account</h3>`;
  html += `<div class="space-y-3 text-sm">`;
  html += infoRow('Status', `<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-green-400"></span>${s.status||'-'}</span>`);
  html += infoRow('Platform', s.ecommerce_platform||'-');
  html += infoRow('Plan', s.shopify_plan||'-');
  html += infoRow('Courier', (s.courier||'-').toUpperCase());
  html += `</div></div>`;

  // Agents mini
  html += `<div class="bg-dark-800 rounded-3xl p-6 text-white">`;
  html += `<div class="flex items-center justify-between mb-4"><h3 class="font-bold text-base">AI Agents</h3><button onclick="switchTab('agents')" class="text-xs text-brand-400 font-semibold hover:underline">Details</button></div>`;
  ['Data Extraction','Caretaker AI','Intent Router','Order Support','Tenant Info'].forEach(name => {
    html += `<div class="flex items-center gap-3 py-1.5"><span class="w-2 h-2 rounded-full bg-green-400 pulse-dot"></span><span class="text-sm text-gray-300">${name}</span></div>`;
  });
  html += `</div>`;

  // Fulfillment mini
  html += `<div class="bg-white rounded-3xl shadow-card p-6">`;
  html += `<div class="flex items-center justify-between mb-4"><h3 class="font-bold text-base">Fulfillment</h3><button onclick="switchTab('fulfillment')" class="text-xs text-brand-600 font-semibold hover:underline">View</button></div>`;
  if (fJobs.length === 0) {
    html += `<p class="text-sm text-gray-400">No active jobs</p>`;
  } else {
    fJobs.slice(0,4).forEach(j => {
      const m = (j.milestone||'pending').replace(/_/g,' ');
      html += `<div class="flex items-center justify-between py-1.5"><span class="text-sm text-gray-600">${j.waybill||'-'}</span>${badge(j.milestone==='delivered'?'completed':j.milestone==='cancelled'||j.milestone==='failed'?'failed':'processing', m)}</div>`;
    });
  }
  html += `</div>`;
  html += `</div>`; // right col
  html += `</div>`; // grid

  // Agent Runs section
  html += `<div class="bg-white rounded-3xl shadow-card p-6 mt-6">`;
  html += `<div class="flex items-center justify-between mb-4"><h3 class="font-bold text-base">Recent Agent Runs</h3><button onclick="loadAgentRuns()" class="text-xs text-brand-600 font-semibold hover:underline">Refresh</button></div>`;
  html += `<div id="agent-runs-panel"><p class="text-sm text-gray-400">Loading...</p></div>`;
  html += `</div>`;

  document.getElementById('tab-content').innerHTML = html;
  loadAgentRuns();
}

function statCard(label, value, colorClass='text-gray-900') {
  return `<div class="bg-white rounded-2xl shadow-card p-5 hover:shadow-card-hover transition-all hover:-translate-y-0.5 cursor-default"><div class="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">${label}</div><div class="text-3xl font-bold ${colorClass} tracking-tight">${value}</div></div>`;
}
function badge(status, text) {
  const t = text || status;
  const colors = { completed:'bg-green-50 text-green-600', active:'bg-green-50 text-green-600', processing:'bg-blue-50 text-blue-600', failed:'bg-red-50 text-red-500', pending_review:'bg-amber-50 text-amber-600', rejected:'bg-red-50 text-red-500' };
  return `<span class="inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${colors[status]||'bg-gray-100 text-gray-600'}">${t}</span>`;
}
function infoRow(label, value) {
  return `<div class="flex justify-between items-center"><span class="text-gray-400">${label}</span><span class="font-medium">${value}</span></div>`;
}
function emptyState(title, desc, btnText, btnAction) {
  let html = `<div class="text-center py-12"><div class="text-4xl opacity-20 mb-3">&#9673;</div><h3 class="font-semibold text-base mb-1">${title}</h3><p class="text-sm text-gray-400 max-w-xs mx-auto">${desc}</p>`;
  if (btnText) html += `<button onclick="${btnAction}" class="mt-4 px-5 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">${btnText}</button>`;
  html += `</div>`;
  return html;
}


// ---- Pipeline ----

async function renderPipeline() {
  const { data } = await api('GET', '/pipeline/jobs?limit=30');
  if (!data.success) { document.getElementById('tab-content').innerHTML = emptyState('Failed to load','Check your connection.'); return; }
  pipelineJobs = data.data.jobs;
  const hasProcessing = pipelineJobs.some(j => j.status === 'processing');

  // Group jobs by date
  const grouped = {};
  pipelineJobs.forEach(j => {
    const d = new Date(j.created_at);
    const key = d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(j);
  });
  const dateKeys = Object.keys(grouped);

  // Filter state
  const filters = ['all','completed','processing','failed','pending_review','rejected'];
  const activeFilter = window._pipelineFilter || 'all';
  const dateFrom = window._pipelineDateFrom || '';
  const dateTo = window._pipelineDateTo || '';

  let html = '';

  // Filter chips + date range
  html += `<div class="flex items-center gap-2 mb-4 flex-wrap">`;
  filters.forEach(f => {
    const isActive = f === activeFilter;
    const count = f === 'all' ? pipelineJobs.length : pipelineJobs.filter(j=>j.status===f).length;
    html += `<button onclick="setPipelineFilter('${f}')" class="px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${isActive ? 'bg-brand-400 text-gray-900' : 'bg-white text-gray-500 border border-gray-200 hover:border-brand-300 hover:text-gray-900'}">${f.replace(/_/g,' ')} (${count})</button>`;
  });
  if (hasProcessing) html += `<span class="flex items-center gap-1.5 text-xs text-blue-600 font-semibold ml-auto"><span class="w-2 h-2 rounded-full bg-blue-500 pulse-dot"></span>Live</span>`;
  html += `</div>`;

  // Date/time filter row — preset chips + search
  html += `<div class="flex flex-col gap-3 mb-6">`;
  // Date presets
  const datePresets = [
    { label: 'Today', value: 'today' },
    { label: 'Last 7 days', value: '7d' },
    { label: 'Last 30 days', value: '30d' },
    { label: 'Custom Range', value: 'custom' },
  ];
  const activeDatePreset = window._pipelineDatePreset || '7d';
  html += `<div class="flex items-center gap-2">`;
  datePresets.forEach(p => {
    const isActive = p.value === activeDatePreset;
    html += `<button onclick="setPipelineDatePreset('${p.value}')" class="px-4 py-2 rounded-lg text-xs font-semibold transition-all ${isActive ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:border-gray-400'}">${p.label}</button>`;
  });
  if (activeDatePreset === 'custom') {
    html += `<input type="date" id="pipe-date-from" value="${dateFrom}" onchange="setPipelineCustomRange()" class="ml-2 px-3 py-2 text-xs bg-white border border-gray-200 rounded-lg">`;
    html += `<span class="text-xs text-gray-400">to</span>`;
    html += `<input type="date" id="pipe-date-to" value="${dateTo}" onchange="setPipelineCustomRange()" class="px-3 py-2 text-xs bg-white border border-gray-200 rounded-lg">`;
  }
  html += `</div>`;
  // Search bar
  html += `<div class="flex gap-2">`;
  html += `<input id="pipe-search" type="text" placeholder="Search by order number, customer name, or phone..." value="${window._pipelineSearch||''}" onkeydown="if(event.key==='Enter')doPipelineSearch()" class="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm placeholder-gray-400 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 transition-all">`;
  html += `<button onclick="doPipelineSearch()" class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg text-sm transition-all">Search</button>`;
  html += `</div>`;
  html += `</div>`;

  // Main layout
  html += `<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">`;

  // Left: Calendar-style grouped list
  html += `<div class="lg:col-span-1"><div class="bg-white rounded-3xl shadow-card p-5">`;
  html += `<h3 class="font-bold text-sm mb-4">Timeline</h3>`;

  const filteredJobs = applyPipelineFilters(pipelineJobs, activeFilter, dateFrom, dateTo);
  if (filteredJobs.length === 0) {
    html += emptyState('No jobs match','Try a different filter.');
  } else {
    // Re-group filtered
    const fGrouped = {};
    filteredJobs.forEach(j => {
      const d = new Date(j.created_at);
      const key = d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
      if (!fGrouped[key]) fGrouped[key] = [];
      fGrouped[key].push(j);
    });

    html += `<div class="space-y-4 max-h-[600px] overflow-y-auto pr-1">`;
    Object.entries(fGrouped).forEach(([dateLabel, jobs]) => {
      html += `<div>`;
      html += `<div class="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2 sticky top-0 bg-white py-1">${dateLabel}</div>`;
      html += `<div class="space-y-1.5 relative pl-4 border-l-2 border-gray-100">`;
      jobs.forEach((job, i) => {
        const globalIdx = pipelineJobs.indexOf(job);
        const time = new Date(job.created_at).toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit' });
        const stage = job.current_stage.replace(/_/g,' ').toLowerCase();
        const dotColor = job.status==='completed'?'bg-green-400':job.status==='failed'||job.status==='rejected'?'bg-red-400':job.status==='processing'?'bg-blue-400 pulse-dot':'bg-gray-300';
        html += `<div onclick="showJobDetail(${globalIdx})" class="relative flex items-center gap-3 p-2.5 rounded-xl hover:bg-brand-50/40 cursor-pointer transition-all group">`;
        html += `<div class="absolute -left-[13px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ${dotColor} ring-2 ring-white"></div>`;
        html += `<span class="text-[11px] text-gray-400 w-12 flex-shrink-0">${time}</span>`;
        html += `<div class="flex-1 min-w-0"><div class="text-xs font-medium capitalize truncate group-hover:text-brand-700">${stage}</div></div>`;
        // Inline status hints so the row tells the operator what happened
        // without forcing them to click into the detail panel:
        // - approved-resuming: caretaker just approved, courier submission in flight
        // - failed/rejected with last_error: show a short reason snippet
        if (job.status === 'processing' && job.caretaker_verdict === 'approve') {
          html += `<span class="text-[10px] text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full font-medium whitespace-nowrap mr-1">resuming</span>`;
        } else if ((job.status === 'failed' || job.status === 'rejected') && job.last_error) {
          const short = job.last_error.length > 36 ? job.last_error.slice(0, 36) + '…' : job.last_error;
          html += `<span class="text-[10px] text-red-500 truncate max-w-[180px] mr-1" title="${escapeHtml(job.last_error)}">${escapeHtml(short)}</span>`;
        }
        html += badge(job.status);
        html += `</div>`;
      });
      html += `</div></div>`;
    });
    html += `</div>`;
  }
  html += `</div></div>`;

  // Right: Detail panel
  html += `<div class="lg:col-span-2" id="job-detail-panel">`;
  html += `<div class="bg-white rounded-3xl shadow-card p-8 flex items-center justify-center min-h-[400px]">`;
  html += `<div class="text-center"><div class="text-3xl opacity-15 mb-3">&#9654;</div><p class="text-sm text-gray-400">Select a job to view its pipeline stages</p></div>`;
  html += `</div></div>`;
  html += `</div>`;

  document.getElementById('tab-content').innerHTML = html;

  // Preserve the detail-panel view across auto-refresh polls. If the user
  // had a job open when the previous render fired (window._activeJobId),
  // re-render that detail panel from the fresh data so they watch their
  // order go pending_review -> processing -> completed without losing
  // their place.
  if (window._activeJobId) {
    const idx = pipelineJobs.findIndex((j) => j.id === window._activeJobId);
    if (idx >= 0) {
      // Avoid recursive re-entry when showJobDetail itself is the trigger.
      Promise.resolve().then(() => showJobDetail(idx, { silent: true }));
    } else {
      // The job dropped out of the visible window (filter, date range).
      // Don't blow away the panel — just leave the placeholder.
      window._activeJobId = null;
    }
  }

  // Poll while anything is in flight. Caretaker approval pushes a job from
  // pending_review -> processing -> completed across ~5-15 seconds; if the
  // user is sitting on this tab they should see the row transition without
  // having to refresh manually. Stops automatically once nothing's moving.
  const inFlight = pipelineJobs.some((j) => j.status === 'processing' || j.status === 'pending_review');
  clearTimeout(window._pipelineTimer);
  if (inFlight && currentTab === 'pipeline') {
    window._pipelineTimer = setTimeout(() => {
      if (currentTab === 'pipeline') renderPipeline();
    }, 3000);
  }
}

function setPipelineFilter(f) { window._pipelineFilter = f; renderPipeline(); }
function setPipelineDatePreset(preset) {
  window._pipelineDatePreset = preset;
  if (preset === 'today') {
    const today = new Date(); today.setHours(0,0,0,0);
    window._pipelineDateFrom = today.toISOString().split('T')[0];
    window._pipelineDateTo = '';
  } else if (preset === '7d') {
    const d = new Date(); d.setDate(d.getDate() - 7); d.setHours(0,0,0,0);
    window._pipelineDateFrom = d.toISOString().split('T')[0];
    window._pipelineDateTo = '';
  } else if (preset === '30d') {
    const d = new Date(); d.setDate(d.getDate() - 30); d.setHours(0,0,0,0);
    window._pipelineDateFrom = d.toISOString().split('T')[0];
    window._pipelineDateTo = '';
  } else {
    // custom — keep existing values, user will pick
  }
  renderPipeline();
}
function setPipelineCustomRange() {
  window._pipelineDateFrom = document.getElementById('pipe-date-from')?.value || '';
  window._pipelineDateTo = document.getElementById('pipe-date-to')?.value || '';
  renderPipeline();
}
function doPipelineSearch() {
  window._pipelineSearch = (document.getElementById('pipe-search')?.value || '').trim();
  renderPipeline();
}
function filteredByDate(jobs, from, to) {
  let result = jobs;
  if (from) { const d = new Date(from).getTime(); result = result.filter(j => new Date(j.created_at).getTime() >= d); }
  if (to) { const d = new Date(to + 'T23:59:59').getTime(); result = result.filter(j => new Date(j.created_at).getTime() <= d); }
  return result;
}
function applyPipelineFilters(jobs, statusFilter, dateFrom, dateTo) {
  let result = jobs;
  if (statusFilter && statusFilter !== 'all') result = result.filter(j => j.status === statusFilter);
  result = filteredByDate(result, dateFrom, dateTo);
  // Search filter
  const search = (window._pipelineSearch || '').toLowerCase();
  if (search) {
    result = result.filter(j => {
      const haystack = [j.current_stage, j.status, j.correlation_id, j.email_id, j.id].join(' ').toLowerCase();
      return haystack.includes(search);
    });
  }
  return result;
}
async function showJobDetail(index, opts) {
  const job = pipelineJobs[index];
  if (!job || !job.id) {
    if (!opts || !opts.silent) toast('Job not found', 'error');
    return;
  }
  // Track which job's detail panel is open so the auto-refresh poll above
  // can rerender this panel in place each cycle (caretaker approval moves
  // the job pending_review -> processing -> completed/failed in the
  // background, and we want the operator to see those transitions land on
  // the same screen they clicked Approve from).
  window._activeJobId = job.id;
  const { data } = await api('GET', '/pipeline/jobs/' + job.id);
  if (!data.success) {
    if (!opts || !opts.silent) toast('Failed to load job details', 'error');
    return;
  }
  const stages = data.data.stages || [];
  const allStages = ['EMAIL RECEIVED','EMAIL NORMALIZED','DATA EXTRACTED','DATA VALIDATED','SHOPIFY ENRICHED','LOCATION RESOLVED','CUSTOMER DATA','LOCKERS RESOLVED','PAYLOAD CREATED','CARETAKER REVIEW','COURIER SUBMITTED'];
  const currentIdx = allStages.indexOf(job.current_stage.replace(/_/g,' '));
  const progress = Math.round(((currentIdx+1)/allStages.length)*100);

  let html = `<div class="bg-white rounded-3xl shadow-card p-6">`;
  // Header
  html += `<div class="flex items-center justify-between mb-2"><h3 class="font-bold text-base">Pipeline Detail</h3><div class="flex items-center gap-2">${badge(job.status)}<button onclick="reprocessJob('${job.id}')" class="px-3 py-1.5 bg-surface-100 hover:bg-brand-100 text-gray-700 hover:text-gray-900 text-xs font-semibold rounded-full transition-all" title="Re-run pipeline (uses current settings — useful after fixing Shopify token, prompts, etc.)">Reprocess</button></div></div>`;
  html += `<div class="text-[11px] text-gray-400 mb-4">${new Date(job.created_at).toLocaleString()} - ${job.correlation_id||''}</div>`;

  // Surface async failures and the resume status so a reviewer who just
  // approved can see what happened next without leaving the panel.
  if (job.status === 'processing' && job.caretaker_verdict === 'approve') {
    html += `<div class="text-[11px] bg-blue-50 text-blue-600 rounded-xl px-3 py-2 mb-3 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full bg-blue-400 pulse-dot"></span>Resuming after caretaker approval — submitting to courier...</div>`;
  }
  if (job.status === 'failed' && job.last_error) {
    html += `<div class="text-[11px] bg-red-50 text-red-600 rounded-xl px-3 py-2 mb-3"><span class="font-semibold">Failed:</span> ${escapeHtml(job.last_error)}</div>`;
  }
  if (job.status === 'rejected' && job.last_error) {
    html += `<div class="text-[11px] bg-amber-50 text-amber-700 rounded-xl px-3 py-2 mb-3"><span class="font-semibold">Rejected:</span> ${escapeHtml(job.last_error)}</div>`;
  }

  // Order summary (if the pipeline produced an order)
  const order = data.data.order;
  if (order) {
    html += `<div class="bg-surface-100 rounded-2xl p-4 mb-4">`;
    html += `<div class="flex items-center justify-between"><div><div class="text-xs text-gray-400 uppercase font-semibold tracking-wide">Order</div>`;
    html += `<div class="text-sm font-bold mt-0.5">#${order.order_number||'-'} - ${escapeHtml(order.customer_name||'')}</div></div>${badge(order.status==='delivered'||order.status==='completed'?'completed':order.status==='cancelled'||order.status==='failed'?'failed':'processing', order.status||'pending')}</div>`;
    html += `<div class="grid grid-cols-3 gap-3 mt-3">`;
    html += `<div><div class="text-[10px] text-gray-400 uppercase">Waybill</div><div class="text-sm font-semibold">${order.waybill||'-'}</div></div>`;
    html += `<div><div class="text-[10px] text-gray-400 uppercase">PIN</div><div class="text-sm font-semibold">${order.pincode||'-'}</div></div>`;
    html += `<div><div class="text-[10px] text-gray-400 uppercase">Method</div><div class="text-sm font-semibold capitalize">${(order.delivery_method||'-').replace(/-/g,' ')}</div></div>`;
    html += `</div></div>`;
  }

  // Progress
  html += `<div class="h-2 bg-gray-100 rounded-full mb-1 overflow-hidden"><div class="h-full rounded-full transition-all ${job.status==='completed'?'bg-green-400':job.status==='failed'?'bg-red-400':'bg-brand-400'}" style="width:${progress}%"></div></div>`;
  html += `<div class="text-[11px] text-gray-400 text-right mb-6">${currentIdx+1} / ${allStages.length} stages</div>`;

  // Stages as simplified cards
  if (stages.length === 0) {
    html += `<div class="text-center py-8 text-sm text-gray-400">No stage results recorded yet.</div>`;
  } else {
    html += `<div class="space-y-3">`;
    stages.forEach(stage => {
      const time = new Date(stage.created_at).toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      const name = stage.stage.replace(/_/g,' ');
      const dotColor = stage.status === 'completed' ? 'bg-green-400' : stage.status === 'failed' ? 'bg-red-400' : 'bg-blue-400';
      const summary = getStageSimpleSummary(stage);

      html += `<div class="flex gap-3 items-start">`;
      html += `<div class="w-3 h-3 rounded-full ${dotColor} mt-1.5 flex-shrink-0 ring-4 ring-gray-50"></div>`;
      html += `<div class="flex-1 min-w-0">`;
      html += `<div class="flex items-center justify-between"><span class="text-sm font-semibold capitalize">${name.toLowerCase()}</span><span class="text-[11px] text-gray-400">${time}</span></div>`;
      if (summary) html += `<div class="text-xs text-gray-500 mt-1">${summary}</div>`;
      if (stage.error_message) html += `<div class="text-xs text-red-500 mt-1">${escapeHtml(stage.error_message)}</div>`;
      // Expandable raw data
      if (stage.output_data) {
        let raw = '';
        try { const obj = typeof stage.output_data === 'string' ? JSON.parse(stage.output_data) : stage.output_data; raw = JSON.stringify(obj, null, 2); } catch { raw = String(stage.output_data); }
        html += `<details class="mt-2"><summary class="text-[11px] text-gray-400 cursor-pointer hover:text-gray-600">View raw data</summary><pre class="mt-1 text-[10px] text-gray-400 bg-surface-100 rounded-xl p-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">${escapeHtml(raw.substring(0,1200))}</pre></details>`;
      }
      html += `</div></div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;

  const panel = document.getElementById('job-detail-panel');
  if (panel) { panel.innerHTML = html; openMobileDetail('job-detail-panel'); }
}

async function reprocessJob(jobId) {
  if (!confirm('Re-run this order through the pipeline?\n\nThe existing pipeline_job, stage results, and any order created from this run will be deleted, then a fresh job will be enqueued. Use this after fixing settings (Shopify token, prompts, geocoding key, etc.).')) return;
  const { data } = await api('POST', '/pipeline/jobs/' + jobId + '/reprocess');
  if (data.success) {
    toast('Reprocess enqueued — give it a few seconds, then refresh the pipeline list', 'success');
    setTimeout(() => renderPipeline(), 2000);
  } else {
    toast(data.error?.message || 'Reprocess failed', 'error');
  }
}

// Extract a human-readable one-liner from stage output
function getStageSimpleSummary(stage) {
  if (!stage.output_data) return '';
  const d = typeof stage.output_data === 'string' ? (() => { try { return JSON.parse(stage.output_data); } catch { return null; } })() : stage.output_data;
  if (!d) return '';
  const s = stage.stage;
  if (s === 'DATA_EXTRACTED') return `#${d.order_number||d.OrderNumber||'?'} - ${d.customer_name||d.customerName||'?'} - ${d.delivery_method||d.deliverMethod||'?'}`;
  if (s === 'DATA_VALIDATED') return d.valid ? 'Valid' : `Invalid: ${(d.errors||[]).join(', ')}`;
  if (s === 'SHOPIFY_ENRICHED') return d.enriched ? `${(d.line_items||[]).length} line items` : 'Skipped';
  if (s === 'LOCATION_RESOLVED') return d.delivery_address ? `${d.delivery_address.suburb||''}, ${d.delivery_address.city||''} (${d.delivery_address.lat||'?'}, ${d.delivery_address.lng||'?'})` : '';
  if (s === 'CUSTOMER_DATA') return `${d.customerName||''} - ${d.customerPhone||''} - ${d.deliverMethod||''}`;
  if (s === 'LOCKERS_RESOLVED') return `${d.nearest_locker_name||d.terminal_id||'?'} (${d.distance_km||'?'}km)`;
  if (s === 'PAYLOAD_CREATED') return `Service: ${d.service_level_code||'?'}`;
  if (s === 'CARETAKER_REVIEW') return `Verdict: ${d.verdict||'?'} ${(d.flags||[]).length?'- Flags: '+(d.flags||[]).join(', '):''}`;
  if (s === 'COURIER_SUBMITTED') {
    // tracking_reference may be null in old rows; fall back to nested fields
    const ref = d.tracking_reference
      || d.response?.waybill
      || d.response?.pudoResponse?.custom_tracking_reference
      || (Array.isArray(d.response) ? d.response[0]?.pudoResponse?.custom_tracking_reference : null);
    return d.submitted ? `Waybill: ${ref || '?'}` : `Failed: ${d.error||'?'}`;
  }
  return '';
}

// ---- Agents ----

async function renderAgents() {
  const [{ data: ckRes }, { data: waRes }] = await Promise.all([api('GET', '/caretaker/rules'), api('GET', '/whatsapp/settings')]);
  const ckRules = ckRes && ckRes.success ? ckRes.data : {};
  const waSettings = waRes && waRes.success ? waRes.data : {};

  const agents = [
    { id:'data-extraction', name:'Data Extraction', desc:'Reads order emails and extracts structured data using AI.', stage:'DATA_EXTRACTED', status:'active', model:'gpt-4o-mini', capabilities:['Order number, name, phone, address extraction','Delivery method detection','Locker address cleaning','Manual/automatic routing'] },
    { id:'caretaker-llm', name:'Caretaker AI', desc:'Reviews orders before courier submission. Catches anomalies rules miss.', stage:'CARETAKER_REVIEW', status:ckRules.llm_enabled?'active':'disabled', model:'gpt-4o-mini', capabilities:['Address/method mismatch detection','Suspicious name flagging','Test order identification','Province/postal validation'] },
    { id:'intent-router', name:'Intent Router', desc:'Classifies inbound WhatsApp messages and routes to the right agent.', stage:'Classification', status:waSettings.configured?'active':'inactive', model:'gpt-4o-mini', capabilities:['5 intent categories','Regex shortcuts for greetings','LLM fallback for ambiguous messages','Context-aware routing'] },
    { id:'order-support', name:'Order Support', desc:'Answers customer order questions via function calling with real data.', stage:'Response', status:waSettings.configured?'active':'inactive', model:'gpt-4o-mini', capabilities:['lookup_orders_by_phone','get_order_status','escalate_to_human','Multi-turn tool calling (4 rounds)'] },
    { id:'tenant-info', name:'Tenant Info', desc:'Answers store questions from the Knowledge Base. Strictly grounded.', stage:'Response', status:waSettings.configured?'active':'inactive', model:'gpt-4o-mini', capabilities:['Keyword document retrieval','Strict grounding (never invents)','Source URL surfacing','Human escalation fallback'] },
  ];

  let html = `<div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">`;
  const activeCount = agents.filter(a=>a.status==='active').length;
  html += statCard('Total', agents.length, 'text-gray-900');
  html += statCard('Active', activeCount, 'text-green-600');
  html += statCard('Disabled', agents.filter(a=>a.status==='disabled').length, 'text-red-500');
  html += statCard('Inactive', agents.filter(a=>a.status==='inactive').length, 'text-gray-400');
  html += statCard('Model', 'gpt-4o-mini', 'text-sm text-indigo-600');
  html += `</div>`;

  html += `<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">`;
  agents.forEach(a => {
    const borderColor = a.status==='active' ? 'border-l-green-400' : a.status==='disabled' ? 'border-l-red-300' : 'border-l-gray-300';
    html += `<div class="bg-white rounded-3xl shadow-card p-6 border-l-4 ${borderColor} hover:shadow-card-hover transition-all">`;
    html += `<div class="flex items-start justify-between mb-3"><h3 class="font-bold text-base">${a.name}</h3>${badge(a.status)}</div>`;
    html += `<p class="text-sm text-gray-400 mb-4">${a.desc}</p>`;
    html += `<div class="text-[11px] text-gray-400 uppercase tracking-wide font-semibold mb-2">Capabilities</div>`;
    html += `<ul class="space-y-1 mb-4">`;
    a.capabilities.forEach(c => { html += `<li class="text-xs text-gray-600 flex items-start gap-2"><span class="text-brand-500 mt-0.5">&#8226;</span>${c}</li>`; });
    html += `</ul>`;
    html += `<div class="flex items-center justify-between pt-3 border-t border-gray-50"><span class="text-[11px] text-gray-400">${a.model}</span>`;
    if (a.id==='caretaker-llm') html += `<button onclick="switchTab('caretaker')" class="text-xs text-brand-600 font-semibold hover:underline">Configure</button>`;
    else if (a.id==='tenant-info') html += `<button onclick="switchTab('knowledge')" class="text-xs text-brand-600 font-semibold hover:underline">Knowledge</button>`;
    else if (a.id==='order-support'||a.id==='intent-router') html += `<button onclick="switchTab('inbox')" class="text-xs text-brand-600 font-semibold hover:underline">Inbox</button>`;
    html += `</div></div>`;
  });
  html += `</div>`;

  document.getElementById('tab-content').innerHTML = html;
}


// ---- Stub renders for remaining tabs (functional, Tailwind-styled) ----

async function renderFulfillment() {
  const { data } = await api('GET', '/fulfillment/jobs?limit=20');
  if (!data.success) { document.getElementById('tab-content').innerHTML = emptyState('Failed to load',''); return; }
  fulfillmentJobs = data.data.jobs;
  let html = `<div class="bg-white rounded-3xl shadow-card p-6">`;
  html += `<h3 class="font-bold text-base mb-4">Active Fulfillment Jobs</h3>`;
  if (fulfillmentJobs.length === 0) { html += emptyState('No fulfillment jobs','Orders with waybills will appear here automatically.'); }
  else {
    html += `<div class="space-y-2">`;
    fulfillmentJobs.forEach((j,i) => {
      const m = (j.milestone||'pending').replace(/_/g,' ');
      html += `<div onclick="showFulfillmentDetail(${i})" class="flex items-center justify-between p-4 rounded-2xl border border-gray-100 hover:border-brand-300 cursor-pointer transition-all">`;
      html += `<div><div class="text-sm font-semibold">${j.waybill||'-'}</div><div class="text-xs text-gray-400">${j.customer_name||''} - ${j.delivery_method||''}</div></div>`;
      html += `<div class="flex items-center gap-3">${badge(j.milestone==='delivered'?'completed':j.milestone==='cancelled'||j.milestone==='failed'?'failed':'processing', m)}<span class="text-xs text-gray-400">${j.poll_count||0} polls</span></div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div><div id="fulfillment-detail-panel" class="mt-6"></div>`;
  document.getElementById('tab-content').innerHTML = html;
}
async function showFulfillmentDetail(i) {
  const j = fulfillmentJobs[i];
  const { data } = await api('GET', '/fulfillment/jobs/' + j.id);
  if (!data.success) return;
  const job = data.data.job; const events = data.data.events||[];
  let html = `<div class="bg-white rounded-3xl shadow-card p-6">`;
  const isCancelled = job.status === 'cancelled' || job.milestone === 'cancelled';
  const cancelBtn = isCancelled
    ? `<span class="px-4 py-2 bg-red-50 text-red-500 font-semibold rounded-full text-xs">Cancelled</span>`
    : `<button onclick="openCancelModal('${job.id}',${i})" class="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-500 font-semibold rounded-full text-xs transition-all">Cancel...</button>`;
  html += `<div class="flex items-center justify-between mb-4"><h3 class="font-bold">Order #${job.order_number||''} - ${job.customer_name||''}</h3><div class="flex gap-2"><button onclick="pollFulfillment('${job.id}',${i})" class="px-4 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-xs transition-all">Poll Now</button>${cancelBtn}</div></div>`;
  html += `<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">`;
  html += `<div class="bg-surface-100 rounded-xl p-3"><div class="text-[10px] text-gray-400 uppercase">Waybill</div><div class="text-sm font-bold">${job.waybill||'-'}</div></div>`;
  html += `<div class="bg-surface-100 rounded-xl p-3"><div class="text-[10px] text-gray-400 uppercase">PIN</div><div class="text-sm font-bold">${job.pincode||'-'}</div></div>`;
  html += `<div class="bg-surface-100 rounded-xl p-3"><div class="text-[10px] text-gray-400 uppercase">Status</div><div class="text-sm font-bold capitalize">${(job.milestone||'pending').replace(/_/g,' ')}</div></div>`;
  html += `<div class="bg-surface-100 rounded-xl p-3"><div class="text-[10px] text-gray-400 uppercase">Polls</div><div class="text-sm font-bold">${job.poll_count||0}</div></div>`;
  html += `</div>`;
  if (events.length) {
    html += `<h4 class="font-semibold text-sm mb-3">Tracking Events</h4><div class="space-y-2">`;
    events.forEach(ev => {
      html += `<div class="flex items-start gap-3 text-xs"><span class="text-gray-400 whitespace-nowrap">${ev.event_date?new Date(ev.event_date).toLocaleString():'-'}</span><span class="font-medium">${ev.status}</span><span class="text-gray-400">${ev.message||''}</span></div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  document.getElementById('fulfillment-detail-panel').innerHTML = html;
  openMobileDetail('fulfillment-detail-panel');
}
async function pollFulfillment(jobId, index) { await api('POST', '/fulfillment/poll/' + jobId); toast('Polling...','info'); setTimeout(() => showFulfillmentDetail(index), 2000); }

function openCancelModal(jobId, index) {
  // Build a one-shot modal so we don't need persistent DOM.
  const existing = document.getElementById('cancel-modal-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'cancel-modal-overlay';
  overlay.className = 'fixed inset-0 bg-black/40 flex items-center justify-center z-[10000]';
  overlay.innerHTML = `
    <div class="bg-white rounded-3xl shadow-card p-6 w-full max-w-md mx-4">
      <h3 class="font-bold text-base mb-1">Cancel order</h3>
      <p class="text-xs text-gray-400 mb-4">Choose what to cancel. PUDO and Shopify are independent.</p>
      <div class="space-y-3">
        <div>
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Scope</label>
          <select id="cancel-scope" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
            <option value="both">Cancel everything (PUDO + Shopify)</option>
            <option value="pudo">PUDO shipment only (keep Shopify order)</option>
            <option value="shopify">Shopify order only (keep PUDO shipment)</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Reason</label>
          <input id="cancel-reason" value="Customer requested cancellation" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
          <p class="text-[11px] text-gray-400 mt-1">Sent to PUDO as the cancellation message and stored on the order timeline.</p>
        </div>
        <div id="cancel-shopify-extras" class="space-y-3">
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Shopify reason</label>
            <select id="cancel-shopify-reason" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
              <option value="customer">Customer changed/cancelled</option>
              <option value="inventory">Out of stock</option>
              <option value="fraud">Fraud</option>
              <option value="declined">Payment declined</option>
              <option value="other">Other</option>
            </select>
          </div>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="cancel-refund" class="rounded"> Refund the customer</label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="cancel-restock" class="rounded" checked> Restock inventory</label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="cancel-notify" class="rounded" checked> Email customer</label>
        </div>
      </div>
      <div class="flex gap-2 mt-5">
        <button onclick="closeCancelModal()" class="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-sm transition-all">Back</button>
        <button onclick="submitCancel('${jobId}',${index})" class="flex-1 py-2.5 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-full text-sm transition-all">Cancel order</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  // Hide Shopify-only options when scope=pudo
  const scopeEl = document.getElementById('cancel-scope');
  const extras = document.getElementById('cancel-shopify-extras');
  scopeEl.addEventListener('change', () => {
    extras.style.display = scopeEl.value === 'pudo' ? 'none' : 'block';
  });
}

function closeCancelModal() {
  const overlay = document.getElementById('cancel-modal-overlay');
  if (overlay) overlay.remove();
}

async function submitCancel(jobId, index) {
  const v = (id) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
  const scope = v('cancel-scope') || 'both';
  const reason = (v('cancel-reason') || '').toString().trim();
  if (!reason) { toast('A reason is required to cancel', 'error'); return; }
  const body = {
    scope,
    reason,
    shopify_reason: v('cancel-shopify-reason') || 'customer',
    refund: !!v('cancel-refund'),
    restock: v('cancel-restock') !== false, // default true
    notify_customer: v('cancel-notify') !== false, // default true
  };
  closeCancelModal();
  toast('Cancelling…', 'info');
  const { data } = await api('POST', '/fulfillment/jobs/' + jobId + '/cancel', body);
  if (data.success) {
    toast(data.data?.message || 'Cancel completed', 'success');
  } else if (data.data) {
    // Partial: show which side failed
    const pudoMsg = data.data.pudo?.error || (data.data.pudo?.ok ? 'ok' : 'failed');
    const shopMsg = data.data.shopify?.error || (data.data.shopify?.ok ? 'ok' : 'failed');
    toast(`Partial cancel — PUDO: ${pudoMsg}, Shopify: ${shopMsg}`, 'warning');
  } else {
    toast(data.error?.message || 'Cancel failed', 'error');
  }
  setTimeout(() => { renderFulfillment(); }, 800);
}

async function renderCaretaker() {
  const [{ data: rulesRes }, { data: evalsRes }] = await Promise.all([api('GET', '/caretaker/rules'), api('GET', '/caretaker/evaluations?limit=50')]);
  const rules = rulesRes && rulesRes.success ? rulesRes.data : {};
  const evals = evalsRes && evalsRes.success ? evalsRes.data : [];
  let html = `<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">`;
  // Rules card
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Rules</h3>`;
  html += `<div class="space-y-3 text-sm">`;
  html += `<label class="flex items-center gap-2"><input type="checkbox" id="ck-enabled" ${rules.enabled!==false?'checked':''}><span>Enabled</span></label>`;
  html += `<label class="flex items-center gap-2"><input type="checkbox" id="ck-llm" ${rules.llm_enabled?'checked':''}><span>AI evaluator (LLM)</span></label>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Mode</label><select id="ck-mode" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"><option value="shadow"${rules.mode==='shadow'?' selected':''}>Shadow</option><option value="advisory"${rules.mode==='advisory'?' selected':''}>Advisory</option><option value="strict"${rules.mode==='strict'?' selected':''}>Strict</option></select></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Max distance (km)</label><input id="ck-max-dist" type="number" value="${rules.max_distance_km??''}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<label class="flex items-center gap-2"><input type="checkbox" id="ck-phone" ${rules.require_phone!==false?'checked':''}><span>Require phone</span></label>`;
  html += `<label class="flex items-center gap-2"><input type="checkbox" id="ck-name" ${rules.require_customer_name!==false?'checked':''}><span>Require name</span></label>`;
  html += `<label class="flex items-center gap-2"><input type="checkbox" id="ck-items" ${rules.require_line_items!==false?'checked':''}><span>Require line items</span></label>`;
  html += `<label class="flex items-center gap-2"><input type="checkbox" id="ck-dup" ${rules.block_duplicate_order_number!==false?'checked':''}><span>Block duplicate order #</span></label>`;
  html += `</div><button onclick="saveCaretakerRules()" class="mt-4 w-full py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Save Rules</button>`;
  html += `</div>`;

  // Evaluations
  html += `<div class="lg:col-span-2 bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Evaluations</h3>`;
  if (evals.length === 0) { html += `<p class="text-sm text-gray-400">No evaluations yet</p>`; }
  else {
    html += `<div class="space-y-2 max-h-[500px] overflow-y-auto">`;
    evals.forEach(e => {
      const flags = Array.isArray(e.flags)?e.flags:(e.flags||[]);
      html += `<div class="p-3 rounded-2xl border border-gray-100">`;
      html += `<div class="flex items-center justify-between mb-1"><span class="text-xs text-gray-400">${new Date(e.created_at).toLocaleString()}</span>${badge(e.verdict==='approve'?'completed':e.verdict==='review'?'pending_review':'failed', e.verdict)}</div>`;
      html += `<div class="text-xs text-gray-500">${escapeHtml(e.summary||'-')}</div>`;
      let actions = '';
      if (e.verdict==='review' && !e.resolution) {
        actions = `<button onclick="openReviewModal('${e.id}')" class="px-3 py-1 bg-green-50 text-green-600 rounded-full text-xs font-semibold hover:bg-green-100">Review &amp; Approve</button><button onclick="resolveCk('${e.id}','rejected')" class="px-3 py-1 bg-red-50 text-red-500 rounded-full text-xs font-semibold hover:bg-red-100">Reject</button>`;
      } else if (e.verdict==='reject' || e.resolution==='rejected') {
        actions = `<button onclick="reopenCk('${e.id}')" class="px-3 py-1 bg-amber-50 text-amber-700 rounded-full text-xs font-semibold hover:bg-amber-100">Reopen for review</button>`;
      } else if (e.verdict==='approve' && !e.resolution) {
        actions = `<button onclick="reopenCk('${e.id}')" class="px-3 py-1 bg-gray-50 text-gray-600 rounded-full text-xs font-semibold hover:bg-gray-100" title="Convert to pending review">Reopen</button>`;
      }
      if (actions) html += `<div class="flex gap-2 mt-2">${actions}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div></div>`;
  document.getElementById('tab-content').innerHTML = html;
}
async function saveCaretakerRules() {
  const body = { mode:document.getElementById('ck-mode').value, max_distance_km:parseInt(document.getElementById('ck-max-dist').value)||null, enabled:document.getElementById('ck-enabled').checked, llm_enabled:document.getElementById('ck-llm').checked, require_phone:document.getElementById('ck-phone').checked, require_customer_name:document.getElementById('ck-name').checked, require_line_items:document.getElementById('ck-items').checked, block_duplicate_order_number:document.getElementById('ck-dup').checked };
  const { data } = await api('POST', '/caretaker/rules', body);
  if (data.success) toast('Rules saved','success'); else toast(data.error?.message||'Failed','error');
}
async function resolveCk(id, resolution) { await api('POST',`/caretaker/evaluations/${id}/resolve`,{resolution}); toast(`Evaluation ${resolution}`,'success'); renderCaretaker(); }

async function reopenCk(id) {
  if (!confirm('Reopen this evaluation as a pending review?\n\nYou will be able to edit the order data and approve it from the queue.')) return;
  const { data } = await api('POST', `/caretaker/evaluations/${id}/reopen`);
  if (data?.success) {
    toast('Reopened — find it under pending reviews', 'success');
    renderCaretaker();
  } else {
    toast(data?.error?.message || 'Failed to reopen', 'error');
  }
}

async function openReviewModal(evaluationId) {
  // Fetch snapshot of pipeline data + flags so the reviewer can edit before approving.
  const { data } = await api('GET', `/caretaker/evaluations/${evaluationId}`);
  if (!data?.success) { toast('Failed to load evaluation', 'error'); return; }
  const ev = data.data.evaluation;
  const snap = data.data.snapshot || {};
  const cd = snap.customer_data || {};
  const addr = cd.delivery_address || {};
  const items = Array.isArray(cd.line_items) ? cd.line_items : [];
  const flags = Array.isArray(ev.flags) ? ev.flags : (typeof ev.flags === 'string' ? (() => { try { return JSON.parse(ev.flags); } catch { return []; } })() : []);

  const existing = document.getElementById('review-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'review-modal-overlay';
  overlay.className = 'fixed inset-0 bg-black/40 flex items-center justify-center z-[10000] p-4';
  const itemsHtml = items.length
    ? items.map((li, i) => `<div class="flex gap-2 mb-1" data-rv-item-row="${i}"><input class="flex-1 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0" data-rv-item-name value="${escapeHtml(li.name||'')}"><input class="w-20 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0" data-rv-item-qty type="number" min="1" value="${li.quantity||1}"><button onclick="this.parentElement.remove()" class="px-2 text-red-500 hover:text-red-700" title="Remove">&times;</button></div>`).join('')
    : '';

  overlay.innerHTML = `
    <div class="bg-white rounded-3xl shadow-card w-full max-w-2xl max-h-[90vh] overflow-y-auto">
      <div class="p-6 border-b border-gray-100">
        <div class="flex items-center justify-between mb-1">
          <h3 class="font-bold text-base">Review &amp; Approve</h3>
          <button onclick="closeReviewModal()" class="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>
        <p class="text-xs text-gray-400">Edit any field below — your values will override what the AI extracted when the pipeline resumes.</p>
        ${flags.length ? `<div class="mt-3 flex flex-wrap gap-1">${flags.map(f => `<span class="px-2 py-0.5 bg-amber-50 text-amber-700 text-[11px] rounded-full">${escapeHtml(f)}</span>`).join('')}</div>` : ''}
        ${ev.summary ? `<div class="mt-2 text-xs text-gray-500">${escapeHtml(ev.summary)}</div>` : ''}
      </div>

      <div class="p-6 space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><label class="block text-xs text-gray-400 mb-1">Customer name</label><input id="rv-name" value="${escapeHtml(cd.customerName||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
          <div><label class="block text-xs text-gray-400 mb-1">Customer phone</label><input id="rv-phone" value="${escapeHtml(cd.customerPhone||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Delivery method</label>
          <select id="rv-method" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
            ${['locker-to-locker','locker-to-door','door-to-locker','door-to-door'].map(m => `<option value="${m}"${cd.deliverMethod===m?' selected':''}>${m}</option>`).join('')}
          </select>
        </div>

        <div>
          <h4 class="font-semibold text-sm mb-2">Delivery address</h4>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="md:col-span-2"><label class="block text-xs text-gray-400 mb-1">Street</label><input id="rv-addr-street" value="${escapeHtml(addr.street_address||addr.entered_address||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
            <div><label class="block text-xs text-gray-400 mb-1">Suburb</label><input id="rv-addr-suburb" value="${escapeHtml(addr.suburb||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
            <div><label class="block text-xs text-gray-400 mb-1">City</label><input id="rv-addr-city" value="${escapeHtml(addr.city||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
            <div><label class="block text-xs text-gray-400 mb-1">Province</label><input id="rv-addr-province" value="${escapeHtml(addr.province||addr.region||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
            <div><label class="block text-xs text-gray-400 mb-1">Postal code</label><input id="rv-addr-postal" value="${escapeHtml(addr.postal_code||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2"><h4 class="font-semibold text-sm">Line items</h4><button onclick="addReviewItem()" class="px-3 py-1 bg-surface-100 hover:bg-brand-100 rounded-full text-xs font-semibold">+ Add item</button></div>
          <div id="rv-items">${itemsHtml}</div>
        </div>

        <div>
          <label class="block text-xs text-gray-400 mb-1">Reviewer notes (optional)</label>
          <textarea id="rv-notes" rows="2" placeholder="Why are you overriding? Saved for audit." class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></textarea>
        </div>
      </div>

      <div class="p-6 border-t border-gray-100 flex gap-2">
        <button onclick="closeReviewModal()" class="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-sm">Cancel</button>
        <button onclick="submitReview('${evaluationId}')" class="flex-1 py-2.5 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-full text-sm">Approve &amp; resume</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function closeReviewModal() {
  const overlay = document.getElementById('review-modal-overlay');
  if (overlay) overlay.remove();
}

function addReviewItem() {
  const container = document.getElementById('rv-items');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'flex gap-2 mb-1';
  row.innerHTML = `<input class="flex-1 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0" data-rv-item-name placeholder="Item name"><input class="w-20 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0" data-rv-item-qty type="number" min="1" value="1"><button onclick="this.parentElement.remove()" class="px-2 text-red-500 hover:text-red-700" title="Remove">&times;</button>`;
  container.appendChild(row);
}

async function submitReview(evaluationId) {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const overrides = {};
  if (v('rv-name')) overrides.customer_name = v('rv-name');
  if (v('rv-phone')) overrides.customer_phone = v('rv-phone');
  if (v('rv-method')) overrides.delivery_method = v('rv-method');

  const addr = {};
  ['street','suburb','city','province','postal'].forEach(k => {
    const val = v('rv-addr-' + k);
    if (!val) return;
    const key = k === 'street' ? 'street_address' : k === 'postal' ? 'postal_code' : k;
    addr[key] = val;
  });
  if (Object.keys(addr).length) overrides.delivery_address = addr;

  const itemsContainer = document.getElementById('rv-items');
  if (itemsContainer) {
    const rows = itemsContainer.querySelectorAll('[data-rv-item-row], .flex'); // both pre-rendered + added rows
    const items = [];
    itemsContainer.querySelectorAll('[data-rv-item-name]').forEach((nameEl, i) => {
      const qtyEl = itemsContainer.querySelectorAll('[data-rv-item-qty]')[i];
      const name = (nameEl.value || '').trim();
      const qty = parseInt(qtyEl?.value || '1', 10) || 1;
      if (name) items.push({ name, quantity: qty });
    });
    if (items.length) overrides.line_items = items;
  }

  const notes = (document.getElementById('rv-notes')?.value || '').trim();

  const body = { resolution: 'approved' };
  if (Object.keys(overrides).length) body.overrides = overrides;
  if (notes) body.notes = notes;

  const { data } = await api('POST', `/caretaker/evaluations/${evaluationId}/resolve`, body);
  if (data?.success) {
    toast('Approved — pipeline resuming with your edits', 'success');
    closeReviewModal();
    setTimeout(() => renderCaretaker(), 800);
  } else {
    toast(data?.error?.message || 'Failed to approve', 'error');
  }
}

async function renderCustomers() {
  const { data } = await api('GET', '/customers');
  if (!data.success) { document.getElementById('tab-content').innerHTML = emptyState('Failed to load',''); return; }
  const customers = data.data.customers;
  let html = `<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">`;
  // Customer list
  html += `<div class="lg:col-span-1"><div class="bg-white rounded-3xl shadow-card p-5">`;
  html += `<h3 class="font-bold text-sm mb-4">Customers (${data.data.total})</h3>`;
  if (customers.length === 0) { html += emptyState('No customers yet','Customers are created automatically when orders are submitted.'); }
  else {
    html += `<div class="space-y-2 max-h-[600px] overflow-y-auto">`;
    customers.forEach(c => {
      html += `<div onclick="showCustomerDetail('${c.id}')" class="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:border-brand-300 hover:bg-brand-50/30 cursor-pointer transition-all">`;
      html += `<div class="w-9 h-9 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-sm flex-shrink-0">${(c.name||'?')[0].toUpperCase()}</div>`;
      html += `<div class="flex-1 min-w-0"><div class="text-sm font-medium truncate">${escapeHtml(c.name||'Unknown')}</div><div class="text-[11px] text-gray-400">${c.phone_normalized} - ${c.order_count} orders</div></div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div></div>`;
  // Detail panel
  html += `<div class="lg:col-span-2" id="customer-detail-panel"><div class="bg-white rounded-3xl shadow-card p-8 flex items-center justify-center min-h-[300px]"><p class="text-sm text-gray-400">Select a customer to view their order history</p></div></div>`;
  html += `</div>`;
  document.getElementById('tab-content').innerHTML = html;
}

async function showCustomerDetail(customerId) {
  const { data } = await api('GET', '/customers/' + customerId);
  if (!data.success) { toast('Failed to load customer','error'); return; }
  const customer = data.data.customer;
  const orders = data.data.orders || [];

  let html = `<div class="bg-white rounded-3xl shadow-card p-6">`;
  // Customer header
  html += `<div class="flex items-center gap-4 mb-6">`;
  html += `<div class="w-14 h-14 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-xl">${(customer.name||'?')[0].toUpperCase()}</div>`;
  html += `<div><h3 class="text-lg font-bold">${escapeHtml(customer.name||'Unknown')}</h3>`;
  html += `<div class="text-sm text-gray-400">${customer.phone_normalized}${customer.email?' - '+customer.email:''}</div></div>`;
  html += `</div>`;

  // Stats
  html += `<div class="grid grid-cols-3 gap-3 mb-6">`;
  html += `<div class="bg-surface-100 rounded-xl p-3 text-center"><div class="text-[10px] text-gray-400 uppercase">Orders</div><div class="text-lg font-bold">${customer.order_count}</div></div>`;
  html += `<div class="bg-surface-100 rounded-xl p-3 text-center"><div class="text-[10px] text-gray-400 uppercase">First Order</div><div class="text-xs font-medium">${customer.first_order_at?new Date(customer.first_order_at).toLocaleDateString():'-'}</div></div>`;
  html += `<div class="bg-surface-100 rounded-xl p-3 text-center"><div class="text-[10px] text-gray-400 uppercase">Last Order</div><div class="text-xs font-medium">${customer.last_order_at?new Date(customer.last_order_at).toLocaleDateString():'-'}</div></div>`;
  html += `</div>`;

  // Order history
  html += `<h4 class="font-semibold text-sm mb-3">Order History</h4>`;
  if (orders.length === 0) {
    html += `<p class="text-sm text-gray-400">No orders found</p>`;
  } else {
    html += `<div class="space-y-2">`;
    orders.forEach(o => {
      const time = new Date(o.created_at).toLocaleString();
      html += `<div class="flex items-center justify-between p-3 rounded-xl border border-gray-100">`;
      html += `<div><div class="text-sm font-medium">#${o.order_number||'-'}</div><div class="text-[11px] text-gray-400">${o.delivery_method||''} - ${time}</div></div>`;
      html += `<div class="text-right"><div class="text-xs font-medium">${o.waybill||'-'}</div>${badge(o.status==='delivered'||o.status==='completed'?'completed':o.status==='failed'||o.status==='cancelled'?'failed':'processing', o.status||'pending')}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;

  const panel = document.getElementById('customer-detail-panel');
  if (panel) { panel.innerHTML = html; openMobileDetail('customer-detail-panel'); }
}

async function renderHealth() {
  const { data } = await api('POST', '/health/check');
  let html = `<div class="bg-white rounded-3xl shadow-card p-6">`;
  html += `<div class="flex items-center justify-between mb-4"><h3 class="font-bold text-base">System Health</h3><button onclick="renderHealth()" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs transition-all">Re-check</button></div>`;
  if (!data.success) { html += `<p class="text-sm text-red-500">Failed to run health checks</p>`; }
  else {
    const checks = data.data.checks || [];
    html += `<div class="space-y-3">`;
    checks.forEach(item => {
      const dotColor = item.status === 'healthy' ? 'bg-green-400' : item.status === 'unhealthy' ? 'bg-red-400' : 'bg-gray-300';
      const statusBadge = item.status === 'healthy' ? badge('completed','Healthy') : item.status === 'unhealthy' ? badge('failed','Unhealthy') : badge('processing','Not configured');
      html += `<div class="flex items-center gap-4 p-4 rounded-2xl border border-gray-100">`;
      html += `<span class="w-3 h-3 rounded-full ${dotColor} flex-shrink-0"></span>`;
      html += `<div class="flex-1"><div class="text-sm font-semibold capitalize">${(item.service||'').replace(/_/g,' ')}</div><div class="text-xs text-gray-400 mt-0.5">${escapeHtml(item.message||'')}</div></div>`;
      html += statusBadge;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  document.getElementById('tab-content').innerHTML = html;
}

async function renderSettings() {
  const [{ data: shopRes }, { data: imapRes }, { data: pudoRes }, { data: collRes }] = await Promise.all([
    api('GET','/settings/shopify-api'),
    api('GET','/settings/imap'),
    api('GET','/settings/pudo'),
    api('GET','/settings/collection-contact'),
  ]);
  const shop = shopRes&&shopRes.success?shopRes.data:{};
  const imap = imapRes&&imapRes.success?imapRes.data:{};
  const pudo = pudoRes&&pudoRes.success?pudoRes.data:{};
  const coll = collRes&&collRes.success?collRes.data:{};
  let html = `<div class="grid grid-cols-1 md:grid-cols-2 gap-6">`;
  // Shopify
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Shopify API</h3>`;
  html += `<div class="space-y-3"><div><label class="block text-xs text-gray-400 mb-1">Store</label><input id="set-shop-store" value="${shop.shopify_store||''}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Access Token</label><input id="set-shop-token" type="password" placeholder="paste new token" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `</div><button onclick="saveSettingsShopify()" class="mt-4 w-full py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Save</button></div>`;
  // IMAP
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Email Ingestion (IMAP)</h3>`;
  if (imap.configured) {
    html += `<div class="flex items-center gap-2 mb-4"><span class="w-2 h-2 rounded-full bg-green-400"></span><span class="text-sm text-green-600 font-medium">Configured</span><span class="text-xs text-gray-400 ml-2">${imap.imap_host||''}</span></div>`;
  }
  html += `<div class="space-y-3">`;
  html += `<div class="grid grid-cols-3 gap-2">`;
  html += `<div class="col-span-2"><label class="block text-xs text-gray-400 mb-1">Host</label><input id="set-imap-host" value="${imap.imap_host||''}" placeholder="imap.gmail.com" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Port</label><input id="set-imap-port" type="number" value="${imap.imap_port||993}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `</div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Username</label><input id="set-imap-user" value="${imap.imap_username||''}" placeholder="orders@yourstore.com" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Password</label><input id="set-imap-pass" type="password" placeholder="${imap.configured?'leave blank to keep current':'app password'}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Mailbox</label><input id="set-imap-mailbox" value="${imap.imap_mailbox||'INBOX'}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `</div>`;
  html += `<div class="flex gap-2 mt-4"><button onclick="saveSettingsImap()" class="flex-1 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Save</button>`;
  if (imap.configured) html += `<button onclick="deleteSettingsImap()" class="px-4 py-2.5 bg-red-50 text-red-500 font-semibold rounded-full text-sm hover:bg-red-100 transition-all">Remove</button>`;
  html += `</div></div>`;
  // PUDO
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">PUDO Courier</h3>`;
  if (pudo.configured) {
    html += `<div class="flex items-center gap-2 mb-4"><span class="w-2 h-2 rounded-full bg-green-400"></span><span class="text-sm text-green-600 font-medium">Configured</span><span class="text-xs text-gray-400 ml-2">${pudo.pudo_username||''}</span></div>`;
  }
  html += `<div class="space-y-3">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Email</label><input id="set-pudo-user" value="${pudo.pudo_username||''}" placeholder="account email" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Password</label><input id="set-pudo-pass" type="password" placeholder="${pudo.configured?'leave blank to keep current':''}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">API Key</label><input id="set-pudo-key" type="password" placeholder="${pudo.configured?'leave blank to keep current':''}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `</div>`;
  html += `<div class="flex gap-2 mt-4"><button onclick="saveSettingsPudo()" class="flex-1 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Save</button>`;
  if (pudo.configured) html += `<button onclick="deleteSettingsPudo()" class="px-4 py-2.5 bg-red-50 text-red-500 font-semibold rounded-full text-sm hover:bg-red-100 transition-all">Remove</button>`;
  html += `</div></div>`;
  // Collection
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Collection Contact</h3>`;
  html += `<p class="text-xs text-gray-400 -mt-3 mb-4">Used for every PUDO shipment. Locker methods only need the Terminal ID. Door-to-locker / door-to-door methods also need the street address below.</p>`;
  html += `<div class="space-y-3">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Name</label><input id="set-coll-name" value="${escapeHtml(coll.contact_name||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Email</label><input id="set-coll-email" value="${escapeHtml(coll.contact_email||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Phone</label><input id="set-coll-phone" value="${escapeHtml(coll.contact_phone||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Terminal ID <span class="text-gray-300">(locker collection)</span></label><input id="set-coll-terminal" value="${escapeHtml(coll.collection_terminal_id||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;

  // --- Door collection block (only used when delivery method is door-to-* ) ---
  const ca = coll.collection_address || {};
  html += `<div class="pt-3 border-t border-gray-100 mt-3">`;
  html += `<div class="flex items-center justify-between mb-2"><label class="text-xs font-semibold text-gray-500">Door collection address <span class="font-normal text-gray-300">(door-to-locker / door-to-door)</span></label></div>`;
  html += `<div class="space-y-2">`;
  html += `<input id="set-coll-street" placeholder="Street address" value="${escapeHtml(ca.street_address||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
  html += `<div class="grid grid-cols-2 gap-2">`;
  html += `<input id="set-coll-suburb" placeholder="Suburb" value="${escapeHtml(ca.suburb||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
  html += `<input id="set-coll-city" placeholder="City" value="${escapeHtml(ca.city||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
  html += `</div>`;
  html += `<div class="grid grid-cols-3 gap-2">`;
  html += `<input id="set-coll-zone" placeholder="Province" value="${escapeHtml(ca.zone||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
  html += `<input id="set-coll-code" placeholder="Postal code" value="${escapeHtml(ca.code||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
  html += `<select id="set-coll-type" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
  const types = ['business','residential'];
  const curType = (ca.type === 'residential' ? 'residential' : 'business');
  for (const t of types) html += `<option value="${t}"${curType===t?' selected':''}>${t}</option>`;
  html += `</select>`;
  html += `</div>`;
  html += `<div class="grid grid-cols-2 gap-2">`;
  html += `<input id="set-coll-lat" type="number" step="any" placeholder="Latitude (optional)" value="${ca.lat ?? ''}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
  html += `<input id="set-coll-lng" type="number" step="any" placeholder="Longitude (optional)" value="${ca.lng ?? ''}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
  html += `</div>`;
  html += `</div></div>`;

  html += `</div><button onclick="saveSettingsCollection()" class="mt-4 w-full py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Save</button></div>`;
  html += `</div>`;
  document.getElementById('tab-content').innerHTML = html;
}
async function saveSettingsShopify() { const b={shopify_store:document.getElementById('set-shop-store').value,shopify_access_token:document.getElementById('set-shop-token').value}; if(!b.shopify_store){toast('Store URL required','error');return;} if(!b.shopify_access_token){toast('Token required','error');return;} const{data}=await api('POST','/settings/shopify-api',b); if(data.success)toast('Shopify saved','success');else toast(data.error?.message||'Failed','error'); }
async function saveSettingsImap() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const body = {
    imap_host: v('set-imap-host'),
    imap_port: v('set-imap-port') || '993',
    imap_username: v('set-imap-user'),
    imap_mailbox: v('set-imap-mailbox') || 'INBOX',
  };
  const pass = v('set-imap-pass');
  if (pass) body.imap_password = pass;
  if (!body.imap_host) { toast('Host required', 'error'); return; }
  if (!body.imap_username) { toast('Username required', 'error'); return; }
  const { data } = await api('POST', '/settings/imap', body);
  if (data.success) { toast('IMAP saved', 'success'); setTimeout(() => renderSettings(), 500); }
  else toast(data.error?.message || 'Failed', 'error');
}
async function deleteSettingsImap() {
  if (!confirm('Remove IMAP credentials? Email ingestion will stop for this tenant.')) return;
  const { data } = await api('DELETE', '/settings/imap');
  if (data.success) { toast('IMAP removed', 'info'); renderSettings(); }
  else toast(data.error?.message || 'Failed', 'error');
}
async function saveSettingsPudo() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const body = { pudo_username: v('set-pudo-user') };
  const pass = v('set-pudo-pass');
  const key = v('set-pudo-key');
  if (pass) body.pudo_password = pass;
  if (key) body.pudo_api_key = key;
  if (!body.pudo_username) { toast('Email required', 'error'); return; }
  const { data } = await api('POST', '/settings/pudo', body);
  if (data.success) { toast('PUDO saved', 'success'); setTimeout(() => renderSettings(), 500); }
  else toast(data.error?.message || 'Failed', 'error');
}
async function deleteSettingsPudo() {
  if (!confirm('Remove PUDO credentials? Fulfillment will stop for this tenant.')) return;
  const { data } = await api('DELETE', '/settings/pudo');
  if (data.success) { toast('PUDO removed', 'info'); renderSettings(); }
  else toast(data.error?.message || 'Failed', 'error');
}
async function saveSettingsCollection() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const num = (id) => { const s = v(id); if (!s) return null; const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

  // Build the optional door collection address: only send it if at least
  // street_address + city + zone + code are filled. Otherwise the server
  // schema would reject a half-filled object.
  let collectionAddress = null;
  const street = v('set-coll-street');
  const city   = v('set-coll-city');
  const zone   = v('set-coll-zone');
  const code   = v('set-coll-code');
  if (street && city && zone && code) {
    collectionAddress = {
      street_address: street,
      local_area: '',
      suburb: v('set-coll-suburb'),
      city,
      zone,
      code,
      country: 'South Africa',
      type: v('set-coll-type') || 'business',
      lat: num('set-coll-lat'),
      lng: num('set-coll-lng'),
    };
  }

  const b = {
    contact_name: v('set-coll-name'),
    contact_email: v('set-coll-email'),
    contact_phone: v('set-coll-phone'),
    collection_terminal_id: v('set-coll-terminal') || null,
    collection_address: collectionAddress,
  };
  const { data } = await api('POST', '/settings/collection-contact', b);
  if (data.success) toast('Collection contact saved', 'success');
  else toast(data.error?.message || 'Failed', 'error');
}

async function renderWhatsApp() {
  const [{ data: settingsRes }, { data: bizRes }, { data: tplRes }, { data: eventsRes }, { data: msgRes }] = await Promise.all([
    api('GET', '/whatsapp/settings'),
    api('GET', '/whatsapp/business-settings'),
    api('GET', '/whatsapp/templates'),
    api('GET', '/whatsapp/event-types'),
    api('GET', '/whatsapp/messages?limit=30'),
  ]);
  const settings = settingsRes && settingsRes.success ? settingsRes.data : { configured: false };
  const biz = bizRes && bizRes.success ? bizRes.data : { configured: false };
  const templates = tplRes && tplRes.success ? tplRes.data : [];
  const eventTypes = eventsRes && eventsRes.success ? eventsRes.data : [];
  const messages = msgRes && msgRes.success ? msgRes.data : [];
  window._waEventTypes = eventTypes;

  let html = `<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">`;

  // Cloud API settings
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Cloud API (Sending)</h3>`;
  if (settings.configured) html += `<div class="flex items-center gap-2 mb-4"><span class="w-2 h-2 rounded-full bg-green-400"></span><span class="text-sm text-green-600 font-medium">Connected</span><span class="text-xs text-gray-400 ml-2">${settings.phone_number_id||''}</span></div>`;
  html += `<div class="space-y-3">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Phone Number ID</label><input id="wa-pn-id" value="${settings.phone_number_id||''}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Business Account ID</label><input id="wa-baid" value="${settings.business_account_id||''}" placeholder="optional" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Display Number</label><input id="wa-display" value="${settings.display_phone_number||''}" placeholder="+27..." class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Access Token</label><input id="wa-token" type="password" placeholder="paste new token" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Verify Token</label><input id="wa-verify" value="${settings.verify_token||''}" placeholder="for inbound webhook" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `</div><div class="flex gap-2 mt-4"><button onclick="saveWaSettings()" class="flex-1 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Save</button>`;
  if (settings.configured) html += `<button onclick="deleteWaSettings()" class="px-4 py-2.5 bg-red-50 text-red-500 font-semibold rounded-full text-sm hover:bg-red-100 transition-all">Remove</button>`;
  html += `</div></div>`;

  // Business Account settings (for Meta template management)
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-1">Business Account (Templates)</h3>`;
  html += `<p class="text-xs text-gray-400 mb-4">Required to submit templates to Meta for approval. Uses a System User token.</p>`;
  if (biz.configured) html += `<div class="flex items-center gap-2 mb-4"><span class="w-2 h-2 rounded-full bg-green-400"></span><span class="text-sm text-green-600 font-medium">Connected</span><span class="text-xs text-gray-400 ml-2">${biz.business_account_id||''}</span></div>`;
  html += `<div class="space-y-3">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Business Account ID</label><input id="wa-biz-id" value="${biz.business_account_id||''}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">System User Token</label><input id="wa-biz-token" type="password" placeholder="paste new token" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `</div><button onclick="saveWaBusiness()" class="mt-4 w-full py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Save</button></div>`;

  html += `</div>`; // grid

  // Templates section
  html += `<div class="bg-white rounded-3xl shadow-card p-6 mt-6">`;
  html += `<div class="flex items-center justify-between mb-4"><h3 class="font-bold text-base">Templates (${templates.length})</h3><button onclick="showCreateTemplateModal()" class="px-4 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-xs transition-all">New Template</button></div>`;

  if (templates.length === 0) {
    html += emptyState('No templates yet', 'Create a template, map it to events, optionally submit to Meta for approval.');
  } else {
    html += `<div class="space-y-3">`;
    templates.forEach(t => {
      const events = Array.isArray(t.event_types) ? t.event_types : [];
      const metaStatus = t.meta_status || 'DRAFT';
      const metaCls = metaStatus === 'APPROVED' ? 'completed' : metaStatus === 'REJECTED' ? 'failed' : metaStatus === 'PENDING' ? 'processing' : 'pending';
      html += `<div class="p-4 rounded-2xl border border-gray-100 hover:bg-surface-100 transition-all">`;
      html += `<div class="flex items-center justify-between mb-2 gap-3 flex-wrap">`;
      html += `<div class="flex items-center gap-2 flex-wrap"><span class="text-sm font-semibold">${t.purpose}</span>`;
      html += `<span class="text-[10px] text-gray-400 uppercase">${t.language_code||'en'}</span>`;
      html += badge(metaCls, 'Meta: ' + metaStatus);
      if (t.meta_quality_score) html += `<span class="text-[10px] text-gray-400">Q: ${t.meta_quality_score}</span>`;
      html += `</div>`;
      html += `<label class="text-xs"><input type="checkbox" ${t.enabled?'checked':''} onchange="toggleWaTemplate('${t.purpose}',this.checked)"> enabled</label>`;
      html += `</div>`;

      // Event types display
      html += `<div class="text-[11px] text-gray-500 mb-2">Triggers on: ${events.length ? events.map(e => `<span class="inline-block px-2 py-0.5 bg-brand-50 text-brand-700 rounded-full mr-1">${e}</span>`).join('') : '<em class="text-gray-400">no events (manual only)</em>'}</div>`;

      // Body preview
      html += `<div class="text-xs text-gray-700 whitespace-pre-wrap bg-surface-100 rounded-lg p-2 max-h-20 overflow-y-auto">${escapeHtml(t.body_text||'')}</div>`;

      // Actions
      html += `<div class="flex gap-2 mt-2 flex-wrap">`;
      html += `<button onclick="editWaTemplate('${t.purpose}')" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs transition-all">Edit</button>`;
      if (metaStatus === 'DRAFT' || metaStatus === 'REJECTED') {
        html += `<button onclick="submitToMeta('${t.purpose}')" class="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 font-semibold rounded-full text-xs transition-all">Submit to Meta</button>`;
      } else if (metaStatus === 'PENDING' || metaStatus === 'APPROVED') {
        html += `<button onclick="syncFromMeta('${t.purpose}')" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs transition-all">Sync from Meta</button>`;
      }
      html += `<button onclick="deleteWaTemplate('${t.purpose}')" class="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-500 font-semibold rounded-full text-xs transition-all">Delete</button>`;
      html += `</div>`;
      if (t.meta_rejection_reason) html += `<div class="text-xs text-red-500 mt-2">${escapeHtml(t.meta_rejection_reason)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;

  // Test send
  html += `<div class="bg-white rounded-3xl shadow-card p-6 mt-6"><h3 class="font-bold text-base mb-4">Send Test</h3>`;
  html += `<div class="grid grid-cols-1 md:grid-cols-3 gap-3">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">To (phone)</label><input id="wa-test-to" placeholder="+2783..." class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div class="md:col-span-2"><label class="block text-xs text-gray-400 mb-1">Template</label><select id="wa-test-purpose" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
  templates.forEach(t => { html += `<option value="${t.purpose}">${t.purpose}</option>`; });
  html += `</select></div></div>`;
  html += `<button onclick="sendWaTest()" class="mt-4 w-full md:w-auto px-6 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Send Test</button></div>`;

  // Messages log
  if (messages.length) {
    html += `<div class="bg-white rounded-3xl shadow-card p-6 mt-6"><h3 class="font-bold text-base mb-4">Recent Messages</h3><div class="space-y-2 max-h-[400px] overflow-y-auto">`;
    messages.forEach(m => {
      const time = new Date(m.created_at).toLocaleString();
      const dir = m.direction === 'outbound' ? 'text-blue-600' : 'text-green-600';
      html += `<div class="flex items-start gap-3 p-2 rounded-xl hover:bg-surface-100"><div class="flex-1"><div class="flex items-center gap-2"><span class="text-xs font-semibold ${dir}">${m.direction}</span><span class="text-[11px] text-gray-400">${time}</span>${badge(m.status)}</div><div class="text-xs text-gray-600 mt-1 truncate max-w-md">${escapeHtml(m.body||'')}</div></div><span class="text-[11px] text-gray-400 whitespace-nowrap">${m.phone_to||m.phone_from||''}</span></div>`;
    });
    html += `</div></div>`;
  }

  document.getElementById('tab-content').innerHTML = html;
  window._waTemplates = templates;
}
async function saveWaSettings() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const body = {
    phone_number_id: v('wa-pn-id'),
    display_phone_number: v('wa-display'),
    business_account_id: v('wa-baid'),
    verify_token: v('wa-verify'),
  };
  const tok = v('wa-token');
  if (tok) body.access_token = tok;
  if (!body.phone_number_id) { toast('Phone Number ID is required', 'error'); return; }
  if (!body.access_token) { toast('Access Token is required (paste a new one to save)', 'error'); return; }
  const { data } = await api('POST', '/whatsapp/settings', body);
  if (data.success) { toast('WhatsApp settings saved', 'success'); setTimeout(() => renderWhatsApp(), 500); }
  else toast(data.error?.message || 'Failed', 'error');
}
async function deleteWaSettings() { if(!confirm('Remove WhatsApp settings?'))return; await api('DELETE','/whatsapp/settings'); toast('Removed','info'); renderWhatsApp(); }
async function saveWaTemplate(purpose) { const body_text=document.getElementById('wa-tpl-'+purpose).value; const{data}=await api('PUT','/whatsapp/templates/'+purpose,{body_text}); if(data.success)toast('Template saved','success');else toast('Failed','error'); }
async function toggleWaTemplate(purpose,enabled) { await api('PUT','/whatsapp/templates/'+purpose,{enabled}); }
async function sendWaTest() { const to=document.getElementById('wa-test-to').value; const purpose=document.getElementById('wa-test-purpose').value; if(!to){toast('Enter a phone number','error');return;} const{data}=await api('POST','/whatsapp/test',{to,purpose}); if(data.success&&data.data.sent)toast('Test sent','success');else toast(data.data?.skipped_reason||data.data?.error||'Failed','warning'); }

async function renderInbox() {
  const { data } = await api('GET', '/knowledge/__conversations');
  const convs = data && data.success ? data.data : [];
  let html = `<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">`;
  // Conversation list
  html += `<div class="bg-white rounded-3xl shadow-card p-5"><h3 class="font-bold text-sm mb-4">Conversations (${convs.length})</h3>`;
  if (convs.length === 0) { html += emptyState('No conversations','Inbound WhatsApp messages will appear here.'); }
  else {
    html += `<div class="space-y-2 max-h-[600px] overflow-y-auto">`;
    convs.forEach(c => {
      const t = c.last_message_at ? new Date(c.last_message_at).toLocaleString() : '';
      html += `<div onclick="openConv('${c.id}')" class="p-3 rounded-xl border border-gray-100 hover:border-brand-300 cursor-pointer transition-all">`;
      html += `<div class="flex items-center justify-between"><span class="text-sm font-medium">${c.customer_phone_normalized}</span>${badge(c.status==='escalated'?'failed':c.status==='closed'?'completed':'processing',c.status)}</div>`;
      html += `<div class="text-[11px] text-gray-400 mt-1">${c.current_intent||'no intent'} - ${t}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  // Messages panel
  html += `<div class="lg:col-span-2" id="conv-detail-panel"><div class="bg-white rounded-3xl shadow-card p-8 flex items-center justify-center min-h-[300px]"><p class="text-sm text-gray-400">Select a conversation</p></div></div>`;
  html += `</div>`;
  document.getElementById('tab-content').innerHTML = html;
}
async function openConv(id) {
  const { data } = await api('GET', '/knowledge/__conversations/' + id + '/messages');
  if (!data.success) return;
  const conv = data.data.conversation; const msgs = data.data.messages;
  window._currentConvId = id;
  let html = `<div class="bg-white rounded-3xl shadow-card p-6">`;
  html += `<div class="flex items-center justify-between mb-4"><h3 class="font-bold">${conv.customer_phone_normalized}</h3>${badge(conv.status==='escalated'?'failed':'processing',conv.status)}</div>`;
  html += `<div class="text-xs text-gray-400 mb-4">Intent: ${conv.current_intent||'-'}</div>`;
  html += `<div class="space-y-3 max-h-[500px] overflow-y-auto">`;
  msgs.forEach(m => {
    const isUser = m.role === 'user';
    const isAssistant = m.role === 'assistant';
    html += `<div class="flex ${isUser?'justify-start':'justify-end'}"><div class="max-w-[75%] p-3 rounded-2xl ${isUser?'bg-surface-100':'bg-brand-50'}">`;
    html += `<div class="text-[10px] text-gray-400 mb-1">${m.role}${m.agent?' / '+m.agent:''}${m.intent?' / '+m.intent:''}</div>`;
    html += `<div class="text-sm whitespace-pre-wrap">${escapeHtml(m.content||'')}</div>`;
    html += `<div class="text-[10px] text-gray-300 mt-1">${new Date(m.created_at).toLocaleString()}</div>`;
    // Feedback buttons for assistant messages
    if (isAssistant) {
      html += `<div class="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100">`;
      if (m.feedback === 'up') {
        html += `<span class="text-green-500 text-xs font-medium">👍 Good</span>`;
      } else if (m.feedback === 'down') {
        html += `<span class="text-red-500 text-xs font-medium">👎 Corrected</span>`;
        if (m.feedback_correction) html += `<span class="text-[10px] text-gray-400 ml-1 truncate max-w-[200px]" title="${escapeHtml(m.feedback_correction)}">"${escapeHtml(m.feedback_correction.substring(0,50))}..."</span>`;
      } else {
        html += `<button onclick="msgFeedback('${m.id}','up')" class="px-2 py-1 text-xs text-gray-400 hover:text-green-500 hover:bg-green-50 rounded-lg transition-all" title="Good response">👍</button>`;
        html += `<button onclick="showMsgCorrection('${m.id}')" class="px-2 py-1 text-xs text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all" title="Bad response — correct it">👎</button>`;
      }
      html += `</div>`;
    }
    html += `</div></div>`;
  });
  html += `</div></div>`;
  document.getElementById('conv-detail-panel').innerHTML = html;
  openMobileDetail('conv-detail-panel');
}

async function msgFeedback(msgId, feedback) {
  const { data } = await api('POST', `/knowledge/__conversations/${window._currentConvId}/messages/${msgId}/feedback`, { feedback });
  if (data.success) { toast(feedback === 'up' ? 'Marked as good' : 'Marked as bad', feedback === 'up' ? 'success' : 'warning'); openConv(window._currentConvId); }
  else toast(data.error?.message || 'Failed', 'error');
}

function showMsgCorrection(msgId) {
  const body = `
    <div class="space-y-4">
      <p class="text-sm text-gray-500">What should the AI have said instead? This will be used as a training example for future conversations.</p>
      <textarea id="msg-correction-text" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400 min-h-[120px]" placeholder="Type the correct response here..."></textarea>
      <button onclick="submitMsgCorrection('${msgId}')" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Save Correction</button>
    </div>`;
  openModal('Correct AI Response', body);
}

async function submitMsgCorrection(msgId) {
  const correction = document.getElementById('msg-correction-text').value;
  if (!correction.trim()) { toast('Write the correct response', 'error'); return; }
  const { data } = await api('POST', `/knowledge/__conversations/${window._currentConvId}/messages/${msgId}/feedback`, { feedback: 'down', correction });
  if (data.success) { toast('Correction saved — AI will learn from this', 'success'); closeModal(); openConv(window._currentConvId); }
  else toast(data.error?.message || 'Failed', 'error');
}

async function renderKnowledge() {
  const [{ data: srcRes }, { data: docRes }] = await Promise.all([api('GET', '/knowledge/sources'), api('GET', '/knowledge?limit=200')]);
  const sources = srcRes && srcRes.success ? srcRes.data : [];
  const docs = docRes && docRes.success ? docRes.data : [];

  let html = '';
  // Add source card
  html += `<div class="bg-white rounded-3xl shadow-card p-6 mb-6"><h3 class="font-bold text-base mb-4">Add Knowledge</h3>`;
  html += `<p class="text-sm text-gray-400 mb-4">Pull content from URLs, sitemaps, files, or Shopify products. The chatbot answers from these.</p>`;
  html += `<div class="space-y-3">`;
  html += `<div class="flex gap-2"><input id="kb-url" placeholder="https://yourstore.com/pages/return-policy" class="flex-1 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"><button onclick="addKbUrl()" class="px-4 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-xs transition-all">Add URL</button></div>`;
  html += `<div class="flex gap-2"><input id="kb-sitemap" placeholder="https://yourstore.com/sitemap.xml" class="flex-1 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"><button onclick="addKbSitemap()" class="px-4 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-xs transition-all">Crawl</button></div>`;
  html += `<div class="flex gap-2 items-center"><input id="kb-file" type="file" accept=".pdf,.txt,.html" class="flex-1 text-sm"><button onclick="uploadKbFile()" class="px-4 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-xs transition-all">Upload</button></div>`;
  html += `<button onclick="syncShopify()" class="w-full py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-sm transition-all">Sync Shopify Products</button>`;
  html += `</div></div>`;

  // Sources
  if (sources.length) {
    html += `<div class="bg-white rounded-3xl shadow-card p-6 mb-6"><h3 class="font-bold text-base mb-4">Sources (${sources.length})</h3><div class="space-y-2">`;
    sources.forEach(s => {
      html += `<div class="flex items-center justify-between p-3 rounded-xl border border-gray-100">`;
      html += `<div><div class="text-sm font-medium">${escapeHtml(s.label)}</div><div class="text-[11px] text-gray-400">${s.source_type} - ${s.document_count} docs</div></div>`;
      html += `<div class="flex items-center gap-2">${badge(s.status)}`;
      if (s.source_type!=='upload'&&s.source_type!=='manual') html += `<button onclick="resyncKbSource('${s.id}')" class="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded-full text-xs font-medium transition-all">Re-sync</button>`;
      html += `<button onclick="deleteKbSource('${s.id}')" class="px-3 py-1 bg-red-50 hover:bg-red-100 text-red-500 rounded-full text-xs font-medium transition-all">Delete</button>`;
      html += `</div></div>`;
    });
    html += `</div></div>`;
  }

  // Documents
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Documents (${docs.length})</h3>`;
  if (docs.length === 0) { html += emptyState('No documents','Add a URL, upload a file, or sync Shopify products above.'); }
  else {
    html += `<div class="space-y-2 max-h-[500px] overflow-y-auto">`;
    docs.slice(0,80).forEach(d => {
      html += `<div class="p-3 rounded-xl border border-gray-100 hover:bg-surface-100 transition-all">`;
      html += `<div class="flex items-center justify-between mb-1"><span class="text-sm font-medium">${escapeHtml(d.title)}</span><div class="flex items-center gap-2">${d.category?`<span class="text-[10px] text-gray-400">${d.category}</span>`:''}${d.source_url?`<a href="${d.source_url}" target="_blank" class="text-[10px] text-brand-600 hover:underline">link</a>`:''}<button onclick="deleteKbDoc('${d.id}')" class="text-[10px] text-red-400 hover:text-red-600">delete</button></div></div>`;
      html += `<div class="text-xs text-gray-400 truncate">${escapeHtml((d.body||'').substring(0,150))}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  document.getElementById('tab-content').innerHTML = html;
}
async function addKbUrl() { const url=document.getElementById('kb-url').value.trim(); if(!url){toast('Enter a URL','error');return;} toast('Fetching...','info'); const{data}=await api('POST','/knowledge/sources/url',{url}); if(data.success){toast(`Added ${data.data.documents_added} docs`,'success');renderKnowledge();}else toast(data.error?.message||'Failed','error'); }
async function addKbSitemap() { const sitemap_url=document.getElementById('kb-sitemap').value.trim(); if(!sitemap_url){toast('Enter a sitemap URL','error');return;} toast('Crawling...','info'); const{data}=await api('POST','/knowledge/sources/sitemap',{sitemap_url,max_pages:50}); if(data.success){toast(`Crawled: +${data.data.documents_added} docs`,'success');renderKnowledge();}else toast(data.error?.message||'Failed','error'); }
async function uploadKbFile() { const fileInput=document.getElementById('kb-file'); const file=fileInput.files[0]; if(!file){toast('Choose a file','error');return;} toast('Uploading...','info'); const fd=new FormData();fd.append('file',file); const opts={method:'POST',body:fd,headers:{}}; if(token)opts.headers['Authorization']='Bearer '+token; try{const r=await fetch(API+'/knowledge/sources/upload',opts);const data=await r.json();if(data.success){toast(`Uploaded: +${data.data.documents_added} docs`,'success');fileInput.value='';renderKnowledge();}else toast(data.error?.message||'Failed','error');}catch(e){toast(e.message,'error');} }
async function syncShopify() { toast('Syncing Shopify products...','info'); const{data}=await api('POST','/knowledge/sources/shopify-products',{}); if(data.success){toast(`Synced: +${data.data.documents_added} products`,'success');renderKnowledge();}else toast(data.error?.message||'Failed','error'); }
async function resyncKbSource(id) { toast('Re-syncing...','info'); const{data}=await api('POST','/knowledge/sources/'+id+'/resync',{}); if(data.success){toast('Re-synced','success');renderKnowledge();}else toast(data.error?.message||'Failed','error'); }
async function deleteKbSource(id) { if(!confirm('Delete this source and all its documents?'))return; await api('DELETE','/knowledge/sources/'+id); toast('Deleted','info'); renderKnowledge(); }
async function deleteKbDoc(id) { await api('DELETE','/knowledge/'+id); renderKnowledge(); }

// ---- Init ----

(async function init() {
  if (token) {
    const { status, data } = await api('GET', '/auth/me');
    if (status === 200 && data.success) {
      const initial = (data.data.tenant.email||'U')[0].toUpperCase();
      document.getElementById('user-avatar').textContent = initial;
      currentUserPermissions = (data.data.user && data.data.user.permissions) || [];
      if (data.data.tenant.status === 'active') loadDashboard(); else loadOnboarding();
    } else { token = null; localStorage.removeItem('token'); showPage('login'); }
  } else { showPage('login'); }
})();


// ---- Failed Jobs / DLQ ----

let _dlqActiveQueue = null;

async function renderFailed() {
  const { data: summaryRes } = await api('GET', '/dlq/summary');
  const summary = summaryRes && summaryRes.success ? summaryRes.data : { queues: [], outbox_failed_events: 0 };

  // Default to first queue with failures, else first queue
  if (!_dlqActiveQueue) {
    const withFailures = summary.queues.find(q => q.counts.failed > 0);
    _dlqActiveQueue = withFailures ? withFailures.name : (summary.queues[0]?.name || null);
  }

  let html = '';

  // Top stats — one card per queue
  html += `<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">`;
  summary.queues.forEach(q => {
    const isActive = q.name === _dlqActiveQueue;
    const failedColor = q.counts.failed > 0 ? 'text-red-500' : 'text-gray-400';
    html += `<div onclick="setDlqQueue('${q.name}')" class="bg-white rounded-2xl p-5 cursor-pointer transition-all border-2 ${isActive ? 'border-brand-400 shadow-card-hover' : 'border-transparent shadow-card hover:border-brand-200'}">`;
    html += `<div class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">${q.label}</div>`;
    html += `<div class="text-2xl font-bold mt-1 ${failedColor}">${q.counts.failed}</div>`;
    html += `<div class="text-[11px] text-gray-400 mt-1">${q.counts.active} active - ${q.counts.waiting} waiting</div>`;
    html += `</div>`;
  });
  // Outbox card
  const outboxColor = summary.outbox_failed_events > 0 ? 'text-red-500' : 'text-gray-400';
  const outboxActive = _dlqActiveQueue === 'outbox';
  html += `<div onclick="setDlqQueue('outbox')" class="bg-white rounded-2xl p-5 cursor-pointer transition-all border-2 ${outboxActive ? 'border-brand-400 shadow-card-hover' : 'border-transparent shadow-card hover:border-brand-200'}">`;
  html += `<div class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Outbox Events</div>`;
  html += `<div class="text-2xl font-bold mt-1 ${outboxColor}">${summary.outbox_failed_events}</div>`;
  html += `<div class="text-[11px] text-gray-400 mt-1">domain events</div>`;
  html += `</div>`;
  html += `</div>`;

  // Failed jobs panel
  html += `<div id="dlq-detail-panel" class="bg-white rounded-3xl shadow-card p-6">`;
  html += `<div class="text-center py-10 text-sm text-gray-400">Loading...</div>`;
  html += `</div>`;

  document.getElementById('tab-content').innerHTML = html;

  if (_dlqActiveQueue === 'outbox') {
    loadOutboxFailed();
  } else if (_dlqActiveQueue) {
    loadQueueFailed(_dlqActiveQueue);
  }
}

function setDlqQueue(name) { _dlqActiveQueue = name; renderFailed(); }

async function loadQueueFailed(queueName) {
  const { data } = await api('GET', `/dlq/${queueName}/failed?limit=50`);
  const jobs = data && data.success ? data.data : [];
  const panel = document.getElementById('dlq-detail-panel');
  if (!panel) return;

  let html = `<div class="flex items-center justify-between mb-5"><div><h3 class="font-bold text-base">Failed Jobs - ${queueName}</h3><p class="text-xs text-gray-400 mt-0.5">${jobs.length} failed</p></div></div>`;

  if (jobs.length === 0) {
    html += emptyState('No failed jobs','This queue has no failures right now.');
  } else {
    jobs.forEach(j => {
      const time = j.finishedOn ? new Date(j.finishedOn).toLocaleString() : '';
      const dataPreview = JSON.stringify(j.data || {}, null, 2).substring(0, 400);
      html += `<div class="border border-gray-100 rounded-2xl p-4 mb-3">`;
      html += `<div class="flex items-start justify-between gap-3 mb-2">`;
      html += `<div class="flex-1 min-w-0"><div class="text-sm font-semibold">${escapeHtml(j.name||'job')} <span class="text-xs text-gray-400 ml-2">${j.id}</span></div>`;
      html += `<div class="text-xs text-gray-400 mt-0.5">${time} - ${j.attemptsMade} attempts</div></div>`;
      html += `<div class="flex gap-2 flex-shrink-0">`;
      html += `<button onclick="dlqRetry('${queueName}','${j.id}')" class="px-3 py-1.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-xs transition-all">Retry</button>`;
      html += `<button onclick="dlqDiscard('${queueName}','${j.id}')" class="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-500 font-semibold rounded-full text-xs transition-all">Discard</button>`;
      html += `</div></div>`;
      if (j.failedReason) html += `<div class="text-xs text-red-500 bg-red-50 rounded-lg p-2 mt-2">${escapeHtml(j.failedReason)}</div>`;
      html += `<details class="mt-2"><summary class="text-[11px] text-gray-400 cursor-pointer hover:text-gray-600">View payload</summary><pre class="mt-1 text-[10px] text-gray-500 bg-surface-100 rounded-xl p-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-all">${escapeHtml(dataPreview)}</pre></details>`;
      html += `</div>`;
    });
  }
  panel.innerHTML = html;
}

async function loadOutboxFailed() {
  const { data } = await api('GET', '/dlq/outbox?limit=100');
  const events = data && data.success ? data.data : [];
  const panel = document.getElementById('dlq-detail-panel');
  if (!panel) return;

  let html = `<div class="flex items-center justify-between mb-5"><div><h3 class="font-bold text-base">Failed Outbox Events</h3><p class="text-xs text-gray-400 mt-0.5">${events.length} failed</p></div></div>`;

  if (events.length === 0) {
    html += emptyState('No failed events','All domain events have been dispatched successfully.');
  } else {
    events.forEach(e => {
      const time = new Date(e.created_at).toLocaleString();
      html += `<div class="border border-gray-100 rounded-2xl p-4 mb-3">`;
      html += `<div class="flex items-start justify-between gap-3 mb-2">`;
      html += `<div class="flex-1 min-w-0"><div class="text-sm font-semibold">${escapeHtml(e.event_type)}</div>`;
      html += `<div class="text-xs text-gray-400 mt-0.5">${time} - ${e.dispatch_attempts} attempts - ${e.aggregate_type}/${e.aggregate_id.substring(0,8)}</div></div>`;
      html += `<div class="flex gap-2 flex-shrink-0">`;
      html += `<button onclick="outboxRetry('${e.id}')" class="px-3 py-1.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-xs transition-all">Retry</button>`;
      html += `<button onclick="outboxDiscard('${e.id}')" class="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-500 font-semibold rounded-full text-xs transition-all">Discard</button>`;
      html += `</div></div>`;
      if (e.last_error) html += `<div class="text-xs text-red-500 bg-red-50 rounded-lg p-2 mt-2">${escapeHtml(e.last_error)}</div>`;
      html += `</div>`;
    });
  }
  panel.innerHTML = html;
}

async function dlqRetry(queue, jobId) {
  const { data } = await api('POST', `/dlq/${queue}/retry`, { job_id: jobId });
  if (data.success) { toast('Job re-enqueued','success'); renderFailed(); }
  else toast(data.error?.message||'Failed','error');
}
async function dlqDiscard(queue, jobId) {
  if (!confirm('Permanently discard this job?')) return;
  const { data } = await api('POST', `/dlq/${queue}/discard`, { job_id: jobId });
  if (data.success) { toast('Job discarded','info'); renderFailed(); }
  else toast(data.error?.message||'Failed','error');
}
async function outboxRetry(eventId) {
  const { data } = await api('POST', '/dlq/outbox/retry', { event_id: eventId });
  if (data.success) { toast('Event re-queued','success'); renderFailed(); }
  else toast(data.error?.message||'Failed','error');
}
async function outboxDiscard(eventId) {
  if (!confirm('Discard this event? It will not be dispatched.')) return;
  const { data } = await api('POST', '/dlq/outbox/discard', { event_id: eventId });
  if (data.success) { toast('Event discarded','info'); renderFailed(); }
  else toast(data.error?.message||'Failed','error');
}


// ---- AI Usage ----

async function renderUsage() {
  const [{ data: summaryRes }, { data: recentRes }] = await Promise.all([
    api('GET', '/usage/summary'),
    api('GET', '/usage/recent?limit=30'),
  ]);
  const summary = summaryRes && summaryRes.success ? summaryRes.data : { totals: {}, today: {}, by_agent: [], by_day: [] };
  const recent = recentRes && recentRes.success ? recentRes.data : [];

  let html = '';

  // Top stats
  html += `<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">`;
  html += statCard('Total Calls', summary.totals.calls || 0, 'text-gray-900');
  html += statCard('Total Tokens', formatNumber(summary.totals.tokens || 0), 'text-blue-600');
  html += statCard('Total Cost', '$' + (summary.totals.cost_usd || 0).toFixed(4), 'text-green-600');
  html += statCard('Avg Latency', (summary.totals.avg_latency_ms || 0) + 'ms', 'text-amber-600');
  html += `</div>`;

  // Today
  html += `<div class="grid grid-cols-3 gap-4 mb-6">`;
  html += statCard('Today Calls', summary.today.calls || 0, 'text-gray-900');
  html += statCard('Today Tokens', formatNumber(summary.today.tokens || 0), 'text-blue-600');
  html += statCard('Today Cost', '$' + (summary.today.cost_usd || 0).toFixed(4), 'text-green-600');
  html += `</div>`;

  // By agent
  html += `<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">`;
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Cost by Agent</h3>`;
  if (summary.by_agent.length === 0) {
    html += `<p class="text-sm text-gray-400">No usage data yet. AI calls will appear here automatically.</p>`;
  } else {
    html += `<div class="space-y-3">`;
    summary.by_agent.forEach(a => {
      const cost = parseFloat(a.total_cost || 0).toFixed(4);
      const tokens = formatNumber(parseInt(a.total_tokens || 0));
      const calls = parseInt(a.call_count || 0);
      const latency = Math.round(parseFloat(a.avg_latency_ms || 0));
      html += `<div class="flex items-center justify-between p-3 rounded-xl border border-gray-100">`;
      html += `<div><div class="text-sm font-semibold">${a.agent}</div><div class="text-[11px] text-gray-400">${calls} calls - ${tokens} tokens - ${latency}ms avg</div></div>`;
      html += `<span class="text-sm font-bold text-green-600">$${cost}</span>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;

  // By day
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Daily Usage (last 30 days)</h3>`;
  if (summary.by_day.length === 0) {
    html += `<p class="text-sm text-gray-400">No daily data yet.</p>`;
  } else {
    html += `<div class="space-y-2 max-h-[400px] overflow-y-auto">`;
    summary.by_day.forEach(d => {
      const day = new Date(d.day).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
      const cost = parseFloat(d.total_cost || 0).toFixed(4);
      const calls = parseInt(d.call_count || 0);
      html += `<div class="flex items-center justify-between py-2 border-b border-gray-50">`;
      html += `<span class="text-sm">${day}</span>`;
      html += `<div class="text-right"><span class="text-sm font-semibold text-green-600">$${cost}</span><span class="text-[11px] text-gray-400 ml-3">${calls} calls</span></div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div></div>`;

  // Recent calls
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Recent Calls</h3>`;
  if (recent.length === 0) {
    html += emptyState('No AI calls yet', 'Process an order email or send a WhatsApp message to generate usage data.');
  } else {
    html += `<div class="space-y-2 max-h-[400px] overflow-y-auto">`;
    recent.forEach(r => {
      const time = new Date(r.created_at).toLocaleString();
      const cost = parseFloat(r.cost_usd || 0).toFixed(5);
      const statusCls = r.success ? 'completed' : 'failed';
      html += `<div class="flex items-center justify-between p-3 rounded-xl border border-gray-100">`;
      html += `<div class="flex-1 min-w-0"><div class="flex items-center gap-2"><span class="text-sm font-medium">${r.agent}</span>${badge(statusCls, r.success ? 'ok' : 'error')}</div>`;
      html += `<div class="text-[11px] text-gray-400 mt-0.5">${r.model} - v${r.prompt_version || '?'} - ${time}</div></div>`;
      html += `<div class="text-right flex-shrink-0 ml-4"><div class="text-xs font-semibold">${r.total_tokens} tok</div><div class="text-[11px] text-green-600">$${cost}</div><div class="text-[11px] text-gray-400">${r.latency_ms}ms</div></div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;

  document.getElementById('tab-content').innerHTML = html;
}

function formatNumber(n) { return n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n); }


// ---- Agent Runs (Replay + Corrections) ----

async function loadAgentRuns(agent) {
  const url = agent ? `/agent-runs?agent=${agent}&limit=20` : '/agent-runs?limit=20';
  const { data } = await api('GET', url);
  const runs = data && data.success ? data.data : [];
  const panel = document.getElementById('agent-runs-panel');
  if (!panel) return;

  if (runs.length === 0) {
    panel.innerHTML = emptyState('No runs yet', 'AI calls will appear here as they happen.');
    return;
  }

  let html = `<div class="space-y-2 max-h-[500px] overflow-y-auto">`;
  runs.forEach(r => {
    const time = new Date(r.created_at).toLocaleString();
    const statusCls = r.status === 'approved' ? 'completed' : r.status === 'corrected' ? 'warning' : 'processing';
    html += `<div class="flex items-center justify-between p-3 rounded-xl border border-gray-100 hover:bg-surface-100 transition-all">`;
    html += `<div class="flex-1 min-w-0"><div class="flex items-center gap-2"><span class="text-sm font-medium">${r.agent}</span>${badge(statusCls, r.status)}${r.success ? '' : badge('failed','error')}</div>`;
    html += `<div class="text-[11px] text-gray-400 mt-0.5">${r.model} v${r.prompt_version||'?'} - ${r.total_tokens||r.prompt_tokens+r.completion_tokens} tok - ${r.latency_ms}ms - ${time}</div></div>`;
    html += `<div class="flex gap-2 flex-shrink-0 ml-3">`;
    html += `<button onclick="viewRun('${r.id}')" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs transition-all">Replay</button>`;
    if (r.status === 'unreviewed') {
      html += `<button onclick="approveRun('${r.id}')" class="px-3 py-1.5 bg-green-50 hover:bg-green-100 text-green-600 font-semibold rounded-full text-xs transition-all">Approve</button>`;
      html += `<button onclick="showCorrectModal('${r.id}')" class="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-600 font-semibold rounded-full text-xs transition-all">Correct</button>`;
    }
    html += `</div></div>`;
  });
  html += `</div>`;
  panel.innerHTML = html;
}

async function viewRun(runId) {
  const { data } = await api('GET', '/agent-runs/' + runId);
  if (!data.success) { toast('Failed to load run', 'error'); return; }
  const run = data.data.run;
  const correction = data.data.correction;

  let messagesIn = [];
  try { messagesIn = typeof run.messages_in === 'string' ? JSON.parse(run.messages_in) : run.messages_in; } catch {}
  let responseOut = {};
  try { responseOut = typeof run.response_out === 'string' ? JSON.parse(run.response_out) : run.response_out; } catch {}

  let body = `<div class="space-y-4">`;
  body += `<div class="grid grid-cols-3 gap-3 text-xs">`;
  body += `<div class="bg-surface-100 rounded-xl p-3"><div class="text-gray-400 uppercase text-[10px]">Agent</div><div class="font-semibold mt-0.5">${run.agent}</div></div>`;
  body += `<div class="bg-surface-100 rounded-xl p-3"><div class="text-gray-400 uppercase text-[10px]">Model</div><div class="font-semibold mt-0.5">${run.model} v${run.prompt_version||'?'}</div></div>`;
  body += `<div class="bg-surface-100 rounded-xl p-3"><div class="text-gray-400 uppercase text-[10px]">Cost</div><div class="font-semibold mt-0.5">$${parseFloat(run.cost_usd||0).toFixed(5)} - ${run.latency_ms}ms</div></div>`;
  body += `</div>`;

  // Messages
  body += `<div><div class="text-xs font-semibold text-gray-500 uppercase mb-2">Messages Sent (${messagesIn.length})</div>`;
  body += `<div class="space-y-2 max-h-[300px] overflow-y-auto">`;
  messagesIn.forEach(m => {
    const roleCls = m.role === 'system' ? 'bg-gray-100' : m.role === 'user' ? 'bg-blue-50' : 'bg-green-50';
    body += `<div class="p-3 rounded-xl ${roleCls}"><div class="text-[10px] font-semibold text-gray-400 uppercase">${m.role}</div><pre class="text-xs text-gray-700 mt-1 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">${escapeHtml((m.content||'').substring(0, 2000))}</pre></div>`;
  });
  body += `</div></div>`;

  // Response
  body += `<div><div class="text-xs font-semibold text-gray-500 uppercase mb-2">Model Response</div>`;
  body += `<div class="p-3 rounded-xl bg-brand-50"><pre class="text-xs text-gray-700 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">${escapeHtml((responseOut.content||JSON.stringify(responseOut,null,2)).substring(0, 3000))}</pre></div></div>`;

  // Correction if exists
  if (correction) {
    body += `<div class="p-3 rounded-xl bg-amber-50 border border-amber-200"><div class="text-[10px] font-semibold text-amber-600 uppercase mb-1">Correction Applied</div><pre class="text-xs text-gray-700 whitespace-pre-wrap">${escapeHtml(correction.corrected_output)}</pre>`;
    if (correction.correction_note) body += `<div class="text-[11px] text-gray-500 mt-2 italic">${escapeHtml(correction.correction_note)}</div>`;
    body += `</div>`;
  }

  body += `</div>`;

  openModal('Agent Run Replay', body);
}

async function approveRun(runId) {
  const { data } = await api('POST', '/agent-runs/' + runId + '/approve');
  if (data.success) { toast('Run approved', 'success'); loadAgentRuns(); }
  else toast(data.error?.message || 'Failed', 'error');
}

function showCorrectModal(runId) {
  const body = `
    <div class="space-y-4">
      <p class="text-sm text-gray-500">Provide the correct output. This will be used as a few-shot example in future calls to teach the agent the right behavior.</p>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Correct Output (JSON or text)</label>
        <textarea id="correction-output" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400 min-h-[150px]" placeholder='{"OrderNumber": "1234", "customer_name": "...", ...}'></textarea>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Note (optional)</label>
        <input id="correction-note" class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400" placeholder="e.g. The address should not include Pudo brand name">
      </div>
      <button onclick="submitCorrection('${runId}')" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Save Correction</button>
    </div>`;
  openModal('Correct Agent Output', body);
}

async function submitCorrection(runId) {
  const corrected_output = document.getElementById('correction-output').value;
  const correction_note = document.getElementById('correction-note').value;
  if (!corrected_output.trim()) { toast('Provide the correct output', 'error'); return; }
  const { data } = await api('POST', '/agent-runs/' + runId + '/correct', { corrected_output, correction_note });
  if (data.success) { toast('Correction saved — future calls will learn from this', 'success'); closeModal(); loadAgentRuns(); }
  else toast(data.error?.message || 'Failed', 'error');
}


// ---- Team & Roles (RBAC) ----

let _permissionCatalog = null;

async function renderUsers() {
  const [{ data: usersRes }, { data: catRes }] = await Promise.all([
    api('GET', '/users'),
    api('GET', '/users/permissions/catalog'),
  ]);
  const users = usersRes && usersRes.success ? usersRes.data : [];
  _permissionCatalog = catRes && catRes.success ? catRes.data : { permissions: [], role_presets: {} };

  // Identify super-admins (any user holding the wildcard '*' permission).
  // Per Requirement 5.5, while at least one such user exists the Team & Roles
  // tab shows a "Review super-admin assignments" banner with an anchor that
  // jumps to the first affected row. The banner is part of the rendered html
  // below, so re-rendering this tab naturally removes a stale banner once no
  // user holds '*' (no separate cleanup pass needed).
  const superAdmins = users.filter(u => Array.isArray(u.permissions) && u.permissions.includes('*'));
  const firstSuperAdminId = superAdmins.length ? superAdmins[0].id : null;

  let html = '';

  // Top action: invite
  html += `<div class="flex items-center justify-between mb-6">`;
  html += `<div><h3 class="text-lg font-bold">Team Members (${users.length})</h3><p class="text-sm text-gray-400 mt-0.5">Invite colleagues and assign permissions per module</p></div>`;
  html += `<button onclick="showInviteModal()" class="px-5 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Invite User</button>`;
  html += `</div>`;

  // Super-admin review banner. Reuses the same amber callout look as the
  // "Super Admin (all permissions)" warning in the Edit Permissions modal so
  // no new styles are introduced. Rendered only when at least one user holds
  // '*'; absent otherwise (Requirement 5.5).
  if (firstSuperAdminId) {
    html += `<div id="super-admin-review-banner" class="bg-amber-50 text-amber-700 border border-amber-200 rounded-2xl px-4 py-3 mb-4 flex items-center justify-between gap-3 text-sm">`;
    html += `<span class="font-medium">Review super-admin assignments</span>`;
    html += `<a href="#user-row-${firstSuperAdminId}" onclick="scrollToSuperAdminRow(event, '${firstSuperAdminId}')" class="text-amber-800 font-semibold hover:underline whitespace-nowrap">Jump to user &rarr;</a>`;
    html += `</div>`;
  }

  // Users table
  html += `<div class="bg-white rounded-3xl shadow-card overflow-hidden">`;
  if (users.length === 0) {
    html += emptyState('No team members yet', 'Invite your first colleague to give them access.');
  } else {
    html += `<table class="w-full text-sm">`;
    html += `<thead><tr class="border-b border-gray-100"><th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">User</th><th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Status</th><th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Permissions</th><th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Last Login</th><th class="px-5 py-3"></th></tr></thead>`;
    html += `<tbody>`;
    users.forEach(u => {
      const isSuperAdmin = (u.permissions || []).includes('*');
      const permsLabel = isSuperAdmin ? 'Super Admin (all)' : (u.permissions || []).length + ' permissions';
      const lastLogin = u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never';
      // Stable per-row id so the banner anchor can target the first super-admin.
      html += `<tr id="user-row-${u.id}" class="border-b border-gray-50 hover:bg-surface-100 transition-all">`;
      html += `<td class="px-5 py-3"><div class="flex items-center gap-3"><div class="w-9 h-9 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-sm">${(u.email||'?')[0].toUpperCase()}</div><div><div class="font-medium">${escapeHtml(u.display_name||u.email)}</div><div class="text-xs text-gray-400">${escapeHtml(u.email)}</div></div></div></td>`;
      html += `<td class="px-5 py-3">${badge(u.status==='active'?'completed':'failed', u.status)}</td>`;
      html += `<td class="px-5 py-3"><span class="text-xs ${isSuperAdmin?'text-amber-600 font-semibold':''}">${permsLabel}</span></td>`;
      html += `<td class="px-5 py-3 text-xs text-gray-500">${lastLogin}</td>`;
      html += `<td class="px-5 py-3 text-right"><button onclick="editUserPermissions('${u.id}', ${JSON.stringify(u.permissions||[]).replace(/"/g,'&quot;')})" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs transition-all">Edit</button> <button onclick="deleteUser('${u.id}', '${escapeHtml(u.email)}')" class="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-500 font-semibold rounded-full text-xs transition-all">Delete</button></td>`;
      html += `</tr>`;
    });
    html += `</tbody></table>`;
  }
  html += `</div>`;

  document.getElementById('tab-content').innerHTML = html;
}

/**
 * Smooth-scroll the Team & Roles user row matching `userId` into view. Used
 * by the "Review super-admin assignments" banner. We intercept the anchor's
 * default jump because the table lives inside the dashboard content area
 * rather than the document root, so a plain `#user-row-...` href can produce
 * a jarring jump or no-op depending on layout.
 */
function scrollToSuperAdminRow(event, userId) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  const row = document.getElementById('user-row-' + userId);
  if (row && typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function showInviteModal() {
  const cat = _permissionCatalog;
  const presetOptions = Object.keys(cat.role_presets).map(r => `<option value="${r}">${r.replace(/_/g, ' ')}</option>`).join('');
  const body = `
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Email</label>
          <input id="invite-email" type="email" placeholder="user@company.com" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400">
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Display Name</label>
          <input id="invite-name" placeholder="Optional" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400">
        </div>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Temporary Password</label>
        <input id="invite-password" type="password" placeholder="Min 8 characters" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400">
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Role Preset</label>
        <select id="invite-role" onchange="updateInvitePerms()" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
          <option value="">-- Custom (pick permissions below) --</option>
          ${presetOptions}
        </select>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Permissions</label>
        <div id="invite-perms" class="max-h-[280px] overflow-y-auto bg-surface-100 rounded-xl p-3">${renderPermissionPicker([], 'invite-perm')}</div>
      </div>
      <button onclick="submitInvite()" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Invite</button>
    </div>`;
  openModal('Invite Team Member', body);
}

function renderPermissionPicker(selectedPerms, prefix) {
  const cat = _permissionCatalog;
  const grouped = {};
  cat.permissions.forEach(p => {
    const module = p.split('.')[0];
    if (!grouped[module]) grouped[module] = [];
    grouped[module].push(p);
  });
  let h = '';
  Object.entries(grouped).forEach(([mod, perms]) => {
    h += `<div class="mb-3"><div class="text-[11px] font-semibold uppercase text-gray-400 mb-1">${mod}</div>`;
    perms.forEach(p => {
      const checked = selectedPerms.includes(p) || selectedPerms.includes(mod + '.*') || selectedPerms.includes('*');
      h += `<label class="flex items-center gap-2 py-1 text-xs"><input type="checkbox" value="${p}" class="${prefix}-cb" ${checked?'checked':''}><span>${p}</span></label>`;
    });
    h += `</div>`;
  });
  return h;
}

function updateInvitePerms() {
  const role = document.getElementById('invite-role').value;
  if (!role) return;
  const perms = _permissionCatalog.role_presets[role] || [];
  document.getElementById('invite-perms').innerHTML = renderPermissionPicker(perms, 'invite-perm');
}

async function submitInvite() {
  const email = document.getElementById('invite-email').value.trim();
  const password = document.getElementById('invite-password').value;
  const display_name = document.getElementById('invite-name').value.trim();
  const role = document.getElementById('invite-role').value;
  if (!email) { toast('Email required', 'error'); return; }
  if (!password || password.length < 8) { toast('Password must be at least 8 characters', 'error'); return; }

  const body = { email, password, display_name };
  if (role) body.role = role;
  // Always include the explicit permission selection (overrides preset)
  const selectedPerms = Array.from(document.querySelectorAll('.invite-perm-cb:checked')).map(cb => cb.value);
  if (selectedPerms.length) body.permissions = selectedPerms;

  const { data } = await api('POST', '/users/invite', body);
  if (data.success) { toast('User invited', 'success'); closeModal(); renderUsers(); }
  else toast(data.error?.message || 'Failed', 'error');
}

function editUserPermissions(userId, currentPerms) {
  const cat = _permissionCatalog;
  const presetOptions = Object.keys(cat.role_presets).map(r => `<option value="${r}">${r.replace(/_/g, ' ')}</option>`).join('');
  const isSuperAdmin = currentPerms.includes('*');
  const body = `
    <div class="space-y-4">
      ${isSuperAdmin ? '<div class="bg-amber-50 text-amber-700 px-3 py-2 rounded-xl text-xs">This user is a Super Admin (all permissions).</div>' : ''}
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Apply Role Preset</label>
        <select id="edit-role" onchange="updateEditPerms()" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
          <option value="">-- Keep current --</option>
          ${presetOptions}
        </select>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Permissions</label>
        <div id="edit-perms" class="max-h-[300px] overflow-y-auto bg-surface-100 rounded-xl p-3">${renderPermissionPicker(currentPerms, 'edit-perm')}</div>
      </div>
      <button onclick="submitEditPerms('${userId}')" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Save Permissions</button>
    </div>`;
  openModal('Edit Permissions', body);
}

function updateEditPerms() {
  const role = document.getElementById('edit-role').value;
  if (!role) return;
  const perms = _permissionCatalog.role_presets[role] || [];
  document.getElementById('edit-perms').innerHTML = renderPermissionPicker(perms, 'edit-perm');
}

async function submitEditPerms(userId) {
  const selectedPerms = Array.from(document.querySelectorAll('.edit-perm-cb:checked')).map(cb => cb.value);
  const { data } = await api('PUT', `/users/${userId}/permissions`, { permissions: selectedPerms });
  if (data.success) { toast('Permissions updated', 'success'); closeModal(); renderUsers(); }
  else toast(data.error?.message || 'Failed', 'error');
}

async function deleteUser(userId, email) {
  if (!confirm(`Permanently delete ${email}? This cannot be undone.`)) return;
  const { data } = await api('DELETE', `/users/${userId}`);
  if (data.success) { toast('User deleted', 'info'); renderUsers(); }
  else toast(data.error?.message || 'Failed', 'error');
}


// ---- WhatsApp template editor + Meta integration ----

async function saveWaBusiness() {
  const business_account_id = document.getElementById('wa-biz-id').value.trim();
  const system_user_token = document.getElementById('wa-biz-token').value.trim();
  if (!business_account_id || !system_user_token) { toast('Both fields required', 'error'); return; }
  const { data } = await api('POST', '/whatsapp/business-settings', { business_account_id, system_user_token });
  if (data.success) { toast('Business settings saved', 'success'); setTimeout(() => renderWhatsApp(), 500); }
  else toast(data.error?.message || 'Failed', 'error');
}

function showCreateTemplateModal() {
  const eventTypes = window._waEventTypes || [];
  const eventCheckboxes = eventTypes.map(e => `<label class="inline-flex items-center gap-1.5 mr-3 mb-1 text-xs"><input type="checkbox" value="${e}" class="tpl-event"><span>${e}</span></label>`).join('');

  const body = `
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Name (purpose)</label>
          <input id="tpl-purpose" placeholder="e.g. order_confirmed" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
          <div class="text-[10px] text-gray-400 mt-1">Lowercase letters, digits, underscores only</div>
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Language</label>
          <select id="tpl-language" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
            <option value="en">en</option>
            <option value="en_US">en_US</option>
            <option value="en_GB">en_GB</option>
          </select>
        </div>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Meta Category</label>
        <select id="tpl-category" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
          <option value="UTILITY">UTILITY (order updates, alerts)</option>
          <option value="MARKETING">MARKETING (promotional)</option>
          <option value="AUTHENTICATION">AUTHENTICATION (OTPs)</option>
        </select>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Header (optional)</label>
        <input id="tpl-header" placeholder="e.g. Order Update" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Body</label>
        <textarea id="tpl-body" placeholder="Hi {{customer_name}}, your order #{{order_number}} is confirmed." class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 min-h-[80px]"></textarea>
        <div class="text-[10px] text-gray-400 mt-1">Use {{var_name}} for variables</div>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Footer (optional)</label>
        <input id="tpl-footer" placeholder="Thanks for shopping with us" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Variables (comma-separated)</label>
        <input id="tpl-vars" placeholder="customer_name, order_number, waybill" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Sample Values (comma-separated)</label>
        <input id="tpl-samples" placeholder="Adele Brink, 1625, LD-9CNQBD" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
        <div class="text-[10px] text-gray-400 mt-1">Required for Meta approval — must match variables order</div>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Trigger Events</label>
        <div class="bg-surface-100 rounded-xl p-3 max-h-[150px] overflow-y-auto">
          ${eventCheckboxes || '<p class="text-xs text-gray-400">No event types found</p>'}
        </div>
        <div class="text-[10px] text-gray-400 mt-1">Leave all unchecked for manual-only sends</div>
      </div>
      <button onclick="submitCreateTemplate()" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Create Template</button>
    </div>`;
  openModal('New Template', body);
}

async function submitCreateTemplate() {
  const purpose = document.getElementById('tpl-purpose').value.trim().toLowerCase();
  const language_code = document.getElementById('tpl-language').value;
  const meta_category = document.getElementById('tpl-category').value;
  const header_text = document.getElementById('tpl-header').value.trim();
  const body_text = document.getElementById('tpl-body').value;
  const footer_text = document.getElementById('tpl-footer').value.trim();
  const variables = document.getElementById('tpl-vars').value.split(',').map(s => s.trim()).filter(Boolean);
  const sample_values = document.getElementById('tpl-samples').value.split(',').map(s => s.trim()).filter(Boolean);
  const event_types = Array.from(document.querySelectorAll('.tpl-event:checked')).map(cb => cb.value);

  if (!purpose || !body_text) { toast('Name and body required', 'error'); return; }

  const { data } = await api('POST', '/whatsapp/templates', {
    purpose, language_code, meta_category,
    header_text: header_text || null, body_text, footer_text: footer_text || null,
    variables, sample_values, event_types,
  });
  if (data.success) { toast('Template created', 'success'); closeModal(); renderWhatsApp(); }
  else toast(data.error?.message || 'Failed', 'error');
}

function editWaTemplate(purpose) {
  const t = (window._waTemplates || []).find(x => x.purpose === purpose);
  if (!t) return;
  const eventTypes = window._waEventTypes || [];
  const currentEvents = Array.isArray(t.event_types) ? t.event_types : [];
  const variables = Array.isArray(t.variables) ? t.variables : [];
  const sampleValues = Array.isArray(t.sample_values) ? t.sample_values : [];

  const eventCheckboxes = eventTypes.map(e => `<label class="inline-flex items-center gap-1.5 mr-3 mb-1 text-xs"><input type="checkbox" value="${e}" class="tpl-edit-event" ${currentEvents.includes(e)?'checked':''}><span>${e}</span></label>`).join('');

  const body = `
    <div class="space-y-4">
      <div class="text-sm text-gray-500"><strong>${t.purpose}</strong> — Meta status: <strong>${t.meta_status||'DRAFT'}</strong></div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Header (optional)</label>
        <input id="tpl-header" value="${escapeHtml(t.header_text||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Body</label>
        <textarea id="tpl-body" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 min-h-[100px]">${escapeHtml(t.body_text||'')}</textarea>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Footer (optional)</label>
        <input id="tpl-footer" value="${escapeHtml(t.footer_text||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Variables</label>
          <input id="tpl-vars" value="${variables.join(', ')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Sample Values</label>
          <input id="tpl-samples" value="${sampleValues.join(', ')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
        </div>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Trigger Events</label>
        <div class="bg-surface-100 rounded-xl p-3 max-h-[150px] overflow-y-auto">${eventCheckboxes}</div>
      </div>
      <button onclick="submitEditTemplate('${purpose}')" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Save Changes</button>
    </div>`;
  openModal('Edit Template', body);
}

async function submitEditTemplate(purpose) {
  const header_text = document.getElementById('tpl-header').value.trim();
  const body_text = document.getElementById('tpl-body').value;
  const footer_text = document.getElementById('tpl-footer').value.trim();
  const variables = document.getElementById('tpl-vars').value.split(',').map(s => s.trim()).filter(Boolean);
  const sample_values = document.getElementById('tpl-samples').value.split(',').map(s => s.trim()).filter(Boolean);
  const event_types = Array.from(document.querySelectorAll('.tpl-edit-event:checked')).map(cb => cb.value);

  const { data } = await api('PUT', '/whatsapp/templates/' + purpose, {
    header_text: header_text || null, body_text, footer_text: footer_text || null,
    variables, sample_values, event_types,
  });
  if (data.success) { toast('Template saved', 'success'); closeModal(); renderWhatsApp(); }
  else toast(data.error?.message || 'Failed', 'error');
}

async function deleteWaTemplate(purpose) {
  if (!confirm(`Delete template "${purpose}"?`)) return;
  const { data } = await api('DELETE', '/whatsapp/templates/' + purpose);
  if (data.success) { toast('Template deleted', 'info'); renderWhatsApp(); }
  else toast(data.error?.message || 'Failed', 'error');
}

async function submitToMeta(purpose) {
  if (!confirm(`Submit "${purpose}" to Meta for approval? Approval can take 1-24 hours.`)) return;
  toast('Submitting to Meta...', 'info');
  const { data } = await api('POST', `/whatsapp/templates/${purpose}/submit-to-meta`);
  if (data.success) { toast(`Submitted! Status: ${data.data.status}`, 'success'); renderWhatsApp(); }
  else toast(data.error?.message || 'Failed', 'error');
}

async function syncFromMeta(purpose) {
  toast('Syncing from Meta...', 'info');
  const { data } = await api('POST', `/whatsapp/templates/${purpose}/sync-from-meta`);
  if (data.success) { toast(`Synced. Status: ${data.data.status}`, 'success'); renderWhatsApp(); }
  else toast(data.error?.message || 'Failed', 'error');
}


// ---- Packing tab (packers' workbench) ----

let _packingFilter = 'awaiting_packing';
let _packingSearch = '';
let _packingTimer = null;

async function renderPacking() {
  const url = `/packer/queue?status=${_packingFilter}` + (_packingSearch ? `&search=${encodeURIComponent(_packingSearch)}` : '');
  const { data } = await api('GET', url);
  if (!data.success) { document.getElementById('tab-content').innerHTML = emptyState('Failed to load',''); return; }
  const orders = data.data.orders;
  const counts = data.data.counts || {};

  let html = '';

  // Status filter chips with counts
  const filters = [
    { key: 'awaiting_packing', label: 'To Pack', color: 'amber' },
    { key: 'packed', label: 'Packed', color: 'blue' },
    { key: 'dropped_off', label: 'Dropped Off', color: 'green' },
    { key: 'all', label: 'All', color: 'gray' },
  ];
  html += `<div class="flex items-center gap-2 mb-4 flex-wrap">`;
  filters.forEach(f => {
    const isActive = f.key === _packingFilter;
    const count = f.key === 'all'
      ? Object.values(counts).reduce((a, b) => a + b, 0)
      : (counts[f.key] || 0);
    html += `<button onclick="setPackingFilter('${f.key}')" class="px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${isActive ? 'bg-brand-400 text-gray-900' : 'bg-white text-gray-500 border border-gray-200 hover:border-brand-300 hover:text-gray-900'}">${f.label} (${count})</button>`;
  });
  html += `</div>`;

  // Search + auto-refresh hint
  html += `<div class="flex gap-2 mb-6">`;
  html += `<input id="packing-search" value="${escapeHtml(_packingSearch)}" placeholder="Search by order #, customer name, phone, or waybill..." onkeydown="if(event.key==='Enter')doPackingSearch()" class="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm placeholder-gray-400 focus:ring-2 focus:ring-brand-200 focus:border-brand-400 transition-all">`;
  html += `<button onclick="doPackingSearch()" class="px-5 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-lg text-sm transition-all">Search</button>`;
  if (_packingSearch) html += `<button onclick="clearPackingSearch()" class="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg text-sm transition-all">Clear</button>`;
  html += `</div>`;

  // Order cards grid (or horizontal swipe carousel on mobile via .h-snap)
  if (orders.length === 0) {
    html += `<div class="bg-white rounded-3xl shadow-card p-6">${emptyState('Nothing to pack', _packingFilter === 'awaiting_packing' ? 'All orders are packed and dropped off. Great job!' : 'No orders match the current filter.')}</div>`;
  } else {
    // On mobile (.h-snap rule applies <768px), cards become horizontally
    // scrollable with snap-points so packers can flick through the queue
    // one full card at a time. On desktop the grid utility takes over.
    html += `<div class="h-snap md:grid md:grid-cols-2 xl:grid-cols-3 md:gap-4">`;
    orders.forEach(o => html += renderPackingCard(o));
    html += `</div>`;
  }

  document.getElementById('tab-content').innerHTML = html;

  // Auto-refresh awaiting list every 20s so packers see new orders without manual reload
  clearTimeout(_packingTimer);
  if (_packingFilter === 'awaiting_packing' && currentTab === 'packing') {
    _packingTimer = setTimeout(() => { if (currentTab === 'packing') renderPacking(); }, 20000);
  }
}

function renderPackingCard(o) {
  let address = '';
  try {
    const addr = typeof o.delivery_address === 'string' ? JSON.parse(o.delivery_address) : (o.delivery_address || {});
    address = addr.entered_address || [addr.street_address, addr.suburb, addr.city, addr.zone, addr.code, addr.country].filter(Boolean).join(', ');
  } catch { address = ''; }

  let lineItems = [];
  try { lineItems = typeof o.line_items === 'string' ? JSON.parse(o.line_items) : (o.line_items || []); } catch {}

  const time = new Date(o.created_at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const statusConfig = {
    awaiting_packing: { label: 'NOT PACKED', cls: 'bg-amber-100 text-amber-800', border: 'border-amber-200' },
    packed: { label: 'NOT DROPPED OFF', cls: 'bg-amber-100 text-amber-800', border: 'border-amber-200' },
    dropped_off: { label: 'DROPPED OFF', cls: 'bg-green-100 text-green-700', border: 'border-green-200' },
    cancelled: { label: 'CANCELLED', cls: 'bg-red-50 text-red-600', border: 'border-red-200' },
  };
  const cfg = statusConfig[o.packing_status] || { label: (o.packing_status||'').toUpperCase(), cls: 'bg-gray-100 text-gray-600', border: 'border-gray-200' };

  // Action button based on current state
  let action = '';
  if (o.packing_status === 'awaiting_packing') {
    action = `<button onclick="markPacked('${o.id}')" class="w-full mt-4 py-3 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-2xl text-sm transition-all hover:shadow-md">Mark as Packed</button>
              <button onclick="markDroppedOff('${o.id}')" class="w-full mt-2 py-3 bg-green-500 hover:bg-green-600 text-white font-bold rounded-2xl text-sm transition-all hover:shadow-md">Dropped-off</button>`;
  } else if (o.packing_status === 'packed') {
    action = `<button onclick="markDroppedOff('${o.id}')" class="w-full mt-4 py-3 bg-green-500 hover:bg-green-600 text-white font-bold rounded-2xl text-sm transition-all hover:shadow-md">Dropped-off</button>
              <button onclick="revertPacking('${o.id}')" class="w-full mt-2 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 font-medium rounded-xl text-xs transition-all">Revert to Awaiting</button>`;
  } else if (o.packing_status === 'dropped_off') {
    const droppedAt = o.dropped_off_at ? new Date(o.dropped_off_at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    action = `<div class="mt-4 py-3 bg-green-50 text-green-700 font-semibold rounded-2xl text-sm text-center">Handed to courier${droppedAt ? ' - ' + droppedAt : ''}</div>
              <button onclick="revertPacking('${o.id}')" class="w-full mt-2 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 font-medium rounded-xl text-xs transition-all">Revert</button>`;
  }

  let html = `<div class="bg-white rounded-3xl shadow-card border ${cfg.border} p-6 hover:shadow-card-hover transition-all">`;

  // Header: order number + status pill
  html += `<div class="flex items-start justify-between gap-3 mb-3">`;
  html += `<div><div class="text-xl font-bold tracking-tight">Order #${o.order_number || '-'}</div>`;
  html += `<div class="text-xs text-gray-400 mt-0.5">${time}</div></div>`;
  html += `<span class="px-3 py-1 rounded-full text-[10px] font-bold tracking-wide whitespace-nowrap ${cfg.cls}">${cfg.label}</span>`;
  html += `</div>`;

  // Customer
  html += `<div class="mb-3">`;
  html += `<div class="font-bold text-gray-900">${escapeHtml(o.customer_name || 'Unknown')}</div>`;
  html += `<div class="text-sm text-gray-500">${escapeHtml(o.customer_phone || '')}</div>`;
  html += `</div>`;

  // Address
  if (address) html += `<div class="text-sm text-gray-600 mb-3 leading-relaxed">${escapeHtml(address)}</div>`;

  // Line items
  if (lineItems.length) {
    html += `<div class="mb-3"><div class="text-sm font-bold text-gray-900 mb-1">Items:</div>`;
    html += `<ul class="text-sm text-gray-700 space-y-0.5">`;
    lineItems.forEach(li => { html += `<li class="flex items-start gap-2"><span class="text-gray-400 mt-0.5">•</span><span>${escapeHtml(li.name||'Item')} <span class="text-gray-500">x ${li.quantity||1}</span></span></li>`; });
    html += `</ul></div>`;
  }

  // Waybill + PIN — packer's most-needed info
  html += `<div class="space-y-1 text-sm pb-2">`;
  if (o.waybill) html += `<div><span class="font-bold text-gray-900">Waybill:</span> <span class="text-gray-700 font-mono">${escapeHtml(o.waybill)}</span></div>`;
  if (o.pincode) html += `<div><span class="font-bold text-gray-900">PIN:</span> <span class="text-gray-700 font-mono">${escapeHtml(o.pincode)}</span></div>`;
  html += `</div>`;

  // Delivery method as a small badge
  if (o.delivery_method) {
    html += `<div class="text-[11px] text-gray-400 uppercase tracking-wide mt-2">${(o.delivery_method || '').replace(/-/g, ' ')}${o.terminal_id ? ' - ' + o.terminal_id : ''}</div>`;
  }

  // Action button
  html += action;

  html += `</div>`;
  return html;
}

function setPackingFilter(f) { _packingFilter = f; renderPacking(); }
function doPackingSearch() { _packingSearch = (document.getElementById('packing-search')?.value || '').trim(); renderPacking(); }
function clearPackingSearch() { _packingSearch = ''; renderPacking(); }

async function markPacked(orderId) {
  const { data } = await api('POST', `/packer/orders/${orderId}/mark-packed`);
  if (data.success) { toast('Marked as packed', 'success'); renderPacking(); }
  else toast(data.error?.message || 'Failed', 'error');
}

async function markDroppedOff(orderId) {
  const { data } = await api('POST', `/packer/orders/${orderId}/mark-dropped-off`);
  if (data.success) { toast('Marked as dropped off', 'success'); renderPacking(); }
  else toast(data.error?.message || 'Failed', 'error');
}

async function revertPacking(orderId) {
  if (!confirm('Revert this order to awaiting packing?')) return;
  const { data } = await api('POST', `/packer/orders/${orderId}/revert`);
  if (data.success) { toast('Reverted', 'info'); renderPacking(); }
  else toast(data.error?.message || 'Failed', 'error');
}


// ---- Chatbot Config ----

async function renderChatbotConfig() {
  const [{ data }, { data: hRes }] = await Promise.all([
    api('GET', '/chatbot-settings'),
    api('GET', '/knowledge/health'),
  ]);
  const s = data && data.success ? (data.data.configured ? data.data : data.data.defaults || {}) : {};
  const health = hRes && hRes.success ? hRes.data : null;

  let html = '';

  // Knowledge readiness banner — surface upfront when KB is empty/warming
  if (health && health.status !== 'healthy' && (health.messages || []).length) {
    const tone = health.status === 'empty'
      ? 'bg-red-50 border-red-200 text-red-700'
      : 'bg-amber-50 border-amber-200 text-amber-700';
    const icon = health.status === 'empty' ? '⚠' : 'ℹ';
    const docs = health.documents || {};
    html += `<div class="rounded-2xl border ${tone} p-4 mb-6">`;
    html += `<div class="flex items-start gap-3">`;
    html += `<span class="text-lg leading-none">${icon}</span>`;
    html += `<div class="flex-1">`;
    html += `<div class="font-semibold text-sm mb-1">${health.status === 'empty' ? 'Chatbot has no knowledge yet' : 'Knowledge base is still warming up'}</div>`;
    health.messages.forEach((m) => {
      html += `<div class="text-xs leading-relaxed">${escapeHtml(m)}</div>`;
    });
    html += `<div class="text-xs mt-2 opacity-75">Sources: ${health.sources?.total || 0} (${health.sources?.completed || 0} synced) · Documents: ${docs.total || 0} · Embedded: ${docs.embedded || 0}/${docs.total || 0}</div>`;
    html += `<div class="mt-2"><button onclick="switchTab('knowledge')" class="text-xs font-semibold underline">Open Knowledge tab →</button></div>`;
    html += `</div></div></div>`;
  }

  // Personality card
  html += `<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">`;
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Personality</h3>`;
  html += `<div class="space-y-3">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Bot Name</label><input id="cb-name" value="${escapeHtml(s.bot_name||'Muti AI')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Tone</label><select id="cb-tone" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"><option value="friendly"${s.tone==='friendly'?' selected':''}>Friendly</option><option value="professional"${s.tone==='professional'?' selected':''}>Professional</option><option value="casual"${s.tone==='casual'?' selected':''}>Casual</option></select></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Language</label><select id="cb-lang" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"><option value="en"${s.language==='en'?' selected':''}>English</option><option value="af"${s.language==='af'?' selected':''}>Afrikaans</option></select></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Custom Instructions</label><textarea id="cb-instructions" placeholder="e.g. Always mention our 30-day return policy. Never discuss competitor products." class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 min-h-[80px]">${escapeHtml(s.custom_instructions||'')}</textarea></div>`;
  html += `</div></div>`;

  // Escalation card
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Escalation (Redirect to Human)</h3>`;
  html += `<p class="text-xs text-gray-400 mb-3">When the bot can't help or the customer asks for a person, this is who they get connected to.</p>`;
  html += `<div class="space-y-3">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Agent Name</label><input id="cb-esc-name" value="${escapeHtml(s.escalation_name||'')}" placeholder="e.g. Sarah from support" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Agent WhatsApp Number</label><input id="cb-esc-phone" value="${escapeHtml(s.escalation_phone||'')}" placeholder="+27..." class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Agent Email</label><input id="cb-esc-email" value="${escapeHtml(s.escalation_email||'')}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Escalation Message (what the bot tells the customer)</label><textarea id="cb-esc-msg" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 min-h-[60px]">${escapeHtml(s.escalation_message||"I've flagged this for a team member. They'll reach out shortly.")}</textarea></div>`;
  html += `</div></div>`;
  html += `</div>`;

  // Auto-responses card
  html += `<div class="bg-white rounded-3xl shadow-card p-6 mb-6"><h3 class="font-bold text-base mb-4">Auto-Responses</h3>`;
  html += `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Greeting (when customer says hi)</label><textarea id="cb-greeting" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 min-h-[60px]">${escapeHtml(s.greeting_message||'')}</textarea></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Unknown Intent (can't classify)</label><textarea id="cb-unknown" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 min-h-[60px]">${escapeHtml(s.unknown_intent_message||'')}</textarea></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Outside Hours</label><textarea id="cb-outside" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 min-h-[60px]">${escapeHtml(s.outside_hours_message||'')}</textarea></div>`;
  html += `</div></div>`;

  // Boundaries card
  html += `<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">`;
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Blocked Topics</h3>`;
  html += `<p class="text-xs text-gray-400 mb-3">If a customer mentions any of these keywords, the bot immediately escalates to a human instead of trying to answer.</p>`;
  const blockedArr = Array.isArray(s.blocked_topics) ? s.blocked_topics : [];
  html += `<div><label class="block text-xs text-gray-400 mb-1">Keywords (comma-separated)</label><input id="cb-blocked" value="${escapeHtml(blockedArr.join(', '))}" placeholder="refund, cancel order, complaint, damaged" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div class="mt-3"><label class="block text-xs text-gray-400 mb-1">Response when blocked topic detected</label><textarea id="cb-blocked-resp" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 min-h-[60px]">${escapeHtml(s.blocked_topic_response||'')}</textarea></div>`;
  html += `</div>`;

  // Business hours card
  html += `<div class="bg-white rounded-3xl shadow-card p-6"><h3 class="font-bold text-base mb-4">Business Hours</h3>`;
  html += `<p class="text-xs text-gray-400 mb-3">Optional. If set, the bot sends the "outside hours" message when customers write after hours.</p>`;
  html += `<div class="space-y-3">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Timezone</label><input id="cb-tz" value="${escapeHtml(s.timezone||'')}" placeholder="Africa/Johannesburg" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div class="grid grid-cols-2 gap-3"><div><label class="block text-xs text-gray-400 mb-1">Start</label><input id="cb-hours-start" type="time" value="${s.hours_start||'08:00'}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div><div><label class="block text-xs text-gray-400 mb-1">End</label><input id="cb-hours-end" type="time" value="${s.hours_end||'17:00'}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div></div>`;
  const days = Array.isArray(s.active_days) ? s.active_days : [1,2,3,4,5];
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  html += `<div><label class="block text-xs text-gray-400 mb-1">Active Days</label><div class="flex gap-2 flex-wrap">`;
  dayNames.forEach((d, i) => { html += `<label class="inline-flex items-center gap-1 text-xs"><input type="checkbox" value="${i}" class="cb-day" ${days.includes(i)?'checked':''}><span>${d}</span></label>`; });
  html += `</div></div>`;
  html += `</div></div>`;
  html += `</div>`;

  // Save button
  html += `<button onclick="saveChatbotConfig()" class="px-8 py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all hover:shadow-lg">Save All Settings</button>`;

  document.getElementById('tab-content').innerHTML = html;
}

async function saveChatbotConfig() {
  const blocked_topics = document.getElementById('cb-blocked').value.split(',').map(s => s.trim()).filter(Boolean);
  const active_days = Array.from(document.querySelectorAll('.cb-day:checked')).map(cb => parseInt(cb.value));

  const body = {
    bot_name: document.getElementById('cb-name').value.trim(),
    tone: document.getElementById('cb-tone').value,
    language: document.getElementById('cb-lang').value,
    custom_instructions: document.getElementById('cb-instructions').value.trim(),
    escalation_name: document.getElementById('cb-esc-name').value.trim(),
    escalation_phone: document.getElementById('cb-esc-phone').value.trim(),
    escalation_email: document.getElementById('cb-esc-email').value.trim(),
    escalation_message: document.getElementById('cb-esc-msg').value.trim(),
    greeting_message: document.getElementById('cb-greeting').value.trim(),
    unknown_intent_message: document.getElementById('cb-unknown').value.trim(),
    outside_hours_message: document.getElementById('cb-outside').value.trim(),
    blocked_topics,
    blocked_topic_response: document.getElementById('cb-blocked-resp').value.trim(),
    timezone: document.getElementById('cb-tz').value.trim(),
    hours_start: document.getElementById('cb-hours-start').value,
    hours_end: document.getElementById('cb-hours-end').value,
    active_days,
  };

  const { data } = await api('POST', '/chatbot-settings', body);
  if (data.success) toast('Chatbot settings saved', 'success');
  else toast(data.error?.message || 'Failed', 'error');
}


// ---- Marketing Campaigns ----

async function renderMarketing() {
  const [{ data: campRes }, { data: statsRes }, { data: tplRes }] = await Promise.all([
    api('GET', '/marketing/campaigns'),
    api('GET', '/marketing/stats'),
    api('GET', '/whatsapp/templates'),
  ]);
  const campaigns = campRes && campRes.success ? campRes.data : [];
  const stats = statsRes && statsRes.success ? statsRes.data : { total_enrollments: 0, sends_by_status: {} };
  const templates = tplRes && tplRes.success ? tplRes.data : [];
  window._mktTemplates = templates;

  let html = '';

  // Stats
  html += `<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">`;
  html += statCard('Campaigns', campaigns.length, 'text-gray-900');
  html += statCard('Enrolled', stats.total_enrollments, 'text-blue-600');
  html += statCard('Sent', stats.sends_by_status.sent || 0, 'text-green-600');
  html += statCard('Failed', stats.sends_by_status.failed || 0, 'text-red-500');
  html += `</div>`;

  // Create button
  html += `<div class="flex items-center justify-between mb-6">`;
  html += `<h3 class="text-lg font-bold">Campaigns</h3>`;
  html += `<button onclick="showCreateCampaignModal()" class="px-5 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">New Campaign</button>`;
  html += `</div>`;

  // Campaign cards
  if (campaigns.length === 0) {
    html += `<div class="bg-white rounded-3xl shadow-card p-6">${emptyState('No campaigns yet', 'Create a win-back or abandoned cart campaign to re-engage customers automatically.')}</div>`;
  } else {
    html += `<div class="space-y-4">`;
    campaigns.forEach(c => {
      const steps = c.steps || [];
      const typeBadge = c.campaign_type === 'win_back' ? badge('processing', 'Win-back') : badge('warning', 'Abandoned Cart');
      html += `<div class="bg-white rounded-3xl shadow-card p-6">`;
      html += `<div class="flex items-start justify-between mb-3">`;
      html += `<div><div class="flex items-center gap-2"><h4 class="font-bold text-base">${escapeHtml(c.name)}</h4>${typeBadge}${c.enabled ? badge('completed','Active') : badge('failed','Paused')}</div>`;
      if (c.description) html += `<p class="text-xs text-gray-400 mt-1">${escapeHtml(c.description)}</p>`;
      html += `</div>`;
      html += `<div class="flex gap-2"><button onclick="toggleCampaign('${c.id}',${!c.enabled})" class="px-3 py-1.5 ${c.enabled?'bg-red-50 text-red-500':'bg-green-50 text-green-600'} font-semibold rounded-full text-xs transition-all">${c.enabled?'Pause':'Activate'}</button>`;
      html += `<button onclick="deleteCampaign('${c.id}')" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 font-semibold rounded-full text-xs transition-all">Delete</button></div>`;
      html += `</div>`;

      // Config summary
      html += `<div class="flex gap-4 text-xs text-gray-500 mb-4 flex-wrap">`;
      if (c.campaign_type === 'win_back') html += `<span>Trigger: ${c.inactivity_days_trigger || '?'} days inactive</span>`;
      else html += `<span>Trigger: ${c.abandon_hours_trigger || '?'} hours after checkout</span>`;
      html += `<span>Max sends: ${c.max_sends_per_customer}</span>`;
      html += `<span>Cooldown: ${c.cooldown_days} days</span>`;
      html += `<span>Enrolled: ${c.enrolled_count || 0}</span>`;
      html += `</div>`;

      // Steps timeline
      html += `<div class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Steps (${steps.length})</div>`;
      if (steps.length === 0) {
        html += `<p class="text-xs text-gray-400">No steps configured. <button onclick="showAddStepModal('${c.id}')" class="text-brand-600 font-semibold hover:underline">Add one</button></p>`;
      } else {
        html += `<div class="space-y-2">`;
        steps.forEach((s, i) => {
          const delay = s.delay_days ? `Day ${s.delay_days}` : `${s.delay_hours}h`;
          const tpl = s.whatsapp_template_purpose || 'free-text';
          html += `<div class="flex items-center gap-3 p-3 rounded-xl border border-gray-100">`;
          html += `<div class="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-xs flex-shrink-0">${i+1}</div>`;
          html += `<div class="flex-1"><div class="text-sm font-medium">${delay} — ${escapeHtml(tpl)}</div>`;
          if (s.message_body) html += `<div class="text-xs text-gray-400 truncate max-w-md">${escapeHtml(s.message_body.substring(0,80))}</div>`;
          html += `</div>`;
          html += `<button onclick="deleteStep('${c.id}','${s.id}')" class="text-xs text-red-400 hover:text-red-600">Remove</button>`;
          html += `</div>`;
        });
        html += `</div>`;
      }
      html += `<button onclick="showAddStepModal('${c.id}')" class="mt-3 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs transition-all">+ Add Step</button>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  document.getElementById('tab-content').innerHTML = html;
}

function showCreateCampaignModal() {
  const body = `
    <div class="space-y-4">
      <div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Campaign Name</label><input id="mkt-name" placeholder="e.g. 21-Day Win-back" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
      <div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Type</label><select id="mkt-type" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"><option value="win_back">Win-back (inactive customers)</option><option value="abandoned_cart">Abandoned Cart</option></select></div>
      <div><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Description</label><input id="mkt-desc" placeholder="Optional" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs text-gray-400 mb-1">Inactivity trigger (days)</label><input id="mkt-days" type="number" value="21" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
        <div><label class="block text-xs text-gray-400 mb-1">Abandon trigger (hours)</label><input id="mkt-hours" type="number" value="1" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs text-gray-400 mb-1">Max sends per customer</label><input id="mkt-max" type="number" value="3" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
        <div><label class="block text-xs text-gray-400 mb-1">Cooldown (days)</label><input id="mkt-cooldown" type="number" value="30" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
      </div>
      <button onclick="submitCreateCampaign()" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Create Campaign</button>
    </div>`;
  openModal('New Marketing Campaign', body);
}

async function submitCreateCampaign() {
  const body = {
    name: document.getElementById('mkt-name').value.trim(),
    campaign_type: document.getElementById('mkt-type').value,
    description: document.getElementById('mkt-desc').value.trim(),
    inactivity_days_trigger: parseInt(document.getElementById('mkt-days').value) || null,
    abandon_hours_trigger: parseInt(document.getElementById('mkt-hours').value) || null,
    max_sends_per_customer: parseInt(document.getElementById('mkt-max').value) || 3,
    cooldown_days: parseInt(document.getElementById('mkt-cooldown').value) || 30,
  };
  if (!body.name) { toast('Name required', 'error'); return; }
  const { data } = await api('POST', '/marketing/campaigns', body);
  if (data.success) { toast('Campaign created', 'success'); closeModal(); renderMarketing(); }
  else toast(data.error?.message || 'Failed', 'error');
}

function showAddStepModal(campaignId) {
  const templates = window._mktTemplates || [];
  const tplOptions = templates.map(t => `<option value="${t.purpose}">${t.purpose}</option>`).join('');
  const body = `
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs text-gray-400 mb-1">Delay (days after trigger)</label><input id="step-days" type="number" value="0" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
        <div><label class="block text-xs text-gray-400 mb-1">Delay (hours)</label><input id="step-hours" type="number" value="0" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>
      </div>
      <div><label class="block text-xs text-gray-400 mb-1">WhatsApp Template (optional)</label><select id="step-tpl" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"><option value="">-- Free text instead --</option>${tplOptions}</select></div>
      <div><label class="block text-xs text-gray-400 mb-1">Message Body (if no template)</label><textarea id="step-body" placeholder="Hi {{customer_name}}, we miss you! Use code COMEBACK for 10% off." class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 min-h-[80px]"></textarea></div>
      <button onclick="submitAddStep('${campaignId}')" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Add Step</button>
    </div>`;
  openModal('Add Campaign Step', body);
}

async function submitAddStep(campaignId) {
  const body = {
    delay_days: parseInt(document.getElementById('step-days').value) || 0,
    delay_hours: parseInt(document.getElementById('step-hours').value) || 0,
    whatsapp_template_purpose: document.getElementById('step-tpl').value || null,
    message_body: document.getElementById('step-body').value.trim() || null,
  };
  const { data } = await api('POST', `/marketing/campaigns/${campaignId}/steps`, body);
  if (data.success) { toast('Step added', 'success'); closeModal(); renderMarketing(); }
  else toast(data.error?.message || 'Failed', 'error');
}

async function toggleCampaign(id, enabled) {
  await api('PUT', `/marketing/campaigns/${id}`, { enabled });
  toast(enabled ? 'Campaign activated' : 'Campaign paused', 'info');
  renderMarketing();
}

async function deleteCampaign(id) {
  if (!confirm('Delete this campaign and all its steps/sends?')) return;
  await api('DELETE', `/marketing/campaigns/${id}`);
  toast('Campaign deleted', 'info');
  renderMarketing();
}

async function deleteStep(campaignId, stepId) {
  await api('DELETE', `/marketing/campaigns/${campaignId}/steps/${stepId}`);
  toast('Step removed', 'info');
  renderMarketing();
}


// ---- Manual Upload Queue ----

async function renderManualUpload() {
  const status = window._manualFilter || 'pending';
  const { data } = await api('GET', `/manual/upload-queue?status=${status}`);
  if (!data.success) { document.getElementById('tab-content').innerHTML = emptyState('Failed to load',''); return; }
  const orders = data.data.orders;
  const counts = data.data.counts;

  let html = '';
  html += `<div class="flex items-center gap-2 mb-6">`;
  html += `<button onclick="window._manualFilter='pending';renderManualUpload()" class="px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${status==='pending'?'bg-brand-400 text-gray-900':'bg-white text-gray-500 border border-gray-200'}">Pending (${counts.pending})</button>`;
  html += `<button onclick="window._manualFilter='completed';renderManualUpload()" class="px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${status==='completed'?'bg-brand-400 text-gray-900':'bg-white text-gray-500 border border-gray-200'}">Completed (${counts.completed})</button>`;
  html += `</div>`;

  if (orders.length === 0) {
    html += `<div class="bg-white rounded-3xl shadow-card p-6">${emptyState('No orders in manual queue', status === 'pending' ? 'Orders that need manual courier upload will appear here.' : 'No completed manual uploads yet.')}</div>`;
  } else {
    html += `<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">`;
    orders.forEach(o => {
      let address = '';
      try { const a = typeof o.delivery_address === 'string' ? JSON.parse(o.delivery_address) : (o.delivery_address||{}); address = a.entered_address || ''; } catch {}
      let lineItems = [];
      try { lineItems = typeof o.line_items === 'string' ? JSON.parse(o.line_items) : (o.line_items||[]); } catch {}
      const time = new Date(o.created_at).toLocaleString('en-ZA', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });

      html += `<div class="bg-white rounded-3xl shadow-card border border-amber-200 p-6">`;
      html += `<div class="flex items-start justify-between mb-3"><div><div class="text-xl font-bold">Order #${o.order_number||'-'}</div><div class="text-xs text-gray-400">${time}</div></div>`;
      html += `<span class="px-3 py-1 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">${o.waybill ? 'UPLOADED' : 'NEEDS UPLOAD'}</span></div>`;
      html += `<div class="font-bold">${escapeHtml(o.customer_name||'')}</div>`;
      html += `<div class="text-sm text-gray-500">${escapeHtml(o.customer_phone||'')}</div>`;
      if (address) html += `<div class="text-sm text-gray-600 mt-2">${escapeHtml(address)}</div>`;
      if (lineItems.length) { html += `<div class="mt-2 text-sm"><strong>Items:</strong> ${lineItems.map(li=>escapeHtml(li.name)+' x '+li.quantity).join(', ')}</div>`; }
      if (o.manual_upload_reason) html += `<div class="text-xs text-amber-600 mt-2">${escapeHtml(o.manual_upload_reason)}</div>`;
      if (o.waybill) {
        html += `<div class="mt-3 p-3 bg-green-50 rounded-xl text-sm"><strong>Waybill:</strong> ${o.waybill} <strong>PIN:</strong> ${o.pincode||'-'}</div>`;
      } else {
        html += `<div class="mt-4 space-y-2">`;
        html += `<input id="mu-waybill-${o.id}" placeholder="Waybill (e.g. LD-XXXXX)" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
        html += `<input id="mu-pin-${o.id}" placeholder="PIN (optional)" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
        html += `<button onclick="completeManualUpload('${o.id}')" class="w-full py-3 bg-green-500 hover:bg-green-600 text-white font-bold rounded-2xl text-sm transition-all">Submit Waybill</button>`;
        html += `</div>`;
      }
      html += `</div>`;
    });
    html += `</div>`;
  }
  document.getElementById('tab-content').innerHTML = html;
}

async function completeManualUpload(orderId) {
  const waybill = document.getElementById('mu-waybill-' + orderId)?.value?.trim();
  const pincode = document.getElementById('mu-pin-' + orderId)?.value?.trim();
  if (!waybill) { toast('Waybill is required', 'error'); return; }
  const { data } = await api('POST', `/manual/upload-queue/${orderId}/complete`, { waybill, pincode });
  if (data.success) { toast('Waybill recorded — order is now in fulfillment', 'success'); renderManualUpload(); }
  else toast(data.error?.message || 'Failed', 'error');
}

// ---- Collections Queue ----

async function renderCollections() {
  const status = window._collectionFilter || 'pending';
  const { data } = await api('GET', `/manual/collection-queue?status=${status}`);
  if (!data.success) { document.getElementById('tab-content').innerHTML = emptyState('Failed to load',''); return; }
  const orders = data.data.orders;
  const counts = data.data.counts;

  let html = '';
  html += `<div class="flex items-center gap-2 mb-6">`;
  html += `<button onclick="window._collectionFilter='pending';renderCollections()" class="px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${status==='pending'?'bg-brand-400 text-gray-900':'bg-white text-gray-500 border border-gray-200'}">Awaiting Collection (${counts.pending})</button>`;
  html += `<button onclick="window._collectionFilter='collected';renderCollections()" class="px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${status==='collected'?'bg-brand-400 text-gray-900':'bg-white text-gray-500 border border-gray-200'}">Collected (${counts.collected})</button>`;
  html += `</div>`;

  if (orders.length === 0) {
    html += `<div class="bg-white rounded-3xl shadow-card p-6">${emptyState('No collection orders', status === 'pending' ? 'Orders where the customer picks up will appear here.' : 'No confirmed collections yet.')}</div>`;
  } else {
    html += `<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">`;
    orders.forEach(o => {
      let lineItems = [];
      try { lineItems = typeof o.line_items === 'string' ? JSON.parse(o.line_items) : (o.line_items||[]); } catch {}
      const time = new Date(o.created_at).toLocaleString('en-ZA', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });

      html += `<div class="bg-white rounded-3xl shadow-card border ${o.collected_at ? 'border-green-200' : 'border-blue-200'} p-6">`;
      html += `<div class="flex items-start justify-between mb-3"><div><div class="text-xl font-bold">Order #${o.order_number||'-'}</div><div class="text-xs text-gray-400">${time}</div></div>`;
      html += `<span class="px-3 py-1 rounded-full text-[10px] font-bold ${o.collected_at ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}">${o.collected_at ? 'COLLECTED' : 'AWAITING'}</span></div>`;
      html += `<div class="font-bold">${escapeHtml(o.customer_name||'')}</div>`;
      html += `<div class="text-sm text-gray-500">${escapeHtml(o.customer_phone||'')}</div>`;
      if (lineItems.length) { html += `<div class="mt-2 text-sm"><strong>Items:</strong> ${lineItems.map(li=>escapeHtml(li.name)+' x '+li.quantity).join(', ')}</div>`; }
      if (o.collected_at) {
        html += `<div class="mt-3 py-3 bg-green-50 text-green-700 font-semibold rounded-2xl text-sm text-center">Collected ${new Date(o.collected_at).toLocaleString('en-ZA', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>`;
      } else {
        html += `<button onclick="confirmCollection('${o.id}')" class="w-full mt-4 py-3 bg-green-500 hover:bg-green-600 text-white font-bold rounded-2xl text-sm transition-all">Confirm Collected</button>`;
      }
      html += `</div>`;
    });
    html += `</div>`;
  }
  document.getElementById('tab-content').innerHTML = html;
}

async function confirmCollection(orderId) {
  const { data } = await api('POST', `/manual/collection-queue/${orderId}/confirm`, {});
  if (data.success) { toast('Collection confirmed', 'success'); renderCollections(); }
  else toast(data.error?.message || 'Failed', 'error');
}
