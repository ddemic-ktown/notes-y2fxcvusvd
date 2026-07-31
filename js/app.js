// app.js — bootstraps auth, wires UI, and re-renders on Firestore cache updates.
import { Storage } from "./storage.js";
import {
  auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  signInWithEmailAndPassword, updatePassword,
} from "./firebase-init.js";
import { parseHoursNote, generateIIF, fuzzyMatchCustomer } from "./iif.js";
import { LocalFiles } from "./files.js";

// Version format: vYYYY.MM.DD-HHMM (Pacific time).
// On every change: add a new entry at the TOP of CHANGELOG (APP_VERSION follows automatically),
// delete entries beyond 10, and set sw.js VERSION to match.
// Commit message format: "vYYYY.MM.DD-HHMM: description" — version prefix always comes before the description.
const CHANGELOG = [
  ['v2026.07.30-1807', 'Delete moved from the bin icon into the ⋯ menu'],
  ['v2026.07.30-1802', 'Two new tutorials: the price table, and installing the app on your phone'],
  ['v2026.07.30-0211', 'Cancel always fits on small screens; the bin is hidden while it shows'],
  ['v2026.07.30-0200', 'Cancel button when adding a new customer or note discards it'],
  ['v2026.07.30-0158', 'Fixed: the note toolbar could scroll out of view right after the app loaded'],
  ['v2026.07.30-0154', 'Tapping an empty checkbox line lets you type instead of ticking it'],
  ['v2026.07.30-0150', 'Section controls hide until you tap Layout on the home screen'],
  ['v2026.07.30-0148', 'Customers and Price Table cards sit side by side on the home screen'],
  ['v2026.07.30-0147', 'Price Table: reorder, export, import and share moved into a ⋯ menu'],
  ['v2026.07.30-0138', 'Price Table: pinch to zoom, reorder rows and columns, CSV export and import'],
];
const APP_VERSION = CHANGELOG[0][0];

// Canonical site address — all emailed sign-in links point here.
const APP_URL = 'https://ddemic-ktown.github.io/notes-y2fxcvusvd/';

// ---------- DOM refs ----------
const listView = document.getElementById('list-view');
const customersView = document.getElementById('customers-view');
const customerNotesView = document.getElementById('customer-notes-view');
const settingsView = document.getElementById('settings-view');
const sectionView = document.getElementById('section-view');
const sectionViewList = document.getElementById('section-view-list');
const sectionViewControls = document.getElementById('section-view-controls');
const editorView = document.getElementById('editor-view');
const signinView = document.getElementById('signin-view');
const signinBtn = document.getElementById('signin-btn');
const signinError = document.getElementById('signin-error');
const signinMessage = document.getElementById('signin-message');
const signinEmailInput = document.getElementById('signin-email');
const signinPasswordInput = document.getElementById('signin-password');
const emailSigninBtn = document.getElementById('email-signin-btn');
const magicLinkBtn = document.getElementById('magic-link-btn');
const forgotPasswordBtn = document.getElementById('forgot-password-btn');
const setPasswordModal = document.getElementById('set-password-modal');
const setPasswordInput = document.getElementById('set-password-input');
const setPasswordConfirm = document.getElementById('set-password-confirm');
const setPasswordError = document.getElementById('set-password-error');
const setPasswordSave = document.getElementById('set-password-save');
const setPasswordSkip = document.getElementById('set-password-skip');
const signoutBtn = document.getElementById('signout-btn');
const accountEmailEl = document.getElementById('account-email');

const notesList = document.getElementById('notes-list');
const customersList = document.getElementById('customers-list');
const customerNotesList = document.getElementById('customer-notes-list');

const titleInput = document.getElementById('editor-title');
const bodyInput = document.getElementById('editor-body');

const fab = document.getElementById('fab');
const customersFab = document.getElementById('customers-fab');
const customerNotesFab = document.getElementById('customer-notes-fab');

const sortAlphaBtn = document.getElementById('sort-alpha');
const sortRecentBtn = document.getElementById('sort-recent');
const customerSearchInput = document.getElementById('customer-search');
const customerNotesSearchInput = document.getElementById('customer-notes-search');
const homeSearchInput = document.getElementById('home-search-input');
const settingsBtn = document.getElementById('settings-btn');
const keywordInput = document.getElementById('keyword-input');
const keywordAddBtn = document.getElementById('keyword-add-btn');
const keywordListEl = document.getElementById('keyword-list');
const employeeInput = document.getElementById('employee-input');
const employeeAddBtn = document.getElementById('employee-add-btn');
const employeeListEl = document.getElementById('employee-list');
const importCsvInput = document.getElementById('import-csv');
const importCsvBtn = document.getElementById('import-csv-btn');
const importHasHeader = document.getElementById('import-has-header');
const importStatus = document.getElementById('import-status');
const checkboxBtn = document.getElementById('checkbox-btn');
const dateTodayBtn = document.getElementById('date-today-btn');
const datePickerBtn = document.getElementById('date-picker-btn');
const editorMoreBtn = document.getElementById('editor-more-btn');
const editorMoreDropdown = document.getElementById('editor-more-dropdown');
const datePickerInput = document.getElementById('date-picker-input');
const noteSearchInput = document.getElementById('note-search-input');
const noteSearchCount = document.getElementById('note-search-count');
const searchPrevBtn = document.getElementById('search-prev-btn');
const searchNextBtn = document.getElementById('search-next-btn');
const deleteBtn = document.getElementById('delete-btn');
const orphanView = document.getElementById('orphan-view');
const orphanList = document.getElementById('orphan-list');
const orphanSelectAllBtn = document.getElementById('orphan-select-all-btn');
const orphanDeleteSelectedBtn = document.getElementById('orphan-delete-selected-btn');
const orphanSortAlphaBtn = document.getElementById('orphan-sort-alpha');
const orphanSortRecentBtn = document.getElementById('orphan-sort-recent');

// ---------- settings (backed by Firestore via Storage) ----------
const PINNED_SECTIONS = {
  aggregator: 'Aggregator notes',
  recent: 'Recent customer notes',
  notes: 'Generic notes',
};
const DEFAULT_PINNED_ORDER = ['aggregator', 'recent', 'notes'];

function getKeywords() {
  const arr = Storage.getSettings().keywords;
  return Array.isArray(arr) ? arr : [];
}
async function setKeywords(list) { await Storage.setSetting('keywords', list); }

// ---------- employees (Time Logger) ----------
// Employees are { name, type } where type is 'apprentice' or 'journeyman'.
// Legacy entries were plain strings — normalized here as journeyman.
function normalizeEmployee(e) {
  if (typeof e === 'string') return { name: e, type: 'journeyman' };
  return { name: e.name, type: e.type === 'apprentice' ? 'apprentice' : 'journeyman' };
}
function getEmployees() {
  const arr = Storage.getSettings().employees;
  const list = Array.isArray(arr) && arr.length ? arr : ['Davor', 'Janet'];
  return list.map(normalizeEmployee);
}
function getEmployeeNames() { return getEmployees().map(e => e.name); }
// Map of lowercased employee name → type, for the IIF generator
function getEmployeeTypeMap() {
  const map = {};
  getEmployees().forEach(e => { map[e.name.toLowerCase()] = e.type; });
  return map;
}
async function setEmployees(list) { await Storage.setSetting('employees', list); }
async function addEmployee(name, type) {
  const n = (name || '').trim();
  if (!n) return false;
  const list = getEmployees();
  if (list.some(e => e.name.toLowerCase() === n.toLowerCase())) return false;
  // Save exactly as typed — the name must match QuickBooks' employee list verbatim
  await setEmployees([...list, { name: n, type: type === 'apprentice' ? 'apprentice' : 'journeyman' }]);
  return true;
}
async function removeEmployee(name) {
  await setEmployees(getEmployees().filter(e => e.name !== name));
}
async function setEmployeeType(name, type) {
  await setEmployees(getEmployees().map(e => e.name === name ? { ...e, type } : e));
}
function renderEmployeeList() {
  const list = getEmployees();
  if (!employeeListEl) return;
  if (list.length === 0) {
    employeeListEl.innerHTML = '<li class="keyword-empty">No employees yet.</li>';
    return;
  }
  employeeListEl.innerHTML = list.map(e => `
    <li class="keyword-pill">
      <span>${escapeHtml(e.name)}</span>
      <select class="employee-type-select" data-emp-type="${escapeHtml(e.name)}" aria-label="Classification for ${escapeHtml(e.name)}">
        <option value="journeyman" ${e.type === 'journeyman' ? 'selected' : ''}>Journeyman</option>
        <option value="apprentice" ${e.type === 'apprentice' ? 'selected' : ''}>Apprentice</option>
      </select>
      <button data-emp="${escapeHtml(e.name)}" aria-label="Remove ${escapeHtml(e.name)}">×</button>
    </li>
  `).join('');
  employeeListEl.querySelectorAll('button[data-emp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await removeEmployee(btn.dataset.emp);
      renderEmployeeList();
    });
  });
  employeeListEl.querySelectorAll('select[data-emp-type]').forEach(sel => {
    sel.addEventListener('change', async () => {
      await setEmployeeType(sel.dataset.empType, sel.value);
    });
  });
}
async function addKeyword(word) {
  const w = (word || '').trim();
  if (!w) return false;
  const list = getKeywords();
  if (list.some(k => k.toLowerCase() === w.toLowerCase())) return false;
  await setKeywords([...list, w]);
  return true;
}
async function removeKeyword(word) {
  await setKeywords(getKeywords().filter(k => k !== word));
}
function renderKeywordList() {
  const list = getKeywords();
  if (list.length === 0) {
    keywordListEl.innerHTML = '<li class="keyword-empty">No keywords yet.</li>';
    return;
  }
  keywordListEl.innerHTML = list.map(w => `
    <li class="keyword-pill">
      <span>${escapeHtml(w)}</span>
      <button data-word="${escapeHtml(w)}" aria-label="Remove ${escapeHtml(w)}">×</button>
    </li>
  `).join('');
  keywordListEl.querySelectorAll('button[data-word]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await removeKeyword(btn.dataset.word);
      renderKeywordList();
    });
  });
}

function getRecentCount() {
  const n = parseInt(Storage.getSettings().recentCount, 10);
  if (Number.isNaN(n) || n < 0) return 4;
  return Math.min(n, 20);
}
// Home-screen stepper writes are debounced: tapping + five times should cost
// one Firestore write, not five. The UI updates immediately either way.
let _settingsFlushTimer = null;
let _settingsDirty = false;
function queueSetting(key, value) {
  Storage.setSettingLocal(key, value); // instant UI
  _settingsDirty = true;
  if (_settingsFlushTimer) clearTimeout(_settingsFlushTimer);
  _settingsFlushTimer = setTimeout(flushSettings, 400);
}
function flushSettings() {
  if (_settingsFlushTimer) { clearTimeout(_settingsFlushTimer); _settingsFlushTimer = null; }
  if (!_settingsDirty) return;
  _settingsDirty = false;
  Storage.writeSettings();
}
// Never lose a queued setting when the app is closed or backgrounded
window.addEventListener('pagehide', flushSettings);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSettings(); });


function getAggregatorCount() {
  const n = parseInt(Storage.getSettings().aggregatorCount, 10);
  if (Number.isNaN(n) || n < 0) return 4;
  return n;
}

function getGeneralNotesCount() {
  const n = parseInt(Storage.getSettings().generalNotesCount, 10);
  if (Number.isNaN(n) || n < 0) return 5;
  return n;
}

function getPinnedOrder() {
  const raw = Storage.getSettings().pinnedOrder;
  if (!Array.isArray(raw)) return DEFAULT_PINNED_ORDER.slice();
  const filtered = raw.filter(k => k in PINNED_SECTIONS);
  for (const k of DEFAULT_PINNED_ORDER) {
    if (!filtered.includes(k)) filtered.push(k);
  }
  return filtered;
}
function movePinnedSection(key, direction) {
  const order = getPinnedOrder();
  const i = order.indexOf(key);
  if (i === -1) return;
  const j = i + direction;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  queueSetting('pinnedOrder', order); // debounced write, instant UI
}
// Customer sort is a per-device viewing preference (localStorage), NOT an org
// setting: org settings are admin-writable only, so a bookkeeper's tap on A–Z
// was rejected by the rules and snapped back. Local also means no Firestore
// write per tap.
function getCustomerSort() {
  let v = localStorage.getItem('na-customer-sort');
  if (v === null) {
    // One-time carry-over from the old org setting
    const orgVal = Storage.getSettings().customerSort;
    v = orgVal === 'recent' ? 'recent' : 'alpha';
    localStorage.setItem('na-customer-sort', v);
  }
  return v === 'recent' ? 'recent' : 'alpha';
}
async function setCustomerSort(v) {
  localStorage.setItem('na-customer-sort', v === 'recent' ? 'recent' : 'alpha');
}

let customerSearchTerm = '';
let customerNotesSearchTerm = '';
let sectionRecentLimit = 50;
let homeSearchTerm = '';

// ---------- editor state ----------
let currentId = null;
let currentType = null;
let currentIsDefault = false;
let returnScreen = 'notes';
let activeCustomerId = null;
let activeKeyword = null;
let customerNotesReturnTo = { screen: 'customers' };
let saveTimer = null;
let swReg = null;
let handlingPopstate = false;
let currentPopstateTarget = null;
let searchMatches = [];
let searchIndex = 0;

