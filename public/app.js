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
  // Track the last-known `currentTab` so we only clear `body.detail-open`
  // on a real tab switch, NOT on routine in-tab re-renders (e.g. the
  // pipeline poll every 3s). Without this, opening a pipeline detail and
  // then waiting through one poll cycle would flash the list back over
  // the detail because the observer would keep wiping `detail-open`.
  let lastTab = currentTab;
  const tick = () => {
    if (lastTab !== currentTab) {
      document.body.classList.remove('detail-open');
      // Forget any open job from the previous tab so its detail panel
      // is not auto-restored on this new tab.
      window._activeJobId = null;
      lastTab = currentTab;
    }
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
  const order = ['orders','pipeline','packing','manual-upload','collections','fulfillment','customers','agents','chatbot-config','caretaker','whatsapp','marketing','inbox','knowledge','users','settings','usage','failed','health'];
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
  const subtitles = { overview:'Welcome back', orders:'Every order in one place', pipeline:'Order ingestion pipeline', packing:'Pack and drop off orders', fulfillment:'Tracking & delivery', agents:'AI agent configuration', 'chatbot-config':'Chatbot personality and behavior', caretaker:'Order review rules', whatsapp:'Messaging & notifications', inbox:'Customer conversations', knowledge:'Knowledge base', customers:'Customer directory', users:'Team members and permissions', packers:'Invite and manage independent packers', usage:'AI token & cost tracking', failed:'Dead-letter queues', health:'System status', settings:'Account configuration' };
  document.getElementById('page-subtitle').textContent = subtitles[tab] || '';
  document.querySelectorAll('.sidebar-item').forEach(li => li.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(li => { const txt = li.querySelector('span'); if(txt && txt.textContent.toLowerCase()===tab) li.classList.add('active'); });
  document.getElementById('tab-content').innerHTML = '<div class="flex items-center justify-center py-20"><div class="w-6 h-6 border-2 border-brand-400 border-t-transparent rounded-full animate-spin"></div></div>';
  if (tab === 'overview') renderOverview();
  else if (tab === 'orders') renderOrders();
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
  else if (tab === 'packers') renderPackers();
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

/**
 * Build the inner HTML for the timeline (left column) only. Used by both the
 * initial full render and the in-place poll refresh — keeping the detail
 * panel DOM untouched between cycles avoids the "select a row, watch it
 * blink every 3s" issue.
 */
function _renderPipelineTimelineHtml(activeFilter, dateFrom, dateTo) {
  const filteredJobs = applyPipelineFilters(pipelineJobs, activeFilter, dateFrom, dateTo);
  if (filteredJobs.length === 0) {
    return emptyState('No jobs match', 'Try a different filter.');
  }
  const fGrouped = {};
  filteredJobs.forEach((j) => {
    const d = new Date(j.created_at);
    const key = d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
    if (!fGrouped[key]) fGrouped[key] = [];
    fGrouped[key].push(j);
  });
  let html = `<div class="space-y-4 max-h-[600px] overflow-y-auto pr-1">`;
  Object.entries(fGrouped).forEach(([dateLabel, jobs]) => {
    html += `<div>`;
    html += `<div class="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2 sticky top-0 bg-white py-1">${dateLabel}</div>`;
    html += `<div class="space-y-1.5 relative pl-4 border-l-2 border-gray-100">`;
    jobs.forEach((job) => {
      const globalIdx = pipelineJobs.indexOf(job);
      const time = new Date(job.created_at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
      const stage = job.current_stage.replace(/_/g, ' ').toLowerCase();
      const dotColor = job.status === 'completed' ? 'bg-green-400'
        : job.status === 'failed' || job.status === 'rejected' ? 'bg-red-400'
        : job.status === 'processing' ? 'bg-blue-400 pulse-dot'
        : 'bg-gray-300';
      const isActive = window._activeJobId === job.id;
      html += `<div onclick="showJobDetail(${globalIdx})" data-job-id="${job.id}" class="relative flex items-center gap-3 p-2.5 rounded-xl ${isActive ? 'bg-brand-50/60 ring-1 ring-brand-300' : 'hover:bg-brand-50/40'} cursor-pointer transition-all group">`;
      html += `<div class="absolute -left-[13px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ${dotColor} ring-2 ring-white"></div>`;
      html += `<span class="text-[11px] text-gray-400 w-12 flex-shrink-0">${time}</span>`;
      html += `<div class="flex-1 min-w-0"><div class="text-xs font-medium capitalize truncate group-hover:text-brand-700">${stage}</div></div>`;
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
  return html;
}

/**
 * Lightweight poll: refresh `pipelineJobs` and update the list column in
 * place without touching the detail panel. If the open job's status or
 * stages may have changed (status moved or current_stage changed), refresh
 * the panel; otherwise leave it alone so the operator's view doesn't blink.
 */
async function _pollPipeline() {
  if (currentTab !== 'pipeline') return;
  const { data } = await api('GET', '/pipeline/jobs?limit=30');
  if (!data.success) return; // Quietly skip; the next tick will retry.
  const prevJobs = pipelineJobs;
  pipelineJobs = data.data.jobs;

  // Update the timeline column in place.
  const timeline = document.getElementById('pipeline-timeline');
  if (timeline) {
    const activeFilter = window._pipelineFilter || 'all';
    const dateFrom = window._pipelineDateFrom || '';
    const dateTo = window._pipelineDateTo || '';
    timeline.innerHTML = _renderPipelineTimelineHtml(activeFilter, dateFrom, dateTo);
  }

  // Refresh the detail panel ONLY when the underlying job's status or
  // current_stage changed since the previous poll. Without this guard the
  // panel re-renders every 3 seconds even when nothing moved, which is
  // exactly the blink the operator was seeing.
  if (window._activeJobId) {
    const idx = pipelineJobs.findIndex((j) => j.id === window._activeJobId);
    const prev = prevJobs.find((j) => j.id === window._activeJobId);
    const next = idx >= 0 ? pipelineJobs[idx] : null;
    const moved = !!(prev && next && (prev.status !== next.status || prev.current_stage !== next.current_stage));
    if (moved && idx >= 0) {
      showJobDetail(idx, { silent: true });
    }
    // If the job dropped off the visible list (filter, date range, etc.),
    // leave the panel as-is — don't blow it away mid-action.
  }

  // Schedule next tick.
  const inFlight = pipelineJobs.some((j) => j.status === 'processing' || j.status === 'pending_review');
  clearTimeout(window._pipelineTimer);
  if (inFlight && currentTab === 'pipeline') {
    window._pipelineTimer = setTimeout(_pollPipeline, 3000);
  }
}

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
  // Wrap the timeline body in a stable container so the lightweight
  // _pollPipeline() can update only its innerHTML without disturbing
  // the right-hand detail panel.
  html += `<div id="pipeline-timeline">`;
  html += _renderPipelineTimelineHtml(activeFilter, dateFrom, dateTo);
  html += `</div>`;
  html += `</div></div>`;

  // Right: Detail panel — show a subtle skeleton when a job was already
  // open, so the brief gap between innerHTML reset and showJobDetail's
  // async fetch doesn't flash the placeholder over the user's selection.
  html += `<div class="lg:col-span-2" id="job-detail-panel">`;
  if (window._activeJobId && pipelineJobs.some((j) => j.id === window._activeJobId)) {
    html += `<div class="bg-white rounded-3xl shadow-card p-8 flex items-center justify-center min-h-[400px]">`;
    html += `<div class="w-6 h-6 border-2 border-brand-400 border-t-transparent rounded-full animate-spin opacity-60"></div>`;
    html += `</div>`;
  } else {
    html += `<div class="bg-white rounded-3xl shadow-card p-8 flex items-center justify-center min-h-[400px]">`;
    html += `<div class="text-center"><div class="text-3xl opacity-15 mb-3">&#9654;</div><p class="text-sm text-gray-400">Select a job to view its pipeline stages</p></div>`;
    html += `</div>`;
  }
  html += `</div>`;
  html += `</div>`;

  document.getElementById('tab-content').innerHTML = html;

  // If a job was already open before this re-render (e.g. the user clicked a
  // row, then changed a filter), restore its detail view in place. We only
  // do this when the panel is currently the placeholder/skeleton — never
  // during routine 3s polls. The poll loop below uses _pollPipeline(),
  // which leaves the panel alone unless the underlying job actually moved.
  if (window._activeJobId) {
    const idx = pipelineJobs.findIndex((j) => j.id === window._activeJobId);
    if (idx >= 0) {
      const panel = document.getElementById('job-detail-panel');
      const isSkeleton = panel && (panel.querySelector('.animate-spin') || panel.textContent.includes('Select a job'));
      if (isSkeleton) {
        Promise.resolve().then(() => showJobDetail(idx, { silent: true }));
      }
    }
  }

  // Schedule the lightweight poll only if anything is actually moving.
  const inFlight = pipelineJobs.some((j) => j.status === 'processing' || j.status === 'pending_review');
  clearTimeout(window._pipelineTimer);
  if (inFlight && currentTab === 'pipeline') {
    window._pipelineTimer = setTimeout(_pollPipeline, 3000);
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
    html += `<div class="text-sm font-bold mt-0.5">#${order.order_number||'-'} - ${escapeHtml(order.customer_name||'')}</div></div><div class="flex items-center gap-2">${badge(order.status==='delivered'||order.status==='completed'?'completed':order.status==='cancelled'||order.status==='failed'?'failed':'processing', order.status||'pending')}<button onclick="openAddressEditModal('${data.data.job.id}', ${JSON.stringify(JSON.stringify(order || {})).replace(/"/g,'&quot;')})" class="text-[11px] px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 hover:bg-amber-100 font-semibold whitespace-nowrap" title="Edit delivery address and re-run pipeline">&#9998; Edit address</button></div></div>`;
    html += `<div class="grid grid-cols-3 gap-3 mt-3">`;
    html += `<div><div class="text-[10px] text-gray-400 uppercase">Waybill</div><div class="text-sm font-semibold">${order.waybill||'-'}</div></div>`;
    html += `<div><div class="text-[10px] text-gray-400 uppercase">PIN</div><div class="text-sm font-semibold">${order.pincode||'-'}</div></div>`;
    html += `<div><div class="text-[10px] text-gray-400 uppercase">Method</div><div class="text-sm font-semibold capitalize">${(order.delivery_method||'-').replace(/-/g,' ')}</div></div>`;
    html += `</div></div>`;
  }

  // Customer history block — repeat-customer trust signal. Renders only when
  // the API resolved a customer for this order. Shows total order count,
  // success-rate strip, and the 5 most recent prior orders so the operator
  // can spot regulars or chronic problem accounts at a glance before
  // approving a flagged review.
  const ch = data.data.customer_history;
  if (ch && ch.customer) {
    const c = ch.customer;
    const totals = (ch.totals && ch.totals.by_status) || {};
    const totalAll = (ch.totals && ch.totals.all) || 0;
    const completed = (totals.completed || 0) + (totals.delivered || 0);
    const failed = (totals.failed || 0) + (totals.rejected || 0);
    const cancelled = totals.cancelled || 0;
    const inFlight = totalAll - completed - failed - cancelled;
    const successPct = totalAll > 0 ? Math.round((completed / totalAll) * 100) : 0;

    const lastOrderLabel = c.last_order_at
      ? new Date(c.last_order_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
      : '-';
    const firstOrderLabel = c.first_order_at
      ? new Date(c.first_order_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
      : '-';

    html += `<div class="bg-white border border-gray-100 rounded-2xl p-4 mb-4">`;
    html += `<div class="flex items-center justify-between mb-3">`;
    html += `<div><div class="text-[10px] text-gray-400 uppercase font-semibold tracking-wide">Customer history</div>`;
    html += `<div class="text-sm font-bold mt-0.5">${escapeHtml(c.name || '-')} <span class="text-gray-400 font-normal">${escapeHtml(c.phone || '')}</span></div></div>`;
    // Quick navigation to the Customers tab detail
    html += `<button onclick="switchTab('customers');setTimeout(()=>showCustomerDetail('${c.id}'),300)" class="text-[11px] text-brand-600 hover:underline whitespace-nowrap">Open profile &rarr;</button>`;
    html += `</div>`;

    // Aggregate stats
    html += `<div class="grid grid-cols-4 gap-2 text-center mb-3">`;
    html += `<div class="bg-surface-100 rounded-xl py-2"><div class="text-[10px] text-gray-400 uppercase">Total</div><div class="text-base font-bold">${totalAll}</div></div>`;
    html += `<div class="bg-green-50 rounded-xl py-2"><div class="text-[10px] text-green-600 uppercase">Done</div><div class="text-base font-bold text-green-700">${completed}</div></div>`;
    html += `<div class="bg-red-50 rounded-xl py-2"><div class="text-[10px] text-red-500 uppercase">Failed</div><div class="text-base font-bold text-red-600">${failed + cancelled}</div></div>`;
    html += `<div class="bg-blue-50 rounded-xl py-2"><div class="text-[10px] text-blue-500 uppercase">In flight</div><div class="text-base font-bold text-blue-600">${Math.max(0, inFlight)}</div></div>`;
    html += `</div>`;

    // Success-rate strip + first/last order spans
    html += `<div class="flex items-center justify-between text-[11px] text-gray-500">`;
    html += `<span>Success rate <span class="font-semibold text-gray-700">${successPct}%</span></span>`;
    html += `<span>First: <span class="text-gray-700">${firstOrderLabel}</span> &middot; Last: <span class="text-gray-700">${lastOrderLabel}</span></span>`;
    html += `</div>`;

    // Recent prior orders (max 5)
    const recent = Array.isArray(ch.recent_orders) ? ch.recent_orders : [];
    if (recent.length > 0) {
      html += `<div class="mt-3 pt-3 border-t border-gray-100">`;
      html += `<div class="text-[10px] text-gray-400 uppercase font-semibold tracking-wide mb-2">Recent (${recent.length})</div>`;
      html += `<div class="space-y-1">`;
      recent.forEach((r) => {
        const when = new Date(r.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
        const status = r.status || 'pending';
        const tone = status === 'completed' || status === 'delivered'
          ? 'bg-green-50 text-green-700'
          : status === 'failed' || status === 'rejected' || status === 'cancelled'
          ? 'bg-red-50 text-red-600'
          : 'bg-blue-50 text-blue-600';
        html += `<div class="flex items-center justify-between text-[11px] py-1">`;
        html += `<span class="text-gray-500 w-14 flex-shrink-0">${when}</span>`;
        html += `<span class="font-semibold flex-1 truncate mx-2">#${escapeHtml(r.order_number || '-')}</span>`;
        html += `<span class="text-gray-400 truncate mr-2 hidden sm:inline">${(r.delivery_method || '').replace(/-/g, ' ')}</span>`;
        html += `<span class="px-2 py-0.5 rounded-full font-semibold ${tone}">${escapeHtml(status)}</span>`;
        html += `</div>`;
      });
      html += `</div></div>`;
    }
    html += `</div>`;
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
  if (s === 'LOCATION_RECONCILED') {
    if (!d || d.decision === 'skipped') return 'Skipped (address complete)';
    const conf = typeof d.confidence === 'number' ? ` ${(d.confidence*100|0)}%` : '';
    const fixed = (d.missing_before||[]).filter((f) => !(d.missing_after||[]).includes(f));
    const fixedLabel = fixed.length ? `recovered ${fixed.join(', ')}` : '';
    if (d.decision === 'auto_merged_high') return `AI ${d.ai_used?'reconciled':'normalized'}${conf}${fixedLabel?' - '+fixedLabel:''}`;
    if (d.decision === 'auto_merged_low')  return `AI filled (low conf${conf}) - please verify`;
    if (d.decision === 'flagged')          return `Could not reconcile (still missing: ${(d.missing_after||[]).join(', ')||'?'})`;
    return d.decision || '';
  }
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

// ============================================================
// Orders tab — single source of truth across email, pipeline,
// caretaker, packer, courier, and Shopify. Designed so the
// operator can answer "where is order #X" without flipping tabs.
// Backed by GET /orders + GET /orders/:id.
// ============================================================

let _ordersFilters = {
  search: '',
  status: '',           // multi: comma-separated
  packing_status: '',
  routing_status: '',
  email_status: '',     // single
  pipeline_status: '',
  has_review: '',       // 'yes' | 'no' | ''
  shopify: '',          // 'fulfilled' | 'pending' | 'cancelled' | ''
  date_from: '',
  date_to: '',
  sort: 'newest',
};
let _ordersPage = { limit: 50, offset: 0 };
let _ordersDetailId = null;  // currently-open order id (drawer)

async function renderOrders() {
  const f = _ordersFilters;
  const params = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => { if (v) params.set(k, v); });
  params.set('limit', String(_ordersPage.limit));
  params.set('offset', String(_ordersPage.offset));

  const { data } = await api('GET', '/orders?' + params.toString());
  if (!data?.success) {
    document.getElementById('tab-content').innerHTML = emptyState('Failed to load orders', '');
    return;
  }
  const rows = data.data.rows || [];
  const total = data.data.total || 0;
  const counts = data.data.counts || {};

  // ---- Toolbar -----------------------------------------------------
  let html = `<div class="bg-white rounded-3xl shadow-card p-4 md:p-6 mb-4">`;
  html += `<div class="flex flex-col md:flex-row md:items-center gap-2 mb-3">`;
  html += `<input id="orders-search" placeholder="Search by order #, name, phone, waybill, locker, address, email subject..." value="${escapeHtml(f.search || '')}" oninput="onOrdersSearchInput(event)" class="flex-1 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400">`;
  html += `<select onchange="setOrdersFilter('sort', this.value)" class="px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">` +
    `<option value="newest"${f.sort==='newest'?' selected':''}>Newest first</option>` +
    `<option value="oldest"${f.sort==='oldest'?' selected':''}>Oldest first</option>` +
    `<option value="status_priority"${f.sort==='status_priority'?' selected':''}>Status priority</option>` +
    `</select>`;
  html += `<select onchange="setOrdersFilter('date_from', this.value)" class="px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">` +
    `<option value=""${!f.date_from?' selected':''}>Any date</option>` +
    `<option value="today"${f.date_from==='today'?' selected':''}>Today</option>` +
    `<option value="7d"${f.date_from==='7d'?' selected':''}>Last 7 days</option>` +
    `<option value="30d"${f.date_from==='30d'?' selected':''}>Last 30 days</option>` +
    `</select>`;
  if (Object.values(f).some((v) => v)) {
    html += `<button onclick="resetOrdersFilters()" class="text-[11px] text-gray-400 hover:text-gray-700 underline">Reset</button>`;
  }
  html += `</div>`;

  // ---- Filter chips: order status -----------------------------------
  // We render a compact set of meaningful statuses + counts. Counts
  // come from data.counts.by_status (filtered context).
  const ORDER_STATUSES = ['created','submitted','collected','in_transit','at_locker','out_for_delivery','delivered','cancelled','failed','awaiting_manual_upload'];
  const visibleStatuses = ORDER_STATUSES.filter((s) => (counts.by_status || {})[s]);
  if (visibleStatuses.length) {
    html += `<div class="flex gap-1.5 flex-wrap mb-2">`;
    html += `<span class="text-[10px] uppercase tracking-wide text-gray-400 self-center mr-1">Status:</span>`;
    html += chipBtn('', 'All', counts.total ?? total, !f.status, () => '');
    visibleStatuses.forEach((s) => {
      html += chipBtn(s, s.replace(/_/g, ' '), counts.by_status[s] || 0, f.status === s);
    });
    html += `</div>`;
  }

  // Email status chips — useful when chasing "did this order's email get processed"
  const emailCounts = countsForEmailStatus(rows);
  html += `<div class="flex gap-1.5 flex-wrap mb-2">`;
  html += `<span class="text-[10px] uppercase tracking-wide text-gray-400 self-center mr-1">Email:</span>`;
  html += emailChipBtn('', 'Any', total, !f.email_status);
  ['processed','processing','fetched','failed'].forEach((s) => {
    html += emailChipBtn(s, s, emailCounts[s] || 0, f.email_status === s);
  });
  html += `</div>`;

  // Caretaker review filter
  html += `<div class="flex gap-1.5 flex-wrap">`;
  html += `<span class="text-[10px] uppercase tracking-wide text-gray-400 self-center mr-1">Review:</span>`;
  html += reviewChipBtn('', 'Any', total, !f.has_review);
  html += reviewChipBtn('yes', 'Open review', rows.filter((r) => r.latest_evaluation_id && !r.latest_evaluation_resolution).length, f.has_review === 'yes');
  html += reviewChipBtn('no', 'No review', null, f.has_review === 'no');
  html += `</div>`;
  html += `</div>`;

  // ---- List + detail layout ----------------------------------------
  let listHtml = `<div class="bg-white rounded-3xl shadow-card overflow-hidden">`;
  listHtml += `<div class="flex items-center justify-between p-4 border-b border-gray-100"><h3 class="font-bold text-base">${total} order${total === 1 ? '' : 's'}</h3>`;
  listHtml += `<div class="flex items-center gap-2">`;
  if (_ordersPage.offset > 0) {
    listHtml += `<button onclick="ordersPage(-1)" class="text-[11px] px-2 py-1 rounded-full bg-gray-100 hover:bg-gray-200">&larr; Prev</button>`;
  }
  if (_ordersPage.offset + _ordersPage.limit < total) {
    listHtml += `<button onclick="ordersPage(1)" class="text-[11px] px-2 py-1 rounded-full bg-gray-100 hover:bg-gray-200">Next &rarr;</button>`;
  }
  listHtml += `<button onclick="renderOrders()" class="text-[11px] text-gray-400 hover:text-gray-600">refresh</button>`;
  listHtml += `</div></div>`;

  if (rows.length === 0) {
    listHtml += emptyState('No orders match', 'Adjust the filters above or clear the search.');
  } else {
    // Desktop: table. Mobile: cards (the responsive table observer
    // already adds `data-label` per cell).
    listHtml += `<div class="overflow-x-auto">`;
    listHtml += `<table class="w-full text-sm">`;
    listHtml += `<thead class="bg-surface-100"><tr class="text-left">`;
    [
      'Order #', 'Customer', 'Method', 'Email', 'Pipeline',
      'Packing', 'Courier', 'Shopify', 'Created', 'Actions',
    ].forEach((h) => {
      listHtml += `<th class="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">${h}</th>`;
    });
    listHtml += `</tr></thead><tbody>`;
    rows.forEach((r) => {
      const active = _ordersDetailId === r.id;
      listHtml += `<tr onclick="openOrderDrawer('${r.id}')" class="border-b border-gray-100 cursor-pointer ${active ? 'bg-brand-50/40' : 'hover:bg-gray-50'}">`;
      listHtml += `<td class="px-3 py-2 font-semibold whitespace-nowrap">#${escapeHtml(r.order_number || '?')}</td>`;
      listHtml += `<td class="px-3 py-2"><div class="font-medium">${escapeHtml(r.customer_name || '-')}</div><div class="text-[11px] text-gray-400">${escapeHtml(r.customer_phone || '')}</div></td>`;
      listHtml += `<td class="px-3 py-2 text-[11px] text-gray-600 capitalize whitespace-nowrap">${escapeHtml((r.delivery_method || '-').replace(/-/g, ' '))}</td>`;
      listHtml += `<td class="px-3 py-2">${renderEmailPill(r)}</td>`;
      listHtml += `<td class="px-3 py-2">${renderPipelinePill(r)}</td>`;
      listHtml += `<td class="px-3 py-2">${renderPackingPill(r)}</td>`;
      listHtml += `<td class="px-3 py-2">${renderCourierPill(r)}</td>`;
      listHtml += `<td class="px-3 py-2">${renderShopifyPill(r)}</td>`;
      listHtml += `<td class="px-3 py-2 text-[11px] text-gray-500 whitespace-nowrap">${r.order_created_at ? new Date(r.order_created_at).toLocaleString() : '-'}</td>`;
      listHtml += `<td class="px-3 py-2">${renderRowActions(r)}</td>`;
      listHtml += `</tr>`;
    });
    listHtml += `</tbody></table></div>`;
  }
  listHtml += `</div>`;

  // Two-column on desktop: list 3/5, sticky drawer 2/5
  html += `<div class="grid grid-cols-1 lg:grid-cols-5 gap-4">` +
    `<div class="lg:col-span-3">${listHtml}</div>` +
    `<div class="lg:col-span-2"><div id="orders-drawer" class="lg:sticky lg:top-4">${
      _ordersDetailId ? '<div class="bg-white rounded-3xl shadow-card p-6 text-sm text-gray-400">Loading detail...</div>' : '<div class="bg-white rounded-3xl shadow-card p-6 text-sm text-gray-400">Click any order on the left to see its full timeline here — email receipt through Shopify fulfillment.</div>'
    }</div></div>` +
    `</div>`;

  document.getElementById('tab-content').innerHTML = html;

  if (_ordersDetailId) {
    const stillThere = rows.find((r) => r.id === _ordersDetailId);
    if (stillThere) openOrderDrawer(_ordersDetailId);
    else _ordersDetailId = null;
  }
}

// ---- Helpers ------------------------------------------------------

function chipBtn(value, label, count, active) {
  const cls = active
    ? 'bg-brand-400 text-gray-900'
    : 'bg-gray-100 hover:bg-gray-200 text-gray-600';
  return `<button onclick="setOrdersFilter('status', ${JSON.stringify(value)})" class="text-[11px] px-2.5 py-1 rounded-full font-medium transition-all ${cls} capitalize">${escapeHtml(label)}<span class="ml-1 opacity-70">${count ?? ''}</span></button>`;
}
function emailChipBtn(value, label, count, active) {
  const tone = value === 'failed' ? 'red' : value === 'processed' ? 'green' : value === 'processing' ? 'blue' : 'gray';
  const cls = active
    ? `bg-${tone}-500 text-white`
    : `bg-${tone}-50 hover:bg-${tone}-100 text-${tone}-700`;
  return `<button onclick="setOrdersFilter('email_status', ${JSON.stringify(value)})" class="text-[11px] px-2.5 py-1 rounded-full font-medium transition-all ${cls} capitalize">${escapeHtml(label)}<span class="ml-1 opacity-70">${count ?? ''}</span></button>`;
}
function reviewChipBtn(value, label, count, active) {
  const cls = active
    ? 'bg-amber-500 text-white'
    : 'bg-amber-50 hover:bg-amber-100 text-amber-700';
  return `<button onclick="setOrdersFilter('has_review', ${JSON.stringify(value)})" class="text-[11px] px-2.5 py-1 rounded-full font-medium transition-all ${cls}">${escapeHtml(label)}${count !== null && count !== undefined ? `<span class="ml-1 opacity-70">${count}</span>` : ''}</button>`;
}
function countsForEmailStatus(rows) {
  const out = { failed: 0, processed: 0, processing: 0, fetched: 0 };
  rows.forEach((r) => { if (r.email_status && out[r.email_status] !== undefined) out[r.email_status] += 1; });
  return out;
}

function renderEmailPill(r) {
  if (!r.email_status) return `<span class="text-[10px] text-gray-300">-</span>`;
  const colorMap = {
    processed: 'bg-green-50 text-green-700',
    processing: 'bg-blue-50 text-blue-700',
    fetched: 'bg-gray-100 text-gray-600',
    failed: 'bg-red-50 text-red-600',
  };
  const ts = r.email_processed_at || r.email_fetched_at || r.email_date;
  const tooltip = r.email_last_error
    ? r.email_last_error.slice(0, 200)
    : (ts ? new Date(ts).toLocaleString() : '');
  return `<span class="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${colorMap[r.email_status]}" title="${escapeHtml(tooltip)}">${r.email_status}</span>`;
}
function renderPipelinePill(r) {
  if (!r.pipeline_status) return `<span class="text-[10px] text-gray-300">-</span>`;
  const colorMap = {
    completed: 'bg-green-50 text-green-700',
    pending_review: 'bg-amber-50 text-amber-700',
    failed: 'bg-red-50 text-red-600',
    processing: 'bg-blue-50 text-blue-700',
    pending: 'bg-gray-100 text-gray-600',
    rejected: 'bg-red-50 text-red-600',
  };
  const cls = colorMap[r.pipeline_status] || 'bg-gray-100 text-gray-600';
  const label = r.pipeline_status.replace(/_/g, ' ');
  const tip = r.pipeline_last_error || r.pipeline_current_stage || '';
  return `<span class="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${cls}" title="${escapeHtml(tip)}">${label}</span>`;
}
function renderPackingPill(r) {
  if (!r.packing_status) return `<span class="text-[10px] text-gray-300">-</span>`;
  const colorMap = {
    awaiting_packing: 'bg-gray-100 text-gray-600',
    packed: 'bg-blue-50 text-blue-700',
    dropped_off: 'bg-green-50 text-green-700',
    cancelled: 'bg-red-50 text-red-600',
  };
  return `<span class="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${colorMap[r.packing_status] || 'bg-gray-100 text-gray-600'}">${r.packing_status.replace(/_/g, ' ')}</span>`;
}
function renderCourierPill(r) {
  if (!r.fulfillment_milestone) return `<span class="text-[10px] text-gray-300">-</span>`;
  const m = r.fulfillment_milestone;
  const cls = m === 'delivered' ? 'bg-green-50 text-green-700'
    : m === 'cancelled' || m === 'failed' ? 'bg-red-50 text-red-600'
    : m === 'at_locker' ? 'bg-indigo-50 text-indigo-700'
    : m === 'out_for_delivery' || m === 'in_transit' ? 'bg-blue-50 text-blue-700'
    : 'bg-gray-100 text-gray-600';
  return `<span class="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${cls}" title="${escapeHtml(r.fulfillment_courier_status || '')}">${m.replace(/_/g, ' ')}</span>`;
}
function renderShopifyPill(r) {
  if (r.shopify_fulfillment_status === 'cancelled') {
    return `<span class="text-[10px] px-2 py-0.5 rounded-full bg-red-50 text-red-600 font-medium whitespace-nowrap">cancelled</span>`;
  }
  if (r.shopify_fulfilled) {
    return `<span class="text-[10px] px-2 py-0.5 rounded-full bg-green-50 text-green-700 font-medium whitespace-nowrap" title="${r.shopify_fulfilled_at ? new Date(r.shopify_fulfilled_at).toLocaleString() : ''}">fulfilled</span>`;
  }
  return `<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-medium whitespace-nowrap">pending</span>`;
}

function renderRowActions(r) {
  const actions = [];
  // Open caretaker review
  if (r.latest_evaluation_id && !r.latest_evaluation_resolution && r.latest_evaluation_verdict === 'review') {
    actions.push(`<button onclick="event.stopPropagation();openReviewModal('${r.latest_evaluation_id}')" class="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 hover:bg-amber-100 font-semibold">Review</button>`);
  }
  // Open in Manual Upload
  if (r.routing_status === 'manual_upload') {
    actions.push(`<button onclick="event.stopPropagation();switchTab('manual-upload')" class="text-[10px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-semibold">Manual</button>`);
  }
  // Pipeline failed -> Reprocess
  if (r.pipeline_status === 'failed' && r.pipeline_job_id) {
    actions.push(`<button onclick="event.stopPropagation();reprocessFromOrders('${r.pipeline_job_id}')" class="text-[10px] px-2 py-0.5 rounded-full bg-red-50 text-red-700 hover:bg-red-100 font-semibold">Reprocess</button>`);
  }
  if (!actions.length) actions.push(`<span class="text-[10px] text-gray-300">—</span>`);
  return actions.join(' ');
}

async function reprocessFromOrders(pipelineJobId) {
  if (!confirm('Reprocess this pipeline job from the start?\n\nExisting order + stage results will be deleted and the email re-enqueued.')) return;
  const { data } = await api('POST', `/pipeline/jobs/${pipelineJobId}/reprocess`);
  if (data?.success) { toast('Reprocess enqueued', 'success'); setTimeout(renderOrders, 1500); }
  else toast(data?.error?.message || 'Reprocess failed', 'error');
}

function setOrdersFilter(key, value) {
  _ordersFilters[key] = value;
  _ordersPage.offset = 0;
  renderOrders();
}
let _ordersSearchTimer = null;
function onOrdersSearchInput(ev) {
  const v = ev.target.value || '';
  clearTimeout(_ordersSearchTimer);
  _ordersSearchTimer = setTimeout(() => {
    _ordersFilters.search = v;
    _ordersPage.offset = 0;
    renderOrders();
  }, 300);
}
function resetOrdersFilters() {
  _ordersFilters = { search: '', status: '', packing_status: '', routing_status: '', email_status: '', pipeline_status: '', has_review: '', shopify: '', date_from: '', date_to: '', sort: 'newest' };
  _ordersPage.offset = 0;
  renderOrders();
}
function ordersPage(direction) {
  _ordersPage.offset = Math.max(0, _ordersPage.offset + direction * _ordersPage.limit);
  renderOrders();
}

async function openOrderDrawer(orderId) {
  _ordersDetailId = orderId;
  // Highlight active row
  document.querySelectorAll('#tab-content tbody tr').forEach((tr) => {
    tr.classList.remove('bg-brand-50/40');
  });
  const drawer = document.getElementById('orders-drawer');
  if (drawer) drawer.innerHTML = `<div class="bg-white rounded-3xl shadow-card p-6 text-sm text-gray-400">Loading...</div>`;

  const { data } = await api('GET', `/orders/${orderId}`);
  if (!data?.success) {
    if (drawer) drawer.innerHTML = `<div class="bg-white rounded-3xl shadow-card p-6 text-sm text-red-500">Failed to load order</div>`;
    return;
  }
  const d = data.data;
  const o = d.order;
  const e = d.email;
  const pj = d.pipeline_job;
  const stages = d.pipeline_stages || [];
  const evals = d.caretaker_evaluations || [];
  const recs = d.reconciliations || [];
  const fj = d.fulfillment_job;
  const fevents = d.fulfillment_events || [];
  const wamsgs = d.whatsapp_messages || [];

  let h = `<div class="bg-white rounded-3xl shadow-card p-5">`;
  h += `<div class="flex items-center justify-between mb-1"><h3 class="font-bold text-base">#${escapeHtml(o.order_number || '?')} &middot; ${escapeHtml(o.customer_name || '-')}</h3>`;
  h += `<button onclick="closeOrderDrawer()" class="text-gray-400 hover:text-gray-700 text-lg">&times;</button></div>`;
  h += `<div class="text-[11px] text-gray-500 mb-4">${escapeHtml(o.customer_phone || '')}${o.delivery_method ? ' &middot; ' + escapeHtml(o.delivery_method.replace(/-/g, ' ')) : ''}</div>`;

  // Status strip
  h += `<div class="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4 text-center">`;
  h += `<div class="bg-surface-100 rounded-xl p-2"><div class="text-[10px] text-gray-400 uppercase">Status</div><div class="text-xs font-semibold mt-1">${escapeHtml((o.status || '-').replace(/_/g, ' '))}</div></div>`;
  h += `<div class="bg-surface-100 rounded-xl p-2"><div class="text-[10px] text-gray-400 uppercase">Routing</div><div class="text-xs font-semibold mt-1">${escapeHtml((o.routing_status || '-').replace(/_/g, ' '))}</div></div>`;
  h += `<div class="bg-surface-100 rounded-xl p-2"><div class="text-[10px] text-gray-400 uppercase">Packing</div><div class="text-xs font-semibold mt-1">${escapeHtml((o.packing_status || '-').replace(/_/g, ' '))}</div></div>`;
  h += `</div>`;

  // Waybill / pin / locker
  if (o.waybill || o.terminal_id) {
    h += `<div class="grid grid-cols-3 gap-2 mb-4">`;
    h += `<div class="bg-surface-100 rounded-xl p-2"><div class="text-[10px] text-gray-400 uppercase">Waybill</div><div class="text-xs font-semibold mt-1">${escapeHtml(o.waybill || '-')}</div></div>`;
    h += `<div class="bg-surface-100 rounded-xl p-2"><div class="text-[10px] text-gray-400 uppercase">PIN</div><div class="text-xs font-semibold mt-1">${escapeHtml(o.pincode || '-')}</div></div>`;
    h += `<div class="bg-surface-100 rounded-xl p-2"><div class="text-[10px] text-gray-400 uppercase">Locker</div><div class="text-xs font-semibold mt-1 truncate" title="${escapeHtml(o.nearest_locker_name || '')}">${escapeHtml(o.terminal_id || '-')}</div></div>`;
    h += `</div>`;
  }

  // Manual upload reason
  if (o.routing_status === 'manual_upload' && o.manual_upload_reason) {
    h += `<div class="bg-amber-50 text-amber-700 text-[11px] rounded-xl px-3 py-2 mb-4"><span class="font-semibold">Manual upload:</span> ${escapeHtml(o.manual_upload_reason)}</div>`;
  }

  // Timeline header
  h += `<h4 class="font-semibold text-xs uppercase tracking-wide text-gray-500 mb-2">Timeline</h4>`;
  h += `<div class="space-y-2 mb-4">`;

  // Email
  if (e) {
    const ts = e.processed_at || e.fetched_at || e.email_date || e.created_at;
    const status = e.last_error ? 'failed' : e.processed_at ? 'processed' : e.processing_at ? 'processing' : 'fetched';
    const color = status === 'failed' ? 'red' : status === 'processed' ? 'green' : status === 'processing' ? 'blue' : 'gray';
    h += `<div class="border-l-2 border-${color}-300 pl-3 py-1">`;
    h += `<div class="flex items-center justify-between"><div class="text-xs font-semibold">Email ${status}</div><div class="text-[10px] text-gray-400">${ts ? new Date(ts).toLocaleString() : ''}</div></div>`;
    if (e.subject) h += `<div class="text-[11px] text-gray-600 truncate" title="${escapeHtml(e.subject)}">${escapeHtml(e.subject)}</div>`;
    if (e.sender) h += `<div class="text-[10px] text-gray-400">from ${escapeHtml(e.sender)}</div>`;
    if (e.last_error) h += `<div class="text-[11px] text-red-600 mt-1">${escapeHtml(e.last_error.slice(0, 200))}</div>`;
    h += `</div>`;
  }

  // Pipeline stages (compact)
  if (stages.length) {
    h += `<div class="border-l-2 border-blue-300 pl-3 py-1">`;
    h += `<div class="flex items-center justify-between"><div class="text-xs font-semibold">Pipeline · ${escapeHtml((pj && pj.status) || '?')}</div><div class="text-[10px] text-gray-400">${stages.length} stages</div></div>`;
    stages.slice(-5).forEach((st) => {
      const sc = st.status === 'completed' ? 'text-green-600' : st.status === 'failed' ? 'text-red-500' : 'text-gray-500';
      h += `<div class="text-[11px] ${sc} flex items-center gap-2"><span class="w-1 h-1 rounded-full bg-current"></span>${escapeHtml(st.stage)}${st.error_message ? `: ${escapeHtml(st.error_message.slice(0, 80))}` : ''}</div>`;
    });
    if (pj && pj.last_error) h += `<div class="text-[11px] text-red-600 mt-1">${escapeHtml(pj.last_error.slice(0, 200))}</div>`;
    h += `</div>`;
  }

  // Caretaker evaluations (latest first, up to 3)
  evals.slice(0, 3).forEach((ev) => {
    const verdict = ev.resolution || ev.verdict;
    const color = verdict === 'approved' ? 'green' : verdict === 'rejected' || verdict === 'reject' ? 'red' : verdict === 'review' ? 'amber' : 'gray';
    h += `<div class="border-l-2 border-${color}-300 pl-3 py-1">`;
    h += `<div class="flex items-center justify-between"><div class="text-xs font-semibold capitalize">Caretaker · ${escapeHtml(verdict)}</div><div class="text-[10px] text-gray-400">${ev.resolved_at ? new Date(ev.resolved_at).toLocaleString() : new Date(ev.created_at).toLocaleString()}</div></div>`;
    if (ev.summary) h += `<div class="text-[11px] text-gray-600">${escapeHtml(ev.summary.slice(0, 200))}</div>`;
    if (ev.resolved_by) h += `<div class="text-[10px] text-gray-400">by ${escapeHtml(ev.resolved_by)}</div>`;
    h += `</div>`;
  });

  // AI reconciliation (most recent only — full history is rare)
  if (recs.length) {
    const r = recs[0];
    const conf = typeof r.confidence === 'number' || typeof r.confidence === 'string'
      ? `${(parseFloat(r.confidence) * 100) | 0}%` : '?';
    h += `<div class="border-l-2 border-amber-300 pl-3 py-1">`;
    h += `<div class="flex items-center justify-between"><div class="text-xs font-semibold">AI address · ${escapeHtml(r.decision)}</div><div class="text-[10px] text-gray-400">conf ${conf}</div></div>`;
    if (r.ai_reasoning) h += `<div class="text-[11px] text-gray-600">${escapeHtml(String(r.ai_reasoning).slice(0, 200))}</div>`;
    h += `</div>`;
  }

  // Fulfillment events (most recent 5)
  if (fevents.length || fj) {
    h += `<div class="border-l-2 border-indigo-300 pl-3 py-1">`;
    h += `<div class="flex items-center justify-between"><div class="text-xs font-semibold">Courier · ${escapeHtml((fj && fj.milestone) || 'pending')}</div><div class="text-[10px] text-gray-400">${fj && fj.last_polled_at ? 'polled ' + new Date(fj.last_polled_at).toLocaleString() : ''}</div></div>`;
    fevents.slice(0, 5).forEach((ev) => {
      h += `<div class="text-[11px] text-gray-600 flex items-center gap-2"><span class="w-1 h-1 rounded-full bg-gray-400"></span>${ev.event_date ? new Date(ev.event_date).toLocaleString() + ' · ' : ''}${escapeHtml(ev.status || '')} ${escapeHtml(ev.message || '')}</div>`;
    });
    h += `</div>`;
  }

  // Shopify
  h += `<div class="border-l-2 border-${o.shopify_fulfilled ? 'green' : 'gray'}-300 pl-3 py-1">`;
  h += `<div class="flex items-center justify-between"><div class="text-xs font-semibold">Shopify · ${o.shopify_fulfilled ? 'fulfilled' : (o.shopify_fulfillment_status || 'not yet')}</div><div class="text-[10px] text-gray-400">${o.shopify_fulfilled_at ? new Date(o.shopify_fulfilled_at).toLocaleString() : ''}</div></div>`;
  if (o.shopify_order_id) h += `<div class="text-[10px] text-gray-400 font-mono">${escapeHtml(o.shopify_order_id)}</div>`;
  h += `</div>`;

  h += `</div>`; // close timeline space-y

  // WhatsApp messages
  if (wamsgs.length) {
    h += `<h4 class="font-semibold text-xs uppercase tracking-wide text-gray-500 mb-2">Customer notifications (${wamsgs.length})</h4>`;
    h += `<div class="space-y-1 mb-4">`;
    wamsgs.forEach((m) => {
      const sc = m.status === 'sent' || m.status === 'delivered' || m.status === 'read'
        ? 'bg-green-50 text-green-700'
        : m.status === 'failed' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700';
      h += `<div class="border border-gray-100 rounded-lg p-2 text-[11px]">`;
      h += `<div class="flex items-center justify-between mb-0.5"><span class="font-semibold capitalize">${escapeHtml((m.purpose || 'unknown').replace(/_/g, ' '))}</span><span class="text-[10px] ${sc} px-1.5 py-0.5 rounded-full uppercase">${escapeHtml(m.status || '-')}</span></div>`;
      h += `<div class="text-gray-500 truncate" title="${escapeHtml(m.body || '')}">${escapeHtml((m.body || '').slice(0, 90))}</div>`;
      h += `</div>`;
    });
    h += `</div>`;
  }

  // Quick deep-links
  h += `<div class="flex flex-wrap gap-1.5 pt-3 border-t border-gray-100">`;
  if (o.latest_evaluation_id || (evals[0] && !evals[0].resolution && evals[0].verdict === 'review')) {
    const eid = (evals[0] && !evals[0].resolution) ? evals[0].id : null;
    if (eid) h += `<button onclick="openReviewModal('${eid}')" class="text-[11px] px-3 py-1 rounded-full bg-amber-50 text-amber-700 hover:bg-amber-100 font-semibold">Review &amp; approve</button>`;
  }
  if (o.routing_status === 'manual_upload') {
    h += `<button onclick="switchTab('manual-upload')" class="text-[11px] px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-semibold">Open in Manual Upload</button>`;
  }
  if (o.pipeline_job_id) {
    h += `<button onclick="reprocessFromOrders('${o.pipeline_job_id}')" class="text-[11px] px-3 py-1 rounded-full bg-gray-100 hover:bg-gray-200 font-semibold">Reprocess</button>`;
  }
  if (fj) {
    h += `<button onclick="switchTab('fulfillment')" class="text-[11px] px-3 py-1 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 font-semibold">Open in Fulfillment</button>`;
  }
  // Rate-packer shortcut. Available once the parcel has visibly left
  // the packer's hands. Pulls assigned_packer_id from the order row,
  // falling back to the most-recent entry of assigned_packer_history
  // so a reassignment chain is rateable too.
  const ratablePackerId = (() => {
    if (o.assigned_packer_id) return o.assigned_packer_id;
    try {
      const hist = Array.isArray(o.assigned_packer_history) ? o.assigned_packer_history : (typeof o.assigned_packer_history === 'string' ? JSON.parse(o.assigned_packer_history || '[]') : []);
      // Find the entry that wasn't rejected — that's the packer who actually delivered.
      const completed = hist.find((e) => !e.rejected_at);
      return completed?.packer_id || null;
    } catch { return null; }
  })();
  const isComplete = o.packing_status === 'dropped_off' || o.status === 'delivered';
  if (ratablePackerId && isComplete) {
    h += `<button onclick="openRatePackerModal('${ratablePackerId}', '${o.id}', '${escapeHtml(o.order_number || '')}')" class="text-[11px] px-3 py-1 rounded-full bg-brand-50 text-brand-700 hover:bg-brand-100 font-semibold">Rate packer</button>`;
  }
  h += `</div>`;

  h += `</div>`;
  if (drawer) drawer.innerHTML = h;
}

function closeOrderDrawer() {
  _ordersDetailId = null;
  const drawer = document.getElementById('orders-drawer');
  if (drawer) drawer.innerHTML = `<div class="bg-white rounded-3xl shadow-card p-6 text-sm text-gray-400">Click any order on the left to see its full timeline here — email receipt through Shopify fulfillment.</div>`;
}

// Fulfillment view state — persisted in-memory for the session so a tab
// switch doesn't reset filters. Resets on full reload.
let _fulfillmentFilters = { milestone: '', search: '', sort: 'newest' };
let _fulfillmentActiveJobId = null;

async function renderFulfillment() {
  const f = _fulfillmentFilters;
  const params = new URLSearchParams();
  params.set('limit', '100');
  if (f.milestone) params.set('milestone', f.milestone);
  if (f.search) params.set('search', f.search);
  if (f.sort) params.set('sort', f.sort);
  const [{ data }, { data: stats }] = await Promise.all([
    api('GET', '/fulfillment/jobs?' + params.toString()),
    api('GET', '/fulfillment/stats'),
  ]);
  if (!data.success) { document.getElementById('tab-content').innerHTML = emptyState('Failed to load',''); return; }
  fulfillmentJobs = data.data.jobs;
  const byMilestone = (stats && stats.success ? stats.data.by_milestone : {}) || {};

  // Toolbar: search + sort + filter chips
  const chipDef = [
    ['',                  'All',          Object.values(byMilestone).reduce((a,b)=>a+(b||0),0)],
    ['submitted',         'Submitted',    byMilestone.submitted || 0],
    ['collected',         'Collected',    byMilestone.collected || 0],
    ['in_transit',        'In transit',   byMilestone.in_transit || 0],
    ['at_locker',         'At locker',    byMilestone.at_locker || 0],
    ['out_for_delivery',  'Out for del.', byMilestone.out_for_delivery || 0],
    ['delivered',         'Delivered',    byMilestone.delivered || 0],
    ['cancelled',         'Cancelled',    byMilestone.cancelled || 0],
    ['failed',            'Failed',       byMilestone.failed || 0],
  ];
  let chipsHtml = '<div class="flex gap-1.5 flex-wrap mb-3">';
  chipDef.forEach(([k, label, count]) => {
    const active = (k || '') === (f.milestone || '');
    chipsHtml += `<button onclick="setFulfillmentFilter('milestone', ${JSON.stringify(k)})" class="text-[11px] px-2.5 py-1 rounded-full font-medium transition-all ${active ? 'bg-brand-400 text-gray-900' : 'bg-gray-100 hover:bg-gray-200 text-gray-600'}">${label}<span class="ml-1 ${active ? 'text-gray-900/70' : 'text-gray-400'}">${count}</span></button>`;
  });
  chipsHtml += '</div>';

  const toolbarHtml =
    `<div class="bg-white rounded-3xl shadow-card p-4 md:p-6 mb-4">` +
    `<div class="flex flex-col md:flex-row md:items-center gap-2 mb-3">` +
      `<input id="fulfillment-search" placeholder="Search waybill, order#, customer, phone..." value="${escapeHtml(f.search || '')}" oninput="onFulfillmentSearchInput(event)" class="flex-1 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400">` +
      `<select id="fulfillment-sort" onchange="setFulfillmentFilter('sort', this.value)" class="px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">` +
        `<option value="newest"${f.sort==='newest'?' selected':''}>Newest first</option>` +
        `<option value="oldest"${f.sort==='oldest'?' selected':''}>Oldest first</option>` +
        `<option value="last_polled"${f.sort==='last_polled'?' selected':''}>Last polled</option>` +
        `<option value="customer"${f.sort==='customer'?' selected':''}>Customer name</option>` +
      `</select>` +
    `</div>` +
    chipsHtml +
    `</div>`;

  // List + detail layout: split-pane on desktop, stacked on mobile.
  let listHtml = '<div class="bg-white rounded-3xl shadow-card p-4 md:p-6">';
  listHtml += `<div class="flex items-center justify-between mb-3">`;
  listHtml += `<h3 class="font-bold text-base">${fulfillmentJobs.length} order${fulfillmentJobs.length===1?'':'s'}</h3>`;
  listHtml += `<button onclick="renderFulfillment()" class="text-[11px] text-gray-400 hover:text-gray-600">refresh</button>`;
  listHtml += `</div>`;
  if (fulfillmentJobs.length === 0) {
    listHtml += emptyState('No orders match', f.search || f.milestone ? 'Adjust the filters above.' : 'Orders with waybills will appear here automatically.');
  } else {
    listHtml += `<div class="space-y-2 max-h-[70vh] overflow-y-auto pr-1">`;
    let lastBucket = null;
    fulfillmentJobs.forEach((j, i) => {
      const ms = (j.milestone||'pending').replace(/_/g,' ');
      const terminal = j.milestone === 'cancelled' || j.milestone === 'failed';
      // Time bucket headers help skim 100 rows fast.
      const bucket = bucketLabel(j.created_at);
      if (bucket !== lastBucket) {
        listHtml += `<div class="text-[10px] uppercase tracking-wide text-gray-400 mt-3 mb-1 first:mt-0">${bucket}</div>`;
        lastBucket = bucket;
      }
      let shopifyPill = '';
      if (!terminal) {
        if (j.shopify_fulfilled) {
          shopifyPill = `<span class="text-[10px] text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-medium whitespace-nowrap" title="Shopify fulfillment created${j.shopify_fulfilled_at ? ' on ' + escapeHtml(new Date(j.shopify_fulfilled_at).toLocaleString()) : ''}">Shopify &#10003;</span>`;
        } else {
          shopifyPill = `<span class="text-[10px] text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full font-medium whitespace-nowrap">Shopify pending</span>`;
        }
      }
      const active = _fulfillmentActiveJobId === j.id;
      listHtml += `<div onclick="showFulfillmentDetail(${i})" class="p-3 rounded-2xl border ${active ? 'border-brand-400 bg-brand-50/40' : 'border-gray-100 hover:border-brand-300'} cursor-pointer transition-all">`;
      listHtml += `<div class="flex items-center justify-between gap-2 mb-1 flex-wrap">`;
      listHtml += `<div class="min-w-0 flex-1">`;
      listHtml += `<div class="text-sm font-semibold truncate">${j.waybill||'-'}${j.order_number ? '<span class="ml-2 text-[11px] text-gray-400">#'+escapeHtml(j.order_number)+'</span>' : ''}</div>`;
      listHtml += `<div class="text-xs text-gray-500 truncate">${escapeHtml(j.customer_name||'')}${j.delivery_method?' &middot; '+escapeHtml(j.delivery_method):''}</div>`;
      listHtml += `</div>`;
      listHtml += `<div class="flex items-center gap-1.5 flex-wrap justify-end">${shopifyPill}${badge(j.milestone==='delivered'?'completed':terminal?'failed':'processing', ms)}</div>`;
      listHtml += `</div>`;
      listHtml += `</div>`;
    });
    listHtml += `</div>`;
  }
  listHtml += `</div>`;

  // Two-column on desktop, single-column on mobile.
  const html =
    toolbarHtml +
    `<div class="grid grid-cols-1 lg:grid-cols-5 gap-4">` +
    `<div class="lg:col-span-2">${listHtml}</div>` +
    `<div class="lg:col-span-3"><div id="fulfillment-detail-panel" class="lg:sticky lg:top-4">${
      _fulfillmentActiveJobId ? '<div class="bg-white rounded-3xl shadow-card p-6 text-sm text-gray-400">Loading detail...</div>' : '<div class="bg-white rounded-3xl shadow-card p-6 text-sm text-gray-400">Select an order on the left to see its detail.</div>'
    }</div></div>` +
    `</div>`;

  document.getElementById('tab-content').innerHTML = html;

  // Restore detail if we had one open — keeps it sticky across re-renders.
  if (_fulfillmentActiveJobId) {
    const idx = fulfillmentJobs.findIndex((j) => j.id === _fulfillmentActiveJobId);
    if (idx >= 0) showFulfillmentDetail(idx);
    else _fulfillmentActiveJobId = null;
  }
}

// Helper: human-readable time-bucket label for grouping fulfillment rows.
function bucketLabel(ts) {
  if (!ts) return 'Older';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const dayMs = 24 * 60 * 60 * 1000;
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (diffMs < 7 * dayMs) return 'This week';
  if (diffMs < 30 * dayMs) return 'This month';
  return 'Older';
}

// Filter chip / sort dropdown handler.
function setFulfillmentFilter(key, value) {
  _fulfillmentFilters[key] = value;
  renderFulfillment();
}

// Debounced search input — fires 300ms after the user stops typing so we
// don't refetch on every keystroke.
let _fulfillmentSearchTimer = null;
function onFulfillmentSearchInput(ev) {
  const v = ev.target.value || '';
  clearTimeout(_fulfillmentSearchTimer);
  _fulfillmentSearchTimer = setTimeout(() => {
    _fulfillmentFilters.search = v;
    renderFulfillment();
  }, 300);
}
async function showFulfillmentDetail(i) {
  const j = fulfillmentJobs[i];
  if (!j) return;
  _fulfillmentActiveJobId = j.id;
  // Subtle ring on the active row so the user always knows which one is open.
  document.querySelectorAll('#tab-content [onclick^="showFulfillmentDetail"]').forEach((el, idx) => {
    el.classList.toggle('border-brand-400', idx === i);
    el.classList.toggle('bg-brand-50/40', idx === i);
  });
  const [{ data }, { data: notifData }] = await Promise.all([
    api('GET', '/fulfillment/jobs/' + j.id),
    api('GET', '/fulfillment/jobs/' + j.id + '/notifications'),
  ]);
  if (!data.success) return;
  const job = data.data.job; const events = data.data.events||[];
  const notifications = (notifData && notifData.success ? notifData.data.notifications : []) || [];
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

  // Shopify fulfillment state — surfaced explicitly so the operator doesn't
  // have to flip to the Shopify admin to know whether the order has been
  // marked fulfilled there. Auto-fires once milestone=in_transit.
  const shopifyState = job.shopify_fulfilled
    ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-50 text-green-600 text-[11px] font-semibold">&#10003; Fulfilled${job.shopify_fulfilled_at ? ' &middot; ' + escapeHtml(new Date(job.shopify_fulfilled_at).toLocaleString()) : ''}</span>`
    : (isCancelled
        ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-100 text-gray-500 text-[11px] font-semibold">N/A (cancelled)</span>`
        : `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-[11px] font-semibold">Pending &middot; auto-fires at in_transit</span>`);
  html += `<div class="flex items-center gap-3 mb-6 flex-wrap">`;
  html += `<span class="text-xs text-gray-500 uppercase tracking-wide font-semibold">Shopify</span>${shopifyState}`;
  if (job.shopify_fulfillment_id) {
    html += `<span class="text-[11px] text-gray-400 font-mono">id: ${escapeHtml(job.shopify_fulfillment_id)}</span>`;
  }
  if (job.shopify_fulfillment_status && job.shopify_fulfillment_status !== 'success') {
    html += `<span class="text-[11px] text-gray-500">status: ${escapeHtml(job.shopify_fulfillment_status)}</span>`;
  }
  html += `</div>`;

  // Customer notifications — every outbound WhatsApp tied to this order_id,
  // so the operator can confirm each milestone notification actually went
  // out (purpose, status, body, error, Meta wa_message_id).
  html += `<h4 class="font-semibold text-sm mb-3">Customer notifications</h4>`;
  if (notifications.length === 0) {
    html += `<p class="text-xs text-gray-400 mb-6">No WhatsApp notifications dispatched yet for this order.</p>`;
  } else {
    html += `<div class="space-y-2 mb-6">`;
    notifications.forEach((n) => {
      const statusColor = n.status === 'sent' || n.status === 'delivered' || n.status === 'read'
        ? 'bg-green-50 text-green-600'
        : n.status === 'failed'
          ? 'bg-red-50 text-red-500'
          : 'bg-amber-50 text-amber-700';
      const purposeLabel = (n.purpose || 'unknown').replace(/_/g, ' ');
      const ts = n.created_at ? new Date(n.created_at).toLocaleString() : '';
      const body = (n.body || '').length > 240 ? (n.body || '').slice(0, 240) + '…' : (n.body || '');
      html += `<div class="border border-gray-100 rounded-xl p-3">`;
      html += `<div class="flex items-center justify-between gap-2 mb-1 flex-wrap">`;
      html += `<div class="flex items-center gap-2 min-w-0">`;
      html += `<span class="text-xs font-semibold capitalize">${escapeHtml(purposeLabel)}</span>`;
      html += `<span class="text-[10px] text-gray-400">to ${escapeHtml(n.phone_to || '-')}</span>`;
      html += `</div>`;
      html += `<div class="flex items-center gap-2">`;
      html += `<span class="text-[10px] ${statusColor} px-2 py-0.5 rounded-full font-medium uppercase">${escapeHtml(n.status || '-')}</span>`;
      html += `<span class="text-[10px] text-gray-400">${escapeHtml(ts)}</span>`;
      html += `</div></div>`;
      if (body) html += `<div class="text-[11px] text-gray-600 whitespace-pre-wrap">${escapeHtml(body)}</div>`;
      if (n.last_error) html += `<div class="text-[11px] text-red-500 mt-1"><span class="font-semibold">Error:</span> ${escapeHtml(n.last_error)}</div>`;
      if (n.wa_message_id) html += `<div class="text-[10px] text-gray-300 font-mono mt-1">${escapeHtml(n.wa_message_id)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

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

// Caretaker view state — survives within a session, resets on reload.
// Default sort = urgency so the first row in the queue is the one most
// likely to slip a collection window.
let _caretakerFilters = { urgency: 'all', sort: 'urgency' };

async function renderCaretaker() {
  const params = new URLSearchParams();
  params.set('limit', '100');
  if (_caretakerFilters.urgency && _caretakerFilters.urgency !== 'all') params.set('urgency', _caretakerFilters.urgency);
  if (_caretakerFilters.sort) params.set('sort', _caretakerFilters.sort);
  const [{ data: rulesRes }, { data: evalsRes }] = await Promise.all([
    api('GET', '/caretaker/rules'),
    api('GET', '/caretaker/evaluations?' + params.toString()),
  ]);
  const rules = rulesRes && rulesRes.success ? rulesRes.data : {};
  const evals = evalsRes && evalsRes.success ? evalsRes.data : [];
  const counts = (evalsRes && evalsRes.success && evalsRes.counts) || {
    critical: 0, high: 0, normal: 0, fresh: 0, resolved: 0, all: evals.length,
  };

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

  // Evaluations panel — header changes based on whether anything's
  // critical so the operator can spot a slipping collection window
  // from across the room.
  html += `<div class="lg:col-span-2 bg-white rounded-3xl shadow-card p-6">`;
  html += `<div class="flex items-center justify-between mb-2 flex-wrap gap-2">`;
  html += `<h3 class="font-bold text-base">Evaluations</h3>`;
  html += `<select onchange="setCaretakerFilter('sort', this.value)" class="px-3 py-1.5 bg-surface-100 rounded-xl text-xs border-0">` +
    `<option value="urgency"${_caretakerFilters.sort==='urgency'?' selected':''}>Sort: Urgency</option>` +
    `<option value="oldest"${_caretakerFilters.sort==='oldest'?' selected':''}>Sort: Oldest first</option>` +
    `<option value="newest"${_caretakerFilters.sort==='newest'?' selected':''}>Sort: Newest first</option>` +
    `</select>`;
  html += `</div>`;

  // Critical banner — only shows when something has been waiting > 24h.
  if (counts.critical > 0) {
    html += `<div class="mb-3 px-4 py-3 rounded-2xl bg-red-50 border border-red-200 flex items-start gap-3">` +
      `<span class="inline-block w-2.5 h-2.5 rounded-full bg-red-500 pulse-dot mt-1 flex-shrink-0"></span>` +
      `<div class="flex-1">` +
        `<div class="text-sm font-bold text-red-700">${counts.critical} order${counts.critical === 1 ? '' : 's'} waiting over 24 hours</div>` +
        `<div class="text-[11px] text-red-600">Collection window is slipping. These are at the top of the queue below.</div>` +
      `</div>` +
      `<button onclick="setCaretakerFilter('urgency', 'critical')" class="text-[11px] px-3 py-1 rounded-full bg-red-100 hover:bg-red-200 text-red-700 font-semibold whitespace-nowrap">Show only critical</button>` +
    `</div>`;
  }

  // Filter chips with live counts.
  const chipDef = [
    ['all',      'All',      counts.all,      'bg-gray-100 hover:bg-gray-200 text-gray-700',     'bg-gray-700 text-white'],
    ['critical', '> 24h',    counts.critical, 'bg-red-50 hover:bg-red-100 text-red-700',         'bg-red-500 text-white'],
    ['high',     '8-24h',    counts.high,     'bg-amber-50 hover:bg-amber-100 text-amber-700',   'bg-amber-500 text-white'],
    ['normal',   '2-8h',     counts.normal,   'bg-blue-50 hover:bg-blue-100 text-blue-700',      'bg-blue-500 text-white'],
    ['fresh',    '< 2h',     counts.fresh,    'bg-green-50 hover:bg-green-100 text-green-700',   'bg-green-500 text-white'],
    ['resolved', 'Resolved', counts.resolved, 'bg-gray-50 hover:bg-gray-100 text-gray-500',      'bg-gray-500 text-white'],
  ];
  html += `<div class="flex gap-1.5 flex-wrap mb-3">`;
  chipDef.forEach(([key, label, count, idle, active]) => {
    const isActive = _caretakerFilters.urgency === key;
    html += `<button onclick="setCaretakerFilter('urgency', '${key}')" class="text-[11px] px-2.5 py-1 rounded-full font-medium transition-all ${isActive ? active : idle}">${label}<span class="ml-1 opacity-80">${count}</span></button>`;
  });
  html += `</div>`;

  if (evals.length === 0) {
    html += `<p class="text-sm text-gray-400">No evaluations match this filter.</p>`;
  } else {
    html += `<div class="space-y-2 max-h-[600px] overflow-y-auto pr-1" id="caretaker-eval-list">`;
    evals.forEach(e => {
      const flags = Array.isArray(e.flags)?e.flags:(e.flags||[]);

      // Visual treatment per urgency tier — only applied to unresolved
      // rows so the eye lands on what still needs work first.
      const isResolved = !!e.resolution;
      const tier = e.urgency || 'fresh';
      let rowClass = 'border-gray-100';
      if (!isResolved) {
        if (tier === 'critical') rowClass = 'border-red-200 bg-red-50/40 border-l-4 border-l-red-500';
        else if (tier === 'high') rowClass = 'border-amber-200 bg-amber-50/40 border-l-4 border-l-amber-500';
        else if (tier === 'normal') rowClass = 'border-blue-100 border-l-4 border-l-blue-300';
      }

      // Age pill — humanize the age in hours/minutes/days.
      const ageLabel = formatAgeShort(e.age_seconds || 0);
      let agePillClass = 'bg-gray-100 text-gray-500';
      if (!isResolved) {
        if (tier === 'critical') agePillClass = 'bg-red-500 text-white font-bold';
        else if (tier === 'high') agePillClass = 'bg-amber-500 text-white font-semibold';
        else if (tier === 'normal') agePillClass = 'bg-blue-100 text-blue-700';
        else agePillClass = 'bg-green-50 text-green-600';
      }

      // After approval, the underlying pipeline_job moves processing -> completed/failed.
      // Surface that state here so the reviewer doesn't have to flip to the
      // Pipeline tab to see what happened next.
      let postResolutionPill = '';
      if (e.resolution === 'approved') {
        if (e.pipeline_status === 'processing' && e.pipeline_caretaker_verdict === 'approve') {
          postResolutionPill = `<span class="text-[10px] text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full font-medium whitespace-nowrap"><span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 pulse-dot mr-1 align-middle"></span>resuming</span>`;
        } else if (e.pipeline_status === 'completed' && (e.order_waybill || e.order_status === 'submitted' || e.order_status === 'completed' || e.order_status === 'delivered')) {
          postResolutionPill = `<span class="text-[10px] text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-medium whitespace-nowrap">submitted${e.order_waybill ? ' &middot; ' + escapeHtml(e.order_waybill) : ''}</span>`;
        } else if (e.pipeline_status === 'failed') {
          postResolutionPill = `<span class="text-[10px] text-red-600 bg-red-50 px-2 py-0.5 rounded-full font-medium whitespace-nowrap" title="${escapeHtml(e.pipeline_last_error || '')}">submit failed</span>`;
        } else if (e.pipeline_status === 'rejected') {
          postResolutionPill = `<span class="text-[10px] text-red-500 bg-red-50 px-2 py-0.5 rounded-full font-medium whitespace-nowrap">rejected by pipeline</span>`;
        }
      }

      html += `<div class="p-3 rounded-2xl border ${rowClass}" data-eval-id="${e.id}">`;
      // Header: age pill + timestamp + order ref + verdict badge + post-resolution pill
      html += `<div class="flex items-center justify-between gap-2 mb-1 flex-wrap">`;
      html += `<div class="flex items-center gap-2 min-w-0">`;
      html += `<span class="text-[10px] px-2 py-0.5 rounded-full ${agePillClass} whitespace-nowrap" title="Age since the review opened">${escapeHtml(ageLabel)}</span>`;
      html += `<span class="text-xs text-gray-400">${new Date(e.created_at).toLocaleString()}</span>`;
      if (e.order_number) {
        html += `<span class="text-[11px] text-gray-700 font-semibold truncate">#${escapeHtml(e.order_number)}${e.customer_name ? ' &middot; ' + escapeHtml(e.customer_name) : ''}</span>`;
      }
      html += `</div>`;
      html += `<div class="flex items-center gap-2">`;
      html += postResolutionPill;
      // Badge reflects the *current* state of the evaluation, not the
      // original system verdict. Once a reviewer has resolved it,
      // `resolution` wins; otherwise fall back to the system verdict.
      // This keeps the amber "review" pill scoped to items that still
      // need attention.
      let badgeStatus, badgeText;
      if (e.resolution === 'approved') {
        badgeStatus = 'completed'; badgeText = 'approved';
      } else if (e.resolution === 'rejected') {
        badgeStatus = 'failed'; badgeText = 'rejected';
      } else if (e.verdict === 'review') {
        badgeStatus = 'pending_review'; badgeText = 'review';
      } else if (e.verdict === 'approve') {
        badgeStatus = 'completed'; badgeText = 'auto-approved';
      } else if (e.verdict === 'reject') {
        badgeStatus = 'failed'; badgeText = 'auto-rejected';
      } else {
        badgeStatus = 'failed'; badgeText = e.verdict || 'unknown';
      }
      html += badge(badgeStatus, badgeText);
      html += `</div></div>`;

      html += `<div class="text-xs text-gray-500">${escapeHtml(e.summary||'-')}</div>`;

      // If the resumed pipeline failed, surface the reason inline so the
      // reviewer can decide whether to reopen (vs. flipping to Pipeline tab).
      if (e.resolution === 'approved' && e.pipeline_status === 'failed' && e.pipeline_last_error) {
        const short = e.pipeline_last_error.length > 200 ? e.pipeline_last_error.slice(0, 200) + '…' : e.pipeline_last_error;
        html += `<div class="text-[11px] text-red-600 bg-red-50 rounded-lg px-2.5 py-1.5 mt-2"><span class="font-semibold">After submit:</span> ${escapeHtml(short)}</div>`;
      }

      let actions = '';
      if (e.verdict==='review' && !e.resolution) {
        // Accept AI shortcut: only renders when the address reconciler
        // produced a usable suggestion. One click sends a resolve with
        // overrides built from the AI suggestion — saves the reviewer
        // ~6 field-by-field clicks for the common case.
        const acceptAiBtn = (e.recon_ai_used && e.recon_ai_suggestion && (e.recon_decision === 'auto_merged_low' || (e.recon_decision === 'flagged' && e.recon_confidence >= 0.5)))
          ? `<button onclick="acceptAiSuggestion('${e.id}')" class="px-3 py-1 bg-amber-50 text-amber-700 rounded-full text-xs font-semibold hover:bg-amber-100" title="Approve using AI's address fill-in (confidence ${typeof e.recon_confidence==='number'?(e.recon_confidence*100|0)+'%':'?'})">&#9889; Accept AI &amp; approve</button>`
          : '';
        actions = `${acceptAiBtn}<button onclick="openReviewModal('${e.id}')" class="px-3 py-1 bg-green-50 text-green-600 rounded-full text-xs font-semibold hover:bg-green-100">Review &amp; Approve</button><button onclick="resolveCk('${e.id}','rejected')" class="px-3 py-1 bg-red-50 text-red-500 rounded-full text-xs font-semibold hover:bg-red-100">Reject</button>`;
      } else if (e.verdict==='reject' || e.resolution==='rejected') {
        actions = `<button onclick="reopenCk('${e.id}')" class="px-3 py-1 bg-amber-50 text-amber-700 rounded-full text-xs font-semibold hover:bg-amber-100">Reopen for review</button>`;
      } else if (e.verdict==='approve' && !e.resolution) {
        actions = `<button onclick="reopenCk('${e.id}')" class="px-3 py-1 bg-gray-50 text-gray-600 rounded-full text-xs font-semibold hover:bg-gray-100" title="Convert to pending review">Reopen</button>`;
      } else if (e.resolution === 'approved' && e.pipeline_status === 'failed') {
        // Approved but the pipeline submit failed — let the reviewer reopen
        // so they can edit and re-approve without going back to Pipeline.
        actions = `<button onclick="reopenCk('${e.id}')" class="px-3 py-1 bg-amber-50 text-amber-700 rounded-full text-xs font-semibold hover:bg-amber-100">Reopen &amp; edit</button>`;
      }
      if (actions) html += `<div class="flex gap-2 mt-2 flex-wrap">${actions}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  html += `</div></div>`;
  document.getElementById('tab-content').innerHTML = html;

  // Auto-refresh:
  //   - 3s while any approved evaluation has a resuming pipeline (so the
  //     resume -> submitted/failed transition lands without a manual
  //     refresh, same as before)
  //   - 30s when there are unresolved critical/high rows (so a fresh
  //     order aging into critical at, say, hour 8.5 gets noticed without
  //     the operator hitting refresh)
  //   - Off otherwise — nothing to watch.
  const inFlight = evals.some((e) => e.resolution === 'approved' && (e.pipeline_status === 'processing' || e.pipeline_status === 'pending_review'));
  const hasUrgent = (counts.critical || 0) + (counts.high || 0) > 0;
  clearTimeout(window._caretakerTimer);
  if (currentTab === 'caretaker') {
    if (inFlight) {
      window._caretakerTimer = setTimeout(() => { if (currentTab === 'caretaker') renderCaretaker(); }, 3000);
    } else if (hasUrgent) {
      window._caretakerTimer = setTimeout(() => { if (currentTab === 'caretaker') renderCaretaker(); }, 30000);
    }
  }
}

function setCaretakerFilter(key, value) {
  _caretakerFilters[key] = value;
  renderCaretaker();
}

// Convert an age in seconds into a tight human label: "3m" / "47m" /
// "5h" / "23h" / "2d" / "11d". Used for the per-row pill so the operator
// can grok urgency at a glance.
function formatAgeShort(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
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

/**
 * One-click approval that uses the AI reconciler's address suggestion
 * verbatim. Avoids opening the modal when the operator trusts the AI's
 * fill-in. Audit row records resolved_by + the override blob.
 */
async function acceptAiSuggestion(evaluationId) {
  // Re-fetch the evaluation so we send the canonical suggestion blob.
  const { data: gd } = await api('GET', `/caretaker/evaluations/${evaluationId}`);
  if (!gd?.success) { toast('Failed to load evaluation', 'error'); return; }
  const recon = gd.data?.snapshot?.location_reconciled || null;
  const ai = recon && recon.ai_suggestion ? recon.ai_suggestion : null;
  if (!ai || Object.keys(ai).length === 0) {
    toast('No AI suggestion available', 'warning');
    return;
  }
  const conf = typeof recon.confidence === 'number' ? `${(recon.confidence * 100) | 0}%` : '?';
  if (!confirm(`Approve this order using the AI's reconstructed address (confidence ${conf})?`)) return;

  // Map AI's keys onto the override schema. Only non-empty fields go through.
  const addr = {};
  ['street_address', 'suburb', 'city', 'zone', 'code', 'country'].forEach((k) => {
    const v = ai[k];
    if (v && String(v).trim()) addr[k] = String(v).trim();
  });
  const body = { resolution: 'approved' };
  if (Object.keys(addr).length) body.overrides = { delivery_address: addr };
  body.notes = `Accepted AI address suggestion (confidence ${conf}, decision ${recon.decision})`;

  const { data } = await api('POST', `/caretaker/evaluations/${evaluationId}/resolve`, body);
  if (data?.success) {
    toast('Approved with AI address — pipeline resuming', 'success');
    setTimeout(() => renderCaretaker(), 600);
  } else {
    toast(data?.error?.message || 'Failed to approve', 'error');
  }
}

/**
 * Inline address-edit modal for the Pipeline detail view.
 *
 * Lets the operator correct a geocode result without flipping to the
 * Caretaker tab. On save, calls POST /pipeline/jobs/:id/address which
 * stores the override on the most recent caretaker_evaluation and
 * re-enqueues the pipeline. The pipeline picks the override up via
 * executeCustomerData on the next pass.
 */
function openAddressEditModal(jobId, orderJson) {
  let order = {};
  try { order = JSON.parse(orderJson); } catch {}
  let addr = {};
  try {
    addr = typeof order.delivery_address === 'string'
      ? JSON.parse(order.delivery_address)
      : (order.delivery_address || {});
  } catch {}

  const f = (id, label, value, placeholder = '') =>
    `<div><label class="block text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">${label}</label>` +
    `<input id="${id}" value="${escapeHtml(value == null ? '' : String(value))}" placeholder="${escapeHtml(placeholder)}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400"></div>`;

  const body =
    `<p class="text-xs text-gray-500 mb-3">Correct any field below. The pipeline re-runs from scratch with these values applied as a reviewer override.</p>` +
    `<div class="grid grid-cols-2 gap-3">` +
      f('addr-street', 'Street',     addr.street || addr.street1 || addr.street_address || '', '12 Long St') +
      f('addr-suburb', 'Suburb',     addr.suburb || '', 'Sea Point') +
      f('addr-city',   'City',       addr.city || '', 'Cape Town') +
      f('addr-province','Province',  addr.province || addr.state || addr.zone || '', 'Western Cape') +
      f('addr-postal', 'Postal code',addr.postal_code || addr.pincode || addr.code || '', '8005') +
      f('addr-country','Country',    addr.country || 'South Africa', 'South Africa') +
      f('addr-lat',    'Latitude',   addr.latitude || addr.lat || '', '-33.92') +
      f('addr-lng',    'Longitude',  addr.longitude || addr.lng || '', '18.42') +
    `</div>` +
    `<div class="mt-3 text-[11px] text-gray-400">Hint: leaving lat/lng blank lets the pipeline re-geocode the corrected text fields.</div>`;

  const footer =
    `<button onclick="closeModal({target:document.querySelector('.modal-backdrop')})" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-sm">Cancel</button>` +
    `<button id="addr-save-btn" onclick="submitAddressEdit('${jobId}')" class="px-4 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm">Save and re-run pipeline</button>`;
  openModal('Edit delivery address', body, footer);
}

async function submitAddressEdit(jobId) {
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  const fields = {
    street: v('addr-street'),
    suburb: v('addr-suburb'),
    city: v('addr-city'),
    province: v('addr-province'),
    postal_code: v('addr-postal'),
    country: v('addr-country'),
    latitude: v('addr-lat'),
    longitude: v('addr-lng'),
  };
  // Drop empty fields so we don't overwrite existing-good with blanks.
  const delivery_address = Object.fromEntries(
    Object.entries(fields).filter(([, val]) => val !== ''),
  );
  // Coerce lat/lng to numbers where present.
  if (delivery_address.latitude) delivery_address.latitude = Number(delivery_address.latitude);
  if (delivery_address.longitude) delivery_address.longitude = Number(delivery_address.longitude);

  if (Object.keys(delivery_address).length === 0) {
    toast('Provide at least one field', 'warning');
    return;
  }

  const btn = document.getElementById('addr-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  const { data } = await api('POST', `/pipeline/jobs/${jobId}/address`, { delivery_address });
  if (data?.success) {
    toast('Address updated; pipeline re-running', 'success');
    closeModal({ target: document.querySelector('.modal-backdrop') });
    setTimeout(() => { if (typeof renderPipeline === 'function') renderPipeline(); }, 500);
  } else {
    toast(data?.error?.message || 'Failed to save address', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Save and re-run pipeline'; }
  }
}

/**
 * Reviewer-notes shorthand: store and recall the operator's most recently
 * used override reasons. Per-browser via localStorage so each operator gets
 * their own list. Capped at 8 entries; new entries promote to the top; case
 * and whitespace are normalized so "Wrong locker" and "wrong locker " collapse
 * to one chip.
 *
 * Storage shape: a JSON-encoded array of { text, lastUsed (ISO) } sorted
 * newest-first. We could pull from caretaker_evaluations.reviewer_notes
 * server-side too but the local list is fast, private, and survives across
 * tabs without a server roundtrip.
 */
const REVIEW_NOTES_KEY = 'relayos.review.recent_notes';
const REVIEW_NOTES_MAX = 8;

function _loadRecentReviewNotes() {
  try {
    const raw = localStorage.getItem(REVIEW_NOTES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function _saveRecentReviewNote(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length < 2) return; // ignore noise
  const current = _loadRecentReviewNotes();
  // Dedupe case-insensitively.
  const norm = trimmed.toLowerCase();
  const filtered = current.filter((e) => (e.text || '').toLowerCase() !== norm);
  filtered.unshift({ text: trimmed, lastUsed: new Date().toISOString() });
  const capped = filtered.slice(0, REVIEW_NOTES_MAX);
  try {
    localStorage.setItem(REVIEW_NOTES_KEY, JSON.stringify(capped));
  } catch {
    // localStorage might be full or disabled — don't break the approve flow.
  }
}

/** Apply a quick-pick reason to the rv-notes textarea. */
function applyReviewNote(text) {
  const el = document.getElementById('rv-notes');
  if (!el) return;
  el.value = text;
  el.focus();
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
  // New context fields from the detail endpoint — all optional.
  const pj = data.data.pipeline_job || null;
  const order = data.data.order || null;
  const history = Array.isArray(data.data.history) ? data.data.history : [];
  const locResolved = snap.location_resolved && snap.location_resolved.delivery_address ? snap.location_resolved.delivery_address : null;
  const recon = snap.location_reconciled || null;
  const lockerSnap = snap.lockers_resolved || null;

  // Build the context banner. Shows: pipeline state, manual-upload origin
  // (when the order has been routed to manual queue), and a compact history
  // line if other evaluations exist for the same job.
  const contextBlocks = [];
  if (pj && pj.status === 'failed' && pj.last_error) {
    contextBlocks.push(`<div class="text-[11px] bg-red-50 text-red-700 rounded-xl px-3 py-2"><span class="font-semibold">Last submit failed:</span> ${escapeHtml(pj.last_error)}</div>`);
  } else if (pj && pj.status === 'processing' && pj.caretaker_verdict === 'approve') {
    contextBlocks.push(`<div class="text-[11px] bg-blue-50 text-blue-700 rounded-xl px-3 py-2"><span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 mr-1 align-middle"></span>Currently resuming after a previous approval — submit may finish before you save here.</div>`);
  }
  if (order && order.routing_status === 'manual_upload' && order.manual_upload_reason) {
    contextBlocks.push(`<div class="text-[11px] bg-amber-50 text-amber-700 rounded-xl px-3 py-2"><span class="font-semibold">Currently in Manual Upload:</span> ${escapeHtml(order.manual_upload_reason)}</div>`);
  }
  if (order && order.routing_status === 'collection') {
    contextBlocks.push(`<div class="text-[11px] bg-indigo-50 text-indigo-700 rounded-xl px-3 py-2"><span class="font-semibold">Customer collection:</span> waiting for in-person pickup.</div>`);
  }
  if (history.length > 0) {
    const summary = history.map((h) => {
      const stamp = new Date(h.resolved_at || h.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
      const who = h.resolution
        ? `${h.resolution} by ${escapeHtml(h.resolved_by || 'unknown')}`
        : `${escapeHtml(h.verdict || 'review')} (unresolved)`;
      return `<li>${stamp}: ${who}${h.reviewer_notes ? ` — <span class="text-gray-500">${escapeHtml(h.reviewer_notes)}</span>` : ''}</li>`;
    }).join('');
    contextBlocks.push(`<div class="text-[11px] bg-gray-50 text-gray-700 rounded-xl px-3 py-2"><span class="font-semibold">Reviewed before (${history.length}):</span><ul class="list-disc list-inside mt-0.5 space-y-0.5">${summary}</ul></div>`);
  }
  const contextHtml = contextBlocks.length
    ? `<div class="mt-3 space-y-2">${contextBlocks.join('')}</div>`
    : '';

  const existing = document.getElementById('review-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'review-modal-overlay';
  overlay.className = 'fixed inset-0 bg-black/40 flex items-center justify-center z-[10000] p-4';
  const itemsHtml = items.length
    ? items.map((li, i) => `<div class="flex gap-2 mb-1" data-rv-item-row="${i}"><input class="flex-1 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0" data-rv-item-name value="${escapeHtml(li.name||'')}"><input class="w-20 px-3 py-2 bg-surface-100 rounded-xl text-sm border-0" data-rv-item-qty type="number" min="1" value="${li.quantity||1}"><button onclick="this.parentElement.remove()" class="px-2 text-red-500 hover:text-red-700" title="Remove">&times;</button></div>`).join('')
    : '';

  overlay.innerHTML = `
    <div class="bg-white rounded-3xl shadow-card w-full max-w-3xl max-h-[90vh] overflow-y-auto">
      <div class="p-6 border-b border-gray-100">
        <div class="flex items-center justify-between mb-1">
          <h3 class="font-bold text-base">Review &amp; Approve${order && order.order_number ? ` &middot; <span class="text-gray-500 font-semibold">#${escapeHtml(order.order_number)}</span>` : ''}</h3>
          <button onclick="closeReviewModal()" class="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>
        <p class="text-xs text-gray-400">Edit any field below — your values will override what the AI extracted when the pipeline resumes.</p>
        ${flags.length ? `<div class="mt-3 flex flex-wrap gap-1">${flags.map(f => `<span class="px-2 py-0.5 bg-amber-50 text-amber-700 text-[11px] rounded-full">${escapeHtml(f)}</span>`).join('')}</div>` : ''}
        ${ev.summary ? `<div class="mt-2 text-xs text-gray-500">${escapeHtml(ev.summary)}</div>` : ''}
        ${contextHtml}
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
          <div class="flex items-center justify-between mb-2">
            <h4 class="font-semibold text-sm">Delivery address</h4>
            ${recon ? `<span class="text-[10px] px-2 py-0.5 rounded-full font-medium ${recon.decision==='auto_merged_high'?'bg-green-50 text-green-700':recon.decision==='auto_merged_low'?'bg-amber-50 text-amber-700':recon.decision==='flagged'?'bg-red-50 text-red-700':'bg-gray-100 text-gray-500'}">AI: ${recon.decision==='auto_merged_high'?'verified':recon.decision==='auto_merged_low'?'low conf':recon.decision==='flagged'?'needs review':recon.decision||'-'}${typeof recon.confidence==='number'?' '+(recon.confidence*100|0)+'%':''}</span>` : ''}
          </div>
          ${(() => {
            // Three-column comparison: Entered (raw), Geocoded (Google's
            // structured result, possibly with gaps), AI suggestion (the
            // reconciler's reconstruction). The radio per row picks which
            // value lands in the override on save. The AI value is
            // pre-selected when available, geocoded otherwise, and entered
            // as the last fallback so something is always chosen.
            const aiSugg = (recon && recon.ai_suggestion) ? recon.ai_suggestion : {};
            const enteredAddr = addr.entered_address || (locResolved && locResolved.entered_address) || '';
            // For the Entered column we don't have structured fields — show
            // the raw string in the street row, leave others blank.
            const fields = [
              { key: 'street_address', label: 'Street', entered: enteredAddr, geocoded: (locResolved && locResolved.street_address) || '', ai: aiSugg.street_address || '' },
              { key: 'suburb',         label: 'Suburb', entered: '',          geocoded: (locResolved && locResolved.suburb) || '',         ai: aiSugg.suburb || '' },
              { key: 'city',           label: 'City',   entered: '',          geocoded: (locResolved && locResolved.city) || '',           ai: aiSugg.city || '' },
              { key: 'zone',           label: 'Province', entered: '',        geocoded: (locResolved && locResolved.zone) || '',           ai: aiSugg.zone || '' },
              { key: 'code',           label: 'Postal',   entered: '',        geocoded: (locResolved && locResolved.code) || '',           ai: aiSugg.code || '' },
              { key: 'country',        label: 'Country',  entered: '',        geocoded: (locResolved && locResolved.country) || 'South Africa', ai: aiSugg.country || '' },
            ];
            // Default current value: prefer AI suggestion, then geocode, then entered.
            // The 'edit' input below mirrors whichever radio is selected.
            const defaultPick = (f) => f.ai ? 'ai' : f.geocoded ? 'geocoded' : 'entered';
            return `
              <div class="hidden md:grid grid-cols-[110px_1fr_1fr_1fr_1.2fr] gap-2 text-[10px] uppercase tracking-wide text-gray-400 mb-1 px-1">
                <div></div><div>Entered</div><div>Geocoded</div><div>AI suggestion</div><div>Use this value</div>
              </div>
              <div class="space-y-1.5" id="rv-addr-grid">
                ${fields.map((f) => {
                  const pick = defaultPick(f);
                  const value = pick === 'ai' ? f.ai : pick === 'geocoded' ? f.geocoded : f.entered;
                  return `
                  <div class="grid grid-cols-1 md:grid-cols-[110px_1fr_1fr_1fr_1.2fr] gap-2 items-center" data-rv-addr-row="${f.key}">
                    <div class="text-xs text-gray-500 font-medium">${f.label}</div>
                    <label class="flex items-start gap-1.5 cursor-pointer p-1.5 rounded-lg hover:bg-gray-50 ${pick==='entered'?'bg-gray-50':''}">
                      <input type="radio" name="rv-addr-${f.key}-pick" value="entered" ${pick==='entered'?'checked':''} ${!f.entered?'disabled':''} onchange="onAddressPickChange('${f.key}', 'entered')" class="mt-0.5">
                      <span class="text-[11px] ${f.entered?'text-gray-700':'text-gray-300'} break-words">${escapeHtml(f.entered) || '<span class="italic">empty</span>'}</span>
                    </label>
                    <label class="flex items-start gap-1.5 cursor-pointer p-1.5 rounded-lg hover:bg-gray-50 ${pick==='geocoded'?'bg-gray-50':''}">
                      <input type="radio" name="rv-addr-${f.key}-pick" value="geocoded" ${pick==='geocoded'?'checked':''} ${!f.geocoded?'disabled':''} onchange="onAddressPickChange('${f.key}', 'geocoded')" class="mt-0.5">
                      <span class="text-[11px] ${f.geocoded?'text-gray-700':'text-gray-300'} break-words">${escapeHtml(f.geocoded) || '<span class="italic">empty</span>'}</span>
                    </label>
                    <label class="flex items-start gap-1.5 cursor-pointer p-1.5 rounded-lg hover:bg-amber-50 ${pick==='ai'?'bg-amber-50':''}">
                      <input type="radio" name="rv-addr-${f.key}-pick" value="ai" ${pick==='ai'?'checked':''} ${!f.ai?'disabled':''} onchange="onAddressPickChange('${f.key}', 'ai')" class="mt-0.5">
                      <span class="text-[11px] ${f.ai?'text-amber-700 font-medium':'text-gray-300'} break-words">${escapeHtml(f.ai) || '<span class="italic">empty</span>'}</span>
                    </label>
                    <input id="rv-addr-${f.key}" value="${escapeHtml(value || '')}" class="w-full px-2.5 py-1.5 bg-surface-100 rounded-lg text-xs border-0">
                  </div>`;
                }).join('')}
              </div>
              ${recon && recon.ai_reasoning ? `<div class="mt-2 text-[11px] text-gray-500 bg-amber-50 rounded-lg px-3 py-2"><span class="font-semibold">AI rationale:</span> ${escapeHtml(recon.ai_reasoning)}</div>` : ''}
              ${recon && recon.decision === 'auto_merged_high' ? `<div class="mt-1 text-[10px] text-green-600">AI suggestion already validated by Google geocoder — safe to accept.</div>` : ''}
            `;
          })()}
        </div>

        ${lockerSnap ? `
        <div>
          <h4 class="font-semibold text-sm mb-2">Selected locker</h4>
          <div class="bg-surface-100 rounded-xl p-3 text-xs">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div class="font-semibold">${escapeHtml(lockerSnap.nearest_locker_name || lockerSnap.terminal_id || '-')}</div>
                <div class="text-gray-500">${lockerSnap.terminal_id ? escapeHtml(lockerSnap.terminal_id) : ''}${lockerSnap.distance_km ? ' &middot; ' + escapeHtml(String(lockerSnap.distance_km)) + ' km' : ''}</div>
              </div>
              <div class="text-[10px] text-gray-400">${lockerSnap.locker_type || ''}</div>
            </div>
          </div>
        </div>` : ''}

        <div>
          <div class="flex items-center justify-between mb-2"><h4 class="font-semibold text-sm">Line items</h4><button onclick="addReviewItem()" class="px-3 py-1 bg-surface-100 hover:bg-brand-100 rounded-full text-xs font-semibold">+ Add item</button></div>
          <div id="rv-items">${itemsHtml}</div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-xs text-gray-400">Reviewer notes (optional)</label>
            ${(() => {
              const recent = _loadRecentReviewNotes();
              if (!recent.length) return '';
              const chips = recent.map((r) => {
                const safeText = escapeHtml(r.text);
                const escAttr = r.text.replace(/'/g, "\\'");
                return `<button type="button" onclick="applyReviewNote('${escAttr}')" class="px-2.5 py-0.5 bg-surface-100 hover:bg-brand-100 text-gray-700 text-[11px] rounded-full whitespace-nowrap" title="${safeText}">${safeText.length > 28 ? safeText.slice(0, 28) + '…' : safeText}</button>`;
              }).join('');
              return `<div class="flex flex-wrap gap-1 max-w-[70%] justify-end">${chips}</div>`;
            })()}
          </div>
          <textarea id="rv-notes" rows="2" placeholder="Why are you overriding? Saved for audit." class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></textarea>
        </div>

        <div class="flex items-start gap-2 px-1">
          <input type="checkbox" id="rv-notify" class="mt-1">
          <label for="rv-notify" class="text-xs text-gray-600 leading-relaxed cursor-pointer select-none">
            <span class="font-semibold">Notify customer via WhatsApp</span>
            <span class="block text-gray-400">Sends a brief confirmation message about the changes you made (address, phone, or method) before the parcel ships. Uses the <code class="bg-surface-100 px-1 rounded">order_details_updated</code> template.</span>
          </label>
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

/**
 * Radio handler for the address comparison grid.
 * When the operator picks Entered / Geocoded / AI for a row, mirror that
 * column's value into the right-hand input so save uses it.
 */
function onAddressPickChange(field, source) {
  const row = document.querySelector(`[data-rv-addr-row="${field}"]`);
  if (!row) return;
  const radios = row.querySelectorAll(`input[type="radio"]`);
  const labels = row.querySelectorAll('label');
  // Refresh selected-style highlighting on all three labels.
  labels.forEach((lbl) => {
    const r = lbl.querySelector('input[type="radio"]');
    lbl.classList.toggle('bg-gray-50', r && r.value !== 'ai' && r.checked);
    lbl.classList.toggle('bg-amber-50', r && r.value === 'ai' && r.checked);
  });
  // Find the picked column's text and copy it into the editable input.
  const picked = Array.from(radios).find((r) => r.checked);
  if (!picked) return;
  const span = picked.parentElement.querySelector('span');
  const text = (span?.textContent || '').trim();
  // Strip the placeholder "empty" italic text — that's not a real value.
  const value = text === 'empty' ? '' : text;
  const input = document.getElementById('rv-addr-' + field);
  if (input) input.value = value;
}

async function submitReview(evaluationId) {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const overrides = {};
  if (v('rv-name')) overrides.customer_name = v('rv-name');
  if (v('rv-phone')) overrides.customer_phone = v('rv-phone');
  if (v('rv-method')) overrides.delivery_method = v('rv-method');

  const addr = {};
  // The new modal uses the structured field keys directly so no
  // mapping is needed here. Each input mirrors whichever radio
  // (entered / geocoded / AI) was selected; the operator can also
  // type freely over the choice.
  ['street_address','suburb','city','zone','code','country'].forEach(k => {
    const val = v('rv-addr-' + k);
    if (!val) return;
    addr[k] = val;
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
  const notifyCustomer = !!document.getElementById('rv-notify')?.checked;

  const body = { resolution: 'approved' };
  if (Object.keys(overrides).length) body.overrides = overrides;
  if (notes) body.notes = notes;
  if (notifyCustomer) body.notify_customer = true;

  const { data } = await api('POST', `/caretaker/evaluations/${evaluationId}/resolve`, body);
  if (data?.success) {
    // Stash the note so it shows up as a quick-pick chip next time.
    if (notes) _saveRecentReviewNote(notes);
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
  // Fire all four list endpoints in parallel. The Meta list is the
  // authoritative one — we fall back to local templates when the
  // Business Settings haven't been configured yet.
  const [
    { data: settingsRes },
    { data: bizRes },
    { data: tplRes },
    { data: eventsRes },
    { data: msgRes },
  ] = await Promise.all([
    api('GET', '/whatsapp/settings'),
    api('GET', '/whatsapp/business-settings'),
    api('GET', '/whatsapp/templates'),
    api('GET', '/whatsapp/event-types'),
    api('GET', '/whatsapp/messages?limit=30&exclude_purposes=chatbot_reply,chatbot_inbound'),
  ]);
  const settings = settingsRes && settingsRes.success ? settingsRes.data : { configured: false };
  const biz = bizRes && bizRes.success ? bizRes.data : { configured: false };
  const localTemplates = tplRes && tplRes.success ? tplRes.data : [];
  const eventTypes = eventsRes && eventsRes.success ? eventsRes.data : [];
  const messages = msgRes && msgRes.success ? msgRes.data : [];
  window._waEventTypes = eventTypes;

  // Meta list is gated on whatsapp.templates.manage AND on the tenant
  // having business credentials — pull only when both are met to avoid
  // a noisy NO_BUSINESS error on first paint.
  let metaRows = [];
  let metaLocalByName = {};
  let metaError = null;
  if (biz.configured) {
    const { data: metaRes } = await api('GET', '/whatsapp/templates/meta');
    if (metaRes && metaRes.success) {
      metaRows = metaRes.data.rows || [];
      metaLocalByName = metaRes.data.local_by_template_name || {};
    } else {
      metaError = metaRes?.error?.message || 'Failed to fetch from Meta';
    }
  }

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
  html += `<p class="text-xs text-gray-400 mb-4">Required to read and import templates from Meta. Uses a System User token with the <code class="bg-surface-100 px-1 rounded">whatsapp_business_management</code> scope.</p>`;
  if (biz.configured) html += `<div class="flex items-center gap-2 mb-4"><span class="w-2 h-2 rounded-full bg-green-400"></span><span class="text-sm text-green-600 font-medium">Connected</span><span class="text-xs text-gray-400 ml-2">${biz.business_account_id||''}</span></div>`;
  html += `<div class="space-y-3">`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">Business Account ID</label><input id="wa-biz-id" value="${biz.business_account_id||''}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `<div><label class="block text-xs text-gray-400 mb-1">System User Token</label><input id="wa-biz-token" type="password" placeholder="paste new token" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
  html += `</div><button onclick="saveWaBusiness()" class="mt-4 w-full py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Save</button></div>`;

  html += `</div>`; // grid

  // ============================================================
  // Meta-approved templates — primary section
  // ============================================================
  html += `<div class="bg-white rounded-3xl shadow-card p-6 mt-6">`;
  html += `<div class="flex items-center justify-between mb-4 flex-wrap gap-2">`;
  html += `<div><h3 class="font-bold text-base">Meta Templates</h3>`;
  html += `<p class="text-xs text-gray-400">The canonical list from your WhatsApp Business Account. Only APPROVED templates can deliver outside the 24h customer window.</p></div>`;
  html += `<div class="flex gap-2 items-center flex-wrap">`;
  // Status filter
  if (biz.configured && metaRows.length) {
    const statuses = [
      ['APPROVED', 'green'], ['PENDING', 'amber'], ['REJECTED', 'red'],
      ['PAUSED', 'gray'], ['DISABLED', 'gray'], ['DRAFT', 'gray'],
    ];
    const selected = window._waMetaFilter || 'APPROVED';
    html += `<select onchange="setWaMetaFilter(this.value)" class="text-xs px-3 py-1.5 bg-surface-100 rounded-xl border-0">`;
    html += `<option value="APPROVED"${selected==='APPROVED'?' selected':''}>Approved only</option>`;
    html += `<option value="ALL"${selected==='ALL'?' selected':''}>Show all statuses</option>`;
    statuses.slice(1).forEach(([s]) => { html += `<option value="${s}"${selected===s?' selected':''}>${s}</option>`; });
    html += `</select>`;
    html += `<button onclick="syncAllMetaTemplates()" class="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-semibold rounded-full text-xs">Import all approved</button>`;
    html += `<button onclick="renderWhatsApp()" class="text-[11px] text-gray-400 hover:text-gray-600">refresh</button>`;
  }
  html += `</div></div>`;

  if (!biz.configured) {
    html += `<div class="bg-amber-50 text-amber-700 rounded-xl p-4 text-sm">Configure the Business Account credentials above to load templates from Meta. Without it we can only show local drafts.</div>`;
  } else if (metaError) {
    html += `<div class="bg-red-50 text-red-600 rounded-xl p-4 text-sm">Could not fetch from Meta: ${escapeHtml(metaError)}</div>`;
  } else if (metaRows.length === 0) {
    html += emptyState('No templates on Meta yet', 'Once you submit a template (or someone on your team does in Meta Business Manager), it will appear here.');
  } else {
    const filter = window._waMetaFilter || 'APPROVED';
    const filtered = filter === 'ALL' ? metaRows : metaRows.filter((t) => t.status === filter);
    if (filtered.length === 0) {
      html += emptyState(`No ${filter} templates`, 'Try a different status filter.');
    } else {
      html += `<div class="space-y-2">`;
      filtered.forEach((t) => {
        const local = metaLocalByName[t.name];
        const linked = !!local;
        const bodyComp = (t.components || []).find((c) => c.type === 'BODY');
        const bodyPreview = (bodyComp?.text || '').slice(0, 200);
        const statusCls = t.status === 'APPROVED' ? 'completed'
          : t.status === 'REJECTED' ? 'failed'
          : t.status === 'PENDING' ? 'processing'
          : 'pending';
        html += `<div class="p-4 rounded-2xl border ${linked ? 'border-green-200 bg-green-50/40' : 'border-gray-100'}">`;
        html += `<div class="flex items-center justify-between mb-2 flex-wrap gap-2">`;
        html += `<div class="flex items-center gap-2 flex-wrap">`;
        html += `<span class="text-sm font-semibold">${escapeHtml(t.name)}</span>`;
        html += `<span class="text-[10px] text-gray-400 uppercase">${escapeHtml(t.language || 'en')}</span>`;
        html += `<span class="text-[10px] text-gray-500">${escapeHtml(t.category || 'UTILITY')}</span>`;
        html += badge(statusCls, t.status);
        if (linked) {
          html += `<span class="text-[10px] text-green-700 bg-green-100 px-2 py-0.5 rounded-full">Linked: ${escapeHtml(local.purpose)}${local.enabled === false ? ' (disabled)' : ''}</span>`;
        }
        html += `</div></div>`;
        if (bodyPreview) html += `<div class="text-xs text-gray-700 whitespace-pre-wrap bg-surface-100 rounded-lg p-2 max-h-24 overflow-y-auto">${escapeHtml(bodyPreview)}${bodyComp?.text?.length > 200 ? '...' : ''}</div>`;
        // Actions
        html += `<div class="flex gap-2 mt-2 flex-wrap">`;
        if (t.status === 'APPROVED') {
          if (linked) {
            html += `<button onclick="reimportMetaTemplate('${escapeHtml(t.name)}','${escapeHtml(t.language||'en')}','${escapeHtml(t.id)}','${escapeHtml(local.purpose)}','${escapeHtml(t.status)}','${escapeHtml(t.category||'UTILITY')}')" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs">Re-import</button>`;
          } else {
            html += `<button onclick="linkMetaTemplate('${escapeHtml(t.name)}','${escapeHtml(t.language||'en')}','${escapeHtml(t.id)}','${escapeHtml(t.status)}','${escapeHtml(t.category||'UTILITY')}')" class="px-3 py-1.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-xs">Link to purpose</button>`;
          }
          html += `<button onclick="testMetaTemplate('${escapeHtml(linked ? local.purpose : t.name)}')" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs">Test send</button>`;
        }
        html += `</div></div>`;
      });
      html += `</div>`;
    }
  }
  html += `</div>`; // close meta templates

  // ============================================================
  // Local drafts (collapsed) — power-user editor stays available
  // ============================================================
  const draftCount = localTemplates.filter((t) => !t.template_name).length;
  const localUnlinkedCount = localTemplates.filter((t) => !t.template_name).length;
  if (localUnlinkedCount > 0) {
    html += `<details class="bg-white rounded-3xl shadow-card p-6 mt-6"><summary class="cursor-pointer flex items-center justify-between">`;
    html += `<div><h3 class="font-bold text-base">Local drafts (${localUnlinkedCount})</h3>`;
    html += `<p class="text-xs text-gray-400">Templates created in RelayOS but not yet linked to a Meta-approved template. They can still send within the 24h customer window.</p></div>`;
    html += `<span class="text-xs text-gray-400">click to expand</span></summary>`;
    html += `<div class="mt-4 space-y-3">`;
    localTemplates.filter((t) => !t.template_name).forEach((t) => {
      html += `<div class="p-3 rounded-2xl border border-gray-100">`;
      html += `<div class="text-sm font-semibold mb-1">${escapeHtml(t.purpose)} <span class="text-[10px] text-gray-400">${t.enabled?'enabled':'disabled'}</span></div>`;
      html += `<div class="text-xs text-gray-700 whitespace-pre-wrap bg-surface-100 rounded-lg p-2 max-h-20 overflow-y-auto">${escapeHtml(t.body_text||'')}</div>`;
      html += `<div class="flex gap-2 mt-2"><button onclick="editWaTemplate('${t.purpose}')" class="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full text-xs font-semibold">Edit</button>`;
      html += `<button onclick="submitToMeta('${t.purpose}')" class="px-3 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-full text-xs font-semibold">Submit to Meta</button>`;
      html += `<button onclick="deleteWaTemplate('${t.purpose}')" class="px-3 py-1 bg-red-50 text-red-500 hover:bg-red-100 rounded-full text-xs font-semibold">Delete</button></div>`;
      html += `</div>`;
    });
    html += `<div class="mt-3"><button onclick="showCreateTemplateModal()" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs">Create draft</button></div>`;
    html += `</div></details>`;
  }

  // ============================================================
  // Test send card (only meaningful when there is at least one
  // template configured locally — Meta-linked or draft)
  // ============================================================
  if (localTemplates.length) {
    html += `<div class="bg-white rounded-3xl shadow-card p-6 mt-6"><h3 class="font-bold text-base mb-4">Send Test</h3>`;
    html += `<div class="grid grid-cols-1 md:grid-cols-3 gap-3">`;
    html += `<div><label class="block text-xs text-gray-400 mb-1">To (phone)</label><input id="wa-test-to" placeholder="+2783..." class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0"></div>`;
    html += `<div class="md:col-span-2"><label class="block text-xs text-gray-400 mb-1">Template</label><select id="wa-test-purpose" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">`;
    localTemplates.forEach((t) => {
      const tag = t.template_name ? ' (Meta-linked)' : ' (local draft)';
      html += `<option value="${t.purpose}">${t.purpose}${tag}</option>`;
    });
    html += `</select></div></div>`;
    html += `<button onclick="sendWaTest()" class="mt-4 w-full md:w-auto px-6 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Send Test</button></div>`;
  }

  // Messages log
  if (messages.length) {
    html += `<div class="bg-white rounded-3xl shadow-card p-6 mt-6"><h3 class="font-bold text-base mb-4">Recent Messages</h3><div class="space-y-2 max-h-[400px] overflow-y-auto">`;
    messages.forEach(m => {
      const time = new Date(m.created_at).toLocaleString();
      const dir = m.direction === 'outbound' ? 'text-blue-600' : 'text-green-600';
      html += `<div class="flex items-start gap-3 p-2 rounded-xl hover:bg-surface-100"><div class="flex-1"><div class="flex items-center gap-2"><span class="text-xs font-semibold ${dir}">${m.direction}</span><span class="text-[11px] text-gray-400">${time}</span>${badge(m.status)}</div>`;
      html += `<div class="text-xs text-gray-600 mt-1 truncate max-w-md">${escapeHtml(m.body||'')}</div>`;
      if (m.last_error) html += `<div class="text-[11px] text-red-500 mt-1 truncate max-w-md" title="${escapeHtml(m.last_error)}">Meta error: ${escapeHtml(m.last_error)}</div>`;
      html += `</div><span class="text-[11px] text-gray-400 whitespace-nowrap">${m.phone_to||m.phone_from||''}</span></div>`;
    });
    html += `</div></div>`;
  }

  document.getElementById('tab-content').innerHTML = html;
  window._waTemplates = localTemplates;
  window._waMetaRows = metaRows;
}

function setWaMetaFilter(value) {
  window._waMetaFilter = value;
  renderWhatsApp();
}

// ---- Meta template actions -----------------------------------------

function linkMetaTemplate(name, language, metaId, status, category) {
  // Prompt the operator to choose a local purpose. We show the well-known
  // purposes plus a "custom" entry so they can map e.g. a marketing
  // template to a custom event.
  const purposes = [
    'order_confirmed', 'order_in_transit', 'order_at_locker',
    'order_out_for_delivery', 'order_delivered', 'order_flagged',
    'order_details_updated',
  ];
  const guess = purposes.includes(name) ? name : '';
  openModal('Link Meta template',
    `<p class="text-xs text-gray-400 mb-3">Link <code class="bg-surface-100 px-1 rounded">${escapeHtml(name)}</code> to a local purpose so RelayOS can dispatch it on the matching domain event.</p>` +
    `<label class="block text-xs text-gray-400 mb-1">Purpose</label>` +
    `<select id="link-purpose" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 mb-2">` +
      purposes.map((p) => `<option value="${p}"${p===guess?' selected':''}>${p}</option>`).join('') +
      `<option value="__custom__">Custom...</option>` +
    `</select>` +
    `<input id="link-custom" placeholder="custom purpose" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 hidden">`,
    `<button onclick="closeModal({target:document.querySelector('.modal-backdrop')})" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-sm">Cancel</button>` +
    `<button onclick="confirmLinkMeta('${name}','${language}','${metaId}','${status}','${category}')" class="px-4 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm">Link</button>`,
  );
  document.getElementById('link-purpose').addEventListener('change', (e) => {
    const c = document.getElementById('link-custom');
    if (c) c.classList.toggle('hidden', e.target.value !== '__custom__');
  });
}

async function confirmLinkMeta(name, language, metaId, status, category) {
  let purpose = document.getElementById('link-purpose').value;
  if (purpose === '__custom__') {
    const custom = (document.getElementById('link-custom').value || '').trim();
    if (!custom) { toast('Enter a custom purpose', 'warning'); return; }
    purpose = custom;
  }
  const meta = (window._waMetaRows || []).find((r) => r.name === name && r.language === language);
  const bodyComp = meta && (meta.components || []).find((c) => c.type === 'BODY');
  const bodyText = bodyComp?.text || '';
  const placeholders = (bodyText.match(/\{\{(\d+)\}\}/g) || []).length;
  // Pick well-known variable names for known purposes; otherwise generic.
  // Slot order matches Meta's positional placeholders {{1}}, {{2}} ...
  // Choices map to mutilife's actual approved templates:
  //   order_confirmed   : greeting + order number
  //   order_in_transit  : greeting + waybill (used as the tracking number)
  //   order_at_locker   : greeting + collection PIN
  // Operators can edit afterwards if their template uses a different shape.
  const VAR_MAP = {
    order_confirmed: ['customer_name', 'order_number', 'waybill'],
    order_in_transit: ['customer_name', 'waybill', 'order_number'],
    order_at_locker: ['customer_name', 'pincode', 'order_number'],
    order_out_for_delivery: ['customer_name', 'order_number'],
    order_delivered: ['customer_name', 'order_number'],
    order_flagged: ['customer_name', 'order_number'],
    order_details_updated: ['customer_name', 'change_summary', 'order_number'],
  };
  const variables = (VAR_MAP[purpose] || ['var_1', 'var_2', 'var_3', 'var_4']).slice(0, placeholders);

  const { data } = await api('POST', '/whatsapp/templates/meta/import', {
    meta_template_id: metaId,
    meta_template_name: name,
    language_code: language,
    purpose,
    body_text: bodyText,
    variables,
    meta_status: status,
    meta_category: category,
  });
  if (data?.success) {
    toast('Linked — RelayOS will use this template on the next dispatch', 'success');
    closeModal({ target: document.querySelector('.modal-backdrop') });
    setTimeout(renderWhatsApp, 500);
  } else {
    toast(data?.error?.message || 'Link failed', 'error');
  }
}

async function reimportMetaTemplate(name, language, metaId, purpose, status, category) {
  if (!confirm(`Re-import "${name}" (${language}) into purpose "${purpose}"? This refreshes body, variables and language from Meta.`)) return;
  const meta = (window._waMetaRows || []).find((r) => r.name === name && r.language === language);
  const bodyComp = meta && (meta.components || []).find((c) => c.type === 'BODY');
  const bodyText = bodyComp?.text || '';
  const placeholders = (bodyText.match(/\{\{(\d+)\}\}/g) || []).length;
  const VAR_MAP = {
    order_confirmed: ['customer_name', 'order_number', 'waybill'],
    order_in_transit: ['customer_name', 'waybill', 'order_number'],
    order_at_locker: ['customer_name', 'pincode', 'order_number'],
    order_out_for_delivery: ['customer_name', 'order_number'],
    order_delivered: ['customer_name', 'order_number'],
    order_flagged: ['customer_name', 'order_number'],
    order_details_updated: ['customer_name', 'change_summary', 'order_number'],
  };
  const variables = (VAR_MAP[purpose] || ['var_1', 'var_2', 'var_3', 'var_4']).slice(0, placeholders);
  const { data } = await api('POST', '/whatsapp/templates/meta/import', {
    meta_template_id: metaId,
    meta_template_name: name,
    language_code: language,
    purpose,
    body_text: bodyText,
    variables,
    meta_status: status,
    meta_category: category,
  });
  if (data?.success) { toast('Re-imported from Meta', 'success'); setTimeout(renderWhatsApp, 500); }
  else toast(data?.error?.message || 'Re-import failed', 'error');
}

async function syncAllMetaTemplates() {
  if (!confirm('Import every APPROVED Meta template whose name matches a known purpose (order_confirmed, order_in_transit, etc)? Existing local rows for those purposes will be updated in place.')) return;
  const { data } = await api('POST', '/whatsapp/templates/meta/import-all', {});
  if (!data?.success) { toast(data?.error?.message || 'Import failed', 'error'); return; }
  const imported = data.data.imported || [];
  const skipped = data.data.skipped || [];
  toast(`Imported ${imported.length}${imported.length ? ': ' + imported.join(', ') : ''}${skipped.length ? ` · skipped ${skipped.length}` : ''}`, 'success', 6000);
  setTimeout(renderWhatsApp, 500);
}

async function testMetaTemplate(purposeOrName) {
  const to = prompt(`Send a test "${purposeOrName}" message to which phone number? (international format, e.g. +2783...)`);
  if (!to) return;
  const { data } = await api('POST', '/whatsapp/test', { to: to.trim(), purpose: purposeOrName });
  if (data?.success) {
    if (data.data?.sent) toast('Test sent', 'success');
    else toast(`Test not sent: ${data.data?.skipped_reason || data.data?.error || 'unknown'}`, 'warning', 6000);
  } else {
    toast(data?.error?.message || 'Test failed', 'error');
  }
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
    action = `<div class="mt-4 py-3 bg-green-50 text-green-700 font-semibold rounded-2xl text-sm text-center">Handed to courier${droppedAt ? ' - ' + droppedAt : ''}</div>`;
    if (o.assigned_packer_id) {
      action += `<button onclick="openRatePackerModal('${o.assigned_packer_id}', '${o.id}', '${escapeHtml(o.order_number || '')}')" class="w-full mt-2 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-xl text-xs transition-all">Rate packer</button>`;
    }
    action += `<button onclick="revertPacking('${o.id}')" class="w-full mt-2 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 font-medium rounded-xl text-xs transition-all">Revert</button>`;
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

// ---- Rate packer modal (per-order) ----
//
// Triggered from a Packing card once the order is dropped_off. Opens
// the standard openModal helper with four 1..5 sliders + a comment
// field, and POSTs /packers/ratings on submit. The endpoint upserts
// on (tenant, packer, order), so re-rating just bumps the score.

const PACKER_RATING_CRITERIA = [
  { key: 'packing_quality', label: 'Packing quality', hint: 'Items secure, presentable, correct.' },
  { key: 'speed',           label: 'Speed',           hint: 'Turnaround from assignment to drop-off.' },
  { key: 'communication',   label: 'Communication',   hint: 'Responsive to questions or issues.' },
  { key: 'reliability',     label: 'Reliability',     hint: 'Accepts assignments, on-time, follows through.' },
];

function openRatePackerModal(packerId, orderId, orderNumber) {
  const sliders = PACKER_RATING_CRITERIA.map((c) => `
    <div>
      <div class="flex items-baseline justify-between">
        <label class="text-sm font-semibold">${escapeHtml(c.label)}</label>
        <span class="text-sm font-bold" id="rp-val-${c.key}">4</span>
      </div>
      <input type="range" min="1" max="5" step="1" value="4" id="rp-${c.key}" class="w-full accent-brand-500"
        oninput="document.getElementById('rp-val-${c.key}').textContent = this.value">
      <div class="text-[11px] text-gray-400 mt-0.5">${escapeHtml(c.hint)}</div>
    </div>
  `).join('');

  const body = `
    <div class="space-y-4">
      <div class="text-sm text-gray-500">Rating order <span class="font-mono">${escapeHtml(orderNumber || '')}</span>. Re-rating overwrites the previous score.</div>
      ${sliders}
      <div>
        <label class="block text-xs text-gray-500 uppercase tracking-wide mb-1 font-semibold">Comment <span class="text-gray-400 normal-case font-normal">(optional, only you and admins see this)</span></label>
        <textarea id="rp-comment" rows="3" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0" placeholder="What stood out, good or bad?"></textarea>
      </div>
    </div>
  `;
  const footer = `
    <button onclick="closeModal()" class="px-5 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-sm">Cancel</button>
    <button onclick="submitRatePacker('${packerId}','${orderId}')" class="px-5 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm">Save rating</button>
  `;
  openModal('Rate packer', body, footer);
}

async function submitRatePacker(packerId, orderId) {
  const score = (key) => parseInt(document.getElementById('rp-' + key).value, 10);
  const body = {
    packer_id: packerId,
    order_id: orderId,
    packing_quality: score('packing_quality'),
    speed: score('speed'),
    communication: score('communication'),
    reliability: score('reliability'),
    comment: (document.getElementById('rp-comment').value || '').trim() || null,
  };
  const { data } = await api('POST', '/packers/ratings', body);
  if (data.success) {
    closeModal();
    toast('Rating saved', 'success');
    // Refresh the Packing tab so any aggregate UI we add later picks up the change.
    if (currentTab === 'packing') renderPacking();
  } else {
    toast(data.error?.message || 'Failed to save rating', 'error');
  }
}

// ---- Packers tab filters + ratings drawer ----
//
// `_packersSearch` and `_packersMinRating` live on `window` so they
// survive a re-render (e.g. after a row action like Pause). Reset
// via the "Reset" button in the table header.

function doPackersSearch() {
  const v = (document.getElementById('packers-search')?.value || '').trim();
  window._packersSearch = v;
  renderPackers();
}
function setPackersMinRating(threshold) {
  window._packersMinRating = threshold;
  renderPackers();
}
function resetPackersFilters() {
  window._packersSearch = '';
  window._packersMinRating = 0;
  renderPackers();
}

// ---- View packer ratings (drawer) ----
//
// Operator clicks "Ratings" on a linked-packer row → fetch
// /packers/:id/ratings and render aggregate + this tenant's own
// per-order rating list (including comments).

async function viewPackerRatings(packerId, packerLabel) {
  openModal(
    'Ratings — ' + packerLabel,
    '<div id="ratings-drawer-content" class="text-sm text-gray-400">Loading ratings…</div>',
    '<button onclick="closeModal()" class="px-5 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-sm">Close</button>',
  );
  const { data } = await api('GET', `/packers/${encodeURIComponent(packerId)}/ratings`);
  const root = document.getElementById('ratings-drawer-content');
  if (!root) return; // user closed the modal before the request returned
  if (!data || !data.success) {
    root.innerHTML = '<div class="text-sm text-red-500">' + escapeHtml(data?.error?.message || 'Failed to load ratings') + '</div>';
    return;
  }
  const agg = data.data.aggregate || { count: 0 };
  const mine = data.data.mine || [];

  let html = '';

  // Cross-tenant aggregate strip
  if (agg.count > 0) {
    const overall = agg.overall != null ? agg.overall.toFixed(2) : '—';
    html += `<div class="bg-surface-100 rounded-2xl p-4 mb-5">`;
    html += `<div class="flex items-baseline justify-between mb-2"><div class="font-semibold text-sm">Cross-tenant aggregate</div><div class="text-xs text-gray-400">${agg.count} rating${agg.count === 1 ? '' : 's'}</div></div>`;
    html += `<div class="text-2xl font-bold mb-3">★ ${overall} <span class="text-sm text-gray-500 font-normal">/ 5</span></div>`;
    const rows = [
      ['Packing quality', agg.packing_quality],
      ['Speed', agg.speed],
      ['Communication', agg.communication],
      ['Reliability', agg.reliability],
    ];
    html += `<div class="grid grid-cols-2 gap-2">`;
    rows.forEach(([label, v]) => {
      const pct = v != null ? Math.max(0, Math.min(100, (v / 5) * 100)) : 0;
      const display = v != null ? v.toFixed(2) : '—';
      html += `<div>`;
      html += `<div class="flex items-baseline justify-between"><div class="text-xs text-gray-500">${escapeHtml(label)}</div><div class="text-xs font-semibold">${display}</div></div>`;
      html += `<div class="h-1.5 bg-white rounded-full overflow-hidden mt-1"><div class="h-full bg-brand-400" style="width:${pct}%"></div></div>`;
      html += `</div>`;
    });
    html += `</div>`;
    html += `</div>`;
  } else {
    html += `<div class="text-sm text-gray-500 mb-5">No ratings yet from any tenant.</div>`;
  }

  // This tenant's own rating rows
  html += `<div class="font-semibold text-sm mb-2">Your ratings (${mine.length})</div>`;
  if (mine.length === 0) {
    html += `<div class="text-sm text-gray-400">You haven't rated this packer yet. Use the "Rate packer" button on a dropped-off order.</div>`;
  } else {
    html += `<div class="space-y-2">`;
    mine.forEach((r) => {
      const created = r.updated_at ? new Date(r.updated_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      const overall = ((r.packing_quality + r.speed + r.communication + r.reliability) / 4).toFixed(2);
      html += `<div class="border border-gray-100 rounded-xl p-3">`;
      html += `<div class="flex items-baseline justify-between mb-1">`;
      html += `<div class="text-xs text-gray-500">Order <span class="font-mono">#${escapeHtml(r.order_number || r.order_id || '?')}</span></div>`;
      html += `<div class="text-sm font-semibold">★ ${overall}</div>`;
      html += `</div>`;
      html += `<div class="grid grid-cols-2 sm:grid-cols-4 gap-1 text-[11px] text-gray-500 mb-1">`;
      html += `<div>Pack: <span class="font-semibold text-gray-800">${r.packing_quality}</span></div>`;
      html += `<div>Speed: <span class="font-semibold text-gray-800">${r.speed}</span></div>`;
      html += `<div>Comms: <span class="font-semibold text-gray-800">${r.communication}</span></div>`;
      html += `<div>Reliable: <span class="font-semibold text-gray-800">${r.reliability}</span></div>`;
      html += `</div>`;
      if (r.comment) {
        html += `<div class="text-xs text-gray-600 mt-1 italic">"${escapeHtml(r.comment)}"</div>`;
      }
      html += `<div class="text-[11px] text-gray-400 mt-1">${created}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  root.innerHTML = html;
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

/**
 * Classify a manual_upload_reason string into a stable origin key + a
 * UI-friendly label / tone. Lets the queue tell the operator *why* an
 * order landed here at a glance, instead of forcing them to read every
 * reason string.
 *
 * Detection is substring-based on lowercased text — these reasons are
 * authored by the pipeline (see src/pipeline/index.ts divertToManualQueue
 * and the legacy collection-method branch) so the keywords are stable.
 */
function _classifyManualReason(reason) {
  const r = (reason || '').toLowerCase();
  if (r.includes('no eligible pudo locker') || r.includes('no eligible locker') || r.includes('no locker within')) {
    return { key: 'no_locker', label: 'No locker', tone: 'red', hint: 'No PUDO locker in range — ship via kiosk, alt courier, or contact customer' };
  }
  if (r.includes('collection order') || r.includes('customer picks up')) {
    return { key: 'collection', label: 'Collection', tone: 'indigo', hint: 'Customer collecting — wait for pickup, then mark complete' };
  }
  if (r.includes('caretaker')) {
    return { key: 'caretaker', label: 'Caretaker', tone: 'amber', hint: 'Pipeline flagged this; review the reason and decide' };
  }
  if (r.includes('manual')) {
    return { key: 'manual', label: 'Manual', tone: 'gray', hint: 'Manually uploaded order — process and provide waybill' };
  }
  return { key: 'other', label: 'Other', tone: 'gray', hint: '' };
}

const MANUAL_TONE_CLASSES = {
  red:    { bg: 'bg-red-50',    text: 'text-red-600',    ring: 'border-red-200',    pill: 'bg-red-100 text-red-700' },
  amber:  { bg: 'bg-amber-50',  text: 'text-amber-700',  ring: 'border-amber-200',  pill: 'bg-amber-100 text-amber-800' },
  indigo: { bg: 'bg-indigo-50', text: 'text-indigo-700', ring: 'border-indigo-200', pill: 'bg-indigo-100 text-indigo-700' },
  gray:   { bg: 'bg-gray-50',   text: 'text-gray-700',   ring: 'border-gray-200',   pill: 'bg-gray-100 text-gray-700' },
};

async function renderManualUpload() {
  const status = window._manualFilter || 'pending';
  const originFilter = window._manualOriginFilter || 'all';
  const { data } = await api('GET', `/manual/upload-queue?status=${status}`);
  if (!data.success) { document.getElementById('tab-content').innerHTML = emptyState('Failed to load',''); return; }
  const allOrders = data.data.orders;
  const counts = data.data.counts;

  // Classify once so we can compute origin counts and reuse below.
  const classified = allOrders.map((o) => ({ o, origin: _classifyManualReason(o.manual_upload_reason) }));
  const originCounts = classified.reduce((acc, x) => { acc[x.origin.key] = (acc[x.origin.key] || 0) + 1; return acc; }, {});

  // Apply the origin filter for display.
  const orders = originFilter === 'all'
    ? classified
    : classified.filter((x) => x.origin.key === originFilter);

  let html = '';
  // Status filter chips
  html += `<div class="flex items-center gap-2 mb-3">`;
  html += `<button onclick="window._manualFilter='pending';renderManualUpload()" class="px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${status==='pending'?'bg-brand-400 text-gray-900':'bg-white text-gray-500 border border-gray-200'}">Pending (${counts.pending})</button>`;
  html += `<button onclick="window._manualFilter='completed';renderManualUpload()" class="px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${status==='completed'?'bg-brand-400 text-gray-900':'bg-white text-gray-500 border border-gray-200'}">Completed (${counts.completed})</button>`;
  html += `</div>`;

  // Origin filter chips — one chip per origin that has at least one order
  // in the current status view. "All" is always shown so the user can clear
  // the filter without typing.
  const originOrder = ['no_locker', 'caretaker', 'collection', 'manual', 'other'];
  const visibleOrigins = originOrder.filter((k) => originCounts[k]);
  if (visibleOrigins.length > 0) {
    html += `<div class="flex items-center gap-2 mb-6 flex-wrap">`;
    html += `<span class="text-xs text-gray-400 font-semibold uppercase tracking-wide mr-1">Origin:</span>`;
    html += `<button onclick="window._manualOriginFilter='all';renderManualUpload()" class="px-3 py-1 rounded-full text-[11px] font-semibold transition-all ${originFilter==='all'?'bg-gray-900 text-white':'bg-white text-gray-500 border border-gray-200'}">All (${classified.length})</button>`;
    for (const key of visibleOrigins) {
      const sample = classified.find((x) => x.origin.key === key).origin;
      const cls = MANUAL_TONE_CLASSES[sample.tone] || MANUAL_TONE_CLASSES.gray;
      const isActive = originFilter === key;
      html += `<button onclick="window._manualOriginFilter='${key}';renderManualUpload()" class="px-3 py-1 rounded-full text-[11px] font-semibold transition-all ${isActive ? cls.pill : 'bg-white text-gray-500 border border-gray-200'}">${escapeHtml(sample.label)} (${originCounts[key]})</button>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="mb-6"></div>`;
  }

  if (orders.length === 0) {
    html += `<div class="bg-white rounded-3xl shadow-card p-6">${emptyState('No orders in manual queue', status === 'pending' ? 'Orders that need manual courier upload will appear here.' : 'No completed manual uploads yet.')}</div>`;
  } else {
    html += `<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">`;
    orders.forEach(({ o, origin }) => {
      const tone = MANUAL_TONE_CLASSES[origin.tone] || MANUAL_TONE_CLASSES.gray;
      let address = '';
      try { const a = typeof o.delivery_address === 'string' ? JSON.parse(o.delivery_address) : (o.delivery_address||{}); address = a.entered_address || ''; } catch {}
      let lineItems = [];
      try { lineItems = typeof o.line_items === 'string' ? JSON.parse(o.line_items) : (o.line_items||[]); } catch {}
      const time = new Date(o.created_at).toLocaleString('en-ZA', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });

      // The card's left border colour tracks the origin so the queue is scannable.
      html += `<div class="bg-white rounded-3xl shadow-card border-l-4 ${tone.ring.replace('border-', 'border-l-')} border-y border-r border-gray-100 p-6">`;
      html += `<div class="flex items-start justify-between mb-3 gap-2"><div class="min-w-0"><div class="text-xl font-bold truncate">Order #${o.order_number||'-'}</div><div class="text-xs text-gray-400">${time}</div></div>`;
      html += `<div class="flex flex-col items-end gap-1 flex-shrink-0">`;
      html += `<span class="px-3 py-1 rounded-full text-[10px] font-bold ${o.waybill ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-800'}">${o.waybill ? 'UPLOADED' : 'NEEDS UPLOAD'}</span>`;
      html += `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-semibold ${tone.pill}">${escapeHtml(origin.label)}</span>`;
      html += `</div></div>`;
      html += `<div class="font-bold">${escapeHtml(o.customer_name||'')}</div>`;
      html += `<div class="text-sm text-gray-500">${escapeHtml(o.customer_phone||'')}</div>`;
      if (address) html += `<div class="text-sm text-gray-600 mt-2">${escapeHtml(address)}</div>`;
      if (lineItems.length) { html += `<div class="mt-2 text-sm"><strong>Items:</strong> ${lineItems.map(li=>escapeHtml(li.name)+' x '+li.quantity).join(', ')}</div>`; }

      // Origin reason + hint, color-keyed to the origin so the queue is
      // distinguishable at a glance.
      if (o.manual_upload_reason || origin.hint) {
        html += `<div class="${tone.bg} ${tone.text} rounded-xl px-3 py-2 mt-3 text-[11px] leading-relaxed">`;
        if (o.manual_upload_reason) html += `<div>${escapeHtml(o.manual_upload_reason)}</div>`;
        if (origin.hint) html += `<div class="opacity-80 mt-0.5">${escapeHtml(origin.hint)}</div>`;
        html += `</div>`;
      }

      if (o.waybill) {
        html += `<div class="mt-3 p-3 bg-green-50 rounded-xl text-sm"><strong>Waybill:</strong> ${escapeHtml(o.waybill)} <strong>PIN:</strong> ${escapeHtml(o.pincode||'-')}</div>`;
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


// ============================================================
// Independent Packers tab
// ------------------------------------------------------------
// Tenant-side management of relationships with independent packers.
// Backed by /packers/links + /packers/invites (see src/api/packersRoutes.ts).
//
// Permissions:
//   packers.view    — see this tab + the table
//   packers.invite  — Invite + Revoke pending invites
//   packers.manage  — pause/resume, set load_weight, unlink
// ============================================================

async function renderPackers() {
  const { data } = await api('GET', '/packers/links');
  if (!data || !data.success) {
    document.getElementById('tab-content').innerHTML = emptyState('Failed to load packers', data?.error?.message || '');
    return;
  }
  const links = data.data.links || [];
  const invites = data.data.invites || [];
  const settings = data.data.settings || { packer_assignment_mode: 'off' };
  const pendingInvites = invites.filter(i => i.status === 'pending');
  const recentInvites = invites.filter(i => i.status !== 'pending').slice(0, 8);

  const canInvite = window.RelayPermissions
    ? window.RelayPermissions.hasPermission(currentUserPermissions, 'packers.invite')
    : true;
  const canManage = window.RelayPermissions
    ? window.RelayPermissions.hasPermission(currentUserPermissions, 'packers.manage')
    : true;

  // Apply persistent filters: search + min rating. Stored on
  // window so they survive a re-render after a row action.
  const search = (window._packersSearch || '').toLowerCase().trim();
  const minRating = parseFloat(window._packersMinRating || '0') || 0;
  const filteredLinks = links.filter((l) => {
    if (search) {
      const haystack = [l.packer_name, l.packer_email, l.packer_business_name, l.packer_phone]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (minRating > 0) {
      const r = l.rating;
      if (!r || r.count === 0 || r.overall === null || r.overall < minRating) return false;
    }
    return true;
  });

  const activeCount = links.filter(l => l.status === 'active').length;
  const pausedCount = links.filter(l => l.status === 'paused').length;

  let html = '';

  // Top bar
  html += `<div class="flex items-center justify-between mb-6">`;
  html += `<div>`;
  html += `<h3 class="text-lg font-bold">Independent Packers</h3>`;
  html += `<p class="text-sm text-gray-400 mt-0.5">${activeCount} active · ${pausedCount} paused · ${pendingInvites.length} pending invite${pendingInvites.length===1?'':'s'}</p>`;
  html += `</div>`;
  if (canInvite) {
    html += `<button onclick="showPackerInviteModal()" class="px-5 py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Invite Packer</button>`;
  }
  html += `</div>`;

  // Distribution mode selector
  const mode = settings.packer_assignment_mode || 'off';
  const modeLabels = {
    off: 'Off — never assign to independent packers',
    independents_only: 'Independents only — round-robin to linked packers',
    split_evenly: 'Split evenly with internal team',
    internal_first: 'Internal first, fall back to packers',
  };
  html += `<div class="bg-white rounded-3xl shadow-card p-5 mb-6">`;
  html += `<div class="flex items-center justify-between gap-4 flex-wrap">`;
  html += `<div class="min-w-0">`;
  html += `<div class="font-semibold text-sm">Order distribution</div>`;
  html += `<div class="text-xs text-gray-500 mt-0.5">When a new order is processed, decide whether the courier picks up from your address or from a linked independent packer.</div>`;
  html += `</div>`;
  if (canManage) {
    html += `<select id="packer-mode-select" onchange="savePackerMode()" class="bg-surface-100 rounded-xl px-3 py-2 text-sm border-0 min-w-[280px]">`;
    Object.entries(modeLabels).forEach(([k, label]) => {
      html += `<option value="${k}" ${k===mode?'selected':''}>${escapeHtml(label)}</option>`;
    });
    html += `</select>`;
  } else {
    html += `<div class="text-sm bg-surface-100 rounded-xl px-3 py-2">${escapeHtml(modeLabels[mode] || mode)}</div>`;
  }
  html += `</div>`;
  html += `</div>`;

  // Linked packers table
  html += `<div class="bg-white rounded-3xl shadow-card overflow-hidden mb-6">`;
  html += `<div class="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">`;
  html += `<div class="font-semibold text-sm">Linked packers</div>`;
  html += `<div class="flex items-center gap-2 flex-wrap">`;
  html += `<input id="packers-search" value="${escapeHtml(search)}" placeholder="Search by name, email, phone…" onkeydown="if(event.key==='Enter')doPackersSearch()" class="px-3 py-1.5 bg-surface-100 rounded-full text-xs border-0 placeholder-gray-400 focus:ring-2 focus:ring-brand-200 w-48">`;
  // Min-rating chips. 0 means no floor (default).
  const ratingChoices = [0, 3, 4, 4.5];
  ratingChoices.forEach((r) => {
    const active = Math.abs((minRating || 0) - r) < 0.01;
    const label = r === 0 ? 'Any' : `★ ${r}+`;
    html += `<button onclick="setPackersMinRating(${r})" class="px-3 py-1 rounded-full text-[11px] font-semibold transition-all ${active ? 'bg-gray-900 text-white' : 'bg-surface-100 text-gray-500 border border-gray-200'}">${label}</button>`;
  });
  if (search || minRating > 0) {
    html += `<button onclick="resetPackersFilters()" class="text-[11px] text-gray-500 underline hover:text-gray-800">Reset</button>`;
  }
  html += `</div>`;
  html += `</div>`;
  if (filteredLinks.length === 0) {
    if (links.length === 0) {
      html += emptyState('No linked packers yet', canInvite ? 'Click "Invite Packer" to send your first invite.' : 'No active packer relationships for this tenant.');
    } else {
      html += emptyState('No packers match your filters', 'Try clearing search or lowering the rating threshold.');
    }
  } else {
    html += `<table class="w-full text-sm">`;
    html += `<thead><tr class="border-b border-gray-100">`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Packer</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Status</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Rating</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Load weight</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Collection</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Orders</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Linked</th>`;
    if (canManage) html += `<th class="px-5 py-3"></th>`;
    html += `</tr></thead><tbody>`;
    filteredLinks.forEach(l => {
      const initial = (l.packer_name || l.packer_email || '?')[0].toUpperCase();
      const display = l.packer_name || l.packer_email || '(unknown)';
      const business = l.packer_business_name ? `<div class="text-xs text-gray-400">${escapeHtml(l.packer_business_name)}</div>` : '';
      const phone = l.packer_phone ? `<div class="text-xs text-gray-400">${escapeHtml(l.packer_phone)}</div>` : '';
      const linkedAt = l.linked_at ? new Date(l.linked_at).toLocaleDateString('en-ZA', { day:'numeric', month:'short', year:'numeric' }) : '—';
      const lastAssigned = l.last_assigned_at ? new Date(l.last_assigned_at).toLocaleString('en-ZA', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : 'Never';

      // Collection profile cell
      let coll = '';
      if (l.collection_terminal_id) {
        coll = `<div class="text-xs">Locker <span class="font-mono">${escapeHtml(String(l.collection_terminal_id))}</span></div>`;
        if (l.collection_locker_name) coll += `<div class="text-xs text-gray-400">${escapeHtml(l.collection_locker_name)}</div>`;
      } else if (l.collection_door_address) {
        const a = l.collection_door_address || {};
        const parts = [a.street, a.suburb, a.city].filter(Boolean).join(', ');
        coll = `<div class="text-xs">Door</div>`;
        if (parts) coll += `<div class="text-xs text-gray-400">${escapeHtml(parts)}</div>`;
      } else {
        coll = `<span class="text-xs text-gray-400">—</span>`;
      }

      // Status pill
      let statusBadge = '';
      if (l.status === 'active') statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-50 text-green-700">Active</span>`;
      else if (l.status === 'paused') statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700">Paused</span>`;
      else if (l.status === 'kicked') statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-700">Unlinked</span>`;
      else statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-700">${escapeHtml(l.status||'')}</span>`;

      html += `<tr class="border-b border-gray-50 hover:bg-surface-100 transition-all">`;
      html += `<td class="px-5 py-3"><div class="flex items-center gap-3"><div class="w-9 h-9 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-sm">${initial}</div><div><div class="font-medium">${escapeHtml(display)}</div><div class="text-xs text-gray-400">${escapeHtml(l.packer_email||'')}</div>${business}${phone}</div></div></td>`;
      html += `<td class="px-5 py-3">${statusBadge}</td>`;
      // Rating cell — small star + numeric, shows "—" when nobody has rated yet.
      const r = l.rating;
      let ratingCell;
      if (r && r.count > 0 && r.overall != null) {
        ratingCell = `<div class="text-sm font-semibold">★ ${r.overall.toFixed(2)}</div><div class="text-xs text-gray-400">${r.count} rating${r.count===1?'':'s'}</div>`;
      } else {
        ratingCell = `<span class="text-xs text-gray-400">—</span>`;
      }
      html += `<td class="px-5 py-3">${ratingCell}</td>`;
      // Load weight + effective weight (rating-adjusted) so operators
      // can see the actual share the assigner is using. The formula
      // matches src/packerAuth/assigner.ts effectiveLoadWeight().
      const ratingForCalc = (r && r.count > 0 && r.overall != null) ? r.overall : 4.0;
      const nominal = Math.max(l.load_weight ?? 1, 0);
      const eff = nominal === 0 ? 0 : Math.max(nominal * ratingForCalc / 4.0, nominal * 0.25);
      const effDisplay = eff.toFixed(2);
      const showEff = nominal > 0 && Math.abs(eff - nominal) > 0.01;
      // Tooltip + quick-bump appear only when the rating is dragging
      // the effective weight noticeably below the nominal — that's
      // when the operator might want to compensate.
      const isUnderscored = showEff && eff < nominal;
      const tipText = `Effective weight = nominal × rating ÷ 4. ` +
        (r && r.count ? `Cross-tenant overall is ${(r.overall ?? 0).toFixed(2)}.` : `No ratings yet — treated as neutral 4.0.`);
      let weightCell = `<div class="flex items-center gap-1.5">` +
        `<span class="font-mono text-sm">${nominal}</span>`;
      if (isUnderscored) {
        weightCell += `<span class="text-[11px] text-gray-400" title="${escapeHtml(tipText)}">&#9432;</span>`;
        if (canManage && nominal < 10) {
          weightCell += `<button onclick="bumpPackerWeight('${l.id}', ${nominal + 1})" class="text-[10px] px-1.5 py-0.5 rounded-full bg-brand-50 text-brand-700 hover:bg-brand-100 font-semibold" title="Bump load weight to ${nominal + 1} to compensate">+1</button>`;
        }
      }
      weightCell += `</div>`;
      if (showEff) {
        const arrow = eff < nominal ? '\u25BC' : '\u25B2';
        const arrowCls = eff < nominal ? 'text-amber-600' : 'text-green-600';
        weightCell += `<div class="text-[11px] text-gray-400">eff. ${effDisplay} <span class="${arrowCls}">${arrow}</span></div>`;
      }
      html += `<td class="px-5 py-3">${weightCell}</td>`;
      html += `<td class="px-5 py-3">${coll}</td>`;
      html += `<td class="px-5 py-3"><div class="text-sm font-semibold">${l.orders_assigned_count ?? 0}</div><div class="text-xs text-gray-400">Last: ${lastAssigned}</div></td>`;
      html += `<td class="px-5 py-3 text-xs text-gray-500">${linkedAt}</td>`;
      if (canManage) {
        html += `<td class="px-5 py-3 text-right whitespace-nowrap">`;
        html += `<button onclick="viewPackerRatings('${l.packer_id}', '${escapeHtml(display)}')" class="px-3 py-1.5 bg-surface-100 hover:bg-surface-200 text-gray-700 font-semibold rounded-full text-xs transition-all">Ratings</button> `;
        if (l.status === 'active' || l.status === 'paused') {
          html += `<button onclick="editPackerLink('${l.id}', ${l.load_weight ?? 1}, '${escapeHtml(l.status||'')}', ${JSON.stringify(l.note||'').replace(/"/g,'&quot;')})" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-full text-xs transition-all">Edit</button> `;
          if (l.status === 'active') {
            html += `<button onclick="togglePackerLink('${l.id}', 'paused')" class="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 font-semibold rounded-full text-xs transition-all">Pause</button> `;
          } else {
            html += `<button onclick="togglePackerLink('${l.id}', 'active')" class="px-3 py-1.5 bg-green-50 hover:bg-green-100 text-green-700 font-semibold rounded-full text-xs transition-all">Resume</button> `;
          }
          html += `<button onclick="unlinkPacker('${l.id}', '${escapeHtml(display)}')" class="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-500 font-semibold rounded-full text-xs transition-all">Unlink</button>`;
        }
        html += `</td>`;
      }
      html += `</tr>`;
    });
    html += `</tbody></table>`;
  }
  html += `</div>`;

  // Pending invites
  html += `<div class="bg-white rounded-3xl shadow-card overflow-hidden mb-6">`;
  html += `<div class="px-5 py-3 border-b border-gray-100 font-semibold text-sm">Pending invites (${pendingInvites.length})</div>`;
  if (pendingInvites.length === 0) {
    html += `<div class="px-5 py-6 text-sm text-gray-400">No invites currently outstanding.</div>`;
  } else {
    html += `<table class="w-full text-sm">`;
    html += `<thead><tr class="border-b border-gray-100">`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Email</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Load weight</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Sent</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Expires</th>`;
    html += `<th class="px-5 py-3"></th>`;
    html += `</tr></thead><tbody>`;
    pendingInvites.forEach(inv => {
      const sent = inv.created_at ? new Date(inv.created_at).toLocaleDateString('en-ZA', { day:'numeric', month:'short' }) : '—';
      const exp = inv.expires_at ? new Date(inv.expires_at).toLocaleDateString('en-ZA', { day:'numeric', month:'short' }) : '—';
      html += `<tr class="border-b border-gray-50 hover:bg-surface-100 transition-all">`;
      html += `<td class="px-5 py-3 font-medium">${escapeHtml(inv.email)}</td>`;
      html += `<td class="px-5 py-3 font-mono">${inv.load_weight ?? 1}</td>`;
      html += `<td class="px-5 py-3 text-xs text-gray-500">${sent}</td>`;
      html += `<td class="px-5 py-3 text-xs text-gray-500">${exp}</td>`;
      html += `<td class="px-5 py-3 text-right whitespace-nowrap">`;
      if (canInvite) {
        html += `<button onclick="revokePackerInvite('${inv.id}', '${escapeHtml(inv.email)}')" class="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-500 font-semibold rounded-full text-xs transition-all">Revoke</button>`;
      }
      html += `</td></tr>`;
    });
    html += `</tbody></table>`;
  }
  html += `</div>`;

  // Recent invite history (collapsed)
  if (recentInvites.length > 0) {
    html += `<div class="bg-white rounded-3xl shadow-card overflow-hidden">`;
    html += `<div class="px-5 py-3 border-b border-gray-100 font-semibold text-sm">Recent invite history</div>`;
    html += `<table class="w-full text-sm">`;
    html += `<thead><tr class="border-b border-gray-100">`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Email</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Status</th>`;
    html += `<th class="text-left px-5 py-3 text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Sent</th>`;
    html += `</tr></thead><tbody>`;
    recentInvites.forEach(inv => {
      const sent = inv.created_at ? new Date(inv.created_at).toLocaleDateString('en-ZA', { day:'numeric', month:'short' }) : '—';
      let pill = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-700">${escapeHtml(inv.status)}</span>`;
      if (inv.status === 'accepted') pill = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-50 text-green-700">Accepted</span>`;
      else if (inv.status === 'declined') pill = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-700">Declined</span>`;
      else if (inv.status === 'revoked') pill = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-600">Revoked</span>`;
      else if (inv.status === 'expired') pill = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700">Expired</span>`;
      html += `<tr class="border-b border-gray-50">`;
      html += `<td class="px-5 py-3">${escapeHtml(inv.email)}</td>`;
      html += `<td class="px-5 py-3">${pill}</td>`;
      html += `<td class="px-5 py-3 text-xs text-gray-500">${sent}</td>`;
      html += `</tr>`;
    });
    html += `</tbody></table></div>`;
  }

  document.getElementById('tab-content').innerHTML = html;
}

function showPackerInviteModal() {
  const body = `
    <div class="space-y-4">
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Packer email</label>
        <input id="pinv-email" type="email" placeholder="packer@example.com" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400">
        <p class="text-xs text-gray-400 mt-1">They'll get a link to create their packer account and accept the invite.</p>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Load weight</label>
        <input id="pinv-weight" type="number" min="1" max="10" value="1" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400">
        <p class="text-xs text-gray-400 mt-1">1 = standard share, higher = bigger share of orders. Range 1–10.</p>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Note (optional)</label>
        <textarea id="pinv-note" rows="2" placeholder="e.g. handles fragile only" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400"></textarea>
      </div>
      <button onclick="submitPackerInvite()" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Send invite</button>
    </div>`;
  openModal('Invite independent packer', body);
}

async function submitPackerInvite() {
  const email = (document.getElementById('pinv-email').value || '').trim();
  const weight = parseInt(document.getElementById('pinv-weight').value || '1', 10) || 1;
  const note = (document.getElementById('pinv-note').value || '').trim();
  if (!email || !email.includes('@')) { toast('Valid email required', 'error'); return; }
  const { data } = await api('POST', '/packers/invites', { email, load_weight: weight, note: note || undefined });
  if (!data || !data.success) {
    toast(data?.error?.message || 'Failed to invite', 'error');
    return;
  }
  closeModal();
  // Show the accept URL so the operator can copy/paste it (no email service yet).
  const fullUrl = window.location.origin + (data.data.accept_url || '');
  const body = `
    <div class="space-y-3">
      <p class="text-sm text-gray-700">Invite created for <strong>${escapeHtml(email)}</strong>. Send this link to the packer:</p>
      <div class="bg-surface-100 rounded-xl p-3 font-mono text-xs break-all">${escapeHtml(fullUrl)}</div>
      <button onclick="copyPackerInviteLink('${escapeHtml(fullUrl)}'); closeModal();" class="w-full py-2.5 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">Copy link & close</button>
    </div>`;
  openModal('Invite link', body);
  renderPackers();
}

function copyPackerInviteLink(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link copied', 'success'), () => toast('Copy failed; select manually', 'info'));
  } else {
    toast('Copy not supported; select manually', 'info');
  }
}

async function revokePackerInvite(id, email) {
  if (!confirm('Revoke invite for ' + email + '?')) return;
  const { data } = await api('POST', `/packers/invites/${id}/revoke`);
  if (data && data.success) { toast('Invite revoked', 'info'); renderPackers(); }
  else toast(data?.error?.message || 'Failed', 'error');
}

async function togglePackerLink(id, newStatus) {
  const { data } = await api('PUT', `/packers/links/${id}`, { status: newStatus });
  if (data && data.success) {
    toast(newStatus === 'paused' ? 'Packer paused' : 'Packer resumed', 'success');
    renderPackers();
  } else {
    toast(data?.error?.message || 'Failed', 'error');
  }
}

function editPackerLink(id, currentWeight, currentStatus, currentNote) {
  const body = `
    <div class="space-y-4">
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Load weight</label>
        <input id="plink-weight" type="number" min="1" max="10" value="${currentWeight}" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400">
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Status</label>
        <select id="plink-status" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0">
          <option value="active" ${currentStatus==='active'?'selected':''}>Active</option>
          <option value="paused" ${currentStatus==='paused'?'selected':''}>Paused</option>
        </select>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Note</label>
        <textarea id="plink-note" rows="2" class="w-full px-3 py-2 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400">${escapeHtml(currentNote || '')}</textarea>
      </div>
      <button onclick="submitEditPackerLink('${id}')" class="w-full py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all">Save</button>
    </div>`;
  openModal('Edit packer link', body);
}

async function submitEditPackerLink(id) {
  const weight = parseInt(document.getElementById('plink-weight').value || '1', 10) || 1;
  const status = document.getElementById('plink-status').value;
  const note = (document.getElementById('plink-note').value || '').trim();
  const { data } = await api('PUT', `/packers/links/${id}`, { load_weight: weight, status, note });
  if (data && data.success) {
    closeModal();
    toast('Link updated', 'success');
    renderPackers();
  } else {
    toast(data?.error?.message || 'Failed', 'error');
  }
}

/**
 * One-click load-weight bump from the Packers table. Used to
 * compensate when a packer's effective weight is being dragged
 * below their nominal weight by a low cross-tenant rating, and the
 * tenant wants to keep them in the rotation regardless.
 */
async function bumpPackerWeight(linkId, newWeight) {
  const clamped = Math.max(1, Math.min(10, newWeight));
  const { data } = await api('PUT', `/packers/links/${linkId}`, { load_weight: clamped });
  if (data && data.success) {
    toast(`Load weight bumped to ${clamped}`, 'success');
    renderPackers();
  } else {
    toast(data?.error?.message || 'Failed to bump weight', 'error');
  }
}

async function unlinkPacker(id, displayName) {
  const reason = prompt('Unlink ' + displayName + '?\n\nOptional reason (max 30 chars):');
  if (reason === null) return;
  const { data } = await api('POST', `/packers/links/${id}/unlink`, { reason: (reason || '').slice(0, 30) });
  if (data && data.success) { toast('Packer unlinked', 'info'); renderPackers(); }
  else toast(data?.error?.message || 'Failed', 'error');
}


async function savePackerMode() {
  const sel = document.getElementById('packer-mode-select');
  if (!sel) return;
  const mode = sel.value;
  const { data } = await api('PUT', '/packers/settings', { packer_assignment_mode: mode });
  if (data && data.success) {
    toast('Distribution mode updated', 'success');
  } else {
    toast(data?.error?.message || 'Failed to update mode', 'error');
    // Re-render to revert the dropdown to the persisted value
    renderPackers();
  }
}