// ---------- helpers ----------
function splitTitleAndBody(body) {
  const text = body || '';
  const nl = text.indexOf('\n');
  if (nl === -1) return { title: text, body: '' };
  return { title: text.slice(0, nl), body: text.slice(nl + 1) };
}
function composeBody(title, body) {
  const t = (title || '').trim();
  const b = body || '';
  if (!t && !b.trim()) return '';
  if (!b) return t;
  return t + '\n' + b;
}
function stripKeywordToList(paragraph, keyword) {
  const lines = paragraph.split('\n');
  if (lines.length === 0) return '';
  const first = lines[0];
  const lower = first.toLowerCase();
  const kw = keyword.toLowerCase();
  let head = first;
  if (lower.startsWith(kw)) {
    head = first.substring(keyword.length).replace(/^[\s:,.\-–—]+/, '');
  }
  const all = [head, ...lines.slice(1)].map(l => l.trim()).filter(l => l !== '');
  return all.join(', ');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
// Returns an empty-state message for notes lists, swapping in the Firestore error
// (if the notes listener failed) instead of the misleading "no notes yet" text.
function notesEmptyState(defaultMessage) {
  const err = Storage.getNotesError();
  if (err) {
    return `<p class="empty-state error-state">Couldn't load notes — ${escapeHtml(err)}</p>`;
  }
  return `<p class="empty-state">${defaultMessage}</p>`;
}
function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const weekday = d.toLocaleDateString([], { weekday: 'short' });
  if (sameDay) {
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${weekday}, ${time}`;
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function formatDateTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const date = d.toLocaleDateString([], sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return `${date}, ${time}`;
}

// ---------- screen navigation ----------
// ---------- in-app Back button (installed apps without a system back) ----------
// iOS home-screen apps have no browser chrome AND no edge-swipe back, so the
// app must provide one. Android always has system back, so it's excluded.
// Desktop PWAs also hide chrome, so they get it too.
const isStandaloneApp = window.navigator.standalone === true
  || window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: fullscreen)').matches;
const isAndroid = /android/i.test(navigator.userAgent);
if (isStandaloneApp && !isAndroid) document.body.classList.add('show-app-back');

// How many history entries this app has pushed. At 0 we're at the bottom of
// the stack (home), so the Back button hides — it can never exit the app.
let appHistoryDepth = 0;
function updateAppBackButtons() {
  document.querySelectorAll('.app-back-btn').forEach(btn => { btn.hidden = appHistoryDepth <= 0; });
}
// Every screen change routes through pushState/replaceState; wrap them so the
// depth count stays honest without touching each call site.
const _pushState = history.pushState.bind(history);
history.pushState = (...args) => {
  const state = args[0];
  if (state && state.screen === 'home') appHistoryDepth = 0;
  else appHistoryDepth++;
  _pushState(...args);
  updateAppBackButtons();
};
const _replaceState = history.replaceState.bind(history);
history.replaceState = (...args) => {
  const state = args[0];
  if (state && state.screen === 'home') appHistoryDepth = 0;
  _replaceState(...args);
  updateAppBackButtons();
};
window.addEventListener('popstate', () => {
  appHistoryDepth = Math.max(0, appHistoryDepth - 1);
  updateAppBackButtons();
});
document.querySelectorAll('.app-back-btn').forEach(btn => {
  // history.back() fires the same popstate path Android's system back uses,
  // so editor cleanup / save flushing / return-screen logic is shared.
  btn.addEventListener('click', () => { if (appHistoryDepth > 0) history.back(); });
});
updateAppBackButtons();

// ---------- price table ----------
// Rows = items, columns = vendors. A cell shows the newest entry's price and
// an availability dot; tap to enter a new price inline, long-press for the
// full history. Data lives one doc per row (see storage.js).
const priceView = document.getElementById('price-view');
const priceTableEl = document.getElementById('price-table');
const AVAIL_LABELS = { yes: 'Available', no: 'Not available', soon: 'Available in 2–3 days', later: 'Available in more than 3 days' };
let priceZoom = parseFloat(localStorage.getItem('na-price-zoom') || '1') || 1;
let openCellKey = null; // "itemId|vendorId" currently in edit mode

function showPriceTable() {
  hideAllScreens();
  priceView.classList.add('active');
  renderCrumbs('crumbs-price', [{ label: 'Home', go: 'home' }, { label: 'Price Table' }]);
  renderPriceTable();
  restoreScroll('price');
  if (!handlingPopstate) history.pushState({ screen: 'price' }, '');
}

function priceCellHtml(item, vendor, canEdit) {
  const key = `${item.id}|${vendor.id}`;
  const latest = Storage.latestPriceEntry(item, vendor.id);
  if (openCellKey === key && canEdit) {
    const today = new Date().toISOString().slice(0, 10);
    return `<td class="price-cell price-cell-editing" data-key="${key}">
      <input class="price-input" type="number" inputmode="decimal" step="0.01" placeholder="Price" value="" />
      <input class="price-date" type="date" value="${today}" />
      <select class="price-avail">
        <option value="yes">Available</option>
        <option value="soon">2–3 days</option>
        <option value="later">Longer</option>
        <option value="no">Not available</option>
      </select>
      <div class="price-cell-actions">
        <button class="price-save" type="button">Save</button>
        <button class="price-cancel" type="button">Cancel</button>
      </div>
    </td>`;
  }
  let inner = '<span class="price-empty">–</span>';
  if (latest) {
    const noPrice = latest.price == null || latest.price === '';
    const priceTxt = noPrice ? '—' : Number(latest.price).toFixed(2);
    const cls = latest.avail === 'no' ? 'price-value price-unavailable' : 'price-value';
    inner = `<span class="${cls}">${escapeHtml(priceTxt)}</span><span class="avail-dot avail-${escapeHtml(latest.avail || 'yes')}" title="${escapeHtml(AVAIL_LABELS[latest.avail] || '')}"></span>`;
  }
  return `<td class="price-cell" data-key="${key}">${inner}</td>`;
}

function renderPriceTable() {
  if (!priceTableEl) return;
  const cfg = Storage.getPriceConfig();
  const items = Storage.listPriceItems();
  const canEdit = Storage.canEditPriceTable();
  // Action buttons are admin/shared-employee only; Share is admin only
  const addItemBtn = document.getElementById('price-add-item');
  const addVendorBtn = document.getElementById('price-add-vendor');
  const shareBtn = document.getElementById('price-share');
  if (addItemBtn) addItemBtn.hidden = !canEdit;
  if (addVendorBtn) addVendorBtn.hidden = !canEdit;
  if (shareBtn) shareBtn.hidden = !isAdminRole();
  const reorderBtn = document.getElementById('price-reorder');
  const importBtn = document.getElementById('price-import');
  const exportBtn = document.getElementById('price-export');
  if (reorderBtn) reorderBtn.hidden = !canEdit;
  if (importBtn) importBtn.hidden = !canEdit;
  if (exportBtn) exportBtn.hidden = !Storage.canViewPriceTable();
  // Hide the ⋯ button when every item inside it is hidden
  const moreWrap = priceMoreBtn ? priceMoreBtn.closest('.editor-more-wrap') : null;
  if (moreWrap) {
    const anyVisible = [reorderBtn, importBtn, exportBtn, shareBtn].some(b => b && !b.hidden);
    moreWrap.style.display = anyVisible ? '' : 'none';
  }

  if (!cfg.vendors.length && !items.length) {
    priceTableEl.innerHTML = `<tbody><tr><td class="price-empty-state">${canEdit
      ? 'Add a vendor and an item to start your price table.'
      : 'The price table is empty.'}</td></tr></tbody>`;
    return;
  }
  const vendors = cfg.vendors.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const reorder = priceReorderMode && canEdit;
  const head = `<thead><tr><th class="price-corner">Item</th>${
    vendors.map((v, i) => `<th class="price-vendor" data-vendor="${v.id}">${escapeHtml(v.name)}${
      reorder ? `<span class="reorder-arrows"><button type="button" class="v-left" data-vendor="${v.id}" ${i === 0 ? 'disabled' : ''}>←</button><button type="button" class="v-right" data-vendor="${v.id}" ${i === vendors.length - 1 ? 'disabled' : ''}>→</button></span>` : ''
    }</th>`).join('')
  }</tr></thead>`;
  const body = `<tbody>${items.map((item, i) => `<tr>
      <th class="price-item" data-item="${item.id}">${escapeHtml(item.name)}${
        reorder ? `<span class="reorder-arrows"><button type="button" class="i-up" data-item="${item.id}" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="i-down" data-item="${item.id}" ${i === items.length - 1 ? 'disabled' : ''}>↓</button></span>` : ''
      }</th>
      ${vendors.map(v => priceCellHtml(item, v, canEdit)).join('')}
    </tr>`).join('')}</tbody>`;
  priceTableEl.innerHTML = head + body;
  priceTableEl.style.transform = `scale(${priceZoom})`;
  priceTableEl.style.transformOrigin = '0 0';
  wirePriceTable(canEdit);
}

function wirePriceTable(canEdit) {
  // Long-press (or right-click) opens history; a plain tap opens inline entry
  priceTableEl.querySelectorAll('.price-cell').forEach(cell => {
    let pressTimer = null;
    let longPressed = false;
    const key = cell.dataset.key;
    const startPress = () => {
      longPressed = false;
      pressTimer = setTimeout(() => { longPressed = true; openPriceHistory(key); }, 500);
    };
    const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    cell.addEventListener('pointerdown', startPress);
    cell.addEventListener('pointerup', cancelPress);
    cell.addEventListener('pointerleave', cancelPress);
    cell.addEventListener('pointercancel', cancelPress);
    cell.addEventListener('contextmenu', (e) => { e.preventDefault(); cancelPress(); openPriceHistory(key); });
    cell.addEventListener('click', (e) => {
      if (longPressed) { longPressed = false; return; }
      if (!canEdit) return;
      if (e.target.closest('.price-cell-editing')) return; // already editing
      openCellKey = key;
      renderPriceTable();
      const input = priceTableEl.querySelector('.price-cell-editing .price-input');
      if (input) input.focus();
    });
  });
  const editing = priceTableEl.querySelector('.price-cell-editing');
  if (editing) {
    const [itemId, vendorId] = editing.dataset.key.split('|');
    const save = async () => {
      const price = editing.querySelector('.price-input').value;
      const date = editing.querySelector('.price-date').value;
      const avail = editing.querySelector('.price-avail').value;
      openCellKey = null;
      await Storage.addPriceEntry(itemId, vendorId, { price, date, avail });
      renderPriceTable();
    };
    editing.querySelector('.price-save').addEventListener('click', save);
    editing.querySelector('.price-cancel').addEventListener('click', () => { openCellKey = null; renderPriceTable(); });
    editing.querySelector('.price-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { openCellKey = null; renderPriceTable(); }
    });
  }
  // Reorder mode: arrows move rows/columns; taps don't rename
  if (priceReorderMode && canEdit) {
    priceTableEl.querySelectorAll('.i-up').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); movePriceItem(b.dataset.item, -1); }));
    priceTableEl.querySelectorAll('.i-down').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); movePriceItem(b.dataset.item, 1); }));
    priceTableEl.querySelectorAll('.v-left').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); movePriceVendor(b.dataset.vendor, -1); }));
    priceTableEl.querySelectorAll('.v-right').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); movePriceVendor(b.dataset.vendor, 1); }));
    return;
  }
  // Rename / remove a row or column (edit rights only)
  if (canEdit) {
    priceTableEl.querySelectorAll('.price-item').forEach(th => {
      th.addEventListener('click', async () => {
        const item = Storage.listPriceItems().find(i => i.id === th.dataset.item);
        if (!item) return;
        const name = prompt('Item name (blank to delete):', item.name);
        if (name === null) return;
        if (!name.trim()) {
          if (confirm(`Delete item "${item.name}" and its prices?`)) await Storage.removePriceItem(item.id);
        } else {
          await Storage.savePriceItem(item.id, { name: name.trim() });
        }
        renderPriceTable();
      });
    });
    priceTableEl.querySelectorAll('.price-vendor').forEach(th => {
      th.addEventListener('click', async () => {
        const v = Storage.getPriceConfig().vendors.find(x => x.id === th.dataset.vendor);
        if (!v) return;
        const name = prompt('Vendor name (blank to delete):', v.name);
        if (name === null) return;
        if (!name.trim()) {
          if (confirm(`Delete vendor "${v.name}" and its prices?`)) await Storage.removePriceVendor(v.id);
        } else {
          await Storage.renamePriceVendor(v.id, name.trim());
        }
        renderPriceTable();
      });
    });
  }
}

// ---------- price history sheet ----------
const priceHistoryModal = document.getElementById('price-history-modal');
const priceHistoryTitle = document.getElementById('price-history-title');
const priceHistorySub = document.getElementById('price-history-sub');
const priceHistoryList = document.getElementById('price-history-list');

function openPriceHistory(key) {
  if (!priceHistoryModal || !key) return;
  const [itemId, vendorId] = key.split('|');
  const item = Storage.listPriceItems().find(i => i.id === itemId);
  const vendor = Storage.getPriceConfig().vendors.find(v => v.id === vendorId);
  if (!item || !vendor) return;
  const canEdit = Storage.canEditPriceTable();
  priceHistoryTitle.textContent = item.name;
  priceHistorySub.textContent = vendor.name;
  const entries = Storage.priceHistory(item, vendorId);
  priceHistoryList.innerHTML = entries.length
    ? entries.map(e => `<li class="price-history-item">
        <span class="price-history-price">${e.price == null ? '—' : escapeHtml(Number(e.price).toFixed(2))}</span>
        <span class="price-history-date">${escapeHtml(e.date || '')}</span>
        <span class="avail-dot avail-${escapeHtml(e.avail || 'yes')}"></span>
        <span class="price-history-avail">${escapeHtml(AVAIL_LABELS[e.avail] || '')}</span>
        ${canEdit ? `<button class="price-history-del" data-added="${escapeHtml(e.added || '')}" aria-label="Delete entry">✕</button>` : ''}
      </li>`).join('')
    : '<li class="price-history-item">No prices recorded yet.</li>';
  priceHistoryList.querySelectorAll('.price-history-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await Storage.removePriceEntry(itemId, vendorId, btn.dataset.added);
      openPriceHistory(key);
      renderPriceTable();
    });
  });
  priceHistoryModal.hidden = false;
}
const priceHistoryClose = document.getElementById('price-history-close');
if (priceHistoryClose) priceHistoryClose.addEventListener('click', () => { priceHistoryModal.hidden = true; });
if (priceHistoryModal) priceHistoryModal.addEventListener('click', (e) => { if (e.target === priceHistoryModal) priceHistoryModal.hidden = true; });

// ---------- price table header actions ----------
const priceAddItemBtn = document.getElementById('price-add-item');
const priceAddVendorBtn = document.getElementById('price-add-vendor');
const priceShareBtn = document.getElementById('price-share');
const priceShareModal = document.getElementById('price-share-modal');
const priceShareList = document.getElementById('price-share-list');
const priceShareClose = document.getElementById('price-share-close');
const priceZoomIn = document.getElementById('price-zoom-in');
const priceZoomOut = document.getElementById('price-zoom-out');

if (priceAddItemBtn) priceAddItemBtn.addEventListener('click', async () => {
  const name = prompt('New item name:');
  if (name && name.trim()) { await Storage.addPriceItem(name.trim()); renderPriceTable(); }
});
if (priceAddVendorBtn) priceAddVendorBtn.addEventListener('click', async () => {
  const name = prompt('New vendor name:');
  if (name && name.trim()) { await Storage.addPriceVendor(name.trim()); renderPriceTable(); }
});
function setPriceZoom(z) {
  priceZoom = Math.max(0.5, Math.min(2, Math.round(z * 10) / 10));
  localStorage.setItem('na-price-zoom', String(priceZoom));
  if (priceTableEl) priceTableEl.style.transform = `scale(${priceZoom})`;
}
if (priceZoomIn) priceZoomIn.addEventListener('click', () => setPriceZoom(priceZoom + 0.1));
if (priceZoomOut) priceZoomOut.addEventListener('click', () => setPriceZoom(priceZoom - 0.1));

if (priceShareBtn) priceShareBtn.addEventListener('click', () => {
  if (!priceShareModal || !isAdminRole()) return;
  const shared = Storage.getPriceConfig().sharedWith;
  const employees = Storage.listMembers().filter(m => m.role === 'employee');
  priceShareList.innerHTML = employees.length
    ? employees.map(m => `<li class="member-item">
        <label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;">
          <input type="checkbox" data-uid="${m.uid}" ${shared.includes(m.uid) ? 'checked' : ''} />
          <span class="member-email">${escapeHtml(m.name || m.email || m.uid)}</span>
        </label>
      </li>`).join('')
    : '<li class="member-item">No employees to share with yet.</li>';
  priceShareList.querySelectorAll('input[data-uid]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const cur = Storage.getPriceConfig().sharedWith;
      const next = cb.checked ? [...new Set([...cur, cb.dataset.uid])] : cur.filter(u => u !== cb.dataset.uid);
      await Storage.savePriceConfig({ sharedWith: next });
    });
  });
  priceShareModal.hidden = false;
});
if (priceShareClose) priceShareClose.addEventListener('click', () => { priceShareModal.hidden = true; });
if (priceShareModal) priceShareModal.addEventListener('click', (e) => { if (e.target === priceShareModal) priceShareModal.hidden = true; });

// ---------- viewport height ----------
// iOS changes the visible height as the address bar shows/hides, and 100dvh
// doesn't always keep up — the editor could end up taller than the screen on
// first load, letting its toolbar scroll out of view. Track the real height.
function updateAppVh() {
  document.documentElement.style.setProperty('--app-vh', window.innerHeight + 'px');
}
updateAppVh();
window.addEventListener('resize', updateAppVh);
window.addEventListener('orientationchange', updateAppVh);
if (window.visualViewport) window.visualViewport.addEventListener('resize', updateAppVh);

// ---------- price table: pinch zoom ----------
// Two-finger pinch adjusts the same zoom the −/+ buttons use. One finger is
// left alone so normal scrolling/panning still works.
const priceScrollEl = document.getElementById('price-scroll');
if (priceScrollEl) {
  const pts = new Map();
  let startDist = 0, startZoom = 1;
  const dist = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  priceScrollEl.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { startDist = dist(); startZoom = priceZoom; }
  });
  priceScrollEl.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && startDist > 0) {
      e.preventDefault();
      setPriceZoom(startZoom * (dist() / startDist));
    }
  });
  const dropPt = (e) => { pts.delete(e.pointerId); if (pts.size < 2) startDist = 0; };
  priceScrollEl.addEventListener('pointerup', dropPt);
  priceScrollEl.addEventListener('pointercancel', dropPt);
  priceScrollEl.addEventListener('pointerleave', dropPt);
}

// ---------- price table: ⋯ menu ----------
const priceMoreBtn = document.getElementById('price-more-btn');
const priceMoreDropdown = document.getElementById('price-more-dropdown');
function closePriceMenu() { if (priceMoreDropdown) priceMoreDropdown.hidden = true; }
if (priceMoreBtn) priceMoreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (priceMoreDropdown) priceMoreDropdown.hidden = !priceMoreDropdown.hidden;
});
if (priceMoreDropdown) priceMoreDropdown.addEventListener('click', () => closePriceMenu());
document.addEventListener('click', (e) => {
  if (priceMoreDropdown && !priceMoreDropdown.hidden
      && !priceMoreDropdown.contains(e.target) && e.target !== priceMoreBtn) closePriceMenu();
});

// ---------- price table: reorder mode ----------
let priceReorderMode = false;
const priceReorderBtn = document.getElementById('price-reorder');
if (priceReorderBtn) priceReorderBtn.addEventListener('click', () => {
  priceReorderMode = !priceReorderMode;
  priceReorderBtn.setAttribute('aria-pressed', String(priceReorderMode));
  priceReorderBtn.textContent = priceReorderMode ? 'Done reordering' : 'Reorder rows & columns';
  // Make it obvious from the closed menu that reorder mode is on
  if (priceMoreBtn) priceMoreBtn.classList.toggle('active', priceReorderMode);
  openCellKey = null;
  renderPriceTable();
});
async function movePriceItem(itemId, dir) {
  const items = Storage.listPriceItems();
  const i = items.findIndex(x => x.id === itemId);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= items.length) return;
  const a = items[i], b = items[j];
  await Storage.savePriceItem(a.id, { order: j });
  await Storage.savePriceItem(b.id, { order: i });
  renderPriceTable();
}
async function movePriceVendor(vendorId, dir) {
  const vendors = Storage.getPriceConfig().vendors.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const i = vendors.findIndex(v => v.id === vendorId);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= vendors.length) return;
  [vendors[i], vendors[j]] = [vendors[j], vendors[i]];
  await Storage.savePriceConfig({ vendors: vendors.map((v, idx) => ({ ...v, order: idx })) });
  renderPriceTable();
}

// ---------- price table: CSV export / import ----------
function priceCsvCell(entry) {
  if (!entry) return '';
  const price = entry.price == null ? '' : Number(entry.price).toFixed(2);
  return `${price}|${entry.avail || 'yes'}|${entry.date || ''}`;
}
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportPriceCsv() {
  const cfg = Storage.getPriceConfig();
  const vendors = cfg.vendors.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const items = Storage.listPriceItems();
  const rows = [['Item', ...vendors.map(v => v.name)]];
  for (const item of items) {
    rows.push([item.name, ...vendors.map(v => priceCsvCell(Storage.latestPriceEntry(item, v.id)))]);
  }
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `price-table-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const priceExportBtn = document.getElementById('price-export');
if (priceExportBtn) priceExportBtn.addEventListener('click', exportPriceCsv);

// Split a pasted table: real CSV (quoted commas) or tab-separated from a sheet
function parseDelimited(text) {
  const useTab = text.includes('\t');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === (useTab ? '\t' : ',')) { row.push(field.trim()); field = ''; continue; }
    if (c === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  row.push(field.trim());
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows.filter(r => r.some(v => v !== ''));
}
// A cell is "12.99", "12.99|soon", or "12.99|no|2026-07-22"; empty = skip
function parsePriceCell(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const [p, a, d] = s.split('|').map(x => (x || '').trim());
  // Strip currency symbols/spaces, but text with NO digits must not become 0:
  // Number('') === 0, so "abc" would silently import as 0.00.
  const cleaned = p.replace(/[^0-9.\-]/g, '');
  const priceNum = p === '' ? null : (cleaned === '' ? NaN : Number(cleaned));
  if (p !== '' && Number.isNaN(priceNum)) return null;
  return {
    price: priceNum,
    avail: ['yes', 'no', 'soon', 'later'].includes(a) ? a : 'yes',
    date: /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : new Date().toISOString().slice(0, 10),
  };
}
function analysePriceImport(text) {
  const rows = parseDelimited(text);
  if (rows.length < 2) return { error: 'Need a header row of vendors and at least one item row.' };
  const cfg = Storage.getPriceConfig();
  const existingVendors = cfg.vendors;
  const existingItems = Storage.listPriceItems();
  const header = rows[0].slice(1);
  const newVendors = header.filter(h => h && !existingVendors.some(v => v.name.toLowerCase() === h.toLowerCase()));
  let newItems = 0, entries = 0, skipped = 0;
  const plan = [];
  for (const r of rows.slice(1)) {
    const name = (r[0] || '').trim();
    if (!name) continue;
    const known = existingItems.some(i => i.name.toLowerCase() === name.toLowerCase());
    if (!known) newItems++;
    const cells = [];
    header.forEach((vName, idx) => {
      const parsed = parsePriceCell(r[idx + 1]);
      if (!vName) return;
      if (parsed) { cells.push({ vendorName: vName, entry: parsed }); entries++; }
      else if ((r[idx + 1] || '').trim()) skipped++;
    });
    plan.push({ itemName: name, cells });
  }
  return { plan, newVendors: [...new Set(newVendors)], newItems, entries, skipped };
}
async function applyPriceImport(analysis) {
  // Create any missing vendors first, then rows, then entries
  for (const name of analysis.newVendors) await Storage.addPriceVendor(name);
  const vendors = Storage.getPriceConfig().vendors;
  const vendorByName = new Map(vendors.map(v => [v.name.toLowerCase(), v]));
  for (const row of analysis.plan) {
    let item = Storage.listPriceItems().find(i => i.name.toLowerCase() === row.itemName.toLowerCase());
    if (!item) item = await Storage.addPriceItem(row.itemName);
    if (!item) continue;
    for (const c of row.cells) {
      const v = vendorByName.get(c.vendorName.toLowerCase());
      if (!v) continue;
      await Storage.addPriceEntry(item.id, v.id, c.entry);
    }
  }
}
const priceImportBtn = document.getElementById('price-import');
const priceImportModal = document.getElementById('price-import-modal');
const priceImportText = document.getElementById('price-import-text');
const priceImportPreview = document.getElementById('price-import-preview');
const priceImportCheck = document.getElementById('price-import-check');
const priceImportApply = document.getElementById('price-import-apply');
const priceImportClose = document.getElementById('price-import-close');
let pendingPriceImport = null;

if (priceImportBtn) priceImportBtn.addEventListener('click', () => {
  if (!priceImportModal) return;
  priceImportText.value = '';
  priceImportPreview.textContent = '';
  priceImportApply.disabled = true;
  pendingPriceImport = null;
  priceImportModal.hidden = false;
});
if (priceImportCheck) priceImportCheck.addEventListener('click', () => {
  const res = analysePriceImport(priceImportText.value || '');
  if (res.error) {
    priceImportPreview.textContent = res.error;
    priceImportApply.disabled = true;
    pendingPriceImport = null;
    return;
  }
  pendingPriceImport = res;
  priceImportApply.disabled = res.entries === 0 && res.newItems === 0 && res.newVendors.length === 0;
  priceImportPreview.textContent =
    `Will add ${res.newVendors.length} vendor${res.newVendors.length === 1 ? '' : 's'}, `
    + `${res.newItems} item${res.newItems === 1 ? '' : 's'} and ${res.entries} price entr${res.entries === 1 ? 'y' : 'ies'}.`
    + (res.skipped ? ` ${res.skipped} cell${res.skipped === 1 ? '' : 's'} couldn't be read and will be skipped.` : '')
    + ' Nothing is overwritten — entries are added to each cell\'s history.';
});
if (priceImportApply) priceImportApply.addEventListener('click', async () => {
  if (!pendingPriceImport) return;
  priceImportApply.disabled = true;
  priceImportPreview.textContent = 'Importing…';
  await applyPriceImport(pendingPriceImport);
  priceImportModal.hidden = true;
  pendingPriceImport = null;
  renderPriceTable();
});
if (priceImportClose) priceImportClose.addEventListener('click', () => { priceImportModal.hidden = true; });
if (priceImportModal) priceImportModal.addEventListener('click', (e) => { if (e.target === priceImportModal) priceImportModal.hidden = true; });

// ---------- breadcrumbs ----------
// Every screen's sticky header carries a trail: Home › Customers › John Canuck.
// Earlier crumbs are tappable shortcuts; the last one is the current screen
// (bold, not tappable) so you still know where you are after scrolling.
// These replace the per-screen Home buttons and the editor's "Go to:" button.
function renderCrumbs(containerId, crumbs) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = crumbs.map((c, i) => {
    const last = i === crumbs.length - 1;
    const sep = i > 0 ? '<span class="crumb-sep" aria-hidden="true">›</span>' : '';
    if (last) return `${sep}<span class="crumb crumb-current" aria-current="page">${escapeHtml(c.label)}</span>`;
    return `${sep}<button type="button" class="crumb crumb-link" data-go="${c.go}"${c.id ? ` data-id="${c.id}"` : ''}>${escapeHtml(c.label)}</button>`;
  }).join('');
  el.querySelectorAll('.crumb-link').forEach(btn => {
    btn.addEventListener('click', () => {
      // Leaving the editor must flush saves, exactly like the old Home button
      if (editorView.classList.contains('active')) commitAndCleanupEditor();
      const go = btn.dataset.go;
      if (go === 'home') goHome();
      else if (go === 'customers') showCustomers();
      else if (go === 'customer' && btn.dataset.id) showCustomerNotes(btn.dataset.id);
      else if (go === 'section' && btn.dataset.id) showSection(btn.dataset.id);
    });
  });
}
function customerCrumbLabel(customerId) {
  const def = customerId ? Storage.getDefaultNoteForCustomer(customerId) : null;
  const name = def ? (splitTitleAndBody(def.body).title || '').trim() : '';
  return name || 'Unnamed customer';
}

// ---------- scroll memory ----------
// Leaving a list screen remembers where you were; coming back restores it, so
// the back button doesn't dump you at the top. Home buttons clear the memory
// (goHome), so tapping Home always lands at the top.
const screenScroll = {};
let activeSectionKey = null;
function activeScreenKey() {
  if (listView.classList.contains('active')) return 'home';
  if (customersView.classList.contains('active')) return 'customers';
  // Per customer / per section, so a different one starts at the top
  if (customerNotesView.classList.contains('active')) return 'customer-notes:' + activeCustomerId;
  if (sectionView && sectionView.classList.contains('active')) return 'section:' + activeSectionKey;
  if (orphanView && orphanView.classList.contains('active')) return 'orphans';
  if (priceView && priceView.classList.contains('active')) return 'price';
  return null;
}
function rememberScroll() {
  const key = activeScreenKey();
  if (key) screenScroll[key] = window.scrollY || 0;
}
function resetScrollMemory() { Object.keys(screenScroll).forEach(k => delete screenScroll[k]); }
// Restore after the list has rendered, so the page is tall enough to scroll to
function restoreScroll(key) {
  const y = screenScroll[key] || 0;
  if (!y) { window.scrollTo(0, 0); return; }
  requestAnimationFrame(() => window.scrollTo(0, y));
}

function hideAllScreens() {
  rememberScroll();
  // Don't come back to a home screen full of layout controls
  if (homeLayoutMode && listView.classList.contains('active')) {
    homeLayoutMode = false;
    applyLayoutMode();
  }
  flushSettings(); // don't leave a debounced setting unwritten on navigation
  const fm = document.getElementById('fab-menu');
  if (fm) fm.hidden = true;
  const pm = document.getElementById('price-more-dropdown');
  if (pm) pm.hidden = true;
  listView.classList.remove('active');
  customersView.classList.remove('active');
  customerNotesView.classList.remove('active');
  settingsView.classList.remove('active');
  if (sectionView) sectionView.classList.remove('active');
  if (orphanView) orphanView.classList.remove('active');
  if (priceView) priceView.classList.remove('active');
  editorView.classList.remove('active');
  if (signinView) signinView.classList.remove('active');
  // Body class controls page-level scroll lock for editor screen
  document.body.classList.remove('editor-open');
  // Screens reset search inputs programmatically (no input event) — keep the
  // ✕ clear buttons in sync on every navigation
  refreshSearchClears();
}

// ---------- compiled aggregator editor ----------
// Clicking a keyword opens ONE editable note compiled from every matching
// paragraph, with a ━━ Client Name ━━ header above each. Sections map back to
// their source notes BY POSITION (order of ━━ lines); the header name is only
// a sanity check. Name mismatches hold that section from saving; a changed
// header COUNT pauses all write-back. Both surface a tappable warning banner
// with a resolve dialog.
const COMPILED_ID = '__compiled__';
const compiledHeaderRe = /^━━ (.*) ━━\s*$/;
let compiledSections = null; // [{ noteId, expectedName, originalParagraph }]
let compiledKeyword = null;
let compiledIssues = { count: null, names: [], notFound: [] };

const compiledWarning = document.getElementById('compiled-warning');
const compiledModal = document.getElementById('compiled-modal');
const compiledModalBody = document.getElementById('compiled-modal-body');
const compiledModalClose = document.getElementById('compiled-modal-close');
if (compiledWarning) compiledWarning.addEventListener('click', () => openCompiledModal());
if (compiledModalClose) compiledModalClose.addEventListener('click', () => closeCompiledModal());

function compiledHeaderLine(name) { return `━━ ${name} ━━`; }

// Label for one aggregator match: the customer's name for customer notes; for
// general notes the note's own title, plus the owner's name when the note
// belongs to someone else (so you can see whose note you're editing).
function aggregateMatchLabel(match) {
  if (match.customerId) {
    const def = Storage.getDefaultNoteForCustomer(match.customerId);
    const name = def ? (splitTitleAndBody(def.body).title || '').trim() : '';
    return name || 'Unnamed customer';
  }
  const note = Storage.getNote(match.noteId);
  const title = note ? (splitTitleAndBody(note.body).title || '').trim() : '';
  let label = title || 'General note';
  const owners = (note && Array.isArray(note.assignedTo) ? note.assignedTo : [])
    .filter(uid => uid !== Storage.getUid())
    .map(uid => {
      const m = Storage.getMember(uid);
      return m ? (m.name || m.email || '') : '';
    })
    .filter(Boolean);
  if (owners.length) label += ' — ' + owners.join(', ');
  return label;
}

function buildCompiledSections(keyword) {
  const matches = Storage.aggregateParagraphsByKeyword(keyword);
  compiledSections = matches.map(m => ({
    noteId: m.noteId,
    expectedName: aggregateMatchLabel(m),
    originalParagraph: m.paragraph,
  }));
  return compiledSections.map(s => compiledHeaderLine(s.expectedName) + '\n' + s.originalParagraph).join('\n\n');
}

function showAggregator(keyword) {
  const fromSection = sectionView && sectionView.classList.contains('active');
  activeKeyword = keyword;
  compiledKeyword = keyword;
  currentId = COMPILED_ID;
  currentType = 'compiled';
  currentIsDefault = false;
  returnScreen = fromSection ? 'aggregator-section' : 'notes';

  const body = buildCompiledSections(keyword);
  titleInput.value = keyword;
  titleInput.readOnly = true;
  titleInput.placeholder = 'Keyword';
  bodyInput.value = body;
  const empty = compiledSections.length === 0;
  bodyInput.readOnly = isReadOnlyRole() || empty;
  bodyInput.placeholder = empty ? `No paragraphs starting with “${keyword}” yet.` : '';

  resetNoteSearch();
  const aggSearchWrap = noteSearchInput.closest('.search-wrap');
  if (aggSearchWrap) aggSearchWrap.style.display = '';
  noteSearchCount.style.display = '';
  searchPrevBtn.style.display = 'none';
  searchNextBtn.style.display = 'none';
  if (editorMoreBtn) editorMoreBtn.closest('.editor-more-wrap').style.display = 'none';
  closeMoreDropdown();
  if (checkboxBtn) checkboxBtn.style.display = bodyInput.readOnly ? 'none' : '';
  resetUndo();
  lastKnownRemoteBody = null; // compiled editor has its own conflict handling
  if (undoBtn) undoBtn.style.display = bodyInput.readOnly ? 'none' : '';
  if (redoBtn) redoBtn.style.display = bodyInput.readOnly ? 'none' : '';
  deleteBtn.style.display = 'none';
  const editorSharedBadge = document.getElementById('editor-shared-badge');
  if (editorSharedBadge) editorSharedBadge.hidden = true;

  renderCrumbs('crumbs-editor', [
    { label: 'Home', go: 'home' },
    { label: keyword },
  ]);
  compiledIssues = { count: null, names: [], notFound: [] };
  renderCompiledWarning();

  hideAllScreens();
  window.scrollTo(0, 0);
  editorView.classList.add('active');
  document.body.classList.add('editor-open');
  if (!handlingPopstate) history.pushState({ screen: 'aggregator', keyword }, '');
}

// Split the textarea into header/content segments. Content is trimmed of
// leading/trailing blank lines; internal blank lines are kept.
function parseCompiledBody() {
  const lines = bodyInput.value.split('\n');
  const headers = [];
  lines.forEach((ln, i) => {
    const m = ln.match(compiledHeaderRe);
    if (m) headers.push({ name: m[1].trim(), line: i });
  });
  const segments = headers.map((h, i) => {
    let a = h.line + 1;
    let b = i + 1 < headers.length ? headers[i + 1].line : lines.length;
    while (a < b && lines[a].trim() === '') a++;
    while (b > a && lines[b - 1].trim() === '') b--;
    return { name: h.name, headerLine: h.line, contentEnd: b, content: lines.slice(a, b).join('\n') };
  });
  return { lines, segments };
}

function saveCompiledEdits() {
  if (currentType !== 'compiled' || !compiledSections || compiledSections.length === 0) return;
  if (isReadOnlyRole()) return;
  const { segments } = parseCompiledBody();
  if (segments.length !== compiledSections.length) {
    compiledIssues = { count: { found: segments.length, expected: compiledSections.length }, names: [], notFound: [] };
    renderCompiledWarning();
    return; // nothing saves until the ━━ markers line up again
  }
  const names = [];
  const notFound = [];
  // Group sections by source note and walk each note's body once, in section
  // order, so duplicate paragraphs map to the right occurrence.
  const byNote = new Map();
  segments.forEach((seg, i) => {
    const sec = compiledSections[i];
    if (!byNote.has(sec.noteId)) byNote.set(sec.noteId, []);
    byNote.get(sec.noteId).push({ seg, sec, index: i });
  });
  for (const [noteId, entries] of byNote) {
    const note = Storage.getNote(noteId);
    let body = note ? (note.body || '') : null;
    let searchFrom = 0;
    let changed = false;
    for (const { seg, sec, index } of entries) {
      const nameMismatch = seg.name !== sec.expectedName;
      const contentChanged = seg.content !== sec.originalParagraph;
      if (nameMismatch) names.push({ index, found: seg.name, expected: sec.expectedName });
      if (body === null) {
        if (contentChanged && !nameMismatch) notFound.push({ index, name: sec.expectedName });
        continue;
      }
      const at = body.indexOf(sec.originalParagraph, searchFrom);
      if (at === -1) {
        if (contentChanged && !nameMismatch) notFound.push({ index, name: sec.expectedName });
        continue;
      }
      if (nameMismatch || !contentChanged) {
        searchFrom = at + sec.originalParagraph.length;
        continue;
      }
      body = body.substring(0, at) + seg.content + body.substring(at + sec.originalParagraph.length);
      searchFrom = at + seg.content.length;
      sec.originalParagraph = seg.content;
      changed = true;
    }
    if (changed) {
      // A deleted section leaves stacked blank lines behind — collapse them.
      Storage.updateNote(noteId, body.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, ''));
    }
  }
  compiledIssues = { count: null, names, notFound };
  renderCompiledWarning();
}

function compiledIssueCount() {
  if (compiledIssues.count) return 1;
  return compiledIssues.names.length + compiledIssues.notFound.length;
}

function renderCompiledWarning() {
  if (!compiledWarning) return;
  const show = currentType === 'compiled' && compiledIssueCount() > 0;
  compiledWarning.hidden = !show;
  if (!show) { closeCompiledModal(); return; }
  const n = compiledIssueCount();
  compiledWarning.textContent = compiledIssues.count
    ? "⚠ Section markers changed — edits aren't saving. Tap to resolve."
    : `⚠ ${n} section${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention — tap to resolve.`;
}

// Rebuild the whole compiled view from the source notes (unsaved edits lost).
function compiledRebuild() {
  bodyInput.value = buildCompiledSections(compiledKeyword);
  bodyInput.readOnly = isReadOnlyRole() || compiledSections.length === 0;
  compiledIssues = { count: null, names: [], notFound: [] };
  renderCompiledWarning();
  closeCompiledModal();
}

function compiledResolveName(index, action) {
  const { lines, segments } = parseCompiledBody();
  if (segments.length !== compiledSections.length || !segments[index]) { saveCompiledEdits(); openCompiledModal(); return; }
  const seg = segments[index];
  const sec = compiledSections[index];
  if (action === 'trust') {
    // Position wins — accept the renamed header from here on.
    sec.expectedName = seg.name;
  } else if (action === 'restore') {
    lines[seg.headerLine] = compiledHeaderLine(sec.expectedName);
    bodyInput.value = lines.join('\n');
  } else if (action === 'discard') {
    // Put the header AND content back to the last saved version.
    const replaced = [compiledHeaderLine(sec.expectedName)]
      .concat(sec.originalParagraph ? sec.originalParagraph.split('\n') : []);
    bodyInput.value = lines.slice(0, seg.headerLine).concat(replaced, lines.slice(seg.contentEnd)).join('\n');
  }
  saveCompiledEdits();
  openCompiledModal();
}

function compiledResolveNotFound(index, action) {
  if (action === 'reload') { compiledRebuild(); return; }
  // 'append' — the original paragraph is gone from the source note; add this
  // version to the end of that note instead.
  const { segments } = parseCompiledBody();
  if (segments.length !== compiledSections.length || !segments[index]) { saveCompiledEdits(); openCompiledModal(); return; }
  const seg = segments[index];
  const sec = compiledSections[index];
  const note = Storage.getNote(sec.noteId);
  if (note && seg.content) {
    const base = (note.body || '').replace(/\n+$/, '');
    Storage.updateNote(sec.noteId, base + (base ? '\n\n' : '') + seg.content);
    sec.originalParagraph = seg.content;
  }
  saveCompiledEdits();
  openCompiledModal();
}

function openCompiledModal() {
  if (!compiledModal || !compiledModalBody) return;
  if (compiledIssueCount() === 0) { closeCompiledModal(); return; }
  let html = '';
  if (compiledIssues.count) {
    const { found, expected } = compiledIssues.count;
    html += `
      <p class="modal-hint">This view had ${expected} ━━ section marker${expected === 1 ? '' : 's'} but now has ${found}. Nothing is saving, so edits can't land in the wrong customer's note.</p>
      <div class="compiled-resolve-actions">
        <button class="compiled-action" data-act="close">Keep editing — I'll restore the ━━ lines</button>
        <button class="compiled-action danger-soft" data-act="rebuild">Rebuild view (discard unsaved edits)</button>
      </div>`;
  } else {
    compiledIssues.names.forEach(n => {
      html += `
        <div class="compiled-resolve-item">
          <p>Section ${n.index + 1}: expected header <strong>${escapeHtml(n.expected)}</strong> but found <strong>${escapeHtml(n.found || '(blank)')}</strong>. This section is not saving.</p>
          <div class="compiled-resolve-actions">
            <button class="compiled-action" data-act="name-trust" data-index="${n.index}">Save anyway</button>
            <button class="compiled-action" data-act="name-restore" data-index="${n.index}">Restore header name</button>
            <button class="compiled-action danger-soft" data-act="name-discard" data-index="${n.index}">Discard my edits here</button>
          </div>
        </div>`;
    });
    compiledIssues.notFound.forEach(n => {
      html += `
        <div class="compiled-resolve-item">
          <p><strong>${escapeHtml(n.name)}</strong>: the original paragraph changed elsewhere (maybe another device), so this edit couldn't be saved.</p>
          <div class="compiled-resolve-actions">
            <button class="compiled-action" data-act="nf-append" data-index="${n.index}">Save mine (add to their note)</button>
            <button class="compiled-action danger-soft" data-act="nf-reload" data-index="${n.index}">Discard mine and reload</button>
          </div>
        </div>`;
    });
  }
  compiledModalBody.innerHTML = html;
  compiledModalBody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      const index = parseInt(btn.dataset.index || '-1', 10);
      if (act === 'rebuild') compiledRebuild();
      else if (act === 'close') closeCompiledModal();
      else if (act === 'name-trust') compiledResolveName(index, 'trust');
      else if (act === 'name-restore') compiledResolveName(index, 'restore');
      else if (act === 'name-discard') compiledResolveName(index, 'discard');
      else if (act === 'nf-append') compiledResolveNotFound(index, 'append');
      else if (act === 'nf-reload') compiledResolveNotFound(index, 'reload');
    });
  });
  compiledModal.hidden = false;
}
function closeCompiledModal() { if (compiledModal) compiledModal.hidden = true; }

function clearCompiledState() {
  compiledSections = null;
  compiledKeyword = null;
  compiledIssues = { count: null, names: [], notFound: [] };
  if (compiledWarning) compiledWarning.hidden = true;
  closeCompiledModal();
  titleInput.readOnly = false;
}

function showSection(key) {
  hideAllScreens();
  activeSectionKey = key;
  const titles = { aggregator: 'Aggregators', recent: "Recent Customer's Notes", notes: 'General Notes' };
  renderCrumbs('crumbs-section', [{ label: 'Home', go: 'home' }, { label: titles[key] || key }]);
  renderSectionView(key);
  sectionView.classList.add('active');
  restoreScroll('section:' + key);
  if (!handlingPopstate) history.pushState({ screen: 'section', key }, '');
}

function renderSectionView(key) {
  if (!sectionViewList) return;
  // Show/hide count control for recent section
  if (sectionViewControls) {
    if (key === 'recent') {
      sectionViewControls.hidden = false;
      sectionViewControls.innerHTML = `
        <span style="font-size:13px;color:var(--ink-soft);margin-right:8px;">Showing:</span>
        <div class="stepper" style="flex-shrink:0;">
          <button class="stepper-btn" id="section-recent-down">−</button>
          <input id="section-recent-input" type="number" min="1" value="${sectionRecentLimit}" style="width:56px;text-align:center;" />
          <button class="stepper-btn" id="section-recent-up">+</button>
        </div>`;
      setTimeout(() => {
        const inp = document.getElementById('section-recent-input');
        const dn = document.getElementById('section-recent-down');
        const up = document.getElementById('section-recent-up');
        if (inp) inp.addEventListener('change', () => {
          const n = parseInt(inp.value, 10);
          if (!Number.isNaN(n) && n > 0) { sectionRecentLimit = n; renderSectionView('recent'); }
        });
        if (dn) dn.addEventListener('click', () => {
          sectionRecentLimit = Math.max(1, sectionRecentLimit - 10);
          if (inp) inp.value = sectionRecentLimit;
          renderSectionView('recent');
        });
        if (up) up.addEventListener('click', () => {
          sectionRecentLimit += 10;
          if (inp) inp.value = sectionRecentLimit;
          renderSectionView('recent');
        });
      }, 0);
    } else {
      sectionViewControls.hidden = true;
    }
  }

  if (key === 'aggregator') {
    const keywords = getKeywords();
    if (!keywords.length) {
      sectionViewList.innerHTML = '<p class="empty-state">No aggregator keywords configured.</p>';
      return;
    }
    const html = keywords.map(kw => {
      const matches = Storage.aggregateParagraphsByKeyword(kw);
      const count = matches.length;
      let previewHtml = '';
      if (count > 0) {
        const m = matches[0];
        const label = aggregateMatchLabel(m);
        const list = stripKeywordToList(m.paragraph, kw);
        const note = Storage.getNote(m.noteId);
        const noteTitle = (m.customerId && note) ? (splitTitleAndBody(note.body).title || '').trim() : '';
        const notePart = noteTitle ? ` - ${escapeHtml(noteTitle)}` : '';
        previewHtml = `<span class="match-customer">${escapeHtml(label)}</span>${notePart} - ${escapeHtml(list || '(empty)')}`;
      }
      return `
        <article class="note-card keyword-card" data-keyword="${escapeHtml(kw)}">
          <div class="note-head">
            <p class="note-title">${escapeHtml(kw)}</p>
            <span class="note-date">${count} ${count === 1 ? 'match' : 'matches'}</span>
          </div>
          ${previewHtml ? `<p class="note-preview">${previewHtml}</p>` : ''}
        </article>`;
    }).join('');
    sectionViewList.innerHTML = html;
    sectionViewList.querySelectorAll('.note-card[data-keyword]').forEach(card => {
      card.addEventListener('click', () => showAggregator(card.dataset.keyword));
    });
    return;
  }

  if (key === 'recent') {
    if (!Storage.isReady()) {
      sectionViewList.innerHTML = '<p class="empty-state" style="font-style:normal"><span class="nav-spinner" style="width:20px;height:20px;border-width:3px;"></span></p>';
      return;
    }
    const all = Storage.listRecentCustomerNotes(sectionRecentLimit);
    if (!all.length) { sectionViewList.innerHTML = notesEmptyState('No customer notes yet.'); return; }
    sectionViewList.innerHTML = all.map(n => {
      const def = Storage.getDefaultNoteForCustomer(n.customerId);
      const name = def ? (splitTitleAndBody(def.body).title || '').trim() : '';
      const { title, body } = splitTitleAndBody(n.body);
      const safeTitle = title.trim() ? escapeHtml(title) : '<span style="color:var(--ink-soft);font-style:italic">Untitled</span>';
      const preview = (body.split('\n').find(l => l.trim()) || '').trim();
      return `
        <article class="note-card home-pinned" data-id="${n.id}">
          <span class="customer-tag">${escapeHtml(name || 'Unnamed customer')}</span>
          <div class="note-head"><p class="note-title">${safeTitle}</p><span class="note-date">${formatDateTime(n.updated)}</span></div>
          ${preview ? `<p class="note-preview">${escapeHtml(preview)}</p>` : ''}
        </article>`;
    }).join('');
    sectionViewList.querySelectorAll('.note-card').forEach(card => {
      card.addEventListener('click', () => {
        const note = Storage.getNote(card.dataset.id);
        if (note) { returnScreen = 'customer-notes'; activeCustomerId = note.customerId; showEditor(note, 'note'); }
      });
    });
    return;
  }

  if (key === 'notes') {
    if (!Storage.isReady()) {
      sectionViewList.innerHTML = '<p class="empty-state" style="font-style:normal"><span class="nav-spinner" style="width:20px;height:20px;border-width:3px;"></span></p>';
      return;
    }
    const all = Storage.listNotes();
    if (!all.length) { sectionViewList.innerHTML = notesEmptyState('No general notes yet.'); return; }
    sectionViewList.innerHTML = all.map(n => renderNoteCard(n)).join('');
    sectionViewList.querySelectorAll('.note-card').forEach(card => {
      card.addEventListener('click', () => {
        const note = Storage.getNote(card.dataset.id);
        if (note) { returnScreen = 'notes'; showEditor(note, 'note'); }
      });
    });
  }
}

function showSettings() {
  hideAllScreens();
  renderCrumbs('crumbs-settings', [{ label: 'Home', go: 'home' }, { label: 'Settings' }]);
  window.scrollTo(0, 0);
  renderKeywordList();
  renderEmployeeList();
  if (accountEmailEl && auth.currentUser) accountEmailEl.textContent = auth.currentUser.email || '';
  refreshSeedButtons();
  const moveCheckedInput = document.getElementById('setting-move-checked');
  if (moveCheckedInput) moveCheckedInput.checked = getMoveCheckedToBottom();
  const collapseSearchInput = document.getElementById('setting-collapse-search');
  if (collapseSearchInput) collapseSearchInput.checked = getCollapseSearch();
  settingsView.classList.add('active');
  if (!handlingPopstate) history.pushState({ screen: 'settings' }, '');
  applyTheme(localStorage.getItem('na-theme') || 'dark');
  renderMembersList();
}

function showNotes() {
  returnScreen = 'notes';
  activeCustomerId = null;
  hideAllScreens();
  listView.classList.add('active');
  renderNotesList();
  history.replaceState({ screen: 'home' }, '');
  restoreScroll('home');
  if (swReg) swReg.update().catch(() => {});
}

const isDesktop = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function showCustomers() {
  returnScreen = 'customers';
  activeCustomerId = null;
  hideAllScreens();
  customersView.classList.add('active');
  renderCrumbs('crumbs-customers', [{ label: 'Home', go: 'home' }, { label: 'Customers' }]);
  renderCustomersList();
  restoreScroll('customers');
  if (isDesktop) setTimeout(() => customerSearchInput.focus(), 50);
  if (!handlingPopstate) history.pushState({ screen: 'customers' }, '');
}

function showCustomerNotes(customerId, returnTo) {
  customerNotesSearchTerm = '';
  if (customerNotesSearchInput) customerNotesSearchInput.value = '';
  const customer = Storage.getCustomer(customerId);
  if (!customer) {
    alert('This customer no longer exists — it may have been deleted.');
    showCustomers();
    return;
  }
  const def = Storage.ensureDefaultNoteForCustomer(customerId);
  const { title } = splitTitleAndBody(def.body);
  if (activeCustomerId !== customerId) closeFileGallery();
  activeCustomerId = customerId;
  returnScreen = 'customer-notes';
  customerNotesReturnTo = returnTo || { screen: 'customers' };
  renderCustomerFiles(customerId);
  renderCrumbs('crumbs-customer-notes', [
    { label: 'Home', go: 'home' },
    { label: 'Customers', go: 'customers' },
    { label: title.trim() || 'Unnamed customer' },
  ]);
  hideAllScreens();
  customerNotesView.classList.add('active');
  renderCustomerNotesList(customerId);
  restoreScroll('customer-notes:' + customerId);
  if (!handlingPopstate) history.pushState({ screen: 'customer-notes', customerId, returnTo: customerNotesReturnTo }, '');
}

function showEditor(record, type, cursorHint) {
  clearCompiledState();
  // Any editor open other than the one right after a + button clears Cancel;
  // the creating handler re-sets it immediately afterwards.
  pendingNewRecord = null;
  updateCancelBtn();
  currentId = record.id;
  currentType = type;
  currentIsDefault = !!record.isDefault;
  resetUndo();
  lastKnownRemoteBody = type === 'note' ? (record.body || '') : null;

  if (type === 'note') {
    const { title, body } = splitTitleAndBody(record.body);
    // Placeholders spell out what each kind of note expects — the default
    // note's title IS the customer's name, which isn't obvious otherwise.
    if (currentIsDefault) {
      titleInput.placeholder = 'Customer name (e.g. John Canuck)';
      bodyInput.placeholder = 'Address, phone, email, notes… (optional)';
    } else {
      titleInput.placeholder = record.customerId ? 'Note title' : 'General note title';
      bodyInput.placeholder = 'Start typing…';
    }
    titleInput.value = title;
    bodyInput.value = body;
  } else {
    titleInput.placeholder = 'Customer name';
    bodyInput.placeholder = 'Address';
    titleInput.value = record.name || '';
    bodyInput.value = record.address || '';
  }

  resetNoteSearch();
  const showNoteOnly = (type === 'note');
  // Hide the whole search wrap (incl. the collapsed 🔍) for customer records
  const noteSearchWrap = noteSearchInput.closest('.search-wrap');
  if (noteSearchWrap) noteSearchWrap.style.display = showNoteOnly ? '' : 'none';
  noteSearchCount.style.display = showNoteOnly ? '' : 'none';
  // Arrows appear only with an active search and 2+ hits (updateSearchCount)
  searchPrevBtn.style.display = 'none';
  searchNextBtn.style.display = 'none';
  if (editorMoreBtn) editorMoreBtn.closest('.editor-more-wrap').style.display = (showNoteOnly && !isReadOnlyRole()) ? '' : 'none';
  closeMoreDropdown();

  // Customer/bookkeeper roles: view-only editor.
  const readOnly = isReadOnlyRole();
  titleInput.readOnly = readOnly;
  bodyInput.readOnly = readOnly;
  // Checkbox toolbar button mutates the note — hide it for read-only roles
  if (checkboxBtn) checkboxBtn.style.display = readOnly ? 'none' : '';
  if (undoBtn) undoBtn.style.display = (showNoteOnly && !readOnly) ? '' : 'none';
  if (redoBtn) redoBtn.style.display = (showNoteOnly && !readOnly) ? '' : 'none';
  // Shared badge in the editor header
  const editorSharedBadge = document.getElementById('editor-shared-badge');
  if (editorSharedBadge) {
    const isShared = type === 'note' && isSharedWithLimitedUsers(record);
    editorSharedBadge.hidden = !(isAdminRole() && isShared);
  }

  // Breadcrumb: Home › Customers › <name> › Note. Only roles that can READ the
  // customers collection get the customer crumbs (employees/customers can't).
  const editorCrumbs = [{ label: 'Home', go: 'home' }];
  if (type === 'note' && record.customerId && canViewAllRole()) {
    editorCrumbs.push({ label: 'Customers', go: 'customers' });
    editorCrumbs.push({ label: customerCrumbLabel(record.customerId), go: 'customer', id: record.customerId });
  }
  editorCrumbs.push({ label: type === 'note' ? (currentIsDefault ? 'Customer details' : 'Note') : 'Customer' });
  renderCrumbs('crumbs-editor', editorCrumbs);

  // Delete is admin-only (and never on default notes)
  deleteBtn.style.display = (isAdminRole() && !(type === 'note' && currentIsDefault)) ? '' : 'none';
  const assignBtnEl = document.getElementById('assign-btn');
  if (assignBtnEl) assignBtnEl.hidden = (Storage.getRole() !== 'admin' || type !== 'note');
  const assignCustomerBtnEl = document.getElementById('assign-customer-btn');
  if (assignCustomerBtnEl) {
    // Admins can assign any note to a customer — or move it to a different
    // one — except a customer's default note (it defines the customer).
    const canAssign = isAdminRole() && type === 'note' && !currentIsDefault;
    assignCustomerBtnEl.hidden = !canAssign;
    if (canAssign) {
      const hasCustomer = !!record.customerId && !!Storage.getCustomer(record.customerId);
      assignCustomerBtnEl.textContent = hasCustomer ? 'Assign note to different customer' : 'Assign note to customer';
    }
  }
  const editorIifBtnEl = document.getElementById('editor-iif-btn');
  if (editorIifBtnEl) {
    const isHoursNote = type === 'note' && (splitTitleAndBody(record.body).title || '').trim().toLowerCase() === 'hours';
    // Editor IIF is admin-only (bookkeepers use Settings → QuickBooks; employees have no IIF access)
    editorIifBtnEl.hidden = !(isAdminRole() && isHoursNote);
  }

  hideAllScreens();
  editorView.classList.add('active');
  document.body.classList.add('editor-open');
  // Ensure page-level scroll is reset so the toolbar is at the top
  window.scrollTo(0, 0);
  if (!handlingPopstate) history.pushState({ screen: 'editor' }, '');

  setTimeout(() => {
    // If a cursor hint was passed (e.g. came from an aggregator match), scroll
    // to the matching paragraph but do NOT focus (avoids triggering keyboard).
    if (cursorHint && cursorHint.paragraph && type === 'note') {
      const bodyVal = bodyInput.value;
      const lines = cursorHint.paragraph.split('\n');
      for (let start = 0; start < lines.length; start++) {
        const candidate = lines.slice(start).join('\n');
        if (!candidate) continue;
        const idx = bodyVal.indexOf(candidate);
        if (idx !== -1) {
          bodyInput.setSelectionRange(idx, idx);
          const before = bodyVal.substring(0, idx);
          const lineHeight = parseFloat(getComputedStyle(bodyInput).lineHeight) || 22;
          const lineCount = (before.match(/\n/g) || []).length;
          const target = lineCount * lineHeight - bodyInput.clientHeight / 2 + lineHeight;
          bodyInput.scrollTop = Math.max(0, target);
          return;
        }
      }
    }
    // Do not auto-focus — keyboard should only appear when user taps the text
  }, 50);
}

function returnFromEditor() {
  if (returnScreen === 'aggregator-section') {
    // Leaving the compiled aggregator editor that was opened from the
    // "Aggregators" section screen.
    showSection('aggregator');
    if (handlingPopstate && currentPopstateTarget !== 'section') {
      history.pushState({ screen: 'section', key: 'aggregator' }, '');
    }
  } else if (returnScreen === 'customer-notes' && activeCustomerId) {
    showCustomerNotes(activeCustomerId);
    // Rebuild history if we didn't pop to the customer-notes entry
    if (handlingPopstate && currentPopstateTarget !== 'customer-notes') {
      history.pushState({ screen: 'customers' }, '');
      history.pushState({ screen: 'customer-notes', customerId: activeCustomerId, returnTo: customerNotesReturnTo }, '');
    }
  } else if (returnScreen === 'customers') {
    showCustomers();
    if (handlingPopstate && currentPopstateTarget !== 'customers') {
      history.pushState({ screen: 'customers' }, '');
    }
  } else if (returnScreen === 'orphans') {
    showOrphanNotes();
    if (handlingPopstate && currentPopstateTarget !== 'orphans') {
      history.pushState({ screen: 'orphans' }, '');
    }
  } else {
    showNotes();
  }
}

// ---------- home search ----------
function noteMatchesSearch(note, words) {
  const haystack = (note.body || '').toLowerCase();
  return words.every(w => haystack.includes(w));
}

function renderHomeSearchResults(term) {
  const words = term.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) { renderNotesList(); return; }

  // Collect all notes (general + customer)
  const allNotes = Storage.listAllNotes ? Storage.listAllNotes() : [
    ...Storage.listNotes(),
    ...Storage.listCustomers().flatMap(c => Storage.listNotesByCustomer(c.id)),
  ];

  const results = allNotes.filter(n => noteMatchesSearch(n, words));

  if (results.length === 0) {
    notesList.innerHTML = `<p class="empty-state">No notes match "${escapeHtml(term)}".</p>`;
    return;
  }

  notesList.innerHTML = results.map(n => {
    const { title, body } = splitTitleAndBody(n.body);
    const safeTitle = title.trim()
      ? escapeHtml(title)
      : '<span style="color:var(--ink-soft);font-style:italic">Untitled</span>';
    const firstBodyLine = (body.split('\n').find(l => l.trim() !== '') || '').trim();
    const safePreview = firstBodyLine ? escapeHtml(firstBodyLine) : '';
    let customerTag = '';
    if (n.customerId) {
      const def = Storage.getDefaultNoteForCustomer(n.customerId);
      const name = def ? (splitTitleAndBody(def.body).title || '').trim() : '';
      customerTag = `<span class="customer-tag">${escapeHtml(name || 'Unnamed customer')}</span>`;
    }
    return `
      <article class="note-card" data-id="${n.id}" data-kind="note">
        ${customerTag}
        <div class="note-head">
          <p class="note-title">${safeTitle}</p>
          <span class="note-date">${formatDateTime(n.updated)}</span>
        </div>
        ${safePreview ? `<p class="note-preview">${safePreview}</p>` : ''}
      </article>
    `;
  }).join('');

  notesList.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => {
      const note = Storage.getNote(card.dataset.id);
      if (note) {
        returnScreen = note.customerId ? 'customer-notes' : 'notes';
        if (note.customerId) activeCustomerId = note.customerId;
        showEditor(note, 'note');
        // Carry the home search into the note: pre-fill the in-note search and
        // highlight the first instance. Home search matches words scattered
        // anywhere, in-note search is a phrase — if the full phrase isn't in
        // this note, fall back to the first word.
        const phrase = term.trim();
        const haystack = (note.body || '').toLowerCase();
        const query = haystack.includes(phrase.toLowerCase()) ? phrase : words[0];
        noteSearchInput.value = query;
        findMatches(query);
        // gotoMatch scrolls via the highlight overlay — wait for layout
        // (showEditor's own cursor-hint timer is skipped: no hint passed).
        if (searchMatches.length > 0) setTimeout(() => gotoMatch(0), 80);
        else { updateSearchCount(); renderHighlights(); }
      }
    });
  });
}

// ---------- list rendering ----------
function renderNotesList() {
  if (homeSearchTerm.trim()) { renderHomeSearchResults(homeSearchTerm); return; }
  if (!Storage.isReady()) {
    notesList.innerHTML = '<p class="empty-state" style="font-style:normal"><span class="nav-spinner" style="width:20px;height:20px;border-width:3px;"></span></p>';
    return;
  }
  const notes = Storage.listNotes();
  const customersCount = Storage.listCustomers().length;

  // Customer/employee roles: simplified home — only the notes assigned to them.
  // (Admin and bookkeeper get the full home.)
  if (!canViewAllRole()) {
    const assigned = Storage.listAllNotes();
    const emptyState = isCustomerRole()
      ? '<p class="empty-state">No notes have been shared with you yet.</p>'
      : '<p class="empty-state">No notes yet. Tap <strong>+</strong> to add one.</p>';
    notesList.innerHTML = assigned.length === 0
      ? emptyState
      : '<p class="section-label">Your notes:</p>' + assigned.map(n => renderNoteCard(n)).join('');
    notesList.querySelectorAll('.note-card[data-id]').forEach(card => {
      card.addEventListener('click', () => {
        const note = Storage.getNote(card.dataset.id);
        if (note) { returnScreen = 'notes'; showEditor(note, 'note'); }
      });
    });
    return;
  }

  const customersCard = `
    <article class="note-card nav-card" data-nav="customers">
      <div class="note-head">
        <p class="note-title">Customers</p>
        <span class="note-chevron">›</span>
      </div>
      <p class="note-preview">${customersCount} ${customersCount === 1 ? 'customer' : 'customers'}</p>
    </article>
  `;

  // Price table card — admins/bookkeepers always, employees only when shared
  const priceItemCount = Storage.listPriceItems().length;
  const priceVendorCount = Storage.getPriceConfig().vendors.length;
  const priceCard = Storage.canViewPriceTable() ? `
    <article class="note-card nav-card" data-nav="price">
      <div class="note-head">
        <p class="note-title">Price Table</p>
        <span class="note-chevron">›</span>
      </div>
      <p class="note-preview">${priceItemCount} ${priceItemCount === 1 ? 'item' : 'items'} · ${priceVendorCount} ${priceVendorCount === 1 ? 'vendor' : 'vendors'}</p>
    </article>
  ` : '';

  const keywordsRanked = getKeywords()
    .map(kw => {
      const matches = Storage.aggregateParagraphsByKeyword(kw);
      const mostRecent = matches.length > 0 ? new Date(matches[0].updated).getTime() : 0;
      return { kw, matches, mostRecent };
    })
    .sort((a, b) => b.mostRecent - a.mostRecent)
    .slice(0, getAggregatorCount());

  const keywordHtml = keywordsRanked.map(({ kw, matches }) => {
    const count = matches.length;
    let previewHtml = '';
    if (count > 0) {
      const m = matches[0];
      const label = aggregateMatchLabel(m);
      const note = Storage.getNote(m.noteId);
      // For customer notes the note title adds context; for general notes the
      // label IS the note title, so don't repeat it.
      const noteTitle = (m.customerId && note) ? (splitTitleAndBody(note.body).title || '').trim() : '';
      const list = stripKeywordToList(m.paragraph, kw);
      const notePart = noteTitle ? ` - ${escapeHtml(noteTitle)}` : '';
      previewHtml = `<span class="match-customer">${escapeHtml(label)}</span>${notePart} - ${escapeHtml(list || '(empty)')}`;
    }
    return `
      <article class="note-card keyword-card" data-keyword="${escapeHtml(kw)}">
        <div class="note-head">
          <p class="note-title">${escapeHtml(kw)}</p>
          <span class="note-date">${count} ${count === 1 ? 'match' : 'matches'}</span>
        </div>
        ${previewHtml ? `<p class="note-preview">${previewHtml}</p>` : ''}
      </article>
    `;
  }).join('');

  const recent = Storage.listRecentCustomerNotes(getRecentCount());
  const recentHtml = recent.map(n => {
    const customer = Storage.getCustomer(n.customerId);
    const def = customer ? Storage.getDefaultNoteForCustomer(customer.id) : null;
    const customerName = def ? (splitTitleAndBody(def.body).title || '').trim() : '';
    const tag = customerName ? escapeHtml(customerName) : 'Unnamed customer';
    const { title, body } = splitTitleAndBody(n.body);
    const safeTitle = title.trim()
      ? escapeHtml(title)
      : '<span style="color:var(--ink-soft);font-style:italic">Untitled</span>';
    const firstBodyLine = (body.split('\n').find(l => l.trim() !== '') || '').trim();
    const safePreview = firstBodyLine ? escapeHtml(firstBodyLine) : '';
    const sharedBadge = isSharedWithLimitedUsers(n)
      ? '<span class="shared-badge" title="Shared with assigned users">Shared</span>'
      : '';
    return `
      <article class="note-card home-pinned" data-id="${n.id}" data-kind="note">
        <span class="customer-tag">${tag}</span>${sharedBadge}
        <div class="note-head">
          <p class="note-title">${safeTitle}</p>
          <span class="note-date">${formatDateTime(n.updated)}</span>
        </div>
        ${safePreview ? `<p class="note-preview">${safePreview}</p>` : ''}
      </article>
    `;
  }).join('');

  const generalLimit = getGeneralNotesCount();
  const recentNotes = notes.slice(0, generalLimit);
  const olderNotes = notes.slice(generalLimit);

  let notesHtml = '';
  if (notes.length === 0) {
    notesHtml = Storage.getNotesError()
      ? notesEmptyState('No notes yet.')
      : '<p class="empty-state">No notes yet. Tap <strong>+</strong> to add one.</p>';
  } else {
    notesHtml = recentNotes.map(n => renderNoteCard(n)).join('');
  }

  const olderHtml = olderNotes.length > 0
    ? `<p class="section-label">Older general notes:</p>` + olderNotes.map(n => renderNoteCard(n)).join('')
    : '';

  // Section heading with inline controls: − + move up/down, See all
  const order = getPinnedOrder();
  const sectionLabel = (text, key) => {
    const i = order.indexOf(key);
    const upDisabled = i <= 0 ? 'disabled' : '';
    const downDisabled = (i === -1 || i >= order.length - 1) ? 'disabled' : '';
    return `
    <p class="section-label">
      <button class="section-label-btn" data-section="${key}">${text}</button>
      <span class="section-ctrls">
        <button class="section-ctrl" data-count="${key}" data-delta="-1" aria-label="Show fewer">−</button>
        <button class="section-ctrl" data-count="${key}" data-delta="1" aria-label="Show more">+</button>
        <button class="section-ctrl" data-move="${key}" data-dir="-1" aria-label="Move section up" ${upDisabled}>↑</button>
        <button class="section-ctrl" data-move="${key}" data-dir="1" aria-label="Move section down" ${downDisabled}>↓</button>
      </span>
      <button class="section-label-all" data-section="${key}">See all ›</button>
    </p>`;
  };
  const pinnedBlock = getPinnedOrder().map(key => {
    if (key === 'aggregator') return sectionLabel('Aggregators:', 'aggregator') + keywordHtml;
    if (key === 'recent') return sectionLabel("Recent Customer's Notes:", 'recent') + recentHtml;
    if (key === 'notes') return sectionLabel('General Notes:', 'notes') + notesHtml;
    return '';
  }).join('');
  const orphanCount = Storage.listOrphanedNotes().length;
  const orphanCard = `
    <article class="note-card orphan-nav-card" data-nav="orphans" style="opacity:${orphanCount > 0 ? '1' : '0.45'};">
      <div class="note-head">
        <p class="note-title">Orphaned Notes</p>
        <span class="note-date">${orphanCount}</span>
      </div>
      <p class="note-preview">${orphanCount > 0 ? 'Tap to review notes with no customer' : 'No orphaned notes'}</p>
    </article>`;
  // Customers and Price Table sit side by side at the top of the home screen
  const navRow = `<div class="nav-card-row">${customersCard}${priceCard}</div>`;
  notesList.innerHTML = navRow + pinnedBlock + olderHtml + orphanCard;

  applyLayoutMode();
  notesList.querySelectorAll('[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.innerHTML = '<span class="nav-spinner" style="width:14px;height:14px;border-width:2px;vertical-align:middle;"></span>';
      setTimeout(() => showSection(btn.dataset.section), 0);
    });
  });

  // Inline section controls: how many to show, and section order
  notesList.querySelectorAll('[data-count]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const key = btn.dataset.count;
      const delta = parseInt(btn.dataset.delta, 10);
      const getters = { aggregator: getAggregatorCount, recent: getRecentCount, notes: getGeneralNotesCount };
      const settingKeys = { aggregator: 'aggregatorCount', recent: 'recentCount', notes: 'generalNotesCount' };
      if (!getters[key]) return;
      const next = Math.max(0, getters[key]() + delta);
      queueSetting(settingKeys[key], next); // debounced write, instant UI
      renderNotesList();
    });
  });
  notesList.querySelectorAll('[data-move]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      movePinnedSection(btn.dataset.move, parseInt(btn.dataset.dir, 10));
      renderNotesList();
    });
  });

  notesList.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.dataset.nav === 'customers') {
        const chevron = card.querySelector('.note-chevron');
        if (chevron) chevron.innerHTML = '<span class="nav-spinner"></span>';
        setTimeout(showCustomers, 0);
      }
      else if (card.dataset.keyword) showAggregator(card.dataset.keyword);
      else if (card.dataset.nav === 'price') showPriceTable();
      else if (card.dataset.nav === 'orphans') {
        const count = Storage.listOrphanedNotes().length;
        if (count > 0) showOrphanNotes();
      }
      else {
        const note = Storage.getNote(card.dataset.id);
        if (note) { returnScreen = 'notes'; showEditor(note, 'note'); }
      }
    });
  });
}

function renderNoteCard(n) {
  const { title, body } = splitTitleAndBody(n.body);
  const safeTitle = title.trim()
    ? escapeHtml(title)
    : '<span style="color:var(--ink-soft);font-style:italic">Untitled</span>';
  const safePreview = body.trim() ? escapeHtml(body) : '';
  const pinned = n.isDefault ? 'pinned' : '';
  // Customer tag: admins use the live lookup, others the stored snapshot
  let customerTag = '';
  if (n.customerId) {
    const name = canViewAllRole()
      ? Storage.getCustomerNameSnapshot(n.customerId)
      : (n.customerName || '');
    customerTag = `<span class="customer-tag">${escapeHtml(name || 'Unnamed customer')}</span>`;
  }
  // Shared badge for admin/bookkeeper: this note is visible to assigned users
  const sharedBadge = (canViewAllRole() && isSharedWithLimitedUsers(n))
    ? '<span class="shared-badge" title="Shared with assigned users">Shared</span>'
    : '';
  return `
    <article class="note-card ${pinned}" data-id="${n.id}" data-kind="note">
      ${customerTag}${sharedBadge}
      <div class="note-head">
        <p class="note-title">${safeTitle}</p>
        <span class="note-date">${formatDateTime(n.updated)}</span>
      </div>
      ${safePreview ? `<p class="note-preview">${safePreview}</p>` : ''}
    </article>
  `;
}

function customerSortKey(c) {
  if (getCustomerSort() === 'alpha') {
    const def = Storage.ensureDefaultNoteForCustomer(c.id);
    const { title } = splitTitleAndBody(def.body);
    return (title || '').trim().toLowerCase();
  }
  const def = Storage.getDefaultNoteForCustomer(c.id);
  let maxTs = new Date(c.updated).getTime();
  if (def) {
    const t = new Date(def.updated).getTime();
    if (t > maxTs) maxTs = t;
  }
  Storage.listNotesByCustomer(c.id).forEach(n => {
    const t = new Date(n.updated).getTime();
    if (t > maxTs) maxTs = t;
  });
  return maxTs;
}

function applyCustomerSort(customers) {
  const sorted = customers.slice();
  if (getCustomerSort() === 'alpha') {
    sorted.sort((a, b) => {
      const ak = customerSortKey(a);
      const bk = customerSortKey(b);
      if (!ak && bk) return 1;
      if (ak && !bk) return -1;
      return ak.localeCompare(bk);
    });
  } else {
    sorted.sort((a, b) => customerSortKey(b) - customerSortKey(a));
  }
  return sorted;
}

function updateSortButtons() {
  const v = getCustomerSort();
  sortAlphaBtn.setAttribute('aria-pressed', v === 'alpha');
  sortRecentBtn.setAttribute('aria-pressed', v === 'recent');
}

function customerMatchesSearch(c, term) {
  if (!term) return true;
  const def = Storage.getDefaultNoteForCustomer(c.id);
  const haystack = (def ? def.body : '').toLowerCase();
  const words = term.split(/\s+/).filter(w => w.length > 0);
  return words.every(w => haystack.includes(w));
}

function renderCustomersList() {
  updateSortButtons();
  if (!Storage.isReady()) {
    customersList.innerHTML = '<p class="empty-state" style="font-style:normal"><span class="nav-spinner" style="width:20px;height:20px;border-width:3px;"></span></p>';
    return;
  }
  const all = Storage.listCustomers();
  const term = customerSearchTerm.trim().toLowerCase();
  const filtered = all.filter(c => customerMatchesSearch(c, term));
  const customers = applyCustomerSort(filtered);

  if (all.length === 0) {
    customersList.innerHTML = '<p class="empty-state">No customers yet. Tap <strong>+</strong> to add one.</p>';
    return;
  }
  if (customers.length === 0) {
    customersList.innerHTML = '<p class="empty-state">No customers match “' + escapeHtml(customerSearchTerm) + '”.</p>';
    return;
  }
  customersList.innerHTML = customers.map(c => {
    const def = Storage.ensureDefaultNoteForCustomer(c.id);
    const { title, body } = splitTitleAndBody(def.body);
    const safeTitle = title.trim()
      ? escapeHtml(title)
      : '<span style="color:var(--ink-soft);font-style:italic">Untitled</span>';
    const firstBodyLine = (body.split('\n').find(l => l.trim() !== '') || '').trim();
    const safePreview = firstBodyLine ? escapeHtml(firstBodyLine) : '';
    return `
      <article class="note-card pinned" data-id="${c.id}" data-kind="customer">
        <div class="note-head">
          <p class="note-title">${safeTitle}</p>
          <span class="note-date">${formatDateTime(c.updated)}</span>
        </div>
        ${safePreview ? `<p class="note-preview">${safePreview}</p>` : ''}
      </article>
    `;
  }).join('');

  customersList.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => showCustomerNotes(card.dataset.id));
  });
}

function renderCustomerNotesList(customerId) {
  const all = Storage.listNotesByCustomer(customerId);
  const term = customerNotesSearchTerm.trim().toLowerCase();
  const words = term ? term.split(/\s+/).filter(w => w.length > 0) : [];
  const notes = words.length
    ? all.filter(n => words.every(w => (n.body || '').toLowerCase().includes(w)))
    : all;
  // Detach the persistent files section before re-rendering so innerHTML doesn't destroy it
  const filesSection = document.getElementById('customer-files-section');
  if (filesSection) filesSection.remove();

  if (notes.length === 0 && words.length) {
    customerNotesList.innerHTML = `<p class="empty-state">No notes match "${escapeHtml(customerNotesSearchTerm)}".</p>`;
    if (filesSection) customerNotesList.insertAdjacentElement('afterbegin', filesSection);
    return;
  }
  customerNotesList.innerHTML = notes.map(renderNoteCard).join('');
  customerNotesList.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => {
      const note = Storage.getNote(card.dataset.id);
      if (note) showEditor(note, 'note');
    });
  });
  // Place the files card right below the customer's default (pinned) note
  if (filesSection) {
    const defCard = customerNotesList.querySelector('.note-card.pinned');
    if (defCard) defCard.insertAdjacentElement('afterend', filesSection);
    else customerNotesList.insertAdjacentElement('afterbegin', filesSection);
  }
}

// ---------- editor save / back / delete ----------
function scheduleSave() {
  if (!currentId) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(commitSave, 400);
}
function commitSave() {
  if (!currentId) return;
  if (currentType === 'compiled') {
    saveCompiledEdits();
    return;
  }
  if (currentType === 'note') {
    const composed = composeBody(titleInput.value, bodyInput.value);
    // Track our own save so the remote-change detector doesn't fire on it
    lastKnownRemoteBody = composed;
    Storage.updateNote(currentId, composed);
  } else if (currentType === 'customer') {
    Storage.updateCustomer(currentId, {
      name: titleInput.value, address: bodyInput.value,
    });
  }
}

// Home + : admins pick note or customer; employees only create general notes,
// so for them it stays a single tap.
const fabMenu = document.getElementById('fab-menu');
function closeFabMenu() { if (fabMenu) fabMenu.hidden = true; }
// A record created seconds ago by a + button: Cancel discards it entirely.
// Cleared as soon as the editor opens anything else.
let pendingNewRecord = null; // { kind: 'note' | 'customer', id, customerId }
function newGeneralNote() {
  const note = Storage.createNote();
  returnScreen = 'notes';
  showEditor(note, 'note');
  pendingNewRecord = { kind: 'note', id: note.id };
  updateCancelBtn();
}
fab.addEventListener('click', (e) => {
  if (!isAdminRole() || !fabMenu) { newGeneralNote(); return; }
  e.stopPropagation();
  fabMenu.hidden = !fabMenu.hidden;
});
const fabNewNote = document.getElementById('fab-new-note');
const fabNewCustomer = document.getElementById('fab-new-customer');
if (fabNewNote) fabNewNote.addEventListener('click', () => { closeFabMenu(); newGeneralNote(); });
if (fabNewCustomer) fabNewCustomer.addEventListener('click', () => {
  closeFabMenu();
  const { customer, defaultNote } = Storage.createCustomer();
  activeCustomerId = customer.id;
  returnScreen = 'customer-notes';
  showEditor(defaultNote, 'note');
  pendingNewRecord = { kind: 'customer', id: customer.id };
  updateCancelBtn();
});
document.addEventListener('click', (e) => {
  if (fabMenu && !fabMenu.hidden && !fabMenu.contains(e.target) && e.target !== fab) closeFabMenu();
});
customersFab.addEventListener('click', () => {
  const { customer, defaultNote } = Storage.createCustomer();
  activeCustomerId = customer.id;
  returnScreen = 'customer-notes';
  showEditor(defaultNote, 'note');
  pendingNewRecord = { kind: 'customer', id: customer.id };
  updateCancelBtn();
});
customerNotesFab.addEventListener('click', () => {
  if (!activeCustomerId) return;
  const note = Storage.createNote({ customerId: activeCustomerId });
  returnScreen = 'customer-notes';
  showEditor(note, 'note');
  pendingNewRecord = { kind: 'note', id: note.id, customerId: activeCustomerId };
  updateCancelBtn();
});

settingsBtn.addEventListener('click', showSettings);

// ---------- home layout mode ----------
// The − + ↑ ↓ controls beside each section heading only appear while layout
// mode is on, so the everyday home screen stays clean.
let homeLayoutMode = false;
const layoutBtn = document.getElementById('layout-btn');
function applyLayoutMode() {
  if (notesList) notesList.classList.toggle('layout-mode', homeLayoutMode);
  if (layoutBtn) {
    layoutBtn.textContent = homeLayoutMode ? 'Done' : 'Layout';
    layoutBtn.setAttribute('aria-pressed', String(homeLayoutMode));
    layoutBtn.classList.toggle('active', homeLayoutMode);
  }
}
if (layoutBtn) layoutBtn.addEventListener('click', () => {
  homeLayoutMode = !homeLayoutMode;
  applyLayoutMode();
});

function goHome() {
  activeCustomerId = null;
  activeKeyword = null;
  homeSearchTerm = '';
  if (homeSearchInput) homeSearchInput.value = '';
  // Home button = home AND top; back navigation keeps its place
  resetScrollMemory();
  showNotes();
  // Check GitHub for a newer version every time we land on the home screen.
  // If one is found, it's downloaded, activated, and applied automatically —
  // no button or prompt needed.
  if (swReg) swReg.update().catch(() => {});
}

keywordAddBtn.addEventListener('click', async () => {
  if (await addKeyword(keywordInput.value)) {
    keywordInput.value = '';
    renderKeywordList();
  } else {
    keywordInput.value = '';
  }
  keywordInput.focus();
});
keywordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    keywordAddBtn.click();
  }
});

if (employeeAddBtn) employeeAddBtn.addEventListener('click', async () => {
  const typeSel = document.getElementById('employee-type-input');
  if (await addEmployee(employeeInput.value, typeSel ? typeSel.value : 'journeyman')) {
    employeeInput.value = '';
    renderEmployeeList();
  } else {
    employeeInput.value = '';
  }
  if (employeeInput) employeeInput.focus();
});
if (employeeInput) employeeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); employeeAddBtn.click(); }
});

// CSV import
function parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else { field += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cur.push(field); field = ''; }
      else if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (ch === '\r') { /* skip; \n handles row end */ }
      else { field += ch; }
    }
  }
  if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

importCsvBtn.addEventListener('click', async () => {
  const raw = importCsvInput.value.trim();
  if (!raw) { importStatus.textContent = 'Paste some CSV first.'; return; }
  const rows = parseCsv(raw);
  const dataRows = importHasHeader.checked ? rows.slice(1) : rows;
  if (dataRows.length === 0) { importStatus.textContent = 'Nothing to import.'; return; }
  const customerRows = dataRows.map(cells => ({
    body: cells.map(c => c.trim()).filter(c => c !== '').join('\n'),
  })).filter(r => r.body);
  if (customerRows.length === 0) { importStatus.textContent = 'Nothing to import.'; return; }
  importStatus.textContent = `Importing ${customerRows.length}…`;
  importCsvBtn.disabled = true;
  try {
    const n = await Storage.importCustomers(customerRows);
    importStatus.textContent = `Imported ${n} customer${n === 1 ? '' : 's'}.`;
    importCsvInput.value = '';
  } catch (e) {
    importStatus.textContent = 'Import failed: ' + (e && e.message ? e.message : 'unknown');
  } finally {
    importCsvBtn.disabled = false;
  }
});

customerSearchInput.addEventListener('input', () => {
  customerSearchTerm = customerSearchInput.value;
  renderCustomersList();
});

homeSearchInput.addEventListener('input', () => {
  homeSearchTerm = homeSearchInput.value;
  renderNotesList();
});

if (customerNotesSearchInput) {
  customerNotesSearchInput.addEventListener('input', () => {
    customerNotesSearchTerm = customerNotesSearchInput.value;
    if (activeCustomerId) renderCustomerNotesList(activeCustomerId);
  });
}

sortAlphaBtn.addEventListener('click', async () => {
  if (getCustomerSort() === 'alpha') return;
  await setCustomerSort('alpha');
  renderCustomersList();
});
sortRecentBtn.addEventListener('click', async () => {
  if (getCustomerSort() === 'recent') return;
  await setCustomerSort('recent');
  renderCustomersList();
});

titleInput.addEventListener('input', scheduleSave);
bodyInput.addEventListener('input', scheduleSave);

checkboxBtn.addEventListener('click', () => {
  if (isReadOnlyRole()) return; // view-only
  if (!currentId) return;
  toggleCheckboxOnSelection();
});

function formatDateForInsert(d) {
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
function insertDateAtCursor(dateStr) {
  if (!currentId) return;
  pushUndo();
  undoLastRunType = null;
  const pos = bodyInput.selectionStart ?? bodyInput.value.length;
  const value = bodyInput.value;
  bodyInput.value = value.substring(0, pos) + dateStr + value.substring(pos);
  const newPos = pos + dateStr.length;
  bodyInput.selectionStart = bodyInput.selectionEnd = newPos;
  bodyInput.focus();
  scheduleSave();
}
function closeMoreDropdown() { if (editorMoreDropdown) editorMoreDropdown.hidden = true; }
function toggleMoreDropdown() {
  if (!editorMoreDropdown) return;
  editorMoreDropdown.hidden = !editorMoreDropdown.hidden;
}
if (editorMoreBtn) editorMoreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMoreDropdown();
});
// Close dropdown when any item inside it is clicked
// Exception: date-picker-btn is a label that opens the native picker — let iOS handle it first
if (editorMoreDropdown) editorMoreDropdown.addEventListener('click', (e) => {
  if (e.target.closest('#date-picker-btn')) return;
  closeMoreDropdown();
});

dateTodayBtn.addEventListener('click', () => {
  insertDateAtCursor(formatDateForInsert(new Date()));
});
datePickerInput.addEventListener('change', () => {
  if (!datePickerInput.value) return;
  const [y, m, d] = datePickerInput.value.split('-').map(Number);
  insertDateAtCursor(formatDateForInsert(new Date(y, m - 1, d)));
  datePickerInput.value = '';
  closeMoreDropdown();
});
document.addEventListener('click', (e) => {
  if (editorMoreDropdown && !editorMoreDropdown.hidden) {
    if (!editorMoreDropdown.contains(e.target) && e.target !== editorMoreBtn) closeMoreDropdown();
  }
});

const highlightEl = document.getElementById('editor-body-highlight');

function renderHighlights() {
  if (!highlightEl) return;
  const term = noteSearchInput.value;
  const body = bodyInput.value;
  // Only highlight body matches (title matches are shown via selection on the title input)
  const bodyMatches = searchMatches.filter(m => !m.inTitle);
  if (!term || bodyMatches.length === 0) {
    highlightEl.innerHTML = '';
    return;
  }
  let html = '';
  let last = 0;
  bodyMatches.forEach((m, idx) => {
    // searchIndex may point to a title match — find the current body match index
    const globalIdx = searchMatches.indexOf(m);
    html += escapeHtml(body.substring(last, m.start));
    const cls = globalIdx === searchIndex ? 'current-match' : '';
    html += `<mark class="${cls}">${escapeHtml(body.substring(m.start, m.end))}</mark>`;
    last = m.end;
  });
  html += escapeHtml(body.substring(last));
  highlightEl.innerHTML = html;
  highlightEl.scrollTop = bodyInput.scrollTop;
}

function findMatches(term) {
  searchMatches = [];
  if (!term) return;
  const termLower = term.toLowerCase();
  // Search title
  const title = titleInput.value;
  const titleLower = title.toLowerCase();
  let i = 0;
  while ((i = titleLower.indexOf(termLower, i)) !== -1) {
    searchMatches.push({ start: i, end: i + term.length, inTitle: true });
    i += Math.max(term.length, 1);
  }
  // Search body
  const body = bodyInput.value;
  const bodyLower = body.toLowerCase();
  i = 0;
  while ((i = bodyLower.indexOf(termLower, i)) !== -1) {
    searchMatches.push({ start: i, end: i + term.length, inTitle: false });
    i += Math.max(term.length, 1);
  }
}
function updateSearchCount() {
  if (!noteSearchInput.value) noteSearchCount.textContent = '';
  else if (searchMatches.length === 0) noteSearchCount.textContent = '0';
  else noteSearchCount.textContent = `${searchIndex + 1}/${searchMatches.length}`;
  // Prev/next arrows only make sense with an active search and 2+ hits
  const showNav = !!noteSearchInput.value && searchMatches.length > 1;
  searchPrevBtn.style.display = showNav ? '' : 'none';
  searchNextBtn.style.display = showNav ? '' : 'none';
}
function gotoMatch(index) {
  if (searchMatches.length === 0) { updateSearchCount(); renderHighlights(); return; }
  const n = searchMatches.length;
  searchIndex = ((index % n) + n) % n;
  const m = searchMatches[searchIndex];
  updateSearchCount();
  renderHighlights();
  if (m.inTitle) {
    // Don't focus the title (would raise the mobile keyboard) — flash it instead
    titleInput.classList.add('search-hit-flash');
    setTimeout(() => titleInput.classList.remove('search-hit-flash'), 800);
    bodyInput.scrollTop = 0;
    if (highlightEl) highlightEl.scrollTop = 0;
  } else {
    bodyInput.setSelectionRange(m.start, m.end);
    // The highlight overlay mirrors the text exactly (wrapping included), so the
    // current match's real position centers the scroll accurately.
    const mark = highlightEl ? highlightEl.querySelector('mark.current-match') : null;
    if (mark) {
      const target = mark.offsetTop - (bodyInput.clientHeight / 2) + (mark.offsetHeight / 2);
      bodyInput.scrollTop = Math.max(0, target);
      highlightEl.scrollTop = bodyInput.scrollTop;
    }
  }
}
function resetNoteSearch() {
  noteSearchInput.value = '';
  searchMatches = [];
  searchIndex = 0;
  updateSearchCount();
  renderHighlights();
  refreshSearchClears();
}
noteSearchInput.addEventListener('input', () => {
  findMatches(noteSearchInput.value);
  if (searchMatches.length > 0) gotoMatch(0);
  else { updateSearchCount(); renderHighlights(); }
});

bodyInput.addEventListener('scroll', () => {
  if (highlightEl) highlightEl.scrollTop = bodyInput.scrollTop;
});
noteSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); gotoMatch(searchIndex + (e.shiftKey ? -1 : 1)); }
  else if (e.key === 'Escape') { e.preventDefault(); resetNoteSearch(); }
});
// Arrow navigation dismisses the keyboard (blur) — it stays down until a text field is tapped again
searchPrevBtn.addEventListener('click', () => { gotoMatch(searchIndex - 1); noteSearchInput.blur(); });
searchNextBtn.addEventListener('click', () => { gotoMatch(searchIndex + 1); noteSearchInput.blur(); });
bodyInput.addEventListener('input', () => {
  if (noteSearchInput.value) {
    findMatches(noteSearchInput.value);
    if (searchIndex >= searchMatches.length) searchIndex = Math.max(0, searchMatches.length - 1);
    updateSearchCount();
  }
});

// Whether the textarea was already focused BEFORE this tap (pointerdown fires
// before focus) — used to decide whether the keyboard should come up.
let bodyWasFocusedBeforeTap = false;
bodyInput.addEventListener('pointerdown', () => {
  bodyWasFocusedBeforeTap = document.activeElement === bodyInput;
});

// The readonly trick: a readonly textarea can still be tapped (caret moves)
// but never raises the mobile keyboard. On touch devices we flip it readonly
// for the duration of the tap; the click handler then either keeps it that way
// (checkbox tap → no keyboard) or restores + refocuses (normal tap → keyboard).
let bodyTempReadonly = false;
let bodyReadonlyTimer = null;
function restoreBodyEditable() {
  if (!bodyTempReadonly) return;
  bodyTempReadonly = false;
  if (!isReadOnlyRole() && currentType !== null) bodyInput.readOnly = false;
  if (bodyReadonlyTimer) { clearTimeout(bodyReadonlyTimer); bodyReadonlyTimer = null; }
}
bodyInput.addEventListener('touchstart', () => {
  if (isReadOnlyRole() || bodyInput.readOnly) return;
  if (document.activeElement === bodyInput) return; // already typing
  bodyTempReadonly = true;
  bodyInput.readOnly = true;
  // Safety net: a tap that never becomes a click (scroll/drag) must not leave
  // the note stuck readonly.
  if (bodyReadonlyTimer) clearTimeout(bodyReadonlyTimer);
  bodyReadonlyTimer = setTimeout(restoreBodyEditable, 700);
}, { passive: true });

bodyInput.addEventListener('click', () => {
  if (isReadOnlyRole()) { restoreBodyEditable(); return; } // view-only
  const value = bodyInput.value;
  const pos = bodyInput.selectionStart;
  const lineStart = pos == null ? -1 : value.lastIndexOf('\n', pos - 1) + 1;
  const col = pos == null ? -1 : pos - lineStart;
  const head = lineStart < 0 ? '' : value.substring(lineStart, lineStart + 2);
  // An EMPTY checkbox line is only two characters long, so every tap on it
  // lands "on the box" — tapping to type would tick the item instead. Skip the
  // toggle when there's no text yet and just place the cursor.
  let lineEnd = lineStart < 0 ? -1 : value.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = value.length;
  const lineHasText = lineStart >= 0 && value.substring(lineStart + 2, lineEnd).trim() !== '';
  let replacement = null;
  if (col >= 0 && col <= 2 && lineHasText) {
    if (head === '☐ ') replacement = '☑ ';
    else if (head === '☑ ') replacement = '☐ ';
  }

  if (!replacement) {
    // Normal tap to edit — restore editability and refocus within the same
    // gesture so the keyboard opens with the caret where the user tapped.
    if (bodyTempReadonly) {
      const caret = pos;
      restoreBodyEditable();
      bodyInput.blur();
      bodyInput.focus();
      if (caret != null) bodyInput.setSelectionRange(caret, caret);
    }
    return;
  }

  pushUndo(); // one undo step covers the toggle AND its sink-to-bottom
  undoLastRunType = null;
  bodyInput.value = value.substring(0, lineStart) + replacement + value.substring(lineStart + 2);
  bodyInput.selectionStart = bodyInput.selectionEnd = pos;
  sinkCheckedLines(pos);
  // Checkbox tap: keep the keyboard away. The textarea stays readonly for this
  // gesture (restored right after), and we blur as a second line of defense.
  const wasTemp = bodyTempReadonly;
  restoreBodyEditable();
  if (!bodyWasFocusedBeforeTap || wasTemp) bodyInput.blur();
  scheduleSave();
});

// ---------- undo (note body only) ----------
// Custom stack — programmatic edits (checkboxes, sink, date insert) wipe the
// browser's native undo, so the app keeps its own. One snapshot per word typed
// or per action; capped at 100; cleared per note and on remote changes.
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const editorToast = document.getElementById('editor-toast');
let undoStack = [];
let redoStack = [];
let undoLastRunType = null;
let lastKnownRemoteBody = null; // body as last loaded/saved — detects remote edits
let editorToastTimer = null;

function updateUndoBtn() {
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}
function resetUndo() { undoStack = []; redoStack = []; undoLastRunType = null; updateUndoBtn(); }
function snapshotState() {
  return { text: bodyInput.value, selStart: bodyInput.selectionStart, selEnd: bodyInput.selectionEnd };
}
function pushUndo() {
  if (!currentId) return;
  undoStack.push(snapshotState());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = []; // a new edit discards the redo branch
  updateUndoBtn();
}
function showEditorToast(msg) {
  if (!editorToast) return;
  editorToast.textContent = msg;
  editorToast.hidden = false;
  if (editorToastTimer) clearTimeout(editorToastTimer);
  editorToastTimer = setTimeout(() => { editorToast.hidden = true; }, 3000);
}
function restoreSnapshot(snap) {
  bodyInput.value = snap.text;
  const s = snap.selStart == null ? snap.text.length : snap.selStart;
  const e = snap.selEnd == null ? snap.text.length : snap.selEnd;
  bodyInput.setSelectionRange(s, e);
  undoLastRunType = null;
  updateUndoBtn();
  // The input event refreshes search highlights and schedules the save
  bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
}
function doUndo() {
  if (!undoStack.length || !currentId) return;
  const snap = undoStack.pop();
  redoStack.push(snapshotState());
  restoreSnapshot(snap);
}
function doRedo() {
  if (!redoStack.length || !currentId) return;
  const snap = redoStack.pop();
  undoStack.push(snapshotState());
  if (undoStack.length > 100) undoStack.shift();
  restoreSnapshot(snap);
}

// Typing granularity: snapshot at word boundaries, on insert/delete direction
// changes, and before chunk operations (paste, newline, autocorrect).
bodyInput.addEventListener('beforeinput', (e) => {
  if (!currentId) return;
  const t = e.inputType || '';
  const isDelete = t.startsWith('delete');
  const isChunk = t === 'insertFromPaste' || t === 'insertFromDrop'
    || t === 'insertReplacementText' || t === 'insertParagraph' || t === 'insertLineBreak';
  const wordBoundary = t === 'insertText' && e.data != null && /\s/.test(e.data);
  const runType = isDelete ? 'del' : 'ins';
  if (undoStack.length === 0 || isChunk || wordBoundary || runType !== undoLastRunType) pushUndo();
  undoLastRunType = runType;
});

if (undoBtn) {
  // pointerdown preventDefault: don't steal focus (keyboard stays as-is)
  undoBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  undoBtn.addEventListener('click', doUndo);
}
if (redoBtn) {
  redoBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  redoBtn.addEventListener('click', doRedo);
}

// Desktop shortcuts route to our stacks (the native ones are unreliable here):
// Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo
bodyInput.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); }
});

// ---------- move checked items to paragraph bottom (per-device setting) ----------
function getMoveCheckedToBottom() { return localStorage.getItem('na-move-checked') === '1'; }

// If the setting is on, sink ☑ lines to the bottom of the paragraph containing
// `pos` (stable order otherwise). Paragraph bounds are blank lines and — in the
// compiled aggregator editor — ━━ section headers, so lines never cross into a
// neighboring section. The cursor follows the line it was on.
function sinkCheckedLines(pos) {
  if (!getMoveCheckedToBottom()) return;
  const lines = bodyInput.value.split('\n');
  // Locate the line containing pos, and the offset within it
  let idx = 0, off = 0, run = 0;
  for (let i = 0; i < lines.length; i++) {
    if (pos <= run + lines[i].length) { idx = i; off = pos - run; break; }
    run += lines[i].length + 1;
    idx = i;
    off = lines[i].length;
  }
  const isBoundary = l => l.trim() === '' || compiledHeaderRe.test(l);
  if (isBoundary(lines[idx])) return;
  let start = idx;
  while (start > 0 && !isBoundary(lines[start - 1])) start--;
  let end = idx;
  while (end + 1 < lines.length && !isBoundary(lines[end + 1])) end++;
  const para = lines.slice(start, end + 1).map((text, i) => ({ text, orig: start + i }));
  const checkedRe = /^☑ /;
  const sorted = para.filter(p => !checkedRe.test(p.text)).concat(para.filter(p => checkedRe.test(p.text)));
  if (sorted.every((p, i) => p.orig === start + i)) return; // already in order
  const newLines = lines.slice(0, start).concat(sorted.map(p => p.text), lines.slice(end + 1));
  // The cursor stays put: same line NUMBER and column as before the sink (the
  // line that slid up now sits under the cursor) — no focus/scroll jump.
  let newPos = 0;
  for (let i = 0; i < idx; i++) newPos += newLines[i].length + 1;
  newPos += Math.min(off, newLines[idx].length);
  bodyInput.value = newLines.join('\n');
  bodyInput.selectionStart = bodyInput.selectionEnd = newPos;
}

function toggleCheckboxOnSelection() {
  pushUndo();
  undoLastRunType = null;
  const value = bodyInput.value;
  const selStart = bodyInput.selectionStart;
  const selEnd = bodyInput.selectionEnd;
  const lineStart = value.lastIndexOf('\n', selStart - 1) + 1;
  let probe = selEnd;
  if (selEnd > selStart && value[selEnd - 1] !== '\n') probe = selEnd - 1;
  let lineEnd = value.indexOf('\n', probe);
  if (lineEnd === -1) lineEnd = value.length;
  const block = value.substring(lineStart, lineEnd);
  const lines = block.split('\n');
  const checkboxRe = /^[☐☑] /;
  const allHave = lines.every(l => checkboxRe.test(l));
  const newLines = allHave
    ? lines.map(l => l.replace(checkboxRe, ''))
    : lines.map(l => checkboxRe.test(l) ? l : '☐ ' + l);
  const newBlock = newLines.join('\n');
  bodyInput.value = value.substring(0, lineStart) + newBlock + value.substring(lineEnd);
  if (selStart === selEnd) {
    const delta = allHave ? -2 : 2;
    bodyInput.selectionStart = bodyInput.selectionEnd = Math.max(lineStart, selStart + delta);
  } else {
    bodyInput.selectionStart = lineStart;
    bodyInput.selectionEnd = lineStart + newBlock.length;
  }
  sinkCheckedLines(bodyInput.selectionStart);
  bodyInput.focus();
  scheduleSave();
}

titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); bodyInput.focus(); }
});

bodyInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const val = bodyInput.value;
  const pos = bodyInput.selectionStart;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const currentLine = val.substring(lineStart, pos);
  const prefixMatch = currentLine.match(/^([-–]\s|☐\s|☑\s)/);
  if (!prefixMatch) return;
  pushUndo(); // list auto-continue is one undo step
  undoLastRunType = null;
  // If the line is only the prefix (empty item), remove it and stop
  if (currentLine === prefixMatch[0]) {
    e.preventDefault();
    bodyInput.value = val.substring(0, lineStart) + val.substring(pos);
    bodyInput.selectionStart = bodyInput.selectionEnd = lineStart;
    scheduleSave();
    return;
  }
  e.preventDefault();
  // Always continue with ☐ (not ☑)
  const prefix = prefixMatch[0].startsWith('☑') ? '☐ ' : prefixMatch[0];
  const insert = '\n' + prefix;
  bodyInput.value = val.substring(0, pos) + insert + val.substring(pos);
  bodyInput.selectionStart = bodyInput.selectionEnd = pos + insert.length;
  scheduleSave();
});

function commitAndCleanupEditor() {
  let cancelledCustomer = false;
  if (currentType === 'compiled') {
    // Compiled aggregator note: flush the last save; never delete anything.
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveCompiledEdits();
    currentId = null;
    currentType = null;
    currentIsDefault = false;
    clearCompiledState();
    return false;
  }
  if (currentId) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    commitSave();
    const composed = composeBody(titleInput.value, bodyInput.value);
    if (currentType === 'note') {
      if (currentIsDefault) {
        if (composed.trim() === '') {
          const note = Storage.getNote(currentId);
          if (note && note.customerId) {
            Storage.deleteCustomer(note.customerId);
            cancelledCustomer = true;
          }
        }
      } else if (composed.trim() === '') {
        Storage.deleteNote(currentId);
      }
    } else if (currentType === 'customer') {
      if (!titleInput.value.trim() && !bodyInput.value.trim()) {
        Storage.deleteCustomer(currentId);
      }
    }
  }
  currentId = null;
  currentType = null;
  currentIsDefault = false;
  resetUndo();
  lastKnownRemoteBody = null;
  pendingNewRecord = null;
  updateCancelBtn();
  return cancelledCustomer;
}

// Android/browser back button support
window.addEventListener('popstate', (e) => {
  handlingPopstate = true;
  const screen = e.state && e.state.screen;
  currentPopstateTarget = screen;

  // Lightbox and file gallery sit above everything — back closes them first.
  if (fileLightbox && !fileLightbox.hidden) {
    fileLightbox.hidden = true;
    fileLightboxImg.src = '';
    handlingPopstate = false; return;
  }
  if (galleryView && !galleryView.hidden) {
    closeFileGallery();
    handlingPopstate = false; return;
  }

  if (!screen) {
    // Bottom of the history stack (stateless entry). If we're not on the home
    // screen, show it (showNotes re-stamps this entry as home) instead of doing
    // nothing — otherwise the next back press exits the app from a sub-screen.
    if (!listView.classList.contains('active')) {
      if (editorView.classList.contains('active')) commitAndCleanupEditor();
      showNotes();
    }
    handlingPopstate = false;
    return;
  }

  // Editor check MUST come before screen === 'home' so cleanup always runs
  if (editorView.classList.contains('active')) {
    const cancelledCustomer = commitAndCleanupEditor();
    if (cancelledCustomer) {
      activeCustomerId = null;
      showCustomers();
    } else {
      returnFromEditor();
    }
    handlingPopstate = false; return;
  }

  if (screen === 'home') {
    showNotes();
    handlingPopstate = false; return;
  }

  // Section view → home
  if (sectionView && sectionView.classList.contains('active')) {
    showNotes(); handlingPopstate = false; return;
  }

  // Screen-based: if customer-notes is showing, always go to customers
  if (customerNotesView.classList.contains('active')) {
    const ret = customerNotesReturnTo;
    if (ret && ret.screen === 'aggregator' && ret.keyword) showAggregator(ret.keyword);
    else showCustomers();
    handlingPopstate = false; return;
  }

  if (screen === 'editor') { returnFromEditor(); handlingPopstate = false; return; }
  if (screen === 'customers') { showCustomers(); handlingPopstate = false; return; }
  if (screen === 'customer-notes') {
    if (e.state.customerId) showCustomerNotes(e.state.customerId, e.state.returnTo);
    else showCustomers();
    handlingPopstate = false; return;
  }
  if (screen === 'aggregator') { showAggregator(e.state.keyword); handlingPopstate = false; return; }
  if (screen === 'orphans') { showOrphanNotes(); handlingPopstate = false; return; }
  if (screen === 'price') { showPriceTable(); handlingPopstate = false; return; }
  if (screen === 'section') { showSection(e.state.key); handlingPopstate = false; return; }
  if (screen === 'settings') { showSettings(); handlingPopstate = false; return; }
  showNotes();
  handlingPopstate = false;
});

// ---------- Cancel (discard a just-created note/customer) ----------
const editorCancelBtn = document.getElementById('editor-cancel-btn');
function updateCancelBtn() {
  if (!editorCancelBtn) return;
  const show = !!pendingNewRecord && currentType === 'note' && currentId === pendingNewRecord.id;
  editorCancelBtn.hidden = !show;
  // Cancel already discards the record — showing 🗑 next to it is redundant.
  // (showEditor sets delete per role/note type; this only overrides while a
  // brand-new record is open.)
  if (show && deleteBtn) deleteBtn.style.display = 'none';
}
if (editorCancelBtn) editorCancelBtn.addEventListener('click', () => {
  const rec = pendingNewRecord;
  if (!rec) return;
  // Nothing to keep: drop the save timer so it can't resurrect the record
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  pendingNewRecord = null;
  currentId = null; currentType = null; currentIsDefault = false;
  resetUndo();
  clearCompiledState();
  if (rec.kind === 'customer') {
    Storage.deleteCustomer(rec.id);
    activeCustomerId = null;
    showCustomers();
  } else {
    Storage.deleteNote(rec.id);
    if (rec.customerId) showCustomerNotes(rec.customerId);
    else showNotes();
  }
});

deleteBtn.addEventListener('click', () => {
  if (!currentId) return;
  if (currentType === 'note' && currentIsDefault) return;
  const label = currentType === 'customer'
    ? 'Delete this customer and all their notes?'
    : 'Delete this note?';
  if (confirm(label)) {
    if (currentType === 'customer') {
      Storage.deleteCustomer(currentId);
      currentId = null; currentType = null; currentIsDefault = false;
      activeCustomerId = null;
      showCustomers();
      return;
    }
    Storage.deleteNote(currentId);
    currentId = null; currentType = null; currentIsDefault = false;
    returnFromEditor();
  }
});

// ---------- assign users ----------
const assignBtn = document.getElementById('assign-btn');
const assignModal = document.getElementById('assign-modal');
const assignModalClose = document.getElementById('assign-modal-close');
const assignMembersList = document.getElementById('assign-members-list');
const assignSaveBtn = document.getElementById('assign-save-btn');

function openAssignModal() {
  if (!currentId || !assignModal) return;
  const note = Storage.getNote(currentId);
  if (!note) return;
  const assigned = note.assignedTo || [];
  // Only limited roles can be picked — admins/bookkeepers see everything anyway.
  const members = Storage.listMembers().filter(m => m.role === 'employee' || m.role === 'customer');

  if (members.length === 0) {
    assignMembersList.innerHTML = '<li style="font-size:14px;color:var(--ink-soft)">No employee or customer members yet.</li>';
  } else {
    assignMembersList.innerHTML = members.map(m => `
      <li class="assign-member-item">
        <input type="checkbox" id="assign-${m.uid}" data-uid="${m.uid}" ${assigned.includes(m.uid) ? 'checked' : ''} />
        <label for="assign-${m.uid}" style="flex:1;cursor:pointer">
          ${escapeHtml(m.email || m.uid)}
          <span style="font-size:12px;color:var(--ink-soft);margin-left:6px">${m.role}</span>
        </label>
      </li>
    `).join('');
  }
  assignModal.hidden = false;
}

if (assignBtn) assignBtn.addEventListener('click', openAssignModal);
if (assignModalClose) assignModalClose.addEventListener('click', () => { assignModal.hidden = true; });
if (assignModal) assignModal.addEventListener('click', (e) => { if (e.target === assignModal) assignModal.hidden = true; });

// ---------- assign to customer ----------
const assignCustomerModal = document.getElementById('assign-customer-modal');
const assignCustomerModalClose = document.getElementById('assign-customer-modal-close');
const assignCustomerSearch = document.getElementById('assign-customer-search');
const assignCustomerList = document.getElementById('assign-customer-list');
const assignCustomerBtn = document.getElementById('assign-customer-btn');

function renderAssignCustomerList(filter) {
  const words = (filter || '').trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
  const customers = Storage.listCustomers().filter(c => {
    if (!words.length) return true;
    const def = Storage.getDefaultNoteForCustomer(c.id);
    const haystack = (def ? def.body : '').toLowerCase();
    return words.every(w => haystack.includes(w));
  });
  if (!assignCustomerList) return;
  // A note that already belongs to a customer can be sent back to the general
  // pool from here (no separate menu item needed).
  const note = currentId ? Storage.getNote(currentId) : null;
  const noneRow = (note && note.customerId)
    ? `<li class="assign-customer-item assign-customer-none" data-id="">
         <p class="assign-none-title">None — make this a general note</p>
         <p class="assign-none-hint">Removes it from the customer; the note itself is kept.</p>
       </li>`
    : '';
  if (customers.length === 0) {
    assignCustomerList.innerHTML = noneRow
      + '<li style="padding:10px;font-size:14px;color:var(--ink-soft)">No customers found.</li>';
    wireAssignCustomerRows();
    return;
  }
  assignCustomerList.innerHTML = noneRow + customers.map(c => {
    const def = Storage.getDefaultNoteForCustomer(c.id);
    const { title, body } = def ? splitTitleAndBody(def.body) : { title: '', body: '' };
    const name = title.trim() || 'Unnamed customer';
    const secondLine = (body.split('\n').find(l => l.trim()) || '').trim();
    return `<li class="assign-customer-item" data-id="${c.id}" style="padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--line);">
      <p style="margin:0;font-size:15px;">${escapeHtml(name)}</p>
      ${secondLine ? `<p style="margin:2px 0 0;font-size:12px;color:var(--ink-soft);">${escapeHtml(secondLine)}</p>` : ''}
    </li>`;
  }).join('');
  wireAssignCustomerRows();
}

function wireAssignCustomerRows() {
  assignCustomerList.querySelectorAll('.assign-customer-item').forEach(item => {
    item.addEventListener('click', () => {
      if (!currentId) return;
      commitSave();
      const targetId = item.dataset.id || null; // '' = None (general note)
      Storage.assignNoteToCustomer(currentId, targetId);
      assignCustomerModal.hidden = true;
      currentId = null; currentType = null; currentIsDefault = false;
      if (!targetId) {
        activeCustomerId = null;
        showNotes();
        return;
      }
      activeCustomerId = targetId;
      returnScreen = 'customer-notes';
      showCustomerNotes(targetId);
    });
  });
}

if (assignCustomerBtn) assignCustomerBtn.addEventListener('click', () => {
  if (!assignCustomerModal) return;
  if (assignCustomerSearch) assignCustomerSearch.value = '';
  refreshSearchClears();
  renderAssignCustomerList('');
  assignCustomerModal.hidden = false;
  setTimeout(() => { if (assignCustomerSearch) assignCustomerSearch.focus(); }, 50);
});
if (assignCustomerModalClose) assignCustomerModalClose.addEventListener('click', () => { assignCustomerModal.hidden = true; });
if (assignCustomerModal) assignCustomerModal.addEventListener('click', (e) => { if (e.target === assignCustomerModal) assignCustomerModal.hidden = true; });
if (assignCustomerSearch) assignCustomerSearch.addEventListener('input', () => renderAssignCustomerList(assignCustomerSearch.value));

if (assignSaveBtn) {
  assignSaveBtn.addEventListener('click', () => {
    if (!currentId) return;
    const checked = [...assignMembersList.querySelectorAll('input[type="checkbox"]:checked')];
    const uids = checked.map(cb => cb.dataset.uid);
    Storage.assignUsersToNote(currentId, uids);
    assignModal.hidden = true;
  });
}

// ---------- auth bootstrap ----------
function showSignin() {
  hideAllScreens();
  // Never fall back to the plain form while a link sign-in is still in play
  if (linkinCard && !linkinCard.hidden) { signinView.classList.add('active'); return; }
  signinView.classList.add('active');
}

if (signinBtn) {
  signinBtn.addEventListener('click', async () => {
    signinError.textContent = '';
    if (signinMessage) signinMessage.textContent = '';
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error(err);
      signinError.textContent = err && err.message ? err.message : 'Sign-in failed.';
    }
  });
}

// ---------- email link + password auth ----------
const EMAIL_FOR_SIGNIN_KEY = 'emailForSignIn';

function friendlyAuthError(err) {
  const code = err && err.code ? err.code : '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Wrong email or password. If you haven’t set a password yet, use the sign-in link option below.';
  }
  if (code === 'auth/invalid-email') return 'Please enter a valid email address.';
  if (code === 'auth/missing-password') return 'Please enter your password.';
  if (code === 'auth/too-many-requests') return 'Too many attempts. Please try again later.';
  if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code') {
    return 'That sign-in link has expired or was already used. Request a new one.';
  }
  return err && err.message ? err.message : 'Sign-in failed.';
}

async function sendMagicLink(email) {
  signinError.textContent = '';
  if (signinMessage) signinMessage.textContent = '';
  if (!email) {
    signinError.textContent = 'Enter your email address first.';
    return;
  }
  try {
    await sendSignInLinkToEmail(auth, email, {
      url: APP_URL,
      handleCodeInApp: true,
    });
    window.localStorage.setItem(EMAIL_FOR_SIGNIN_KEY, email);
    if (signinMessage) signinMessage.textContent = `Sign-in link sent to ${email}. Check your inbox.`;
  } catch (err) {
    console.error(err);
    signinError.textContent = friendlyAuthError(err);
  }
}

if (emailSigninBtn) {
  emailSigninBtn.addEventListener('click', async () => {
    signinError.textContent = '';
    if (signinMessage) signinMessage.textContent = '';
    const email = (signinEmailInput.value || '').trim();
    const password = signinPasswordInput.value || '';
    if (!email || !password) {
      signinError.textContent = 'Enter your email and password, or request a sign-in link.';
      return;
    }
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      console.error(err);
      signinError.textContent = friendlyAuthError(err);
    }
  });
}

if (magicLinkBtn) {
  magicLinkBtn.addEventListener('click', () => sendMagicLink((signinEmailInput.value || '').trim()));
}
if (forgotPasswordBtn) {
  forgotPasswordBtn.addEventListener('click', () => sendMagicLink((signinEmailInput.value || '').trim()));
}

function showSetPasswordModal() {
  if (!setPasswordModal) return;
  setPasswordInput.value = '';
  setPasswordConfirm.value = '';
  setPasswordError.textContent = '';
  setPasswordModal.hidden = false;
}

if (setPasswordSave) {
  setPasswordSave.addEventListener('click', async () => {
    setPasswordError.textContent = '';
    const pw = setPasswordInput.value;
    if (pw.length < 6) { setPasswordError.textContent = 'Password must be at least 6 characters.'; return; }
    if (pw !== setPasswordConfirm.value) { setPasswordError.textContent = 'Passwords don’t match.'; return; }
    try {
      await updatePassword(auth.currentUser, pw);
      setPasswordModal.hidden = true;
    } catch (err) {
      console.error(err);
      setPasswordError.textContent = err && err.message ? err.message : 'Could not set password.';
    }
  });
}
if (setPasswordSkip) {
  setPasswordSkip.addEventListener('click', () => { setPasswordModal.hidden = true; });
}

// Complete magic-link sign-in if the page was opened from an emailed link.
//
// The tricky case is an INVITE: the admin triggered the email, so the
// invitee's browser has no stored address. The old code used window.prompt(),
// which browsers can suppress (and in-app email webviews often do) — the
// function then returned silently and the plain sign-in screen appeared, as if
// the link had failed. It also stripped the link's one-time code from the URL
// even on failure, so nothing could be retried. Now: a dedicated
// "Finishing sign-in…" card, an in-page email confirm form, and the URL is
// only cleaned after success.
let pendingPasswordPrompt = false;
const linkinCard = document.getElementById('linkin-card');
const signinCard = document.getElementById('signin-card');
const linkinStatus = document.getElementById('linkin-status');
const linkinConfirm = document.getElementById('linkin-confirm');
const linkinEmail = document.getElementById('linkin-email');
const linkinContinue = document.getElementById('linkin-continue');
const linkinError = document.getElementById('linkin-error');
const linkinNewLink = document.getElementById('linkin-newlink');

function showLinkinCard(on) {
  if (!linkinCard || !signinCard) return;
  linkinCard.hidden = !on;
  signinCard.hidden = on;
  if (on) {
    hideAllScreens();
    signinView.classList.add('active');
  } else if (linkinError) {
    linkinError.textContent = '';
    if (linkinConfirm) linkinConfirm.hidden = true;
    if (linkinNewLink) linkinNewLink.hidden = true;
  }
}
function linkinAskForEmail(msg) {
  if (linkinStatus) linkinStatus.textContent = msg || 'Confirm your email to finish signing in.';
  if (linkinConfirm) linkinConfirm.hidden = false;
  if (linkinNewLink) linkinNewLink.hidden = false;
  setTimeout(() => { if (linkinEmail) linkinEmail.focus(); }, 50);
}

async function tryLinkSignin(email) {
  if (linkinError) linkinError.textContent = '';
  const addr = (email || '').trim();
  if (!addr) { linkinAskForEmail(); return false; }
  if (linkinStatus) linkinStatus.textContent = 'Finishing sign-in…';
  if (linkinConfirm) linkinConfirm.hidden = true;
  try {
    await signInWithEmailLink(auth, addr, window.location.href);
    window.localStorage.removeItem(EMAIL_FOR_SIGNIN_KEY);
    pendingPasswordPrompt = true;
    // Only now is the one-time code spent — safe to clean the URL. Keep a
    // screen state: a stateless bottom entry breaks the back button.
    window.history.replaceState({ screen: 'home' }, document.title, window.location.origin + window.location.pathname);
    maybeShowInstallHint();
    return true;
  } catch (err) {
    console.error(err);
    const code = err && err.code;
    if (linkinError) linkinError.textContent = friendlyAuthError(err);
    if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code') {
      // The link itself is spent — retrying the address won't help
      if (linkinStatus) linkinStatus.textContent = 'This sign-in link can’t be used.';
      if (linkinConfirm) linkinConfirm.hidden = true;
      if (linkinNewLink) linkinNewLink.hidden = false;
    } else {
      // Most likely a mistyped/mismatched address — let them correct it. The
      // URL still holds the code, so Continue can try again.
      linkinAskForEmail('That didn’t match. Confirm the email address this link was sent to:');
    }
    return false;
  }
}

async function completeEmailLinkSignin() {
  if (!isSignInWithEmailLink(auth, window.location.href)) return;
  showLinkinCard(true);
  const stored = window.localStorage.getItem(EMAIL_FOR_SIGNIN_KEY);
  if (stored) { await tryLinkSignin(stored); return; }
  // Invite case: this browser never requested the link, so ask in-page
  linkinAskForEmail();
}

if (linkinContinue) {
  linkinContinue.addEventListener('click', () => tryLinkSignin(linkinEmail.value));
}
if (linkinEmail) {
  linkinEmail.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tryLinkSignin(linkinEmail.value); }
  });
}
if (linkinNewLink) {
  linkinNewLink.addEventListener('click', async () => {
    const addr = (linkinEmail && linkinEmail.value.trim()) || '';
    if (!addr) { linkinAskForEmail('Enter your email address and we’ll send a fresh link.'); return; }
    showLinkinCard(false);
    if (signinEmailInput) signinEmailInput.value = addr;
    await sendMagicLink(addr);
  });
}

// After signing in from a link in a normal browser tab, nudge the user to
// install the app — sessions in an email app's in-app browser don't carry
// over, and the installed app is what they'll want day to day.
const installHint = document.getElementById('install-hint');
const installHintText = document.getElementById('install-hint-text');
const installHintClose = document.getElementById('install-hint-close');
function maybeShowInstallHint() {
  if (!installHint || isStandaloneApp) return;
  if (localStorage.getItem('na-install-hint-dismissed') === '1') return;
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  installHintText.textContent = iOS
    ? 'Tip: tap the Share button, then “Add to Home Screen” to keep JobPilot one tap away.'
    : 'Tip: use your browser’s “Install app” / “Add to Home screen” option to keep JobPilot one tap away.';
  installHint.hidden = false;
}
if (installHintClose) {
  installHintClose.addEventListener('click', () => {
    localStorage.setItem('na-install-hint-dismissed', '1');
    installHint.hidden = true;
  });
}
// ---------- always-visible ✕ clear buttons on search fields ----------
const SEARCH_CLEAR_IDS = ['home-search-input', 'customer-search', 'customer-notes-search', 'note-search-input', 'assign-customer-search'];

// Empty every search field and its backing term (used by the tutorial: a
// filtered list hides the cards its steps point at).
function clearAllSearches() {
  homeSearchTerm = '';
  customerSearchTerm = '';
  customerNotesSearchTerm = '';
  if (homeSearchInput) homeSearchInput.value = '';
  if (customerSearchInput) customerSearchInput.value = '';
  if (customerNotesSearchInput) customerNotesSearchInput.value = '';
  if (noteSearchInput) noteSearchInput.value = '';
  refreshSearchClears();
}

function refreshSearchClears() {
  SEARCH_CLEAR_IDS.forEach(id => {
    const input = document.getElementById(id);
    const wrap = input ? input.closest('.search-wrap') : null;
    const btn = wrap ? wrap.querySelector('.search-clear') : null;
    if (btn) btn.hidden = !input.value;
  });
  refreshSearchCollapse();
}

SEARCH_CLEAR_IDS.forEach(id => {
  const input = document.getElementById(id);
  const wrap = input ? input.closest('.search-wrap') : null;
  const btn = wrap ? wrap.querySelector('.search-clear') : null;
  if (!btn) return;
  input.addEventListener('input', () => { btn.hidden = !input.value; });
  btn.addEventListener('click', () => {
    input.value = '';
    // Fire the normal input event so lists/highlights reset as if cleared by hand
    input.dispatchEvent(new Event('input', { bubbles: true }));
    btn.hidden = true;
  });
});

// ---------- collapsible search bars (per-device setting) ----------
// When enabled, an EMPTY, unfocused search bar collapses to a 🔍 icon;
// tapping the icon expands and focuses it. Bars with text stay expanded.
const COLLAPSIBLE_SEARCH_IDS = ['home-search-input', 'customer-search', 'customer-notes-search', 'note-search-input'];

function getCollapseSearch() { return localStorage.getItem('na-collapse-search') === '1'; }

function syncSearchCollapse(input) {
  const wrap = input.closest('.search-wrap');
  if (!wrap || !wrap.querySelector('.search-open')) return;
  const collapsed = getCollapseSearch() && !input.value && document.activeElement !== input;
  wrap.classList.toggle('collapsed', collapsed);
}

function refreshSearchCollapse() {
  COLLAPSIBLE_SEARCH_IDS.forEach(id => {
    const input = document.getElementById(id);
    if (input) syncSearchCollapse(input);
  });
}

COLLAPSIBLE_SEARCH_IDS.forEach(id => {
  const input = document.getElementById(id);
  const wrap = input ? input.closest('.search-wrap') : null;
  const openBtn = wrap ? wrap.querySelector('.search-open') : null;
  if (!openBtn) return;
  openBtn.addEventListener('click', () => {
    wrap.classList.remove('collapsed');
    input.focus();
  });
  input.addEventListener('input', () => syncSearchCollapse(input));
  input.addEventListener('focus', () => syncSearchCollapse(input));
  input.addEventListener('blur', () => syncSearchCollapse(input));
});
refreshSearchCollapse();

// Show/Hide password toggles — the set-password one flips both fields at once
function wirePasswordToggle(toggleId, inputIds) {
  const btn = document.getElementById(toggleId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const show = btn.textContent === 'Show';
    inputIds.forEach(id => {
      const inp = document.getElementById(id);
      if (inp) inp.type = show ? 'text' : 'password';
    });
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', (show ? 'Hide' : 'Show') + ' password');
  });
}
wirePasswordToggle('signin-password-toggle', ['signin-password']);
wirePasswordToggle('set-password-toggle', ['set-password-input', 'set-password-confirm']);

const emailLinkSigninReady = completeEmailLinkSignin();
if (signoutBtn) {
  signoutBtn.addEventListener('click', async () => { await signOut(auth); });
}

// ---------- sample data + first-run welcome ----------
const seedBtn = document.getElementById('seed-btn');
const unseedBtn = document.getElementById('unseed-btn');
const seedStatus = document.getElementById('seed-status');
const welcomeModal = document.getElementById('welcome-modal');

function refreshSeedButtons() {
  if (!seedBtn || !unseedBtn) return;
  const has = Storage.hasSampleData();
  unseedBtn.hidden = !has;
  seedBtn.textContent = has ? 'Add more sample data' : 'Add sample data';
}

if (seedBtn) {
  seedBtn.addEventListener('click', async () => {
    seedBtn.disabled = true;
    if (seedStatus) seedStatus.textContent = 'Adding…';
    const { customers, notes } = await Storage.seedSampleData();
    if (seedStatus) seedStatus.textContent = `Added ${customers} customers and ${notes} notes.`;
    seedBtn.disabled = false;
    refreshSeedButtons();
  });
}
if (unseedBtn) {
  unseedBtn.addEventListener('click', async () => {
    if (!confirm('Remove all sample customers and notes? Your own data is not affected.')) return;
    unseedBtn.disabled = true;
    const { customers, notes } = await Storage.removeSampleData();
    if (seedStatus) seedStatus.textContent = `Removed ${customers} customers and ${notes} notes.`;
    unseedBtn.disabled = false;
    refreshSeedButtons();
  });
}

// Offer sample data + the tour the first time an admin opens an empty org.
// The choice is stored org-side so other devices don't ask again.
function maybeShowWelcome() {
  if (!welcomeModal) return;
  if (!isAdminRole()) return;
  if (Storage.getSettings().onboardingSeen) return;
  if (!Storage.isOrgEmpty()) return;
  welcomeModal.hidden = false;
}
function dismissWelcome() {
  if (welcomeModal) welcomeModal.hidden = true;
  Storage.setSetting('onboardingSeen', true);
}
const welcomeSeedTour = document.getElementById('welcome-seed-tour');
const welcomeTour = document.getElementById('welcome-tour');
const welcomeEmpty = document.getElementById('welcome-empty');
if (welcomeSeedTour) {
  welcomeSeedTour.addEventListener('click', async () => {
    welcomeSeedTour.disabled = true;
    await Storage.seedSampleData();
    refreshSeedButtons();
    dismissWelcome();
    welcomeSeedTour.disabled = false;
    // Let the seeded data render before the first bubble measures its target
    setTimeout(() => startTutorial(1), 200);
  });
}
if (welcomeTour) {
  welcomeTour.addEventListener('click', () => { dismissWelcome(); setTimeout(() => startTutorial(1), 100); });
}
if (welcomeEmpty) welcomeEmpty.addEventListener('click', dismissWelcome);

// ---------- role-based UI ----------
const ROLE_LABELS = { admin: 'Admin', employee: 'Employee', bookkeeper: 'Bookkeeper', customer: 'Customer' };

function applyRoleUI(role) {
  const isAdminRole = role === 'admin';
  const isCustomer = role === 'customer';
  // Admin-only controls: customer creation, per-customer note creation, delete
  const adminControls = [
    document.getElementById('customers-fab'),
    document.getElementById('customer-notes-fab'),
    document.getElementById('delete-btn'),
  ];
  adminControls.forEach(el => { if (el) el.style.display = isAdminRole ? '' : 'none'; });
  // Home + FAB: admins and employees can create general notes; read-only roles cannot
  const homeFab = document.getElementById('fab');
  if (homeFab) homeFab.style.display = (isCustomer || role === 'bookkeeper') ? 'none' : '';
  // Admin-only settings rows
  document.querySelectorAll('[data-staff-only]').forEach(el => {
    el.style.display = isAdminRole ? '' : 'none';
  });
  // Layout button only for roles that see the home sections at all
  const layoutBtnEl = document.getElementById('layout-btn');
  if (layoutBtnEl) layoutBtnEl.hidden = !(role === 'admin' || role === 'bookkeeper');
  // Personal editing prefs: hidden for read-only roles (they can't edit notes)
  document.querySelectorAll('[data-editor-pref]').forEach(el => {
    el.style.display = (isCustomer || role === 'bookkeeper') ? 'none' : '';
  });
  // QuickBooks/IIF tools: admin and bookkeeper (read-only export)
  document.querySelectorAll('[data-role-iif]').forEach(el => {
    el.style.display = (isAdminRole || role === 'bookkeeper') ? '' : 'none';
  });
  // Orphan view write controls: admin only
  ['orphan-select-all-btn', 'orphan-delete-selected-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isAdminRole ? '' : 'none';
  });
}

function isCustomerRole() { return Storage.getRole() === 'customer'; }
function isAdminRole() { return Storage.getRole() === 'admin'; }
function isBookkeeperRole() { return Storage.getRole() === 'bookkeeper'; }
// Bookkeeper and customer can never modify anything
function isReadOnlyRole() { return isCustomerRole() || isBookkeeperRole(); }
// Admin and bookkeeper see all notes and customers
function canViewAllRole() { return isAdminRole() || isBookkeeperRole(); }

// A note counts as "shared" only when someone with a limited role
// (employee/customer) is on its assigned list — admin/bookkeeper accounts
// see every note anyway, so sharing with them means nothing for the badge.
function isSharedWithLimitedUsers(note) {
  if (!note || !Array.isArray(note.assignedTo)) return false;
  return note.assignedTo.some(uid => {
    const m = Storage.getMember(uid);
    return !!m && (m.role === 'employee' || m.role === 'customer');
  });
}

// ---------- shared pill tooltip (tap a pill → who is this shared with) ----------
const sharedTooltip = document.getElementById('shared-tooltip');
let sharedTooltipTimer = null;

function hideSharedTooltip() {
  if (!sharedTooltip) return;
  sharedTooltip.hidden = true;
  if (sharedTooltipTimer) { clearTimeout(sharedTooltipTimer); sharedTooltipTimer = null; }
}

function showSharedTooltip(pillEl, note) {
  if (!sharedTooltip) return;
  // Always show SOMETHING on tap — silent no-shows made the pill impossible
  // to diagnose. List every assigned entry, including admins/bookkeepers and
  // uids that no longer resolve to a member ("removed user").
  let html;
  if (!note) {
    html = "Couldn't load this note.";
  } else {
    const entries = (note.assignedTo || []).map(uid => {
      const m = Storage.getMember(uid);
      if (!m) return `<em>removed user</em><span class="tooltip-role">${escapeHtml(uid.slice(0, 8))}…</span>`;
      return `${escapeHtml(m.name || m.email || m.uid)}<span class="tooltip-role">${escapeHtml(m.role)}</span>`;
    });
    html = entries.length === 0
      ? 'Not shared with anyone.'
      : 'Shared with:<br>' + entries.join('<br>');
  }
  sharedTooltip.innerHTML = html;
  sharedTooltip.hidden = false;
  // Position above the pill, clamped to the viewport; below it if no room
  const r = pillEl.getBoundingClientRect();
  const tw = sharedTooltip.offsetWidth;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = r.top - sharedTooltip.offsetHeight - 8;
  if (top < 8) top = r.bottom + 8;
  sharedTooltip.style.left = `${left}px`;
  sharedTooltip.style.top = `${top}px`;
  sharedTooltipTimer = setTimeout(hideSharedTooltip, 4000);
}

// Capture-phase so a pill tap never falls through to the card (which opens the note)
document.addEventListener('click', (e) => {
  const pill = e.target.closest ? e.target.closest('.shared-badge') : null;
  if (!pill) { hideSharedTooltip(); return; }
  e.stopPropagation();
  e.preventDefault();
  let note = null;
  if (pill.id === 'editor-shared-badge') {
    note = currentId ? Storage.getNote(currentId) : null;
  } else {
    const card = pill.closest('.note-card');
    note = card ? Storage.getNote(card.dataset.id) : null;
  }
  hideSharedTooltip();
  showSharedTooltip(pill, note);
}, true);

// ---------- Users tab ----------
function renderMembersList() {
  const membersList = document.getElementById('members-list');
  const invitesList = document.getElementById('invites-list');
  const role = Storage.getRole();
  if (!membersList || role !== 'admin') return;

  const members = Storage.listMembers();
  const currentUid = Storage.getUid();
  membersList.innerHTML = members.map(m => `
    <li class="member-item">
      <span class="member-email">${escapeHtml(m.email || m.uid)}</span>
      <select class="member-role-select" data-uid="${m.uid}" ${m.uid === currentUid ? 'disabled' : ''}>
        <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
        <option value="employee" ${m.role === 'employee' ? 'selected' : ''}>Employee</option>
        <option value="bookkeeper" ${m.role === 'bookkeeper' ? 'selected' : ''}>Bookkeeper</option>
        <option value="customer" ${m.role === 'customer' ? 'selected' : ''}>Customer</option>
      </select>
      ${m.uid !== currentUid ? `<button class="member-remove-btn" data-uid="${m.uid}" title="Remove">✕</button>` : ''}
    </li>
  `).join('');

  membersList.querySelectorAll('.member-role-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      await Storage.updateMemberRole(sel.dataset.uid, sel.value);
    });
  });
  membersList.querySelectorAll('.member-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('Remove this user from the org?')) {
        await Storage.removeMember(btn.dataset.uid);
        renderMembersList();
      }
    });
  });

  if (invitesList) {
    const invites = Storage.listInvites();
    invitesList.innerHTML = invites.length === 0
      ? '<li style="font-size:13px;color:var(--ink-soft)">No pending invites</li>'
      : invites.map(inv => `
        <li class="member-item">
          <span class="member-email">${escapeHtml(inv.email)}</span>
          <span style="font-size:12px;color:var(--ink-soft)">${inv.role}</span>
          <button class="member-remove-btn" data-email="${escapeHtml(inv.email)}" title="Cancel">✕</button>
        </li>
      `).join('');
    invitesList.querySelectorAll('.member-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await Storage.cancelInvite(btn.dataset.email);
        renderMembersList();
      });
    });
  }
}

const inviteBtn = document.getElementById('invite-btn');
const inviteEmailInput = document.getElementById('invite-email');
const inviteRoleSelect = document.getElementById('invite-role');
const inviteStatus = document.getElementById('invite-status');

if (inviteBtn) {
  inviteBtn.addEventListener('click', async () => {
    const email = inviteEmailInput ? inviteEmailInput.value.trim() : '';
    const role = inviteRoleSelect ? inviteRoleSelect.value : 'employee';
    if (!email) { if (inviteStatus) inviteStatus.textContent = 'Please enter an email.'; return; }
    inviteBtn.disabled = true;
    if (inviteStatus) inviteStatus.textContent = 'Sending…';
    try {
      await Storage.inviteUser(email, role);
      // Email them a sign-in link that doubles as the invite.
      // Note: no localStorage write here — this browser isn't the one signing in.
      try {
        await sendSignInLinkToEmail(auth, email, { url: APP_URL, handleCodeInApp: true });
        if (inviteStatus) inviteStatus.textContent = `Invited ${email} — sign-in link sent.`;
      } catch (mailErr) {
        console.error(mailErr);
        if (inviteStatus) inviteStatus.textContent = `Invite created, but the email failed: ${mailErr.message || mailErr}`;
      }
      if (inviteEmailInput) inviteEmailInput.value = '';
      renderMembersList();
    } catch (e) {
      if (inviteStatus) inviteStatus.textContent = 'Failed: ' + (e.message || e);
    }
    inviteBtn.disabled = false;
  });
}

// ---------- theme (light / dark) ----------
function applyTheme(theme) {
  document.body.classList.toggle('dark-mode', theme === 'dark');
  const lightBtn = document.getElementById('theme-light-btn');
  const darkBtn = document.getElementById('theme-dark-btn');
  if (lightBtn) lightBtn.classList.toggle('active', theme !== 'dark');
  if (darkBtn) darkBtn.classList.toggle('active', theme === 'dark');
}

const savedTheme = localStorage.getItem('na-theme') || 'dark';
applyTheme(savedTheme);

const moveCheckedToggle = document.getElementById('setting-move-checked');
if (moveCheckedToggle) {
  moveCheckedToggle.addEventListener('change', () => {
    localStorage.setItem('na-move-checked', moveCheckedToggle.checked ? '1' : '0');
  });
}

const collapseSearchToggle = document.getElementById('setting-collapse-search');
if (collapseSearchToggle) {
  collapseSearchToggle.addEventListener('change', () => {
    localStorage.setItem('na-collapse-search', collapseSearchToggle.checked ? '1' : '0');
    refreshSearchCollapse();
  });
}

const themeLightBtn = document.getElementById('theme-light-btn');
const themeDarkBtn = document.getElementById('theme-dark-btn');
if (themeLightBtn) {
  themeLightBtn.addEventListener('click', () => {
    localStorage.setItem('na-theme', 'light');
    applyTheme('light');
  });
}
if (themeDarkBtn) {
  themeDarkBtn.addEventListener('click', () => {
    localStorage.setItem('na-theme', 'dark');
    applyTheme('dark');
  });
}

function rerenderCurrent() {
  if (signinView && signinView.classList.contains('active')) return;
  if (editorView.classList.contains('active')) {
    // A remote edit to the OPEN note makes undo snapshots stale — clear them
    // and tell the user. Our own saves keep lastKnownRemoteBody current, so
    // they never trigger this.
    if (currentType === 'note' && currentId && lastKnownRemoteBody !== null) {
      const fresh = Storage.getNote(currentId);
      if (fresh && fresh.body !== lastKnownRemoteBody) {
        lastKnownRemoteBody = fresh.body;
        if (undoStack.length) {
          resetUndo();
          showEditorToast('Note changed on another device — undo history reset');
        }
      }
    }
    return;
  }
  if (listView.classList.contains('active')) renderNotesList();
  else if (customersView.classList.contains('active')) renderCustomersList();
  else if (customerNotesView.classList.contains('active') && activeCustomerId) {
    showCustomerNotes(activeCustomerId, customerNotesReturnTo);
  } else if (priceView && priceView.classList.contains('active')) {
    renderPriceTable();
  } else if (orphanView && orphanView.classList.contains('active')) {
    renderOrphanList();
  } else if (settingsView.classList.contains('active')) {
    renderKeywordList();
    renderEmployeeList();
    renderMembersList();
  }
}

let unsubStorage = null;
onAuthStateChanged(auth, async (user) => {
  if (unsubStorage) { unsubStorage(); unsubStorage = null; }
  if (!user) {
    // Give a pending magic-link sign-in a chance to complete before showing the sign-in screen.
    await emailLinkSigninReady;
    if (auth.currentUser) return; // link sign-in succeeded; a new auth event will follow
    Storage.signedOut();
    showSignin();
    return;
  }
  // Signed in — resolve org (creates or joins), then migrate if needed
  try {
    await Storage.init(user.uid, user.email);
    // Wait for initial snapshots
    await new Promise((resolve) => {
      const un = Storage.onChange(() => {
        if (Storage.isReady()) { un(); resolve(); }
      });
    });
    // Subscribe before migration so we catch the snapshot update
    unsubStorage = Storage.onChange(rerenderCurrent);
    await Storage.maybeMigrateFromOldPath(user.uid);
  } catch (err) {
    console.error('Account load failed:', err);
    showInitError(user, err);
    return;
  }
  hideInitError();
  // Link sign-in finished and the account loaded — retire the "Finishing
  // sign-in…" card so a later sign-out shows the normal form.
  showLinkinCard(false);
  // Hide write controls for customer role
  applyRoleUI(Storage.getRole());
  // An admin can change our role while we're using the app — follow it live
  Storage.onRoleChange((newRole, prevRole) => {
    if (!newRole) {
      // Removed from the org: close up and show the no-access banner
      if (editorView.classList.contains('active')) commitAndCleanupEditor();
      showInitError(user, { code: 'app/no-access' });
      return;
    }
    // Leave the editor first — a demoted user must not keep typing into a
    // note the server will now reject (saves are flushed on the way out).
    if (editorView.classList.contains('active')) commitAndCleanupEditor();
    applyRoleUI(newRole);
    // Land on home: the previous screen (customers, a note list) may no longer
    // be readable under the new role.
    goHome();
    showEditorToast(`Your access level changed to ${ROLE_LABELS[newRole] || newRole}`);
  });
  showNotes();
  // One-time catch-up: stamp customer names onto already-shared notes
  Storage.backfillAssignedCustomerNames();
  // Drop stale assignments left behind by removed members (field edit only)
  Storage.cleanupOrphanedAssignments();
  // Strip admin/bookkeeper uids from assignedTo — they see everything anyway
  Storage.cleanupElevatedAssignments();
  // First magic-link sign-in (or forgot-password): prompt to set a password.
  if (pendingPasswordPrompt) {
    pendingPasswordPrompt = false;
    showSetPasswordModal();
  } else {
    // Brand-new empty org: offer sample data and the tour
    maybeShowWelcome();
  }
});

// ---------- init error banner ----------
const initErrorBanner = document.getElementById('init-error-banner');
const initErrorText = document.getElementById('init-error-text');
function showInitError(user, err) {
  if (!initErrorBanner) return;
  if (err && err.code === 'app/no-access') {
    initErrorText.textContent =
      `${user.email || 'This account'} doesn't have access to this app yet. Ask the administrator for an invite.`;
  } else {
    const detail = (err && (err.message || err.code)) ? (err.message || err.code) : String(err);
    initErrorText.textContent =
      `You're signed in as ${user.email || 'unknown'}, but your account couldn't be loaded: ${detail}`;
  }
  initErrorBanner.hidden = false;
}
function hideInitError() {
  if (initErrorBanner) initErrorBanner.hidden = true;
}
const initErrorRetry = document.getElementById('init-error-retry');
if (initErrorRetry) initErrorRetry.addEventListener('click', () => window.location.reload());
const initErrorSignout = document.getElementById('init-error-signout');
if (initErrorSignout) initErrorSignout.addEventListener('click', async () => {
  hideInitError();
  await signOut(auth);
});

window.addEventListener('beforeunload', () => {
  if (currentId) commitSave();
});

// Display app version in the home toolbar
const appVersionEl = document.getElementById('app-version');
if (appVersionEl) appVersionEl.textContent = APP_VERSION;

// ---------- local customer files (on-device only) ----------
LocalFiles.requestPersistence();

const filesToggle = document.getElementById('customer-files-toggle');
const fileInput = document.getElementById('customer-file-input');
const galleryView = document.getElementById('file-gallery-view');
const galleryGrid = document.getElementById('file-gallery-grid');
const galleryTitle = document.getElementById('file-gallery-title');
const galleryBackBtn = document.getElementById('file-gallery-back');
const galleryFileInput = document.getElementById('gallery-file-input');
const galleryCols2Btn = document.getElementById('gallery-cols-2');
const galleryCols3Btn = document.getElementById('gallery-cols-3');
const fileLightbox = document.getElementById('file-lightbox');
const fileLightboxImg = document.getElementById('file-lightbox-img');
let fileObjectUrls = [];
let galleryCols = localStorage.getItem('jp-gallery-cols') === '2' ? 2 : 3;
let galleryImageIds = []; // ordered ids of image files in the current grid
let lightboxIndex = -1;   // position in galleryImageIds of the shown image

function fmtFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Updates the "Files (n)" count on the customer card.
async function renderCustomerFiles(customerId) {
  if (!filesToggle) return;
  let recs = [];
  try { recs = await LocalFiles.list(customerId); } catch (e) { console.warn('files list', e); }
  filesToggle.textContent = `Files (${recs.length}) ▸`;
}

function applyGalleryCols() {
  if (!galleryGrid) return;
  galleryGrid.classList.toggle('cols-2', galleryCols === 2);
  galleryGrid.classList.toggle('cols-3', galleryCols === 3);
  if (galleryCols2Btn) galleryCols2Btn.classList.toggle('active', galleryCols === 2);
  if (galleryCols3Btn) galleryCols3Btn.classList.toggle('active', galleryCols === 3);
}

function closeFileGallery() {
  if (galleryView) galleryView.hidden = true;
}

async function openFileGallery(customerId) {
  if (!galleryView) return;
  if (!handlingPopstate) history.pushState({ screen: 'file-gallery', customerId }, '');
  galleryView.hidden = false;
  applyGalleryCols();
  await renderFileGallery(customerId);
}

function openFileLightbox(url, recId) {
  history.pushState({ screen: 'file-lightbox' }, '');
  lightboxIndex = galleryImageIds.indexOf(recId);
  fileLightboxImg.src = url;
  fileLightbox.hidden = false;
}

// Swipe left/right in the lightbox steps through the grid's images (no wrap).
async function lightboxStep(dir) {
  if (lightboxIndex < 0) return;
  const nextIndex = lightboxIndex + dir;
  if (nextIndex < 0 || nextIndex >= galleryImageIds.length) return;
  const rec = await LocalFiles.get(galleryImageIds[nextIndex]);
  if (!rec) return;
  const url = URL.createObjectURL(rec.blob);
  fileObjectUrls.push(url);
  lightboxIndex = nextIndex;
  fileLightboxImg.src = url;
}

async function renderFileGallery(customerId) {
  if (!galleryGrid) return;
  fileObjectUrls.forEach(u => URL.revokeObjectURL(u));
  fileObjectUrls = [];
  let recs = [];
  try { recs = await LocalFiles.list(customerId); } catch (e) { console.warn('files list', e); }
  if (galleryTitle) galleryTitle.textContent = `Files (${recs.length})`;
  renderCustomerFiles(customerId);
  galleryImageIds = recs.filter(r => (r.type || '').startsWith('image/')).map(r => r.id);
  if (recs.length === 0) {
    galleryGrid.innerHTML = '<li class="gallery-tile gallery-tile-empty">No files yet. Use + Add to attach photos or documents.</li>';
    return;
  }
  galleryGrid.innerHTML = recs.map(r => {
    const isImage = (r.type || '').startsWith('image/');
    let preview;
    if (isImage) {
      const url = URL.createObjectURL(r.blob);
      fileObjectUrls.push(url);
      preview = `<img src="${url}" alt="${escapeHtml(r.name)}" />`;
    } else {
      preview = `
        <div class="gallery-tile-doc">
          <span class="file-icon">📄</span>
          <span class="file-name">${escapeHtml(r.name)}</span>
        </div>`;
    }
    return `
      <li class="gallery-tile" data-open="${r.id}" title="${escapeHtml(r.name)} · ${fmtFileSize(r.size)} · ${formatDateTime(r.addedAt)}">
        ${preview}
        <button class="gallery-tile-btn gallery-share-btn" data-share="${r.id}" aria-label="Share file">⇪</button>
        <button class="gallery-tile-btn gallery-delete-btn" data-del="${r.id}" aria-label="Delete file">✕</button>
      </li>
    `;
  }).join('');

  galleryGrid.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', async () => {
      const rec = await LocalFiles.get(el.dataset.open);
      if (!rec) return;
      const url = URL.createObjectURL(rec.blob);
      fileObjectUrls.push(url);
      if ((rec.type || '').startsWith('image/')) {
        openFileLightbox(url, rec.id);
      } else {
        // View in a new tab (phone's built-in viewer); no copy saved to Downloads.
        const win = window.open(url, '_blank');
        if (!win) {
          // Popup blocked — fall back to downloading.
          const a = document.createElement('a');
          a.href = url;
          a.download = rec.name;
          a.click();
        }
      }
    });
  });
  galleryGrid.querySelectorAll('[data-share]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const rec = await LocalFiles.get(btn.dataset.share);
      if (!rec) return;
      const result = await LocalFiles.share(rec);
      if (result === 'unsupported') {
        // Desktop fallback: download instead
        const url = URL.createObjectURL(rec.blob);
        fileObjectUrls.push(url);
        const a = document.createElement('a');
        a.href = url;
        a.download = rec.name;
        a.click();
      }
    });
  });
  galleryGrid.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('Delete this file from this device?')) return;
      await LocalFiles.remove(btn.dataset.del);
      renderFileGallery(customerId);
    });
  });
}

function setGalleryCols(n) {
  galleryCols = n;
  localStorage.setItem('jp-gallery-cols', String(n));
  applyGalleryCols();
}
if (galleryCols2Btn) galleryCols2Btn.addEventListener('click', () => setGalleryCols(2));
if (galleryCols3Btn) galleryCols3Btn.addEventListener('click', () => setGalleryCols(3));
if (galleryBackBtn) galleryBackBtn.addEventListener('click', () => history.back());

if (filesToggle) filesToggle.addEventListener('click', () => {
  if (activeCustomerId) openFileGallery(activeCustomerId);
});

async function addFilesFromInput(input) {
  if (!activeCustomerId || !input.files || input.files.length === 0) return;
  for (const f of input.files) {
    try { await LocalFiles.add(activeCustomerId, f); } catch (e) { console.warn('file add', e); }
  }
  input.value = '';
  renderCustomerFiles(activeCustomerId);
  if (galleryView && !galleryView.hidden) renderFileGallery(activeCustomerId);
}
if (fileInput) fileInput.addEventListener('change', () => addFilesFromInput(fileInput));
if (galleryFileInput) galleryFileInput.addEventListener('change', () => addFilesFromInput(galleryFileInput));

if (fileLightbox) {
  fileLightbox.addEventListener('click', () => history.back());
  let touchX = 0, touchY = 0;
  fileLightbox.addEventListener('touchstart', (e) => {
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }, { passive: true });
  fileLightbox.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    // Horizontal swipe only: needs 50px+ of travel, mostly sideways.
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    lightboxStep(dx < 0 ? 1 : -1); // swipe left → next, right → previous
  }, { passive: true });
}

// "What's new" list in Settings — shows at most the 10 latest changelog entries.
const changelogList = document.getElementById('changelog-list');
if (changelogList) {
  changelogList.innerHTML = CHANGELOG.slice(0, 10).map(([ver, desc]) => `
    <li class="changelog-item"><span class="changelog-ver">${ver}</span> ${desc}</li>
  `).join('');
}

// ---------- IIF generator ----------
const iifBtn = document.getElementById('iif-btn');
const iifModal = document.getElementById('iif-modal');
const iifModalClose = document.getElementById('iif-modal-close');
const iifStatus = document.getElementById('iif-status');
const iifTableBody = document.getElementById('iif-table-body');
const iifDownloadBtn = document.getElementById('iif-download-btn');
const iifReviewNote = document.getElementById('iif-review-note');
const editorIifBtn = document.getElementById('editor-iif-btn');

let iifParsedEntries = [];
const iifFromDate = document.getElementById('iif-from-date');
const iifToDate = document.getElementById('iif-to-date');

// Default the IIF date range to the last two weeks (user can still change or clear it)
(function setDefaultIIFRange() {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (iifFromDate && !iifFromDate.value) {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    iifFromDate.value = fmt(d);
  }
  if (iifToDate && !iifToDate.value) iifToDate.value = fmt(new Date());
})();

function getCustomerNamesList() {
  return Storage.listCustomers().map(c => {
    const def = Storage.getDefaultNoteForCustomer(c.id);
    const body = def ? def.body : '';
    const name = (splitTitleAndBody(body).title || '').trim();
    return { name, searchText: body };
  }).filter(c => c.name.length > 0);
}

function findHoursNote() {
  return Storage.listAllNotes().find(n => {
    const { title } = splitTitleAndBody(n.body);
    return title.trim().toLowerCase() === 'hours';
  });
}

function confidenceColor(score) {
  if (score >= 80) return 'var(--color-success, #16a34a)';
  if (score >= 50) return '#d97706';
  return '#dc2626';
}

function renderIIFEntries(entries) {
  if (!iifTableBody) return;
  if (!entries.length) {
    iifTableBody.innerHTML = '<tr><td colspan="6" style="padding:16px;color:var(--ink-soft);text-align:center;">No entries found.</td></tr>';
    return;
  }

  // Expand multi-employee entries into one row each
  const rows = [];
  entries.forEach((e, idx) => {
    const emps = e.employees.length ? e.employees : ['?'];
    emps.forEach((emp, empIdx) => {
      rows.push({ e, idx, emp, first: empIdx === 0 });
    });
  });

  iifTableBody.innerHTML = rows.map(({ e, idx, emp, first }) => {
    const scoreColor = confidenceColor(e.confidence);
    const rowClass = e.needsReview ? 'iif-needs-review' : '';
    const issueIcon = (first && e.issue) ? `<br><span style="font-size:10px;color:#d97706;">⚠ ${escapeHtml(e.issue)}</span>` : '';
    const empColor = emp === '?' ? 'color:#dc2626' : '';
    return `
      <tr class="${rowClass} iif-main-row" title="${escapeHtml(e.raw)}" data-raw-idx="${idx}">
        <td><input type="checkbox" class="iif-row-check" data-idx="${idx}" data-emp="${escapeHtml(emp)}" checked /></td>
        <td style="white-space:nowrap;">${first ? (e.dateFormatted || '?') : ''}</td>
        <td style="white-space:nowrap;${empColor}">${escapeHtml(emp)}${issueIcon}</td>
        <td><input class="iif-cell-input iif-customer-input" data-idx="${idx}" value="${escapeHtml(e.customerMatched)}" placeholder="Customer" /></td>
        <td><input class="iif-cell-input iif-hours-input" data-idx="${idx}" value="${e.hoursFormatted || ''}" placeholder="H:MM" /></td>
        <td>${first ? `<span class="iif-score" style="color:${scoreColor};">${e.confidence}%</span>` : ''}</td>
      </tr>
      <tr class="iif-raw-row" data-raw-for="${idx}" hidden>
        <td colspan="6"><span class="iif-raw-label">Note line:</span> ${escapeHtml(e.raw)}</td>
      </tr>
    `;
  }).join('');

  // Tap a row (not its checkbox/inputs) to show/hide the raw note line — hover
  // tooltips don't exist on touch screens.
  iifTableBody.querySelectorAll('.iif-main-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('input, select, button, a')) return;
      const rawRow = row.nextElementSibling;
      if (rawRow && rawRow.classList.contains('iif-raw-row')) rawRow.hidden = !rawRow.hidden;
    });
  });

  // Row checkboxes: unchecked rows are excluded from the download.
  // Exclusion is tracked per entry+employee, since multi-employee entries expand to one row each.
  iifTableBody.querySelectorAll('.iif-row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const entry = iifParsedEntries[parseInt(cb.dataset.idx, 10)];
      if (!entry._excludedEmps) entry._excludedEmps = {};
      entry._excludedEmps[cb.dataset.emp] = !cb.checked;
    });
  });

  iifTableBody.querySelectorAll('.iif-customer-input').forEach(input => {
    input.addEventListener('input', () => {
      iifParsedEntries[parseInt(input.dataset.idx, 10)].customerMatched = input.value;
    });
  });
  iifTableBody.querySelectorAll('.iif-hours-input').forEach(input => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.idx, 10);
      const val = input.value.trim();
      const m = val.match(/^(\d+):(\d{2})$/);
      if (m) {
        iifParsedEntries[idx].hours = parseInt(m[1]) + parseInt(m[2]) / 60;
        iifParsedEntries[idx].hoursFormatted = val;
      }
    });
  });
}

let iifNoteBody = null;      // cached while the modal is open
let iifCustomerNames = null; // cached while the modal is open

function iifRangeFromInputs() {
  const parseInput = (el, endOfDay) => {
    if (!el || !el.value) return null;
    const [y, mo, d] = el.value.split('-').map(Number);
    return new Date(y, mo - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  };
  return { from: parseInput(iifFromDate, false), to: parseInput(iifToDate, true) };
}

// Parse the hours note (only the selected date range) and render the table.
function runIIFParse() {
  iifStatus.innerHTML = '<span class="nav-spinner" style="width:16px;height:16px;border-width:2px;vertical-align:middle;"></span> Parsing your hours note…';
  if (iifTableBody) iifTableBody.innerHTML = '';
  if (iifDownloadBtn) iifDownloadBtn.hidden = true;
  if (iifReviewNote) iifReviewNote.textContent = '';

  setTimeout(() => {
    const range = iifRangeFromInputs();
    iifParsedEntries = parseHoursNote(iifNoteBody, iifCustomerNames, getEmployeeNames(), range);

    const total = iifParsedEntries.length;
    const reviewCount = iifParsedEntries.filter(e => e.needsReview).length;
    const ranged = !!(range.from || range.to);
    iifStatus.innerHTML = `${total} entr${total === 1 ? 'y' : 'ies'}${ranged ? ' in the selected date range' : ' parsed from your hours note'}.`;
    if (iifReviewNote) iifReviewNote.textContent = reviewCount ? `⚠ ${reviewCount} entr${reviewCount === 1 ? 'y needs' : 'ies need'} review (orange rows)` : '';
    renderIIFEntries(iifParsedEntries);
    if (iifDownloadBtn) iifDownloadBtn.hidden = total === 0;
  }, 30);
}

function openIIFModal() {
  const note = findHoursNote();
  if (!note) {
    iifStatus.textContent = 'No note titled "hours" found. Create a general note with the title "hours" and add your work notes there.';
    if (iifTableBody) iifTableBody.innerHTML = '';
    if (iifDownloadBtn) iifDownloadBtn.hidden = true;
    if (iifReviewNote) iifReviewNote.textContent = '';
    iifModal.hidden = false;
    return;
  }

  // Cache the note body and customer list for re-parses while the modal is open
  iifNoteBody = splitTitleAndBody(note.body).body;
  iifCustomerNames = getCustomerNamesList();

  iifModal.hidden = false;
  runIIFParse();
}

if (iifBtn) iifBtn.addEventListener('click', openIIFModal);

if (iifModalClose) iifModalClose.addEventListener('click', () => { iifModal.hidden = true; });
if (iifModal) iifModal.addEventListener('click', e => { if (e.target === iifModal) iifModal.hidden = true; });
if (editorIifBtn) editorIifBtn.addEventListener('click', openIIFModal);

if (iifDownloadBtn) iifDownloadBtn.addEventListener('click', () => {
  // Only include checked rows (per entry+employee)
  const includedEntries = iifParsedEntries
    .map(e => ({
      ...e,
      employees: e.employees.filter(emp => !(e._excludedEmps && e._excludedEmps[emp])),
    }))
    .filter(e => e.employees.length > 0);
  const iif = generateIIF(includedEntries, getEmployeeTypeMap());
  const blob = new Blob([iif], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hours-${new Date().toISOString().slice(0,10)}.iif`;
  a.click();
  URL.revokeObjectURL(url);
  // (Export markers retired — the Settings date range decides what gets parsed.)
});

// ---------- orphaned notes view ----------
let _orphanSort = 'recent'; // 'alpha' | 'recent'

function updateOrphanSortButtons() {
  if (orphanSortAlphaBtn) orphanSortAlphaBtn.setAttribute('aria-pressed', _orphanSort === 'alpha');
  if (orphanSortRecentBtn) orphanSortRecentBtn.setAttribute('aria-pressed', _orphanSort === 'recent');
}

function sortOrphans(orphans) {
  const sorted = orphans.slice();
  if (_orphanSort === 'alpha') {
    sorted.sort((a, b) => {
      const at = splitTitleAndBody(a.body).title.trim().toLowerCase();
      const bt = splitTitleAndBody(b.body).title.trim().toLowerCase();
      if (!at && bt) return 1;
      if (at && !bt) return -1;
      return at.localeCompare(bt);
    });
  } else {
    sorted.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  }
  return sorted;
}

function renderOrphanList() {
  if (!orphanList) return;
  const orphans = sortOrphans(Storage.listOrphanedNotes());
  updateOrphanSortButtons();
  if (orphans.length === 0) {
    orphanList.innerHTML = '<p class="empty-state">No orphaned notes.</p>';
    if (orphanDeleteSelectedBtn) orphanDeleteSelectedBtn.disabled = true;
    return;
  }
  orphanList.innerHTML = orphans.map(n => {
    const { title, body } = splitTitleAndBody(n.body);
    const safeTitle = title.trim()
      ? escapeHtml(title)
      : '<span style="color:var(--ink-soft);font-style:italic">Untitled</span>';
    const firstLine = (body.split('\n').find(l => l.trim()) || '').trim();
    const safePreview = firstLine ? escapeHtml(firstLine) : '';
    return `
      <div class="orphan-item">
        <input type="checkbox" class="orphan-cb" data-id="${n.id}" />
        <div class="orphan-item-body" data-id="${n.id}">
          <p class="note-title" style="margin:0;font-size:15px;">${safeTitle}</p>
          ${safePreview ? `<p class="note-preview" style="margin:2px 0 0;">${safePreview}</p>` : ''}
        </div>
      </div>`;
  }).join('');

  orphanList.querySelectorAll('.orphan-cb').forEach(cb => {
    cb.addEventListener('change', updateOrphanDeleteBtn);
  });

  orphanList.querySelectorAll('.orphan-item-body').forEach(el => {
    el.addEventListener('click', () => {
      const note = Storage.getNote(el.dataset.id);
      if (note) { returnScreen = 'orphans'; showEditor(note, 'note'); }
    });
  });
}

function updateOrphanDeleteBtn() {
  if (!orphanDeleteSelectedBtn || !orphanList) return;
  const anyChecked = orphanList.querySelector('.orphan-cb:checked') !== null;
  orphanDeleteSelectedBtn.disabled = !anyChecked;
}

function showOrphanNotes() {
  hideAllScreens();
  orphanView.classList.add('active');
  renderCrumbs('crumbs-orphans', [{ label: 'Home', go: 'home' }, { label: 'Orphaned Notes' }]);
  restoreScroll('orphans');
  if (!handlingPopstate) history.pushState({ screen: 'orphans' }, '');
  renderOrphanList();
  if (orphanDeleteSelectedBtn) orphanDeleteSelectedBtn.disabled = true;
}

if (orphanSelectAllBtn) {
  orphanSelectAllBtn.addEventListener('click', () => {
    const cbs = orphanList.querySelectorAll('.orphan-cb');
    const allChecked = [...cbs].every(cb => cb.checked);
    cbs.forEach(cb => { cb.checked = !allChecked; });
    updateOrphanDeleteBtn();
  });
}

if (orphanDeleteSelectedBtn) {
  orphanDeleteSelectedBtn.addEventListener('click', () => {
    orphanList.querySelectorAll('.orphan-cb:checked').forEach(cb => {
      Storage.deleteNote(cb.dataset.id);
    });
    renderOrphanList();
  });
}

if (orphanSortAlphaBtn) {
  orphanSortAlphaBtn.addEventListener('click', () => {
    if (_orphanSort === 'alpha') return;
    _orphanSort = 'alpha';
    renderOrphanList();
  });
}

if (orphanSortRecentBtn) {
  orphanSortRecentBtn.addEventListener('click', () => {
    if (_orphanSort === 'recent') return;
    _orphanSort = 'recent';
    renderOrphanList();
  });
}

// ---------- tutorial ----------
const tutorialOverlay = document.getElementById('tutorial-overlay');
const tutorialBubble = document.getElementById('tutorial-bubble');
const tutorialText = document.getElementById('tutorial-text');
const tutorialNext = document.getElementById('tutorial-next');
const tutorialBack = document.getElementById('tutorial-back');
const tutorialProgress = document.getElementById('tutorial-progress');
const tutorialClose = document.getElementById('tutorial-close');

let tutorialStepIndex = 0;
let tutorialPart = 1;
let tutorialStartPart = 1; // the part the user launched — back never goes before it
const TUTORIAL_PARTS = 5;

// The tutorial is split into three short parts, each startable from Settings.
// The last bubble of parts 1 and 2 offers to continue into the next part.
function tutorialSteps(part) {
  if (part === 1) return [
    {
      screen: 'home',
      target: () => document.getElementById('settings-btn'),
      text: 'Settings live here — keywords, users, your QuickBooks export.',
    },
    {
      screen: 'home',
      target: () => document.querySelector('#notes-list .note-card[data-nav="customers"]'),
      text: 'Your customers live here. Tap to open the list.',
    },
    {
      screen: 'customers',
      setup: () => showCustomers(),
      target: () => document.getElementById('customers-fab'),
      text: 'Tap + to add a customer.',
    },
    {
      screen: 'customer-notes',
      group: 'customer',
      requires: () => Storage.listCustomers().length > 0,
      fallback: {
        target: () => document.querySelector('#notes-list .note-card[data-nav="customers"]'),
        text: 'You have no customers yet. Add one from the Customers list — or load sample data from Settings — then run this tour again to see the rest.',
      },
      setup: () => {
        const customers = Storage.listCustomers();
        if (!customers.length) return false;
        showCustomerNotes(customers[0].id);
        return true;
      },
      target: () => document.querySelector('#customer-notes-list .note-card'),
      text: 'Each customer has their own notes. Whatever you type as this first note’s title becomes the customer’s name — that’s the only part the app uses. The rest is a normal note; address and phone are just handy things to keep there.',
    },
    {
      screen: 'customer-notes',
      group: 'customer',
      requires: () => Storage.listCustomers().length > 0,
      target: () => document.getElementById('customer-notes-fab'),
      text: 'Tap + to add another note for this customer.',
    },
    {
      screen: 'customer-notes',
      group: 'customer',
      requires: () => Storage.listCustomers().length > 0,
      target: () => document.querySelector('#crumbs-customer-notes'),
      text: 'The trail at the top always shows where you are. Tap an earlier step — Home, Customers — to go back there.',
    },
  ];

  if (part === 2) {
    // Home section steps — ordered to match the current settings pinned order
    const sectionSteps = {
      notes: [
        {
          screen: 'home',
          target: () => document.querySelector('[data-section="notes"]'),
          text: 'General notes aren’t tied to a customer — shopping lists, reminders, your hours.',
        },
        {
          screen: 'home',
          target: () => document.getElementById('fab'),
          text: 'Tap + to start something new — a general note or a customer.',
        },
      ],
      aggregator: [
        {
          screen: 'home',
          target: () => document.querySelector('[data-section="aggregator"]'),
          text: 'Start a paragraph with a keyword — todo, materials — and it shows up here. Tap a keyword to see every matching paragraph auto-merged into one note you can edit; changes save back to the original notes.',
        },
      ],
      recent: [
        {
          screen: 'home',
          target: () => document.querySelector('[data-section="recent"]'),
          text: 'The customer notes you edited most recently.',
        },
        {
          screen: 'home',
          target: () => document.querySelector('#notes-list .home-pinned'),
          text: 'Tap any card to open the note.',
        },
      ],
    };
    const ordered = getPinnedOrder().flatMap(key => sectionSteps[key] || []);
    if (ordered.length) ordered[0] = { ...ordered[0], setup: () => goHome() };
    ordered.push({
      screen: 'home',
      target: () => document.getElementById('home-search-input'),
      text: 'Search all your notes at once. Open a result and the word is already highlighted inside the note.',
    });
    ordered.push({
      screen: 'home',
      target: () => document.querySelector('#notes-list .section-ctrls'),
      text: 'Tap Layout at the top to show these controls: − and + change how many items a section shows, ↑ and ↓ reorder the sections.',
    });
    ordered.push({
      screen: 'home',
      target: () => document.querySelector('#notes-list .orphan-nav-card'),
      text: 'Notes whose customer was deleted land here, so nothing is lost by accident.',
    });
    return ordered;
  }

  if (part === 4) return [
    {
      screen: 'home',
      setup: () => { goHome(); return true; },
      target: () => document.querySelector('#notes-list .note-card[data-nav="price"]'),
      text: 'The price table keeps what you buy (rows) against who you buy it from (columns), so you can compare before you order.',
    },
    {
      screen: 'price',
      setup: () => { showPriceTable(); return true; },
      target: () => document.getElementById('price-add-vendor'),
      text: 'Add your suppliers with + Vendor, and the things you buy with + Item. Tap a name later to rename it.',
    },
    {
      screen: 'price',
      group: 'pricecells',
      requires: () => Storage.listPriceItems().length > 0 && Storage.getPriceConfig().vendors.length > 0,
      fallback: {
        target: () => document.getElementById('price-add-vendor'),
        text: 'Add a vendor and an item first, then run this part again to see how prices work.',
      },
      setup: () => { showPriceTable(); return true; },
      target: () => document.querySelector('#price-table .price-cell'),
      text: 'Tap any cell to record a price: the amount, the date you got it, and whether it’s in stock. Each cell keeps every price you’ve entered.',
    },
    {
      screen: 'price',
      group: 'pricecells',
      requires: () => Storage.listPriceItems().length > 0 && Storage.getPriceConfig().vendors.length > 0,
      setup: () => { showPriceTable(); return true; },
      target: () => document.querySelector('#price-view .price-legend'),
      text: 'The dot shows availability: green now, amber 2–3 days, grey longer, red not available. A red dot with a dash means they had none and quoted no price.',
    },
    {
      screen: 'price',
      group: 'pricecells',
      requires: () => Storage.listPriceItems().length > 0 && Storage.getPriceConfig().vendors.length > 0,
      setup: () => { showPriceTable(); return true; },
      target: () => document.querySelector('#price-table .price-cell'),
      text: 'Press and hold a cell to see every price you’ve recorded for it, with dates — handy when a supplier says the price “hasn’t changed”.',
    },
    {
      screen: 'price',
      setup: () => { showPriceTable(); return true; },
      target: () => document.getElementById('price-more-btn'),
      text: 'The ⋯ menu reorders rows and columns, exports the table to a spreadsheet, imports prices back in, and shares the table with an employee.',
    },
  ];

  if (part === 5) {
    const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const android = /android/i.test(navigator.userAgent);
    const homeTarget = () => document.querySelector('#list-view .home-header-top h1');
    if (isStandaloneApp) return [
      {
        screen: 'home',
        setup: () => { goHome(); return true; },
        target: homeTarget,
        text: 'You’re already running JobPilot as an installed app — that’s why there’s no browser bar. Nothing to do here.',
      },
    ];
    const installText = iOS
      ? 'Install JobPilot on your iPhone: tap the Share button in Safari’s toolbar (the square with an arrow), scroll to “Add to Home Screen”, then tap Add.'
      : android
        ? 'Install JobPilot on your Android phone: open your browser’s ⋮ menu and choose “Install app” (or “Add to home screen”), then confirm.'
        : 'Install JobPilot on this computer: click the install icon at the right of the address bar (or your browser’s menu → “Install JobPilot”).';
    return [
      {
        screen: 'home',
        setup: () => { goHome(); return true; },
        target: homeTarget,
        text: installText,
      },
      {
        screen: 'home',
        target: homeTarget,
        text: 'Once installed it opens full screen from your home screen, works with no signal, and keeps you signed in — the same notes, just quicker to reach.',
      },
    ];
  }

  // part 3 — editor & extras (the default)
  return [
    {
      screen: 'editor',
      group: 'note',
      requires: () => Storage.listRecentCustomerNotes(1).length > 0,
      fallback: {
        target: () => document.getElementById('fab'),
        text: 'Add a note first — tap + — and run this part again to see the editor tools.',
      },
      setup: () => {
        const recent = Storage.listRecentCustomerNotes(1);
        if (!recent.length) return false;
        // Ensure the "Go to: customer" link is shown (it hides when the
        // editor was entered from that same customer's note list)
        returnScreen = 'notes';
        activeCustomerId = null;
        showEditor(recent[0], 'note');
        return true;
      },
      target: () => document.getElementById('crumbs-editor'),
      text: 'The trail shows which customer this note belongs to — tap their name to go to their file.',
    },
    {
      screen: 'editor',
      group: 'note',
      requires: () => Storage.listRecentCustomerNotes(1).length > 0,
      target: () => document.getElementById('editor-more-btn'),
      text: 'Note tools: insert a date, share the note, move it to another customer, or delete it.',
    },
    {
      screen: 'editor',
      group: 'note',
      requires: () => Storage.listRecentCustomerNotes(1).length > 0,
      target: () => document.getElementById('checkbox-btn'),
      text: 'Turn lines into a checklist. Tap a box in the text to check it off — the keyboard stays down.',
    },
    {
      screen: 'editor',
      group: 'note',
      requires: () => Storage.listRecentCustomerNotes(1).length > 0,
      target: () => document.getElementById('undo-btn'),
      text: 'Undo and redo your edits, one word or action at a time.',
    },
    {
      screen: 'editor',
      group: 'note',
      requires: () => Storage.listRecentCustomerNotes(1).length > 0,
      target: () => document.getElementById('note-search-input'),
      text: 'Find text in this note. Arrows appear when there’s more than one match.',
    },
    {
      screen: 'customer-notes',
      group: 'customer',
      requires: () => Storage.listCustomers().length > 0,
      setup: () => {
        const customers = Storage.listCustomers();
        if (!customers.length) return false;
        showCustomerNotes(customers[0].id);
        return true;
      },
      target: () => document.getElementById('customer-files-section'),
      text: 'Photos and documents for this customer. They stay on this device only — not synced or backed up.',
    },
    {
      screen: 'settings',
      setup: () => { showSettings(); return true; },
      target: () => {
        const el = document.getElementById('setting-move-checked');
        return el ? el.closest('.setting-row') : null;
      },
      text: 'Optional: checked-off items sink to the bottom of their paragraph.',
    },
    {
      screen: 'settings',
      setup: () => { showSettings(); return true; },
      target: () => {
        const el = document.getElementById('tutorial-btn-1');
        return el ? el.closest('.setting-row') : null;
      },
      text: 'Replay any part of this tour any time.',
    },
  ];
}

function positionBubble(targetEl) {
  if (!targetEl || !tutorialBubble) return;
  const r = targetEl.getBoundingClientRect();
  // Width is PINNED, not re-measured: re-reading offsetWidth on every scroll
  // tick let tiny differences (text rewrap, a scrollbar appearing) shift
  // `left` a little each time, so the bubble slowly walked sideways.
  const bw = Math.min(260, window.innerWidth - 24);
  tutorialBubble.style.width = bw + 'px';
  const bh = tutorialBubble.offsetHeight || 120;
  const margin = 12;
  const arrowSize = 18;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x) => Math.max(8, Math.min(x, vw - bw - 8));
  const clampY = (y) => Math.max(8, Math.min(y, vh - bh - 8));

  const spaceBelow = vh - r.bottom - margin;
  const spaceAbove = r.top - margin;
  const spaceRight = vw - r.right - margin;
  const spaceLeft = r.left - margin;

  // Prefer a side that actually fits; otherwise take the roomiest one so the
  // bubble never has to sit on top of the thing it's pointing at.
  let placement;
  if (spaceBelow >= bh + arrowSize) placement = 'below';
  else if (spaceAbove >= bh + arrowSize) placement = 'above';
  else if (spaceRight >= bw + arrowSize) placement = 'right';
  else if (spaceLeft >= bw + arrowSize) placement = 'left';
  else {
    const best = Math.max(spaceBelow, spaceAbove, spaceRight, spaceLeft);
    placement = best === spaceBelow ? 'below'
      : best === spaceAbove ? 'above'
      : best === spaceRight ? 'right' : 'left';
  }

  let top, left;
  const targetCX = r.left + r.width / 2;
  const targetCY = r.top + r.height / 2;

  if (placement === 'below') {
    top = clampY(r.bottom + arrowSize);
    left = clampX(targetCX - bw / 2);
    const arrowH = Math.max(8, Math.min(targetCX - left - 8, bw - 24));
    tutorialBubble.className = 'tutorial-bubble arrow-up';
    tutorialBubble.style.setProperty('--arrow-h', arrowH + 'px');
  } else if (placement === 'above') {
    top = clampY(r.top - bh - arrowSize);
    left = clampX(targetCX - bw / 2);
    const arrowH = Math.max(8, Math.min(targetCX - left - 8, bw - 24));
    tutorialBubble.className = 'tutorial-bubble arrow-down';
    tutorialBubble.style.setProperty('--arrow-h', arrowH + 'px');
  } else if (placement === 'right') {
    left = clampX(r.right + arrowSize);
    top = clampY(targetCY - bh / 2);
    const arrowV = Math.max(8, Math.min(targetCY - top - 8, bh - 24));
    tutorialBubble.className = 'tutorial-bubble arrow-left';
    tutorialBubble.style.setProperty('--arrow-v', arrowV + 'px');
  } else {
    left = clampX(r.left - bw - arrowSize);
    top = clampY(targetCY - bh / 2);
    const arrowV = Math.max(8, Math.min(targetCY - top - 8, bh - 24));
    tutorialBubble.className = 'tutorial-bubble arrow-right';
    tutorialBubble.style.setProperty('--arrow-v', arrowV + 'px');
  }

  tutorialBubble.style.top = top + 'px';
  tutorialBubble.style.left = left + 'px';
}

// iOS scrolls asynchronously (and its address bar resizes the viewport), so a
// position measured right after scrollIntoView lands where the target WAS.
// Wait for the rect to stop moving before the first placement.
function waitForScrollSettle(el, timeout = 600) {
  return new Promise(resolve => {
    let last = null, stable = 0;
    const started = Date.now();
    const tick = () => {
      const r = el.getBoundingClientRect();
      const key = Math.round(r.top) + ':' + Math.round(r.left);
      if (key === last) stable++; else { stable = 0; last = key; }
      if (stable >= 2 || Date.now() - started > timeout) { resolve(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// Keep the bubble glued to its target while the step is on screen: the user
// can scroll, rotate, or watch the iOS toolbar resize the viewport.
let bubbleTarget = null;
let bubbleTickQueued = false;
let bubbleLastRect = '';
function repositionBubble() {
  if (!bubbleTarget || !tutorialOverlay || tutorialOverlay.hidden) return;
  if (bubbleTickQueued) return;
  bubbleTickQueued = true;
  requestAnimationFrame(() => {
    bubbleTickQueued = false;
    if (!bubbleTarget || !tutorialOverlay || tutorialOverlay.hidden) return;
    // Skip when the target hasn't actually moved — nothing can accumulate
    const r = bubbleTarget.getBoundingClientRect();
    const key = [Math.round(r.top), Math.round(r.left), Math.round(r.width), Math.round(r.height), window.innerWidth, window.innerHeight].join(':');
    if (key === bubbleLastRect) return;
    bubbleLastRect = key;
    positionBubble(bubbleTarget);
  });
}
window.addEventListener('scroll', repositionBubble, { passive: true });
window.addEventListener('resize', repositionBubble);
window.addEventListener('orientationchange', repositionBubble);

// A step whose data doesn't exist yet (no customers, no notes) shouldn't kill
// the tour — skip forward, or back if we're reversing, and only stop when a
// whole part has nothing to show.
let tutorialDirection = 1;
// Groups of steps that need data (a customer, a note). When it's missing, the
// group shows ONE substitute bubble instead of silently vanishing.
let tutorialGroupShown = {};
// An element on an inactive screen still EXISTS (screens are display:none), so
// existence isn't enough — it must actually be laid out, or the bubble ends up
// parked in the corner pointing at nothing.
function isTargetVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function tutorialSkipStep(index) {
  const steps = tutorialSteps(tutorialPart);
  const next = index + tutorialDirection;
  if (next >= 0 && next < steps.length) { runTutorialStep(next); return; }
  if (tutorialDirection > 0 && tutorialPart < TUTORIAL_PARTS) {
    tutorialPart++;
    runTutorialStep(0);
    return;
  }
  if (tutorialDirection < 0 && tutorialPart > tutorialStartPart) {
    tutorialPart--;
    runTutorialStep(Math.max(0, tutorialSteps(tutorialPart).length - 1));
    return;
  }
  endTutorial();
}

async function runTutorialStep(index) {
  const steps = tutorialSteps(tutorialPart);
  if (index >= steps.length) { endTutorial(); return; }
  tutorialStepIndex = index;
  const step = steps[index];

  // A filtered list shows search results instead of the usual cards, which
  // would make step targets disappear — start every step from a clean slate.
  clearAllSearches();

  // A step whose data is missing: show the group's substitute bubble once,
  // then skip the rest of that group.
  if (step.group && step.requires && !step.requires()) {
    if (tutorialGroupShown[step.group] || !step.fallback) { tutorialSkipStep(index); return; }
    tutorialGroupShown[step.group] = true;
    goHome();
    await new Promise(r => setTimeout(r, 120));
    const fbTarget = step.fallback.target();
    if (!isTargetVisible(fbTarget)) { tutorialSkipStep(index); return; }
    showTutorialBubble(fbTarget, step.fallback.text, index, steps.length);
    return;
  }

  // Navigate if needed
  if (step.setup) {
    const ok = step.setup();
    if (ok === false) { tutorialSkipStep(index); return; }
  } else if (step.screen === 'home') {
    goHome();
  }

  // Scroll to top so targets are visible (and so a remembered position from a
  // previous visit doesn't scroll the page out from under the bubble)
  resetScrollMemory();
  window.scrollTo(0, 0);

  // Wait for render
  await new Promise(r => setTimeout(r, 120));

  const target = step.target();
  if (!isTargetVisible(target)) { tutorialSkipStep(index); return; }

  await showTutorialBubble(target, step.text, index, steps.length);
}

// Point the bubble at an element and wire the footer controls.
async function showTutorialBubble(target, text, index, stepCount) {
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  await waitForScrollSettle(target);

  tutorialText.textContent = text;
  if (tutorialProgress) tutorialProgress.textContent = `Part ${tutorialPart} \u00b7 ${index + 1} of ${stepCount}`;
  // Back is always visible, greyed when there's nothing before this step
  // (step 1 of the part the user launched).
  if (tutorialBack) {
    tutorialBack.hidden = false;
    tutorialBack.textContent = '\u2190';
    tutorialBack.disabled = (index === 0 && tutorialPart === tutorialStartPart);
  }
  // Last bubble of parts 1 and 2 chains into the next part
  if (tutorialNext) {
    const last = index === stepCount - 1;
    tutorialNext.textContent = !last ? 'Got it \u2192'
      : (tutorialPart < TUTORIAL_PARTS ? 'Next part \u2192' : 'Done \u2713');
    tutorialNext.disabled = false;
  }
  tutorialOverlay.hidden = false;
  // Render bubble off-screen first to measure height
  tutorialBubble.style.top = '-9999px';
  tutorialBubble.style.left = '-9999px';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  bubbleTarget = target;
  bubbleLastRect = '';
  positionBubble(target);

  // Highlight target, and dim everything else so "where to tap" is obvious.
  // The huge spread box-shadow is the spotlight; it needs a stacking context.
  target.style.outline = '3px solid var(--accent, #2563eb)';
  target.style.outlineOffset = '3px';
  target.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.55)';
  // Only STATIC elements need a position for z-index to apply. Checking the
  // inline style instead of the computed one forced position:relative onto the
  // fixed FABs, dropping them out of the corner — the + vanished mid-tutorial.
  if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
  target.style.zIndex = '1000';
  target.dataset.tutorialHighlight = '1';
}

function clearHighlights() {
  bubbleTarget = null;
  bubbleLastRect = '';
  document.querySelectorAll('[data-tutorial-highlight]').forEach(el => {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.boxShadow = '';
    el.style.zIndex = '';
    el.style.position = '';
    delete el.dataset.tutorialHighlight;
  });
}

function endTutorial() {
  clearHighlights();
  if (tutorialOverlay) tutorialOverlay.hidden = true;
  tutorialStepIndex = 0;
  tutorialPart = 1;
  tutorialStartPart = 1;
  tutorialGroupShown = {};
}

// Start a tutorial part programmatically (welcome modal, sample-data flow)
function startTutorial(part) {
  tutorialPart = part || 1;
  tutorialStartPart = tutorialPart;
  tutorialDirection = 1;
  tutorialStepIndex = 0;
  tutorialGroupShown = {};
  clearAllSearches();
  runTutorialStep(0);
}

if (tutorialNext) tutorialNext.addEventListener('click', () => {
  clearHighlights();
  tutorialDirection = 1;
  const steps = tutorialSteps(tutorialPart);
  if (tutorialStepIndex + 1 >= steps.length) {
    if (tutorialPart < TUTORIAL_PARTS) {
      tutorialPart++;
      tutorialStepIndex = 0;
      runTutorialStep(0);
    } else {
      endTutorial();
    }
    return;
  }
  tutorialStepIndex++;
  runTutorialStep(tutorialStepIndex);
});

if (tutorialBack) tutorialBack.addEventListener('click', () => {
  tutorialDirection = -1;
  if (tutorialStepIndex === 0) {
    // Step back into the previous part's last step (never before the part the
    // user launched from Settings)
    if (tutorialPart <= tutorialStartPart) return;
    clearHighlights();
    tutorialPart--;
    tutorialStepIndex = Math.max(0, tutorialSteps(tutorialPart).length - 1);
    runTutorialStep(tutorialStepIndex);
    return;
  }
  clearHighlights();
  tutorialStepIndex--;
  runTutorialStep(tutorialStepIndex);
});

if (tutorialClose) tutorialClose.addEventListener('click', endTutorial);

document.querySelectorAll('[data-tutorial-part]').forEach(btn => {
  btn.addEventListener('click', () => {
    tutorialPart = parseInt(btn.dataset.tutorialPart, 10) || 1;
    tutorialStartPart = tutorialPart;
    tutorialDirection = 1;
    tutorialStepIndex = 0;
    tutorialGroupShown = {};
    clearAllSearches();
    runTutorialStep(0);
  });
});

// Activate a newly-downloaded service worker as soon as it's ready —
// no user action required. The 'controllerchange' listener below reloads
// the page once the new worker takes over, so the update is picked up
// transparently.
function applyWaitingUpdate() {
  if (swReg && swReg.waiting) {
    swReg.waiting.postMessage('SKIP_WAITING');
  }
}

if ('serviceWorker' in navigator) {
  // Reload as soon as the new SW takes control
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });

  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    swReg = reg;

    // A newer SW already finished downloading from a previous check — apply it now
    if (reg.waiting && navigator.serviceWorker.controller) applyWaitingUpdate();

    reg.update().catch(() => {});

    // Also check for updates when app is foregrounded (common on mobile)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          applyWaitingUpdate();
        }
      });
    });
  }).catch(() => {});
}
