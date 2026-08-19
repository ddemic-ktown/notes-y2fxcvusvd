// app.js — bootstraps auth, wires UI, and re-renders on Firestore cache updates.
import { Storage } from "./storage.js";
import {
  auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  signInWithEmailAndPassword, updatePassword,
} from "./firebase-init.js";
// formatDate is aliased: app.js already has its own formatDate(iso) for note
// timestamps, and iif.js's returns the MM/DD/YYYY that QuickBooks expects.
// parseHoursNote is deliberately NOT imported any more (v2026.08.18-2325): the
// hours chart is built from calendar jobs now. The parser is still exported
// from iif.js, unchanged, so switching back is a one-line change.
import { generateIIF, fuzzyMatchCustomer,
         formatDate as iifFormatDate, formatDuration } from "./iif.js";
import { LocalFiles } from "./files.js";

// Version format: vYYYY.MM.DD-HHMM (Pacific time).
// On every change: add a new entry at the TOP of CHANGELOG (APP_VERSION follows automatically),
// delete entries beyond 20, and set sw.js VERSION to match.
// Commit message format: "vYYYY.MM.DD-HHMM: description" — version prefix always comes before the description.
const CHANGELOG = [
  ['v2026.08.19-0020', 'A new company sees two dismissible cards on the home screen — take the tour, add sample data — instead of a pop-up'],
  ['v2026.08.19-0007', 'A new-company invite is now tied to one company, expires after 14 days, and any admin can rename their own company'],
  ['v2026.08.18-2359', 'Invite someone to start their own company — a separate org with its own data, which they administer'],
  ['v2026.08.18-2345', 'Sample data now covers everything — jobs, hours, price table, employees — and Remove says exactly what it will delete'],
  ['v2026.08.18-2325', 'The hours chart is now built from the hours you enter on calendar jobs, not from the hours note'],
  ['v2026.08.18-1029', 'Note hours worked per person on a job; the day view pills show them as Name: 4'],
  ['v2026.08.17-2140', 'Customers linked to an app account can see their own scheduled jobs — date, time and who is coming'],
  ['v2026.08.17-2030', 'Employees can reach the Calendar (and a shared Price Table) from their home screen'],
  ['v2026.08.17-1714', 'The scrollbar in a note stays visible instead of fading out'],
  ['v2026.08.17-1712', 'Editing a job has a Duplicate button — same job, next day, change the date before saving'],
  ['v2026.08.17-1706', 'Accepting a keyboard suggestion mid-paragraph no longer pulls the next line up into it'],
  ['v2026.08.17-1701', 'The vendor row in the price table now stays put while you scroll, like the item column'],
  ['v2026.08.17-1651', 'Day view shows who is on each job and the job note on the block itself; the crew legend is gone'],
  ['v2026.08.16-1951', 'The hours note now understands Aug 14, Thu Aug 14, 8/14 and 2026-08-14 as date lines, not just August 14'],
  ['v2026.08.16-1929', 'Fixed double-tap zoom snapping straight back out on phones'],
  ['v2026.08.16-1923', 'The Files card now fills its full width — tap the left side to open, + Add on the right'],
  ['v2026.08.16-1808', 'Photos close with an X in the corner, double-tap zoom is more reliable, and the Files card is easier to tap'],
  ['v2026.08.16-1755', 'Photo viewer: share and delete buttons now sit at the bottom, with clearer icons'],
  ['v2026.08.16-1431', 'Photos: double-tap or pinch to zoom, drag to pan, and a share button while viewing'],
  ['v2026.08.14-0150', 'The app no longer flashes the sign-in screen while your session is loading'],
  ['v2026.08.08-2000', 'Finishing a new customer opens their file; finishing a new note returns home'],
  ['v2026.08.03-2344', 'Home search finds customers too, listed above the matching notes'],
  ['v2026.08.03-0142', 'Leave a note and come straight back — undo still remembers'],
  ['v2026.08.03-0053', 'Tap anything during a tutorial and it waits with a Resume button instead of getting in the way'],
  ['v2026.08.03-0021', 'One date option in the note menu instead of two: Insert a date'],
  ['v2026.08.02-2214', 'Users list shows full email addresses instead of cutting them short'],
  ['v2026.08.02-2211', 'Employees in Settings are readable cards instead of a crowded, truncated row'],
  ['v2026.08.02-2125', 'Each employee has their own calendar colour, set in Settings'],
  ['v2026.08.02-1920', 'Ticking a checkbox no longer wakes the keyboard after you have put it away'],
  ['v2026.08.02-1800', 'Each screen’s ⋯ menu now explains that screen; new tours for the Calendar and Hours'],
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
// Declared up here with the other screens, not down in the hours section:
// hideAllScreens() reads it, and a screen ref must never be in the temporal
// dead zone when navigation runs.
const hoursView = document.getElementById('hours-view');
const signinView = document.getElementById('signin-view');
const bootView = document.getElementById('boot-view');

// Restoring a session is asynchronous, and on iOS it is slow. These track
// whether we are still waiting for it, so a not-resolved-yet auth state stops
// being mistaken for a signed-out one. Used by onAuthStateChanged below.
const SESSION_FLAG = 'jp-had-session';
const RESTORE_GRACE_MS = 6000;
let firstAuthEmission = true;
let restoreTimer = null;
function hadSession() { try { return localStorage.getItem(SESSION_FLAG) === '1'; } catch (e) { return false; } }
function markSession() { try { localStorage.setItem(SESSION_FLAG, '1'); } catch (e) {} }
function clearSessionFlag() { try { localStorage.removeItem(SESSION_FLAG); } catch (e) {} }
function showBoot() {
  if (!bootView) return;
  hideAllScreens();
  bootView.classList.add('active');
}
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
const accountOrgEl = document.getElementById('account-org');

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
// A stored colour is only honoured if it's a real #rrggbb — it goes straight
// into a style attribute, and a junk value would either do nothing or, worse,
// carry something unexpected into the markup.
function validHex(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null; }
function normalizeEmployee(e) {
  if (typeof e === 'string') return { name: e, type: 'journeyman', colour: null };
  return {
    name: e.name,
    type: e.type === 'apprentice' ? 'apprentice' : 'journeyman',
    colour: validHex(e.colour),
  };
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
  await setEmployees([...list, {
    name: n,
    type: type === 'apprentice' ? 'apprentice' : 'journeyman',
    colour: pickNewEmployeeColour(list),
  }]);
  return true;
}
async function setEmployeeColour(name, hex) {
  const c = validHex(hex);
  if (!c) return;
  await setEmployees(getEmployees().map(e => e.name === name ? { ...e, colour: c } : e));
}
// A colour nobody is using yet, picked at random from the seed set. NOT simply
// random: with 12 seeds a plain random pick collides with the second employee
// about 8% of the time and it climbs fast — which is the whole complaint that
// started this. Once every seed is taken there's nothing left to avoid, so it
// falls back to a random hex and the admin can adjust it.
function pickNewEmployeeColour(list) {
  const used = new Set((list || getEmployees()).map(e => e.colour).filter(Boolean));
  const free = EMP_COLOURS.filter(c => !used.has(c));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}
// Existing employees predate stored colours. Give them distinct ones in list
// order, in ONE write, the first time an admin opens Settings. Without this the
// clash that prompted the feature would persist until each was set by hand.
let colourBackfillDone = false;
async function backfillEmployeeColours() {
  if (colourBackfillDone || !isAdminRole()) return false;
  const list = getEmployees();
  if (!list.some(e => !e.colour)) { colourBackfillDone = true; return false; }
  colourBackfillDone = true;   // set BEFORE awaiting: renderEmployeeList can run again
  const used = new Set(list.map(e => e.colour).filter(Boolean));
  const next = list.map(e => {
    if (e.colour) return e;
    const free = EMP_COLOURS.find(c => !used.has(c));
    const colour = free || ('#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'));
    used.add(colour);
    return { ...e, colour };
  });
  await setEmployees(next);
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
  // One-time: give pre-existing employees distinct colours. Fire-and-forget —
  // the settings listener re-renders this list when the write lands.
  backfillEmployeeColours();
  if (list.length === 0) {
    employeeListEl.innerHTML = '<li class="keyword-empty">No employees yet.</li>';
    return;
  }
  // Optional link to an app account: the calendar schedules by NAME, but the
  // server can only enforce "see your own jobs" with a uid. Linking a name to a
  // member lets that person see their schedule; unlinked names still schedule.
  const links = Storage.getSettings().employeeLinks || {};
  const members = Storage.listMembers().filter(m => m.role === 'employee' || m.role === 'admin');
  // A CARD, not a .keyword-pill. The pill was built to hold one keyword and an
  // ✕; an employee carries a colour, a name, two dropdowns and a delete, and
  // squeezing all that into an inline pill is what truncated the account name.
  // The labels are visible now too — two unlabelled dropdowns side by side gave
  // no clue which was which.
  employeeListEl.innerHTML = list.map(e => `
    <li class="employee-card">
      <div class="employee-card-top">
        <input type="color" class="employee-colour" data-emp-colour="${escapeHtml(e.name)}"
               value="${e.colour || employeeColour(e.name)}"
               aria-label="Calendar colour for ${escapeHtml(e.name)}" />
        <span class="employee-name">${escapeHtml(e.name)}</span>
        <button data-emp="${escapeHtml(e.name)}" class="employee-remove" aria-label="Remove ${escapeHtml(e.name)}">×</button>
      </div>
      <div class="employee-card-fields">
        <label class="employee-field">
          <span class="employee-field-label">Classification</span>
          <select class="employee-type-select" data-emp-type="${escapeHtml(e.name)}" aria-label="Classification for ${escapeHtml(e.name)}">
            <option value="journeyman" ${e.type === 'journeyman' ? 'selected' : ''}>Journeyman</option>
            <option value="apprentice" ${e.type === 'apprentice' ? 'selected' : ''}>Apprentice</option>
          </select>
        </label>
        <label class="employee-field">
          <span class="employee-field-label">App account</span>
          <select class="employee-link-select" data-emp-link="${escapeHtml(e.name)}" aria-label="App account for ${escapeHtml(e.name)}">
            <option value="">No app account</option>
            ${members.map(m => `<option value="${m.uid}" ${links[e.name] === m.uid ? 'selected' : ''}>${escapeHtml(m.name || m.email || m.uid)}</option>`).join('')}
          </select>
        </label>
      </div>
    </li>
  `).join('');
  wireEmployeeRelink();
  employeeListEl.querySelectorAll('select[data-emp-link]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const next = { ...(Storage.getSettings().employeeLinks || {}) };
      if (sel.value) next[sel.dataset.empLink] = sel.value;
      else delete next[sel.dataset.empLink];
      await Storage.setSetting('employeeLinks', next);
    });
  });
  // 'change', NOT 'input'. A colour input fires continuously while the wheel is
  // dragged, and on 'input' every frame of that drag would be a Firestore
  // settings write — the same mistake the home-screen steppers made before they
  // were debounced. 'change' fires once, when the picker is dismissed.
  employeeListEl.querySelectorAll('input[data-emp-colour]').forEach(inp => {
    inp.addEventListener('change', async () => {
      await setEmployeeColour(inp.dataset.empColour, inp.value);
      renderEmployeeList();
    });
  });
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
// ---------- preferences that follow the user ----------
// These five describe the PERSON, so they sync via users/{uid}/prefs/app and
// show up on every device they sign in on. Deliberately excluded:
// na-price-zoom and jp-gallery-cols (screen-size dependent — a phone value is
// wrong on a desktop) and na-install-hint-dismissed (per device by nature).
// localStorage stays the working copy: everything applies instantly and still
// works offline; the cloud copy is written through.
const SYNCED_PREFS = ['na-theme', 'na-clock-24', 'na-move-checked',
                      'na-collapse-search', 'na-customer-sort'];
let prefsLoaded = false;      // don't write back the values we just read in

function collectLocalPrefs() {
  const out = {};
  // null means "not set" — cycling Theme back to Auto REMOVES the key, and
  // that has to propagate, so store the null rather than dropping the field.
  for (const k of SYNCED_PREFS) out[k] = localStorage.getItem(k);
  return out;
}
function pushUserPrefs() {
  if (!prefsLoaded) return;   // still applying the cloud copy
  Storage.saveUserPrefs(collectLocalPrefs());
}
async function initUserPrefs() {
  const cloud = await Storage.loadUserPrefs();
  if (cloud) {
    for (const k of SYNCED_PREFS) {
      if (!(k in cloud)) continue;              // unknown/absent: leave local alone
      const v = cloud[k];
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, String(v));
    }
    // Re-apply everything the values feed, since they may have just changed.
    applyTheme();
    applyClockButton();
    refreshSearchCollapse();
    const mc = document.getElementById('setting-move-checked');
    if (mc) mc.checked = getMoveCheckedToBottom();
    const cs = document.getElementById('setting-collapse-search');
    if (cs) cs.checked = getCollapseSearch();
    prefsLoaded = true;
  } else {
    // First sign-in on this account: seed the cloud from whatever is already
    // set here, so nobody loses the setup they've been using.
    prefsLoaded = true;
    pushUserPrefs();
  }
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
  pushUserPrefs();
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
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !getClock24() });
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
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: !getClock24() });
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

// ---------- modals own the back press ----------
// A sheet used to stay open while the SCREEN BEHIND IT navigated, because
// modals never took part in history at all.
//
// Done with a MutationObserver on the `hidden` attribute rather than by
// converting every open/close site: there are ~35 of them across 11 modals,
// and one missed site would leave the history stack unbalanced — a worse bug
// than the one being fixed. Watching the state itself cannot be missed, works
// however a sheet is opened or closed (✕, tap outside, Save, Escape), and
// covers any modal added later without anyone remembering to wire it up.
const modalStack = [];
let modalBackSwallow = 0;   // history.back() calls we issued ourselves
let modalSyncing = false;   // we are the ones changing .hidden — don't echo
document.querySelectorAll('.modal-overlay').forEach(el => {
  new MutationObserver(() => {
    // Mid-navigation, hideAllScreens closes the job modal. Consuming an entry
    // then would eat a second screen off the stack.
    if (handlingPopstate || modalSyncing) return;
    const open = !el.hidden;
    const at = modalStack.indexOf(el);
    if (open && at === -1) {
      modalStack.push(el);
      history.pushState({ modal: el.id }, '');
    } else if (!open && at !== -1) {
      modalStack.splice(at, 1);
      modalBackSwallow++;
      history.back();          // retire the entry this sheet pushed
    }
  }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
});
document.querySelectorAll('.app-back-btn').forEach(btn => {
  // history.back() fires the same popstate path Android's system back uses,
  // so editor cleanup / save flushing / return-screen logic is shared.
  btn.addEventListener('click', () => { if (appHistoryDepth > 0) history.back(); });
});
updateAppBackButtons();

// ---------- calendar ----------
// Month grid built by hand (no library): one cell per day, one line per job,
// employee names colour-coded. Jobs are scheduled by Time Logger NAME; uids
// are derived from the Settings links so rules can filter an employee's view.
const calendarView = document.getElementById('calendar-view');
const calendarDayView = document.getElementById('calendar-day-view');
const calGrid = document.getElementById('cal-grid');
// Stable per-name colours from a fixed palette — no setup, and a person keeps
// their colour as employees come and go.
// SEED colours for new employees, not "the palette" — since v2026.08.02-2016
// each employee stores their own colour and an admin can set it to anything.
// Twelve rather than eight: these are handed out unused-first, so the count is
// how many people get a distinct colour with no thought from anyone.
// All are dark enough for white text; employeeTextColour handles custom picks.
const EMP_COLOURS = [
  '#2563eb', '#16a34a', '#d97706', '#9333ea', '#db2777', '#0891b2',
  '#65a30d', '#dc2626', '#0d9488', '#4f46e5', '#ea580c', '#475569',
];
// The employee's OWN colour when they have one. The hash below is now only a
// fallback for a name that appears on a job but isn't in Settings — a
// subcontractor, or a name typed before it was added to the list.
//
// The hash was the whole story until v2026.08.02-2016, and it could not work:
// eight buckets means two of four employees collide 59% of the time, and the
// arithmetic was weaker still — 31 ≡ -1 (mod 8), so `h % 8` collapsed to an
// alternating sum of character codes and clustered common names together.
// Taking the high bits instead is WORSE, not better: short names never grow h
// far enough for them to vary. Don't "fix" it that way.
function employeeColour(name) {
  const own = getEmployees().find(e => e.name === name);
  if (own && own.colour) return own.colour;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return EMP_COLOURS[h % EMP_COLOURS.length];
}
// White or near-black, whichever is readable on the given background.
//
// Needed because the colour is now arbitrary: .cal-chip used to hardcode
// `color: #fff`, which was safe while all eight colours were dark, and stops
// being safe the moment someone picks pale yellow. Standard sRGB relative
// luminance with the usual 0.55 cut.
function employeeTextColour(hex) {
  const c = validHex(hex);
  if (!c) return '#fff';
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = lin(parseInt(c.slice(1, 3), 16));
  const g = lin(parseInt(c.slice(3, 5), 16));
  const b = lin(parseInt(c.slice(5, 7), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.55 ? '#111827' : '#fff';
}
// Background and readable text for one employee's chip, in one place — three
// call sites draw chips (month cell, day card, job editor) and all three would
// otherwise have to remember the text colour.
function chipStyle(name) {
  const bg = employeeColour(name);
  return `background:${bg};color:${employeeTextColour(bg)}`;
}
// A "crew" is a set of employees working a job. Several jobs often share the
// same crew, and repeating the same names down a day (or a month cell) is
// noise — so a crew is shown once and its jobs listed against it.
function crewKey(job) {
  return (job.employeeNames || []).slice().sort().join('|');
}
// One colour for a solo crew; a stripe of colours for a pair or more, so the
// bar on a block matches the legend at a glance.
function crewBarStyle(names) {
  if (!names.length) return 'background: var(--ink-soft)';
  const cols = names.slice(0, 3).map(employeeColour);
  if (cols.length === 1) return `background:${cols[0]}`;
  const step = 100 / cols.length;
  const stops = cols.map((c, i) => `${c} ${i * step}%, ${c} ${(i + 1) * step}%`).join(', ');
  return `background: linear-gradient(180deg, ${stops})`;
}
function groupByCrew(jobs) {
  const map = new Map();
  jobs.forEach(j => {
    const k = crewKey(j);
    if (!map.has(k)) map.set(k, { key: k, names: (j.employeeNames || []).slice(), jobs: [] });
    map.get(k).jobs.push(j);
  });
  return [...map.values()];
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MAX_CHIPS = 3; // then "+N"
let calCursor = new Date();      // any date inside the displayed month
let calSelectedDate = null;      // 'YYYY-MM-DD' for the day view

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function shiftYmd(s, days) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + days);      // rolls months and years, DST-safe
  return ymd(d);
}
function shortDay(s) {
  return parseYmd(s).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function prettyDate(s) {
  const d = parseYmd(s);
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
// Days shown in the grid: the 1st back to Sunday, through the last day forward
// to Saturday, so every week row is complete.
function monthGridDays(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const end = new Date(last);
  end.setDate(last.getDate() + (6 - last.getDay()));
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  return days;
}

function showCalendar() {
  hideAllScreens();
  calendarView.classList.add('active');
  renderCalendar();
  if (!handlingPopstate) history.pushState({ screen: 'calendar' }, '');
}

function renderCalendar() {
  // Older months aren't in the live window — pull them once, on demand. The
  // grid draws trailing days of both neighbours, so cover those too.
  for (const off of [-1, 0, 1]) {
    Storage.ensureJobMonth(ymd(new Date(calCursor.getFullYear(), calCursor.getMonth() + off, 1)));
  }
  if (!calGrid) return;
  renderCrumbs('crumbs-calendar', [
    { label: 'Home', go: 'home' },
    { label: `${MONTH_NAMES[calCursor.getMonth()]} ${calCursor.getFullYear()}` },
  ]);
  const canEdit = isAdminRole();
  const calFab = document.getElementById('cal-fab');
  if (calFab) calFab.style.display = canEdit ? '' : 'none';

  const days = monthGridDays(calCursor);
  const todayStr = ymd(new Date());
  const head = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    .map(d => `<div class="cal-head">${d}</div>`).join('');
  const cells = days.map(d => {
    const s = ymd(d);
    const jobs = Storage.listJobsByDate(s);
    const otherMonth = d.getMonth() !== calCursor.getMonth();
    const classes = ['cal-cell'];
    if (otherMonth) classes.push('cal-other');
    if (!jobs.length) classes.push('cal-empty');   // greyed when nobody is on
    if (s === todayStr) classes.push('cal-today');
    // Group by crew so the same names aren't repeated for every job
    const groups = groupByCrew(jobs);
    let shown = 0;
    const lines = groups.map(g => {
      if (shown >= MAX_CHIPS) return '';
      const chips = g.names.length
        ? g.names.map(n => `<span class="cal-chip" style="${chipStyle(n)}">${escapeHtml(n.split(/[\s(]+/)[0])}</span>`).join('')
        : '<span class="cal-chip cal-chip-none">—</span>';
      const room = MAX_CHIPS - shown;
      const take = g.jobs.slice(0, room);
      shown += take.length;
      const whos = take.map(j => j.customerName || (j.customerId ? customerCrumbLabel(j.customerId) : '—'));
      return `<div class="cal-job">${chips}<span class="cal-job-who">${escapeHtml(whos.join(', '))}</span></div>`;
    }).join('');
    const more = jobs.length > shown ? `<div class="cal-more">+${jobs.length - shown}</div>` : '';
    return `<div class="${classes.join(' ')}" data-date="${s}">
      <div class="cal-daynum">${d.getDate()}</div>${lines}${more}
    </div>`;
  }).join('');
  // Cues so it's obvious there's more above and below — naming the month beats
  // a bare arrow, and both are tappable for people who'd rather not swipe.
  const prevMonth = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
  const nextMonth = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
  const cueUp = `<button type="button" class="cal-cue cal-cue-up" data-shift="-1">∧ ${escapeHtml(MONTH_NAMES[prevMonth.getMonth()])}</button>`;
  const cueDown = `<button type="button" class="cal-cue cal-cue-down" data-shift="1">∨ ${escapeHtml(MONTH_NAMES[nextMonth.getMonth()])}</button>`;
  calGrid.innerHTML = cueUp + `<div class="cal-headrow">${head}</div><div class="cal-cells">${cells}</div>` + cueDown;
  calGrid.querySelectorAll('.cal-cue').forEach(btn => {
    btn.addEventListener('click', () => calShiftMonth(parseInt(btn.dataset.shift, 10)));
  });
  calGrid.querySelectorAll('.cal-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const date = cell.dataset.date;
      const jobs = Storage.listJobsByDate(date);
      // Spec: tapping an EMPTY day goes straight to the new-job screen
      if (!jobs.length && isAdminRole()) openJobModal(null, date);
      else showCalendarDay(date);
    });
  });
}

function showCalendarDay(dateStr) {
  Storage.ensureJobMonth(dateStr);
  calSelectedDate = dateStr;
  hideAllScreens();
  calendarDayView.classList.add('active');
  renderCalendarDay();
  if (!handlingPopstate) history.pushState({ screen: 'calendar-day', date: dateStr }, '');
}

// ---------- day timeline ----------
// A Google-style day view: hour rail on the left, jobs drawn as blocks
// positioned by start time and sized by duration. Long-press a block to drag
// it to a new time; drag the corner handle to change its length. Jobs with no
// times can't be placed on a timeline, so they sit in a strip above it.
// While a block is being dragged or resized, swallow the scroll the browser
// would otherwise do. Only effective because a long-press involves no movement
// — once a scroll is under way, touchmove stops being cancelable.
let calTouchOwned = false;
// Set when a long-press drag or a resize actually claims the gesture, and
// cleared at the start of the NEXT touch — not on release. The day-swipe
// handler reads it at touchend, and calTouchOwned is already false by then
// (it's cleared on pointerup, and pointer/touch ordering isn't guaranteed).
let calDragClaimed = false;
function blockCalDragScroll(e) {
  if (calTouchOwned && e.cancelable) e.preventDefault();
}

const HOUR_PX = 56;          // one hour of timeline
const SNAP_MIN = 15;         // dragging snaps to quarter hours
const DEFAULT_LEN = 60;      // a job with a start but no end draws as an hour

// ---------- clock format ----------
// Display only. Times are ALWAYS stored as 24h "HH:MM" (see hhmmFromMinutes) —
// this just controls how they're drawn, so switching the setting can never
// change or corrupt saved jobs. Unset follows whatever the device's locale
// does, which is right for most people without them touching anything.
function getClockPref() {
  const v = localStorage.getItem('na-clock-24');
  if (v === '1') return '24';
  if (v === '0') return '12';
  return 'auto';                 // absence of the key IS the auto state
}
function getClock24() {
  const p = getClockPref();
  if (p !== 'auto') return p === '24';
  try { return Intl.DateTimeFormat().resolvedOptions().hour12 === false; }
  catch { return false; }
}
function fmtClock(min) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  const h = Math.floor(clamped / 60), mi = clamped % 60;
  if (getClock24()) return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  // 0 is 12 AM and 12 is 12 PM — the modulo alone gets both wrong.
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
// The hour rail is narrow, so drop the ":00" in 12h mode — "8 AM" is what a
// paper day-planner prints.
function fmtHourLabel(h) {
  if (getClock24()) return `${String(h).padStart(2, '0')}:00`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? 'AM' : 'PM'}`;
}

function minutesFromHHMM(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
function hhmmFromMinutes(min) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}
function snapMinutes(min) { return Math.round(min / SNAP_MIN) * SNAP_MIN; }
function jobSpan(job) {
  const start = minutesFromHHMM(job.start);
  if (start == null) return null;                       // untimed
  let end = minutesFromHHMM(job.end);
  if (end == null || end <= start) end = start + DEFAULT_LEN;
  return { start, end };
}
// Side-by-side lanes so overlapping jobs don't hide each other: walk them in
// start order and reuse the first lane whose last job has finished.
function layoutLanes(spans) {
  const laneEnds = [];
  const placed = spans.map(() => ({ lane: 0, lanes: 1 }));
  spans.map((s, i) => ({ s, i })).sort((a, b) => a.s.start - b.s.start).forEach(({ s, i }) => {
    let lane = laneEnds.findIndex(end => end <= s.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = s.end;
    placed[i].lane = lane;
  });
  const total = Math.max(1, laneEnds.length);
  placed.forEach(p => { p.lanes = total; });
  return placed;
}

function renderCalendarDay() {
  const timeline = document.getElementById('cal-day-timeline');
  const untimedWrap = document.getElementById('cal-day-untimed');
  if (!timeline || !calSelectedDate) return;
  renderCrumbs('crumbs-calendar-day', [
    { label: 'Home', go: 'home' },
    { label: 'Calendar', go: 'calendar' },
    { label: prettyDate(calSelectedDate) },
  ]);
  // Swipe cues, same idea as the month view's ∧/∨ — naming the day beats a bare
  // arrow, and both are tappable for anyone who'd rather not swipe.
  const prevBtn = document.getElementById('cal-day-prev');
  const nextBtn = document.getElementById('cal-day-next');
  if (prevBtn) prevBtn.textContent = `‹ ${shortDay(shiftYmd(calSelectedDate, -1))}`;
  if (nextBtn) nextBtn.textContent = `${shortDay(shiftYmd(calSelectedDate, 1))} ›`;

  const canEdit = isAdminRole();
  const dayFab = document.getElementById('cal-day-fab');
  if (dayFab) dayFab.style.display = canEdit ? '' : 'none';

  const jobs = Storage.listJobsByDate(calSelectedDate);
  const timed = [], untimed = [];
  jobs.forEach(j => { (jobSpan(j) ? timed : untimed).push(j); });

  // Untimed jobs — nowhere to put them on a clock, so they get their own strip
  if (untimed.length) {
    untimedWrap.hidden = false;
    untimedWrap.innerHTML = '<p class="cal-untimed-label">Any time</p>' + untimed.map(j => {
      const who = j.customerName || (j.customerId ? customerCrumbLabel(j.customerId) : 'No customer');
      const jh = j.employeeHours || {};
      const chips = (j.employeeNames || []).map(n =>
        `<span class="cal-chip" style="${chipStyle(n)}">${escapeHtml(n + (jh[n] ? `: ${jh[n]}` : ''))}</span>`).join('');
      return `<div class="cal-untimed-job" data-job="${j.id}">${escapeHtml(who)} ${chips}</div>`;
    }).join('');
  } else {
    untimedWrap.hidden = true;
    untimedWrap.innerHTML = '';
  }

  const spans = timed.map(jobSpan);
  const lanes = layoutLanes(spans);
  const hours = Array.from({ length: 24 }, (_, h) => `
    <div class="cal-hour" style="top:${h * HOUR_PX}px">
      <span class="cal-hour-label">${fmtHourLabel(h)}</span>
    </div>`).join('');
  const blocks = timed.map((j, i) => {
    const { start, end } = spans[i];
    const { lane, lanes: n } = lanes[i];
    const top = (start / 60) * HOUR_PX;
    const height = Math.max(22, ((end - start) / 60) * HOUR_PX - 2);
    const width = `calc((100% - 52px) / ${n} - 4px)`;
    const left = `calc(52px + ((100% - 52px) / ${n}) * ${lane} + 2px)`;
    const who = j.customerName || (j.customerId ? customerCrumbLabel(j.customerId) : 'No customer');
    const names = (j.employeeNames || []);
    const timeTxt = `${fmtClock(start)}–${fmtClock(end)}`;
    // Who's on the job is shown on the block itself now (the legend that used
    // to carry it is gone). The note follows only when the block is tall
    // enough to hold a line without slicing it.
    const jobHours = j.employeeHours || {};
    const chips = names.length
      ? names.map(n => {
          const h = jobHours[n];
          const label = n.split(/[\s(]+/)[0] + (h ? `: ${h}` : '');
          return `<span class="cal-chip" style="${chipStyle(n)}">${escapeHtml(label)}</span>`;
        }).join('')
      : '<span class="cal-chip cal-chip-none">—</span>';
    // The note often carries internal remarks, so customers don't get it.
    const note = isCustomerRole() ? '' : (j.description || '').trim();
    const roomForNote = height >= 76;
    return `<div class="cal-block" data-job="${j.id}" style="top:${top}px;height:${height}px;left:${left};width:${width}">
      <span class="cal-block-bar" style="${crewBarStyle(names)}"></span>
      <div class="cal-block-time">${escapeHtml(timeTxt)}</div>
      <div class="cal-block-who">${escapeHtml(who)}</div>
      ${j.address ? `<div class="cal-block-addr">${escapeHtml(j.address)}</div>` : ''}
      <div class="cal-block-chips">${chips}</div>
      ${note && roomForNote ? `<div class="cal-block-note">${escapeHtml(note)}</div>` : ''}
      ${canEdit ? '<div class="cal-resize" aria-hidden="true"></div>' : ''}
    </div>`;
  }).join('');
  timeline.style.height = `${24 * HOUR_PX}px`;
  timeline.innerHTML = hours + blocks;

  if (!jobs.length) {
    untimedWrap.hidden = false;
    untimedWrap.innerHTML = `<p class="cal-untimed-label">Nothing scheduled${canEdit ? ' — tap + to add a job' : ''}</p>`;
  }

  wireDayInteractions(canEdit);

  // Open on the first job rather than at midnight
  const scroller = document.getElementById('cal-day-scroll');
  if (scroller) {
    const firstStart = spans.length ? Math.min(...spans.map(s => s.start)) : 8 * 60;
    scroller.scrollTop = Math.max(0, (firstStart / 60) * HOUR_PX - HOUR_PX);
  }
}

// Tap opens the editor; long-press drags the block to a new time; the corner
// handle changes its length. Admin only — employees can't write jobs.
function wireDayInteractions(canEdit) {
  const timeline = document.getElementById('cal-day-timeline');
  if (!timeline) return;
  timeline.querySelectorAll('.cal-untimed-job, #cal-day-untimed .cal-untimed-job').forEach(() => {});
  document.querySelectorAll('#cal-day-untimed .cal-untimed-job').forEach(el => {
    el.addEventListener('click', () => { if (canEdit) openJobModal(el.dataset.job, calSelectedDate); });
  });

  timeline.querySelectorAll('.cal-block').forEach(block => {
    const jobId = block.dataset.job;
    let pressTimer = null, dragging = false, resizing = false;
    let startY = 0, origTop = 0, origH = 0, moved = false;
    let downX = 0, downY = 0;   // where the finger landed, to tell scroll from press
    const takeOverCalTouch = () => {
      calTouchOwned = true;
      calDragClaimed = true;     // survives past pointerup, for the swipe check
      document.addEventListener('touchmove', blockCalDragScroll, { passive: false });
    };
    const releaseCalTouch = () => {
      calTouchOwned = false;
      document.removeEventListener('touchmove', blockCalDragScroll, { passive: false });
    };

    const beginDrag = (y) => {
      dragging = true;
      moved = false;
      startY = y;
      origTop = parseFloat(block.style.top);
      origH = parseFloat(block.style.height);
      block.classList.add('cal-block-dragging');
      // The block stays `touch-action: pan-y` in CSS so the day can still be
      // scrolled with a finger that happens to land on a card. Setting
      // touch-action here would do NOTHING — the browser latched it when the
      // finger landed. What does work: a true long-press means the finger
      // hasn't moved, so no scroll has started and touchmove is still
      // cancelable. preventDefault on it holds the gesture.
      takeOverCalTouch();
      if (navigator.vibrate) navigator.vibrate(10); // "it lifted" feedback
    };

    block.addEventListener('pointerdown', (e) => {
      if (!canEdit) return;
      if (e.target.classList.contains('cal-resize')) {
        resizing = true;
        startY = e.clientY;
        origTop = parseFloat(block.style.top);
        origH = parseFloat(block.style.height);
        block.setPointerCapture(e.pointerId);
        e.preventDefault();
        takeOverCalTouch();
        return;
      }
      downX = e.clientX; downY = e.clientY;
      pressTimer = setTimeout(() => { beginDrag(e.clientY); block.setPointerCapture(e.pointerId); }, 450);
    });
    block.addEventListener('pointermove', (e) => {
      if (resizing) {
        moved = true;
        const h = Math.max(HOUR_PX * SNAP_MIN / 60, origH + (e.clientY - startY));
        block.style.height = `${h}px`;
        return;
      }
      if (!dragging) {
        // A real scroll gesture shouldn't turn into a drag. This compares
        // against where the finger LANDED — the old check used a variable that
        // is only set once dragging starts, so it always measured zero and
        // never cancelled.
        if (pressTimer && Math.hypot(e.clientX - downX, e.clientY - downY) > 8) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
        return;
      }
      moved = true;
      const next = Math.max(0, Math.min(24 * HOUR_PX - origH, origTop + (e.clientY - startY)));
      block.style.top = `${next}px`;
    });
    const finish = async (e) => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!dragging && !resizing) return;                 // plain tap handled below
      const wasDragging = dragging, wasResizing = resizing;
      dragging = resizing = false;
      block.classList.remove('cal-block-dragging');
      releaseCalTouch();              // hand scrolling back to the browser
      if (!moved) { renderCalendarDay(); return; }
      const job = Storage.getJob(jobId);
      if (!job) return;
      const span = jobSpan(job);
      const duration = span ? span.end - span.start : DEFAULT_LEN;
      if (wasDragging) {
        const newStart = snapMinutes((parseFloat(block.style.top) / HOUR_PX) * 60);
        await Storage.saveJob({ ...job, start: hhmmFromMinutes(newStart), end: hhmmFromMinutes(newStart + duration) });
      } else if (wasResizing) {
        const startMin = span ? span.start : 0;
        const newLen = Math.max(SNAP_MIN, snapMinutes((parseFloat(block.style.height) / HOUR_PX) * 60));
        await Storage.saveJob({ ...job, start: hhmmFromMinutes(startMin), end: hhmmFromMinutes(startMin + newLen) });
      }
      renderCalendarDay();
    };
    block.addEventListener('pointerup', finish);
    block.addEventListener('pointercancel', finish);
    block.addEventListener('click', () => {
      if (moved) { moved = false; return; }              // that was a drag, not a tap
      if (canEdit) openJobModal(jobId, calSelectedDate);
    });
  });
}

const calToday = document.getElementById('cal-today');
if (calToday) calToday.addEventListener('click', () => { calCursor = new Date(); renderCalendar(); });
// Swipe UP for the next month, DOWN for the previous — the grid moves the way
// your finger does, as if scrolling forward through a continuous calendar.
// A fade with a 5px nudge in the direction you moved: enough to read as
// forward or back, but no big transform to stutter on a cheap phone. Only
// fires on a deliberate shift — saving a job shouldn't make the day slide.
function calSlide(el, dir) {
  if (!el || !dir) return;
  try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; }
  catch (e) {}
  const cls = `cal-enter-${dir}`;
  el.classList.remove('cal-enter-up', 'cal-enter-down', 'cal-enter-left', 'cal-enter-right');
  void el.offsetWidth;                 // restart the animation if it's replayed
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}
function calShiftMonth(delta) {
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + delta, 1);
  renderCalendar();
  // renderCalendar rebuilds .cal-cells, so grab it after the render
  calSlide(calGrid && calGrid.querySelector('.cal-cells'), delta > 0 ? 'up' : 'down');
}
// Desktop: the wheel changes months once the grid has nothing left to scroll,
// which is the same feel as the swipe. The toolbar arrows are gone — the ∧/∨
// cues above and below the grid remain clickable for anyone using a mouse.
if (calGrid) {
  let lastWheel = 0;
  calGrid.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;   // horizontal scroll
    const cells = calGrid.querySelector('.cal-cells');
    if (cells) {
      // Let the grid scroll itself first; only shift at the edges.
      const atTop = cells.scrollTop <= 0;
      const atBottom = cells.scrollTop + cells.clientHeight >= cells.scrollHeight - 1;
      if (e.deltaY < 0 && !atTop) return;
      if (e.deltaY > 0 && !atBottom) return;
    }
    // One flick of a trackpad fires many events — don't jump three months.
    if (Date.now() - lastWheel < 300) return;
    lastWheel = Date.now();
    calShiftMonth(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });
}

if (calGrid) {
  let sx = 0, sy = 0, tracking = false;
  calGrid.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  calGrid.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 1.5) {
      calShiftMonth(dy < 0 ? 1 : -1);
    }
  });
}

// Swipe left/right to change the day. Re-renders in place rather than calling
// showCalendarDay, which would push a history entry per swipe and bury the
// back button under a stack of days.
function calShiftDay(delta) {
  if (!calSelectedDate) return;
  calSelectedDate = shiftYmd(calSelectedDate, delta);
  Storage.ensureJobMonth(calSelectedDate);       // swiping can cross a month
  renderCalendarDay();
  const dir = delta > 0 ? 'left' : 'right';
  calSlide(document.getElementById('cal-day-scroll'), dir);
  const untimed = document.getElementById('cal-day-untimed');
  if (untimed && !untimed.hidden) calSlide(untimed, dir);
}
const calDayMain = document.querySelector('.cal-day-main');
if (calDayMain) {
  calDayMain.querySelectorAll('.cal-cue-side').forEach(btn => {
    btn.addEventListener('click', () => calShiftDay(parseInt(btn.dataset.shift, 10)));
  });
  let sx = 0, sy = 0, tracking = false;
  calDayMain.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    // Swipes starting ON a job block used to be discarded here, on the theory
    // that such a finger "belongs to the drag gesture". It doesn't: a drag
    // needs a 450ms long-press, and the block's own pointermove cancels that
    // timer after 8px of travel — so a swipe across a job can never become a
    // drag. All the guard achieved was that you couldn't change day by swiping
    // anywhere a job was drawn. Judged at touchend instead, on whether a drag
    // actually took over.
    calDragClaimed = false;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  calDayMain.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    if (calDragClaimed) return;     // that was a drag or a resize, not a swipe
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    // Clearly horizontal only — the timeline scrolls vertically.
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      calShiftDay(dx < 0 ? 1 : -1);       // swipe left = next day
    }
  });
}

// ---------- job editor ----------
const jobModal = document.getElementById('job-modal');
let jobEditingId = null;
let jobChosenCustomer = null; // { id, name, addresses: [] }

// Address candidates from the customer's default note: skip the name line and
// anything that looks like a phone or email; keep lines with both digits and
// letters (street lines). None → leave blank, one → auto-fill, several → ask.
function addressCandidates(customerId) {
  const def = customerId ? Storage.getDefaultNoteForCustomer(customerId) : null;
  if (!def) return [];
  const lines = (def.body || '').split('\n').slice(1);
  return lines.map(l => l.trim()).filter(l => {
    if (!l) return false;
    if (EMAIL_RE.test(l)) { EMAIL_RE.lastIndex = 0; return false; }
    const digits = l.replace(/\D/g, '');
    if (digits.length >= 10 && !/[a-z]{3}/i.test(l.replace(/[^a-z]/gi, ''))) return false; // bare phone
    return /\d/.test(l) && /[a-z]{3}/i.test(l);
  });
}

function openJobModal(jobId, dateStr) {
  if (!jobModal || !isAdminRole()) return;
  jobEditingId = jobId || null;
  const job = jobId ? Storage.getJob(jobId) : null;
  document.getElementById('job-modal-title').textContent = job ? 'Edit job' : 'New job';
  document.getElementById('job-date').value = (job && job.date) || dateStr || ymd(new Date());
  document.getElementById('job-start').value = (job && job.start) || '';
  document.getElementById('job-end').value = (job && job.end) || '';
  syncDurationFromTimes();
  document.getElementById('job-desc').value = (job && job.description) || '';
  document.getElementById('job-address').value = (job && job.address) || '';
  jobChosenCustomer = job && job.customerId
    ? { id: job.customerId, name: job.customerName || customerCrumbLabel(job.customerId) }
    : null;
  renderJobEmployees(job ? (job.employeeNames || []) : [], job ? (job.employeeHours || {}) : {});
  renderJobCustomer('');
  document.getElementById('job-address-wrap').hidden = !jobChosenCustomer && !(job && job.address);
  const delBtn = document.getElementById('job-delete');
  if (delBtn) delBtn.hidden = !job;
  // Duplicate only makes sense for a job that exists — a new one isn't saved yet.
  const dupBtn = document.getElementById('job-duplicate');
  if (dupBtn) dupBtn.hidden = !job;
  jobModal.hidden = false;
}

function renderJobEmployees(selected, hours) {
  const ul = document.getElementById('job-employees');
  if (!ul) return;
  const names = getEmployeeNames();
  const hrs = hours || {};
  ul.innerHTML = names.length
    ? names.map(n => `<li class="member-item">
        <label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;">
          <input type="checkbox" data-emp-name="${escapeHtml(n)}" ${selected.includes(n) ? 'checked' : ''} />
          <span class="cal-chip" style="${chipStyle(n)}">${escapeHtml(n)}</span>
        </label>
        <input type="number" class="job-emp-hours" data-emp-hours="${escapeHtml(n)}"
               min="0" step="0.25" inputmode="decimal" placeholder="hrs"
               value="${hrs[n] != null ? hrs[n] : ''}" aria-label="Hours worked by ${escapeHtml(n)}" />
      </li>`).join('')
    : '<li class="member-item">Add employees in Settings → Time Logger first.</li>';
  // Typing hours implies the person was there — tick them automatically.
  ul.querySelectorAll('[data-emp-hours]').forEach(inp => {
    inp.addEventListener('input', () => {
      if (!inp.value) return;
      const cb = ul.querySelector(`input[data-emp-name="${CSS.escape(inp.dataset.empHours)}"]`);
      if (cb) cb.checked = true;
    });
  });
}

// How tall the match list can be: whatever is left between the bottom of the
// search field and the bottom of the VISIBLE viewport (visualViewport shrinks
// for the keyboard, innerHeight doesn't), less room for the panel's padding.
// Floor of 120px so it's never a useless sliver on a very short screen.
function customerListMaxHeight(inputRect) {
  const viewH = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  // A row with an address wraps to two lines, so measure a real one rather
  // than guessing. Aim for five visible matches.
  const row = document.querySelector('#job-customer-list .member-item');
  const rowH = (row && row.getBoundingClientRect().height) || 58;
  const room = (viewH - inputRect.bottom) - 16;   // 16px of breathing room only
  // Five rows when there's space; never taller than the room available; and a
  // floor so a very short screen still shows something usable (it scrolls).
  return Math.max(120, Math.min(rowH * 5, room));
}

// Scroll the modal panel so the customer field sits just under the panel's top
// edge. This is what native pickers do: put the field at the top and let the
// results own the rest of the screen, instead of trying to guess whether there
// is more room above or below.
function liftCustomerField() {
  const input = document.getElementById('job-customer-search');
  const panel = input && input.closest('.modal-panel');
  if (!panel) return;
  const r = input.getBoundingClientRect(), p = panel.getBoundingClientRect();
  const viewH = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  // Scroll the MINIMUM needed, not all the way to the top. Pinning the field
  // to the panel's edge threw away the context above it even when the matches
  // already had somewhere to go.
  const row = document.querySelector('#job-customer-list .member-item');
  const want = ((row && row.getBoundingClientRect().height) || 58) * 5 + 16;
  const have = (viewH - r.bottom);
  const shortfall = Math.max(0, want - have);
  // Never scroll the field past the panel's top edge.
  const ceiling = (r.top - p.top) - 8;
  const delta = Math.min(shortfall, Math.max(0, ceiling));
  if (delta > 0) {
    // Don't fight the panel: only ever scroll as far as it actually can.
    const max = panel.scrollHeight - panel.clientHeight;
    panel.scrollTop = Math.min(panel.scrollTop + delta, Math.max(0, max));
  }
  const ul = document.getElementById('job-customer-list');
  if (ul && ul.children.length) {
    ul.style.maxHeight = customerListMaxHeight(input.getBoundingClientRect()) + 'px';
  }
}

function renderJobCustomer(filter) {
  const ul = document.getElementById('job-customer-list');
  const chosen = document.getElementById('job-customer-chosen');
  if (!ul) return;
  chosen.textContent = jobChosenCustomer ? `Selected: ${jobChosenCustomer.name}` : '';
  const words = (filter || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Nothing typed yet: offer the customers you actually book, so the common
  // case needs no keyboard at all. Ranked by frequency-then-recency; a brand
  // new org has no job history, so fall back to the customer list (already
  // sorted most-recently-touched first). Skipped once a customer is chosen —
  // a live list under "Selected: …" just looks like it didn't take.
  let heading = '';
  let customers;
  if (!words.length) {
    if (jobChosenCustomer) customers = [];
    else {
      const ids = Storage.recentJobCustomerIds(5);
      customers = ids.map(id => Storage.getCustomer(id)).filter(Boolean);
      heading = customers.length ? 'Recent' : '';
      if (!customers.length) {
        customers = Storage.listCustomers().slice(0, 5);
        heading = customers.length ? 'Customers' : '';
      }
    }
  } else {
    customers = Storage.listCustomers().filter(c => {
      const def = Storage.getDefaultNoteForCustomer(c.id);
      const hay = (def ? def.body : '').toLowerCase();
      return words.every(w => hay.includes(w));
    }).slice(0, 8);
  }
  ul.innerHTML = (heading ? `<li class="member-item picker-heading">${heading}</li>` : '') +
    customers.map(c => {
      // Show the address too — two customers can share a surname, and the
      // address is what tells you which one you mean.
      const addr = addressCandidates(c.id)[0] || '';
      return `<li class="member-item job-customer-item" data-id="${c.id}">
        <span class="member-email">${escapeHtml(customerCrumbLabel(c.id))}${
          addr ? `<em class="setting-check-hint">${escapeHtml(addr)}</em>` : ''
        }</span>
      </li>`;
    }).join('');
  // The list always sits below the field; what makes it usable is that the
  // field gets lifted to the top of the panel on focus (see liftCustomerField),
  // so everything below it is free space. All that's left here is to stop the
  // list running off the bottom of the visible viewport.
  if (customers.length) {
    requestAnimationFrame(() => {
      const input = document.getElementById('job-customer-search');
      if (!input) return;
      // Lift once, when a result set first appears — re-lifting on every
      // keystroke would make the panel jump while you type.
      if (!ul.dataset.lifted) { ul.dataset.lifted = '1'; liftCustomerField(); }
      ul.style.maxHeight = customerListMaxHeight(input.getBoundingClientRect()) + 'px';
    });
  } else {
    delete ul.dataset.lifted;
  }
  ul.querySelectorAll('.job-customer-item').forEach(li => {
    li.addEventListener('click', () => {
      jobChosenCustomer = { id: li.dataset.id, name: customerCrumbLabel(li.dataset.id) };
      document.getElementById('job-customer-search').value = '';
      const cands = addressCandidates(li.dataset.id);
      const wrap = document.getElementById('job-address-wrap');
      const choices = document.getElementById('job-address-choices');
      const input = document.getElementById('job-address');
      wrap.hidden = false;
      if (cands.length === 1) { input.value = cands[0]; choices.hidden = true; }
      else if (cands.length > 1) {
        input.value = '';
        choices.innerHTML = '<p class="muted setting-hint">Which address?</p>' +
          cands.map(a => `<button type="button" class="job-address-pick">${escapeHtml(a)}</button>`).join('');
        choices.hidden = false;
        choices.querySelectorAll('.job-address-pick').forEach(b => {
          b.addEventListener('click', () => { input.value = b.textContent; choices.hidden = true; });
        });
      } else { input.value = ''; choices.hidden = true; }
      renderJobCustomer('');
    });
  });
}

// ---------- duration ⇄ start/end ----------
// Duration is NOT stored — it's derived from start and end. Trades think in
// hours ("2.5"), so that's the unit; everything is snapped to quarter hours to
// match the timeline's drag behaviour.
const jobStartEl = document.getElementById('job-start');
const jobEndEl = document.getElementById('job-end');
const jobDurEl = document.getElementById('job-duration');

function durationFromTimes() {
  const s = minutesFromHHMM(jobStartEl.value);
  const e = minutesFromHHMM(jobEndEl.value);
  if (s == null || e == null || e <= s) return null;
  return (e - s) / 60;
}
function syncDurationFromTimes() {
  const h = durationFromTimes();
  jobDurEl.value = h == null ? '' : String(Math.round(h * 4) / 4);
}
function syncEndFromDuration() {
  const s = minutesFromHHMM(jobStartEl.value);
  const h = parseFloat(jobDurEl.value);
  if (s == null || !Number.isFinite(h) || h <= 0) return;
  jobEndEl.value = hhmmFromMinutes(s + snapMinutes(h * 60));
}
if (jobStartEl) jobStartEl.addEventListener('change', () => {
  // Moving the start keeps the length and shifts the end — same as dragging a
  // block on the timeline. With no duration set, just refresh it.
  if (jobDurEl.value) syncEndFromDuration();
  else syncDurationFromTimes();
});
if (jobEndEl) jobEndEl.addEventListener('change', syncDurationFromTimes);
if (jobDurEl) jobDurEl.addEventListener('change', syncEndFromDuration);
if (jobDurEl) jobDurEl.addEventListener('input', () => { if (jobDurEl.value) syncEndFromDuration(); });

const jobCustomerSearch = document.getElementById('job-customer-search');
if (jobCustomerSearch) jobCustomerSearch.addEventListener('input', () => renderJobCustomer(jobCustomerSearch.value));
if (jobCustomerSearch) {
  // On iOS the focus event fires BEFORE the keyboard is up, so a focus-only
  // lift measures the full-height viewport and lands in the wrong place. The
  // visualViewport resize that follows is the one that gets it right, so we
  // listen to both — debounced, since it fires on every frame of the keyboard
  // animation.
  jobCustomerSearch.addEventListener('focus', () => {
    // Grow the sheet to the full visible viewport while you're picking, so the
    // matches have room. It shrinks back to fit its content on blur.
    const panel = jobCustomerSearch.closest('.modal-panel');
    if (panel) panel.classList.add('modal-panel-tall');
    requestAnimationFrame(liftCustomerField);
  });
  jobCustomerSearch.addEventListener('blur', () => {
    const panel = jobCustomerSearch.closest('.modal-panel');
    // Delayed: a tap on a result blurs the field before the click lands, and
    // resizing the panel mid-tap would move the row out from under the finger.
    setTimeout(() => {
      if (document.activeElement !== jobCustomerSearch && panel) {
        panel.classList.remove('modal-panel-tall');
      }
    }, 150);
  });
  if (window.visualViewport) {
    let liftTimer = null;
    window.visualViewport.addEventListener('resize', () => {
      if (document.activeElement !== jobCustomerSearch) return;
      clearTimeout(liftTimer);
      liftTimer = setTimeout(liftCustomerField, 100);
    });
  }
}
const jobClose = document.getElementById('job-close');
if (jobClose) jobClose.addEventListener('click', () => { jobModal.hidden = true; });
if (jobModal) jobModal.addEventListener('click', (e) => { if (e.target === jobModal) jobModal.hidden = true; });

const jobSave = document.getElementById('job-save');
if (jobSave) jobSave.addEventListener('click', async () => {
  const date = document.getElementById('job-date').value;
  if (!date) { alert('A job needs a date.'); return; }
  const names = [...document.querySelectorAll('#job-employees input[data-emp-name]:checked')]
    .map(cb => cb.dataset.empName);
  // Hours are kept only for people on the job — unticking someone drops theirs.
  const employeeHours = {};
  document.querySelectorAll('#job-employees input[data-emp-hours]').forEach(inp => {
    const n = inp.dataset.empHours;
    const v = parseFloat(inp.value);
    if (names.includes(n) && !isNaN(v) && v > 0) employeeHours[n] = v;
  });
  await Storage.saveJob({
    employeeHours,
    id: jobEditingId,
    date,
    start: document.getElementById('job-start').value,
    end: document.getElementById('job-end').value,
    description: document.getElementById('job-desc').value,
    employeeNames: names,
    customerId: jobChosenCustomer ? jobChosenCustomer.id : null,
    customerName: jobChosenCustomer ? jobChosenCustomer.name : '',
    address: document.getElementById('job-address').value,
  });
  jobModal.hidden = true;
  calCursor = parseYmd(date);
  if (calendarDayView.classList.contains('active')) { calSelectedDate = date; renderCalendarDay(); }
  else renderCalendar();
});
// Duplicate: keep everything on screen, drop the id so Save writes a NEW job,
// and move the date on a day. Nothing is written until Save, so the original is
// untouched and the date can still be changed first.
const jobDuplicate = document.getElementById('job-duplicate');
if (jobDuplicate) jobDuplicate.addEventListener('click', () => {
  if (!jobEditingId) return;
  jobEditingId = null;
  const dateEl = document.getElementById('job-date');
  if (dateEl && dateEl.value) dateEl.value = shiftYmd(dateEl.value, 1);
  document.getElementById('job-modal-title').textContent = 'New job (copy)';
  jobDuplicate.hidden = true;
  const delBtn = document.getElementById('job-delete');
  if (delBtn) delBtn.hidden = true;
  if (dateEl) { dateEl.focus(); }
});

const jobDelete = document.getElementById('job-delete');
if (jobDelete) jobDelete.addEventListener('click', async () => {
  if (!jobEditingId) return;
  if (!confirm('Delete this job?')) return;
  await Storage.deleteJob(jobEditingId);
  jobModal.hidden = true;
  if (calendarDayView.classList.contains('active')) renderCalendarDay(); else renderCalendar();
});
const calFabBtn = document.getElementById('cal-fab');
if (calFabBtn) calFabBtn.addEventListener('click', () => openJobModal(null, ymd(calCursor)));
const calDayFabBtn = document.getElementById('cal-day-fab');
if (calDayFabBtn) calDayFabBtn.addEventListener('click', () => openJobModal(null, calSelectedDate || ymd(new Date())));

// ---------- price table ----------
// Rows = items, columns = vendors. A cell shows the newest entry's price and
// an availability dot; tap to enter a new price inline, long-press for the
// full history. Data lives one doc per row (see storage.js).
const priceView = document.getElementById('price-view');
const priceTableEl = document.getElementById('price-table');
// "Jul 20", with the year only when it isn't this one — keeps the column narrow
function shortDate(iso) {
  if (!iso) return '';
  const d = parseYmd(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const opts = d.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: '2-digit' };
  return d.toLocaleDateString([], opts);
}
const AVAIL_LABELS = { yes: 'Available', no: 'Not available', soon: 'Available in 2–3 days', later: 'Available in more than 3 days' };
let priceZoom = parseFloat(localStorage.getItem('na-price-zoom') || '1') || 1;
let openCellKey = null; // "itemId|vendorId" currently in edit mode

function showPriceTable() {
  hideAllScreens();
  priceView.classList.add('active');
  renderCrumbs('crumbs-price', [{ label: 'Home', go: 'home' }, { label: 'Price Table' }]);
  renderPriceTable();
  restoreScroll('price');
  // Draw from cache first (instant), then confirm against the server. If the
  // realtime stream died while the app was frozen, the cache can be hours
  // stale and nothing else on this screen would ever notice. The fetch emits,
  // which redraws through rerenderCurrent.
  Storage.refreshPriceTable();
  if (!handlingPopstate) history.pushState({ screen: 'price' }, '');
}

// Lowest CURRENT price in a row, ignoring vendors whose latest entry says the
// item isn't available (a price you can't buy at isn't the best price) and
// entries with no figure at all. Returns null when nothing is comparable or
// when several vendors tie — a tie has no single "best", and marking them all
// would just be noise.
function cheapestVendorId(item, vendors) {
  let bestId = null, best = Infinity, ties = 0;
  for (const v of vendors) {
    const e = Storage.latestPriceEntry(item, v.id);
    if (!e || e.avail === 'no' || e.price == null || e.price === '') continue;
    const p = Number(e.price);
    if (!Number.isFinite(p)) continue;
    if (p < best) { best = p; bestId = v.id; ties = 1; }
    else if (p === best) ties++;
  }
  return ties === 1 ? bestId : null;
}

function priceCellHtml(item, vendor, canEdit, isCheapest) {
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
    let cls = latest.avail === 'no' ? 'price-value price-unavailable' : 'price-value';
    if (isCheapest) cls += ' price-best';
    const badge = isCheapest ? '<span class="price-best-badge" title="Lowest price available">✓</span>' : '';
    // Price on top; availability and the date it was quoted underneath, so the
    // column stays narrow and the number is what you read first.
    inner = `<div class="price-top"><span class="${cls}">${escapeHtml(priceTxt)}</span>${badge}</div>`
      + `<div class="price-sub"><span class="avail-dot avail-${escapeHtml(latest.avail || 'yes')}" title="${escapeHtml(AVAIL_LABELS[latest.avail] || '')}"></span>`
      + `<span class="price-date">${escapeHtml(shortDate(latest.date))}</span></div>`;
  }
  return `<td class="price-cell" data-key="${key}">${inner}</td>`;
}

// Close the open price cell without saving — used by Cancel, Escape, and a tap
// outside the cell.
function cancelPriceEdit() {
  detachOutsidePriceTap();
  openCellKey = null;
  renderPriceTable();
}
// Firing on pointerDOWN made the table impossible to scroll with a cell open:
// the moment a finger touched, it counted as "tapped outside". Judge on
// RELEASE instead — a tap is a short press that barely moved; anything longer
// or further is a scroll and leaves the editor alone.
//
// Shared with the hours grid (v2026.08.01-0707): both are tables where one cell
// is open at a time, and getting "was that a tap or a scroll?" right on a phone
// took enough tuning that a second copy would only rot. The differences are
// passed in, not branched on.
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 500;
function makeOutsideTapWatcher({ isOpen, editingSelector, cellSelector, guard, onCell, onOutside }) {
  let start = null;
  const down = (e) => { start = { x: e.clientX, y: e.clientY, t: Date.now() }; };
  const up = (e) => {
    if (!isOpen()) { api.detach(); return; }
    if (guard && guard()) { start = null; return; }
    const s = start;
    start = null;
    if (!s) return;
    const moved = Math.hypot(e.clientX - s.x, e.clientY - s.y);
    if (moved > TAP_SLOP_PX || Date.now() - s.t > TAP_MAX_MS) return;   // a drag
    if (e.target.closest && e.target.closest(editingSelector)) return;  // inside the cell
    // Tapping a DIFFERENT cell should move there in one tap. Re-rendering
    // replaces the DOM, so the follow-up click would never land — open the new
    // cell here instead of waiting for it.
    const other = e.target.closest ? e.target.closest(cellSelector) : null;
    if (other && onCell && onCell(other)) { api.detach(); return; }
    onOutside();
  };
  const api = {
    attach() {
      document.addEventListener('pointerdown', down, true);
      document.addEventListener('pointerup', up, true);
    },
    detach() {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      start = null;
    },
  };
  return api;
}
const priceOutsideTap = makeOutsideTapWatcher({
  isOpen: () => !!openCellKey,
  editingSelector: '.price-cell-editing',
  cellSelector: '.price-cell',
  guard: () => pinchJustHappened(),
  onCell: (other) => {
    if (!other.dataset.key || !Storage.canEditPriceTable()) return false;
    openCellKey = other.dataset.key;
    renderPriceTable();
    focusOpenPriceCell();
    return true;
  },
  onOutside: () => cancelPriceEdit(),
});
function attachOutsidePriceTap() { priceOutsideTap.attach(); }
function detachOutsidePriceTap() { priceOutsideTap.detach(); }

// --- A: bring the open cell (and its stacked fields) to the top, clear of the
// keyboard, instead of leaving it wherever it happened to be.
function focusOpenPriceCell() {
  const cell = priceTableEl ? priceTableEl.querySelector('.price-cell-editing') : null;
  const scroller = document.getElementById('price-scroll');
  if (!cell || !scroller) return;
  requestAnimationFrame(() => {
    const c = cell.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const headH = 34;  // roughly the sticky vendor row
    scroller.scrollTop += (c.top - s.top) - headH;
    // and nudge sideways if the column is half off the edge
    if (c.left < s.left) scroller.scrollLeft += (c.left - s.left) - 8;
    else if (c.right > s.right) scroller.scrollLeft += (c.right - s.right) + 8;
    const input = cell.querySelector('.price-input');
    if (input) input.focus();
  });
}

function renderPriceTable() {
  if (!priceTableEl) return;
  const cfg = Storage.getPriceConfig();
  const allItems = Storage.listPriceItems();
  // Rows only: vendors are few and always visible, and filtering columns too
  // would leave you comparing prices you can't see the context for.
  const words = priceFilter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = words.length
    ? allItems.filter(i => words.every(w => (i.name || '').toLowerCase().includes(w)))
    : allItems;
  const filterCount = document.getElementById('price-filter-count');
  if (filterCount) filterCount.textContent = words.length
    ? `showing ${items.length} of ${allItems.length} items`
    : '';
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

  if (words.length && !items.length) {
    priceTableEl.innerHTML = `<tbody><tr><td class="price-empty-state">No items match “${escapeHtml(priceFilter)}”.</td></tr></tbody>`;
    return;
  }
  if (!cfg.vendors.length && !allItems.length) {
    priceTableEl.innerHTML = `<tbody><tr><td class="price-empty-state">${canEdit
      ? 'Add a vendor and an item to start your price table.'
      : 'The price table is empty.'}</td></tr></tbody>`;
    return;
  }
  const vendors = cfg.vendors.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const reorder = priceReorderMode && canEdit;
  const head = `<thead><tr><th class="price-corner">Item</th>${
    vendors.map((v, i) => `<th class="price-vendor" data-vendor="${v.id}">${
      reorder ? `<input type="checkbox" class="price-pick" data-pick-vendor="${v.id}" ${priceSelVendors.has(v.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(v.name)}" />` : ''
    }${escapeHtml(v.name)}${
      reorder ? `<span class="reorder-arrows"><button type="button" class="v-left" data-vendor="${v.id}" ${i === 0 ? 'disabled' : ''}>←</button><button type="button" class="v-right" data-vendor="${v.id}" ${i === vendors.length - 1 ? 'disabled' : ''}>→</button></span>` : ''
    }</th>`).join('')
  }</tr></thead>`;
  const body = `<tbody>${items.map((item, i) => `<tr>
      <th class="price-item" data-item="${item.id}">${
        reorder ? `<input type="checkbox" class="price-pick" data-pick-item="${item.id}" ${priceSelItems.has(item.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(item.name)}" />` : ''
      }${escapeHtml(item.name)}${
        reorder ? `<span class="reorder-arrows"><button type="button" class="i-up" data-item="${item.id}" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="i-down" data-item="${item.id}" ${i === items.length - 1 ? 'disabled' : ''}>↓</button></span>` : ''
      }</th>
      ${(() => { const best = cheapestVendorId(item, vendors); return vendors.map(v => priceCellHtml(item, v, canEdit, v.id === best)).join(''); })()}
    </tr>`).join('')}</tbody>`;
  priceTableEl.innerHTML = head + body;
  renderPriceSelectBar();
  applyPriceZoomVar();
  wirePriceTable(canEdit);
}

// ---------- price table: long-press to drag a row or column ----------
// Long-press a row or column header to pick it up, drag, release to drop.
// A drop indicator shows where it will land; nothing is reordered live,
// because moving a COLUMN live means touching a cell in every row. One code
// path serves both axes.
let priceDrag = null;
function blockPriceDragScroll(e) {
  if (priceDrag && e.cancelable) e.preventDefault();
}
function priceDropLine() {
  let el = document.getElementById('price-drop-line');
  if (!el) {
    el = document.createElement('div');
    el.id = 'price-drop-line';
    el.className = 'price-drop-line';
    (priceScrollEl || document.body).appendChild(el);
  }
  return el;
}
function clearPriceDrag() {
  if (priceDrag && priceDrag.el) priceDrag.el.classList.remove('price-dragging');
  document.removeEventListener('touchmove', blockPriceDragScroll, { passive: false });
  const line = document.getElementById('price-drop-line');
  if (line) line.remove();
  priceDrag = null;
}
// Which row/column is under the pointer, and do we drop before or after it?
function priceDragTarget(x, y) {
  if (!priceDrag) return null;
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (priceDrag.axis === 'y') {
    const tr = el.closest('tr');
    const th = tr && tr.querySelector('.price-item');
    if (!th || !priceTableEl.contains(tr)) return null;
    const r = tr.getBoundingClientRect();
    return { id: th.dataset.item, after: y > r.top + r.height / 2, rect: r };
  }
  const cell = el.closest('th[data-vendor], td[data-key]');
  if (!cell || !priceTableEl.contains(cell)) return null;
  const id = cell.dataset.vendor || (cell.dataset.key || '').split('|')[1];
  if (!id) return null;
  const head = priceTableEl.querySelector(`th[data-vendor="${id}"]`);
  if (!head) return null;
  const r = head.getBoundingClientRect();
  return { id, after: x > r.left + r.width / 2, rect: r };
}
function drawPriceDropLine(t) {
  if (!priceScrollEl || !t) return;
  const line = priceDropLine();
  const box = priceScrollEl.getBoundingClientRect();
  if (priceDrag.axis === 'y') {
    line.className = 'price-drop-line price-drop-h';
    line.style.top = (t.rect[t.after ? 'bottom' : 'top'] - box.top + priceScrollEl.scrollTop) + 'px';
    line.style.left = priceScrollEl.scrollLeft + 'px';
    line.style.width = box.width + 'px';
    line.style.height = '';
  } else {
    line.className = 'price-drop-line price-drop-v';
    line.style.left = (t.rect[t.after ? 'right' : 'left'] - box.left + priceScrollEl.scrollLeft) + 'px';
    line.style.top = priceScrollEl.scrollTop + 'px';
    line.style.height = box.height + 'px';
    line.style.width = '';
  }
}
// The table is bigger than the screen, so drag near an edge to keep moving.
function priceDragAutoScroll(x, y) {
  if (!priceScrollEl) return;
  const b = priceScrollEl.getBoundingClientRect(), EDGE = 40, STEP = 12;
  if (priceDrag.axis === 'y') {
    if (y < b.top + EDGE) priceScrollEl.scrollTop -= STEP;
    else if (y > b.bottom - EDGE) priceScrollEl.scrollTop += STEP;
  } else {
    if (x < b.left + EDGE) priceScrollEl.scrollLeft -= STEP;
    else if (x > b.right - EDGE) priceScrollEl.scrollLeft += STEP;
  }
}
async function finishPriceDrag() {
  if (!priceDrag) return;
  const { axis, id, target } = priceDrag;
  clearPriceDrag();
  if (!target || target.id === id) return;          // dropped where it started
  if (axis === 'y') {
    const items = Storage.listPriceItems();
    const at = items.findIndex(i => i.id === target.id);
    const beforeIdx = target.after ? at + 1 : at;
    const before = items[beforeIdx] && items[beforeIdx].id === id
      ? (items[beforeIdx + 1] || null) : (items[beforeIdx] || null);
    await Storage.reorderPriceItem(id, before ? before.id : null);
  } else {
    const vendors = Storage.getPriceConfig().vendors.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const from = vendors.findIndex(v => v.id === id);
    if (from === -1) return;
    const [moved] = vendors.splice(from, 1);
    let at = vendors.findIndex(v => v.id === target.id);
    if (at === -1) return;
    vendors.splice(target.after ? at + 1 : at, 0, moved);
    await Storage.savePriceConfig({ vendors: vendors.map((v, i) => ({ ...v, order: i })) });
  }
  renderPriceTable();
}
// Long-press wiring shared by both header types.
function wirePriceHeaderDrag(el, axis, id) {
  let timer = null, down = null, dragged = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  priceLongPressCancels.add(cancel);
  // Belt and braces with the CSS: Android can start a selection before the
  // user-select rule takes effect, and this also kills the compatibility mouse
  // events that seed a desktop selection. Scrolling is unaffected — that's
  // touch-action, which isn't touched until the drag actually starts.
  el.addEventListener('selectstart', (e) => { if (down || priceDrag) e.preventDefault(); });
  el.addEventListener('pointerdown', (e) => {
    if (pricePointerCount > 1 || pinchJustHappened()) return;
    e.preventDefault();
    down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    dragged = false;
    timer = setTimeout(() => {
      timer = null;
      priceDrag = { el, axis, id, target: null };
      el.classList.add('price-dragging');
      // Second line of defence: the axis is already reserved in CSS, but where
      // the browser still allows it, cancel the scroll outright.
      document.addEventListener('touchmove', blockPriceDragScroll, { passive: false });
      try { el.setPointerCapture(down.id); } catch (err) {}
      if (navigator.vibrate) navigator.vibrate(10);
    }, 500);
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (!priceDrag) {
      // Moved before the hold completed — that was a scroll, not a press.
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { cancel(); down = null; }
      return;
    }
    dragged = true;
    e.preventDefault();
    priceDragAutoScroll(e.clientX, e.clientY);
    const t = priceDragTarget(e.clientX, e.clientY);
    if (t) { priceDrag.target = t; drawPriceDropLine(t); }
  });
  const end = () => {
    cancel();
    down = null;
    if (priceDrag) finishPriceDrag();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { cancel(); down = null; clearPriceDrag(); });
  // Without this every drag would end in the rename prompt.
  el.addEventListener('click', (e) => {
    if (dragged) { dragged = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
}

function wirePriceTable(canEdit) {
  priceLongPressCancels.clear();   // stale closures from the previous render
  clearPriceDrag();                // a re-render orphans any in-flight drag
  // Long-press (or right-click) opens history; a plain tap opens inline entry
  priceTableEl.querySelectorAll('.price-cell').forEach(cell => {
    let pressTimer = null;
    let longPressed = false;
    let pressing = false;
    const key = cell.dataset.key;
    const startPress = (e) => {
      if (pricePointerCount > 1 || pinchJustHappened()) return;   // pinching
      pressing = true;
      longPressed = false;      // reset HERE — the only correct place; see below
      pressTimer = setTimeout(() => {
        longPressed = true;
        suppressPriceTap();     // and belt-and-braces for the click that follows
        openPriceHistory(key);
      }, 500);
    };
    // Deliberately does NOT clear longPressed. It used to, and that was the bug:
    // cancelPress runs on POINTERUP, and the click event fires after it — so by
    // the time the click handler asked "was that a long press?" the answer had
    // already been wiped, and it opened the cell editor. Which focused the price
    // input, which raised the keyboard, on top of the history sheet you'd just
    // opened. Intermittent, because some browsers suppress the synthetic click
    // after a long press and some don't. startPress resets the flag for the next
    // gesture, which is all that's needed.
    const cancelPress = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      pressing = false;
    };
    priceLongPressCancels.add(cancelPress);
    cell.addEventListener('selectstart', (e) => { if (pressing) e.preventDefault(); });
    cell.addEventListener('pointerdown', startPress);
    cell.addEventListener('pointerup', cancelPress);
    cell.addEventListener('pointerleave', cancelPress);
    cell.addEventListener('pointercancel', cancelPress);
    cell.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancelPress();
      suppressPriceTap();
      openPriceHistory(key);
    });
    cell.addEventListener('click', (e) => {
      if (longPressed) { longPressed = false; return; }
      if (priceTapSuppressed()) return;  // the click a long-press left behind
      if (pinchJustHappened()) return;   // that was a zoom, not a tap
      if (!canEdit) return;
      if (e.target.closest('.price-cell-editing')) return; // already editing
      openCellKey = key;
      renderPriceTable();
      focusOpenPriceCell();
    });
  });
  const editing = priceTableEl.querySelector('.price-cell-editing');
  if (editing) {
    const [itemId, vendorId] = editing.dataset.key.split('|');
    const save = async () => {
      detachOutsidePriceTap();
      const price = editing.querySelector('.price-input').value;
      const date = editing.querySelector('.price-date').value;
      const avail = editing.querySelector('.price-avail').value;
      openCellKey = null;
      await Storage.addPriceEntry(itemId, vendorId, { price, date, avail });
      renderPriceTable();
    };
    editing.querySelector('.price-save').addEventListener('click', save);
    editing.querySelector('.price-cancel').addEventListener('click', cancelPriceEdit);
    // Tapping anywhere outside the open cell is the same as Cancel. Registered
    // on the NEXT tick so the tap that opened the cell doesn't close it, and
    // ignored during a pinch so zooming doesn't discard what you typed.
    setTimeout(attachOutsidePriceTap, 0);
    focusOpenPriceCell();
    editing.querySelector('.price-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { cancelPriceEdit(); }
    });
  }
  // Reorder mode: arrows move rows/columns; taps don't rename
  if (priceReorderMode && canEdit) {
    priceTableEl.querySelectorAll('.price-pick').forEach(cb => {
      cb.addEventListener('click', (e) => e.stopPropagation());  // not a rename
      cb.addEventListener('change', () => {
        const set = cb.dataset.pickItem ? priceSelItems : priceSelVendors;
        const id = cb.dataset.pickItem || cb.dataset.pickVendor;
        if (cb.checked) set.add(id); else set.delete(id);
        renderPriceSelectBar();
      });
    });
    renderPriceSelectBar();
    priceTableEl.querySelectorAll('.i-up').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); movePriceItem(b.dataset.item, -1); }));
    priceTableEl.querySelectorAll('.i-down').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); movePriceItem(b.dataset.item, 1); }));
    priceTableEl.querySelectorAll('.v-left').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); movePriceVendor(b.dataset.vendor, -1); }));
    priceTableEl.querySelectorAll('.v-right').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); movePriceVendor(b.dataset.vendor, 1); }));
    return;
  }
  // Rename / remove a row or column (edit rights only), plus long-press to move
  if (canEdit) {
    priceTableEl.querySelectorAll('.price-item').forEach(th => wirePriceHeaderDrag(th, 'y', th.dataset.item));
    priceTableEl.querySelectorAll('.price-vendor').forEach(th => wirePriceHeaderDrag(th, 'x', th.dataset.vendor));
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
// Zoom by scaling type and spacing rather than transforming the table: a
// CSS transform on an ancestor establishes a containing block, which stops
// `position: sticky` working — that's what made the item column drift while
// scrolling sideways. Scaling the layout keeps sticky intact and the text
// crisp at every level.
function applyPriceZoomVar() {
  const view = document.getElementById('price-view');
  if (view) view.style.setProperty('--price-scale', String(priceZoom));
}

function setPriceZoom(z) {
  priceZoom = Math.max(0.5, Math.min(2, Math.round(z * 10) / 10));
  localStorage.setItem('na-price-zoom', String(priceZoom));
  applyPriceZoomVar();
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
function editableFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}
function keyboardInset(vv) {
  if (!vv || !editableFocused()) return 0;
  const gap = window.innerHeight - (vv.height + vv.offsetTop);
  if (!(gap > 120)) return 0;                       // browser chrome, not a keyboard
  return Math.min(gap, window.innerHeight * 0.6);   // never more than 60% of the screen
}

// Is the on-screen keyboard ACTUALLY up right now?
//
// Not the same question as "is a field focused". Dismissing the keyboard with
// Android's back button, iOS's Done key or a swipe-down leaves the field
// focused with the keyboard gone, so focus over-reports. keyboardInset already
// encodes the app's hard-won test for real keyboard occupancy (focus AND a gap
// bigger than browser chrome), so this just asks it.
//
// The grace window covers the open animation: the gap grows from zero, so a
// tap landing while the keyboard is sliding in would measure 0 and read as
// "down". If it measured up a moment ago and focus hasn't left, it's up.
// Cost: dismissing the keyboard and tapping a checkbox within 600ms still
// reads as "up", since a dismissal and an opening look the same from one
// sample. Shorten it before removing it — open animations run about 250ms.
let kbLastUpAt = 0;
function keyboardIsUp() {
  if (keyboardInset(window.visualViewport) > 0) return true;
  return editableFocused() && (Date.now() - kbLastUpAt) < 600;
}
function updateAppVh() {
  // visualViewport shrinks when the on-screen keyboard appears; innerHeight
  // does not. Modals sized in vh therefore ran under the keyboard, hiding
  // whatever sat at the bottom (e.g. customer search results).
  const vv = window.visualViewport;
  const h = (vv && vv.height) || window.innerHeight;
  document.documentElement.style.setProperty('--app-vh', h + 'px');
  // How much of the layout viewport the KEYBOARD covers. `position: fixed`
  // anchors to the layout viewport, so a bottom-anchored button would sit
  // behind the keyboard without this offset.
  //
  // The raw gap is NOT trustworthy on its own: browser chrome (the URL bar)
  // produces one too, and treating that as a keyboard pushed every FAB up the
  // screen — mid-screen on one list, off the top on another. So require a
  // focused text field, ignore anything small enough to be chrome, and cap it
  // so a bad reading can never launch a control off-screen.
  const kb = keyboardInset(vv);
  if (kb > 0) kbLastUpAt = Date.now();   // feeds keyboardIsUp's grace window
  document.documentElement.style.setProperty('--kb-inset', kb + 'px');
}
updateAppVh();
window.addEventListener('resize', updateAppVh);
window.addEventListener('orientationchange', updateAppVh);
if (window.visualViewport) window.visualViewport.addEventListener('resize', updateAppVh);
// The keyboard announces itself through focus, not only through resize.
window.addEventListener('focusin', updateAppVh);
window.addEventListener('focusout', () => setTimeout(updateAppVh, 50));

// ---------- price table: pinch zoom ----------
// Two-finger pinch adjusts the same zoom the −/+ buttons use. One finger is
// left alone so normal scrolling/panning still works.
const priceScrollEl = document.getElementById('price-scroll');
// Lifting a pinch used to land as a tap on whatever cell was under the finger,
// opening its editor. Any multi-touch gesture now suppresses cell taps briefly
// after the last finger leaves.
// Multi-touch is tracked for the WHOLE price view, not per cell. Per-cell
// guards weren't enough: the first finger lands on a cell (starting its
// long-press) before the second arrives, and the second finger only cancelled
// the timer on the cell IT touched. Clicks are also swallowed in the capture
// phase during and just after a gesture, so nothing downstream sees them.
let pinchSuppressUntil = 0;
let pricePointerCount = 0;
const priceLongPressCancels = new Set();   // cancel callbacks for open timers
function pinchJustHappened() { return pricePointerCount >= 2 || Date.now() < pinchSuppressUntil; }
// A long press (or right-click) has just opened the history sheet. The click
// that a long press leaves behind must not also open the cell editor.
let priceTapSuppressUntil = 0;
function suppressPriceTap(ms = 700) { priceTapSuppressUntil = Date.now() + ms; }
function priceTapSuppressed() { return Date.now() < priceTapSuppressUntil; }
function cancelAllPriceLongPress() {
  priceLongPressCancels.forEach(fn => { try { fn(); } catch (e) {} });
}
const priceViewEl = document.getElementById('price-view');
if (priceViewEl) {
  const bump = () => { pinchSuppressUntil = Date.now() + 500; };
  priceViewEl.addEventListener('pointerdown', () => {
    pricePointerCount++;
    if (pricePointerCount >= 2) { bump(); cancelAllPriceLongPress(); }
  }, true);
  const release = () => {
    if (pricePointerCount >= 2) bump();       // keep suppressing past the release
    pricePointerCount = Math.max(0, pricePointerCount - 1);
  };
  priceViewEl.addEventListener('pointerup', release, true);
  priceViewEl.addEventListener('pointercancel', release, true);
  // Swallow the click a pinch leaves behind, before any cell/button sees it
  priceViewEl.addEventListener('click', (e) => {
    if (!pinchJustHappened()) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}
if (priceScrollEl) {
  const pts = new Map();
  let startDist = 0, startZoom = 1;
  const dist = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  priceScrollEl.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      startDist = dist();
      startZoom = priceZoom;
      pinchSuppressUntil = Date.now() + 400;   // a pinch has begun
    }
  });
  priceScrollEl.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && startDist > 0) {
      e.preventDefault();
      pinchSuppressUntil = Date.now() + 400;
      setPriceZoom(startZoom * (dist() / startDist));
    }
  });
  const dropPt = (e) => {
    if (pts.size >= 2) pinchSuppressUntil = Date.now() + 400;  // keep it live past the release
    pts.delete(e.pointerId);
    if (pts.size < 2) startDist = 0;
  };
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

// ---------- calendar and hours: ⋯ menus ----------
// Same shape as the price menu above. Dropdowns are NOT .modal-overlay, so the
// MutationObserver that gives modals a back press doesn't cover them — closing
// on navigation and on an outside tap has to be wired by hand.
const moreMenus = [
  ['cal-more-btn', 'cal-more-dropdown'],
  ['hours-more-btn', 'hours-more-dropdown'],
].map(([btnId, dropId]) => ({
  btn: document.getElementById(btnId),
  drop: document.getElementById(dropId),
})).filter(m => m.btn && m.drop);

moreMenus.forEach(({ btn, drop }) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    drop.hidden = !drop.hidden;
  });
  drop.addEventListener('click', () => { drop.hidden = true; });
  document.addEventListener('click', (e) => {
    if (!drop.hidden && !drop.contains(e.target) && e.target !== btn) drop.hidden = true;
  });
});

// Every ⋯ dropdown in the app, closed in one call — used on navigation and
// before a tutorial starts, since an open menu would sit over the very thing
// the first bubble points at.
function closeAllMoreMenus() {
  closePriceMenu();
  moreMenus.forEach(({ drop }) => { drop.hidden = true; });
  const editorDrop = document.getElementById('editor-more-dropdown');
  if (editorDrop) editorDrop.hidden = true;
}

// ---------- price table: reorder mode ----------
let priceFilter = '';
let priceReorderMode = false;
// Rows/columns ticked in layout mode, to be moved to the top/front in one go
const priceSelItems = new Set();
const priceSelVendors = new Set();
const priceReorderBtn = document.getElementById('price-reorder');
if (priceReorderBtn) priceReorderBtn.addEventListener('click', () => {
  priceReorderMode = !priceReorderMode;
  priceReorderBtn.setAttribute('aria-pressed', String(priceReorderMode));
  priceReorderBtn.textContent = priceReorderMode ? 'Done' : 'Layout';
  priceReorderBtn.classList.toggle('active', priceReorderMode);
  if (priceReorderMode && priceFilter) {
    // Reordering a filtered view would move rows relative to ones you can't
    // see — clear the filter on the way in.
    priceFilter = '';
    if (priceSearchInput) priceSearchInput.value = '';
    refreshSearchClears();
  }
  if (!priceReorderMode) { priceSelItems.clear(); priceSelVendors.clear(); }
  openCellKey = null;
  renderPriceTable();
});

function renderPriceSelectBar() {
  const bar = document.getElementById('price-select-bar');
  const count = document.getElementById('price-select-count');
  if (!bar) return;
  const n = priceSelItems.size + priceSelVendors.size;
  bar.hidden = !(priceReorderMode && n > 0);
  if (count) {
    const parts = [];
    if (priceSelItems.size) parts.push(`${priceSelItems.size} item${priceSelItems.size === 1 ? '' : 's'}`);
    if (priceSelVendors.size) parts.push(`${priceSelVendors.size} vendor${priceSelVendors.size === 1 ? '' : 's'}`);
    count.textContent = `${parts.join(' · ')} selected`;
  }
}
// Selected rows go to the top / selected columns to the front, keeping their
// relative order; everything else follows. Then every order value is
// renumbered so the result is stable.
async function movePriceSelectionFirst() {
  if (priceSelItems.size) {
    const items = Storage.listPriceItems();
    const picked = items.filter(i => priceSelItems.has(i.id));
    const rest = items.filter(i => !priceSelItems.has(i.id));
    const ordered = [...picked, ...rest];
    for (let i = 0; i < ordered.length; i++) {
      if ((ordered[i].order ?? -1) !== i) await Storage.savePriceItem(ordered[i].id, { order: i });
    }
  }
  if (priceSelVendors.size) {
    const vendors = Storage.getPriceConfig().vendors.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const picked = vendors.filter(v => priceSelVendors.has(v.id));
    const rest = vendors.filter(v => !priceSelVendors.has(v.id));
    await Storage.savePriceConfig({ vendors: [...picked, ...rest].map((v, i) => ({ ...v, order: i })) });
  }
  priceSelItems.clear();
  priceSelVendors.clear();
  renderPriceTable();
}
const priceSearchInput = document.getElementById('price-search');
if (priceSearchInput) priceSearchInput.addEventListener('input', () => {
  priceFilter = priceSearchInput.value;
  openCellKey = null;
  renderPriceTable();
});

const priceMoveTopBtn = document.getElementById('price-move-top');
if (priceMoveTopBtn) priceMoveTopBtn.addEventListener('click', movePriceSelectionFirst);
const priceSelClearBtn = document.getElementById('price-select-clear');
if (priceSelClearBtn) priceSelClearBtn.addEventListener('click', () => {
  priceSelItems.clear(); priceSelVendors.clear(); renderPriceTable();
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
      else if (go === 'calendar') showCalendar();
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
  if (hoursView && hoursView.classList.contains('active')) return 'hours';
  if (calendarView && calendarView.classList.contains('active')) return 'calendar';
  if (calendarDayView && calendarDayView.classList.contains('active')) return 'calendar-day:' + calSelectedDate;
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
  // The calendar and hours ⋯ menus, same reason — a dropdown left open would
  // reappear over whatever screen you came back to.
  ['cal-more-dropdown', 'hours-more-dropdown'].forEach(id => {
    const d = document.getElementById(id);
    if (d) d.hidden = true;
  });
  detachOutsidePriceTap();
  listView.classList.remove('active');
  customersView.classList.remove('active');
  customerNotesView.classList.remove('active');
  settingsView.classList.remove('active');
  if (sectionView) sectionView.classList.remove('active');
  if (orphanView) orphanView.classList.remove('active');
  if (priceView) priceView.classList.remove('active');
  if (hoursView) {
    // Only when it was actually up: closeIifCell reaches into state declared
    // further down the file, and the guard also keeps it off the hot path.
    // Same reasoning as detachOutsidePriceTap above — leaving with a cell open
    // would strand its document-level pointer listener.
    if (hoursView.classList.contains('active')) closeIifCell(false);
    hoursView.classList.remove('active');
  }
  if (calendarView) calendarView.classList.remove('active');
  if (calendarDayView) calendarDayView.classList.remove('active');
  const jm = document.getElementById('job-modal');
  if (jm) jm.hidden = true;
  editorView.classList.remove('active');
  if (signinView) signinView.classList.remove('active');
  if (bootView) bootView.classList.remove('active');
  // Body class controls page-level scroll lock for the editor and hours screens
  document.body.classList.remove('editor-open');
  document.body.classList.remove('hours-open');
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
  renderCustomerLinks();
  if (accountEmailEl && auth.currentUser) accountEmailEl.textContent = auth.currentUser.email || '';
  // The company name only exists on orgs created from a founder invite; the
  // original org predates names, so the line hides rather than showing blank.
  if (accountOrgEl) {
    const orgName = Storage.getOrgName();
    accountOrgEl.textContent = orgName;
    accountOrgEl.hidden = !orgName;
  }
  refreshNewOrgUi();
  refreshOrgNameUi();
  refreshSeedButtons();
  refreshTrashUi();
  applyClockButton();
  const moveCheckedInput = document.getElementById('setting-move-checked');
  if (moveCheckedInput) moveCheckedInput.checked = getMoveCheckedToBottom();
  const collapseSearchInput = document.getElementById('setting-collapse-search');
  if (collapseSearchInput) collapseSearchInput.checked = getCollapseSearch();
  settingsView.classList.add('active');
  if (!handlingPopstate) history.pushState({ screen: 'settings' }, '');
  applyTheme();
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
  checkDeployedVersion();          // ask GitHub what's actually deployed
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
  renderContactStrip(customerId);
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
  // Hand back the stack if this is the note we just left and nothing has
  // changed it since; otherwise start clean.
  if (!restoreUndoForNote(record, type)) resetUndo();
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
  const duplicateBtnEl = document.getElementById('duplicate-note-btn');
  // Most job notes start out like the last one — duplicating is the cheap 90%
  // of "templates". Never on a customer's default note: that note IS the
  // customer, and a copy would look like a second customer record.
  if (duplicateBtnEl) duplicateBtnEl.hidden = !(type === 'note' && !currentIsDefault && !isReadOnlyRole());
  // The Hours shortcut used to appear on a note titled "hours", because that
  // note was the chart's input. The chart reads calendar jobs now, so no note
  // is special and the shortcut stays hidden. (v2026.08.18-2325)
  const editorIifBtnEl = document.getElementById('editor-iif-btn');
  if (editorIifBtnEl) editorIifBtnEl.hidden = true;

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

  // Customers first — when you search a name you almost always want the
  // person, not one of their notes. Matched on their DEFAULT note, so the
  // address counts too, exactly like the Customers screen's own search.
  // Employees and customers never have this collection in cache, so the group
  // is naturally empty for them without a role check.
  const lowerTerm = term.trim().toLowerCase();
  const customerHits = Storage.listCustomers().filter(c => customerMatchesSearch(c, lowerTerm));
  const customerIds = new Set(customerHits.map(c => c.id));

  // A customer's default note IS that customer, so it matches whenever they
  // do. Showing both would double every name you search for.
  const results = allNotes.filter(n =>
    noteMatchesSearch(n, words) && !(n.isDefault && customerIds.has(n.customerId)));

  if (results.length === 0 && customerHits.length === 0) {
    notesList.innerHTML = `<p class="empty-state">Nothing matches "${escapeHtml(term)}".</p>`;
    return;
  }

  const customerHtml = customerHits.length ? '<p class="section-label">Customers:</p>' + customerHits.map(c => {
    const def = Storage.getDefaultNoteForCustomer(c.id);
    const { title, body } = splitTitleAndBody(def ? def.body : '');
    const safeTitle = title.trim()
      ? escapeHtml(title)
      : '<span style="color:var(--ink-soft);font-style:italic">Untitled</span>';
    const firstBodyLine = (body.split('\n').find(l => l.trim() !== '') || '').trim();
    return `
      <article class="note-card pinned" data-id="${c.id}" data-kind="customer">
        <div class="note-head">
          <p class="note-title">${safeTitle}</p>
          <span class="note-date">${formatDateTime(c.updated)}</span>
        </div>
        ${firstBodyLine ? `<p class="note-preview">${escapeHtml(firstBodyLine)}</p>` : ''}
      </article>
    `;
  }).join('') : '';

  const notesHtml = results.length
    ? (customerHits.length ? '<p class="section-label">Notes:</p>' : '') + results.map(n => {
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
  }).join('') : '';

  notesList.innerHTML = customerHtml + notesHtml;

  notesList.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => {
      // A customer row goes to their note list, the same as tapping them on
      // the Customers screen — not into an editor.
      if (card.dataset.kind === 'customer') { showCustomerNotes(card.dataset.id); return; }
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

  // Customer/employee roles: simplified home — only the notes assigned to them.
  // (Admin and bookkeeper get the full home.)
  if (!canViewAllRole()) {
    const assigned = Storage.listAllNotes();
    const emptyState = isCustomerRole()
      ? '<p class="empty-state">No notes have been shared with you yet.</p>'
      : '<p class="empty-state">No notes yet. Tap <strong>+</strong> to add one.</p>';
    // Nav cards an employee is entitled to. This branch returns before the
    // full home is built, so anything not repeated here is invisible to them —
    // which is exactly how the Calendar card went missing for employees even
    // though the card itself was role-gated to include them.
    const navCards = [
      `<article class="note-card nav-card" data-nav="calendar">
        <div class="note-head"><p class="note-title">Calendar</p><span class="note-chevron">›</span></div>
      </article>`,
      // Price table is staff-only; a customer never sees it.
      (!isCustomerRole() && Storage.canViewPriceTable()) ? `<article class="note-card nav-card" data-nav="price">
        <div class="note-head"><p class="note-title">Price Table</p><span class="note-chevron">›</span></div>
      </article>` : '',
    ].join('');
    notesList.innerHTML = navCards + (assigned.length === 0
      ? emptyState
      : '<p class="section-label">Your notes:</p>' + assigned.map(n => renderNoteCard(n)).join(''));
    notesList.querySelectorAll('.note-card[data-nav]').forEach(card => {
      card.addEventListener('click', () => {
        if (card.dataset.nav === 'calendar') showCalendar();
        else if (card.dataset.nav === 'price') showPriceTable();
      });
    });
    notesList.querySelectorAll('.note-card[data-id]').forEach(card => {
      card.addEventListener('click', () => {
        const note = Storage.getNote(card.dataset.id);
        if (note) { returnScreen = 'notes'; showEditor(note, 'note'); }
      });
    });
    return;
  }

  // The four nav cards are titles only — the counts they used to carry
  // ("42 customers", "3 upcoming jobs") were never the reason anyone tapped
  // them, and dropping them also drops per-render work: the calendar count
  // walked every job and the hours line scanned every note looking for the
  // "hours" note, on every home draw.
  const customersCard = `
    <article class="note-card nav-card" data-nav="customers">
      <div class="note-head">
        <p class="note-title">Customers</p>
        <span class="note-chevron">›</span>
      </div>
    </article>
  `;

  // Calendar card — everyone except the read-only customer role
  const calendarCard = (isAdminRole() || isBookkeeperRole() || Storage.getRole() === 'employee') ? `
    <article class="note-card nav-card" data-nav="calendar">
      <div class="note-head">
        <p class="note-title">Calendar</p>
        <span class="note-chevron">›</span>
      </div>
    </article>
  ` : '';
  // Price table card — admins/bookkeepers always, employees only when shared
  const priceCard = Storage.canViewPriceTable() ? `
    <article class="note-card nav-card" data-nav="price">
      <div class="note-head">
        <p class="note-title">Price Table</p>
        <span class="note-chevron">›</span>
      </div>
    </article>
  ` : '';
  // Hours card — same audience as the Settings entry: admin (full) and
  // bookkeeper (read-only export).
  const hoursCard = (isAdminRole() || isBookkeeperRole()) ? `
    <article class="note-card nav-card" data-nav="hours">
      <div class="note-head">
        <p class="note-title">Hours</p>
        <span class="note-chevron">›</span>
      </div>
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
  // Customers and Price Table sit side by side at the top of the home screen;
  // Calendar and Hours pair up on the row beneath. A lone card fills the row.
  const navRow = `<div class="nav-card-row">${customersCard}${priceCard}</div>`
    + ((calendarCard || hoursCard) ? `<div class="nav-card-row">${calendarCard}${hoursCard}</div>` : '');
  notesList.innerHTML = gettingStartedCardsHtml() + navRow + pinnedBlock + olderHtml + orphanCard;

  applyLayoutMode();
  wireGettingStartedCards(notesList);
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
      // A getting-started card has its own buttons and is not itself tappable —
      // without this it falls through to the note lookup at the bottom and
      // opens nothing, which just looks broken.
      if (card.dataset.gs) return;
      if (card.dataset.nav === 'customers') {
        const chevron = card.querySelector('.note-chevron');
        if (chevron) chevron.innerHTML = '<span class="nav-spinner"></span>';
        setTimeout(showCustomers, 0);
      }
      else if (card.dataset.keyword) showAggregator(card.dataset.keyword);
      else if (card.dataset.nav === 'price') showPriceTable();
      else if (card.dataset.nav === 'calendar') showCalendar();
      else if (card.dataset.nav === 'hours') showHoursView();
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


// ---------- getting-started cards ----------
// Replaces the first-run welcome MODAL (removed v2026.08.19-0020). A dialog in
// front of an empty app has to be answered before you can look at anything, and
// "Start empty" was the fastest way past it — so the two things worth doing got
// dismissed by people who hadn't seen the app yet. As cards they sit on the
// home screen and wait.
//
// Shown to EVERY admin of a young company, not just whoever founded it: a
// second admin added in week one is as new to the app as the first.
//
// Three gates, all of which must pass:
//   · you are an admin (nobody else can seed data or needs the full tour)
//   · the company is younger than GETTING_STARTED_DAYS — an org doc with no
//     createdAt reads as null and counts as OLD, so an established company can
//     never suddenly sprout these
//   · this person hasn't dismissed that card (stored on their own member doc)
// `onboardingSeen` is still honoured as the legacy marker for anyone who went
// through the old modal.
const GETTING_STARTED_DAYS = 90;

function gettingStartedCardsHtml() {
  if (!isAdminRole()) return '';
  if (Storage.getSettings().onboardingSeen) return '';
  const age = Storage.getOrgAgeDays();
  if (age === null || age > GETTING_STARTED_DAYS) return '';
  const done = Storage.gettingStartedDismissed();
  const card = (key, title, hint, action) => done[key] ? '' : `
    <article class="note-card getting-started-card" data-gs="${key}">
      <div class="note-head">
        <p class="note-title">${title}</p>
        <button class="member-remove-btn" data-gs-dismiss="${key}" title="Dismiss" aria-label="Dismiss">✕</button>
      </div>
      <p class="note-preview">${hint}</p>
      <button class="primary setting-wide-btn" data-gs-go="${key}" style="margin-top:8px;">${action}</button>
    </article>`;
  const both = card('tour', 'Take the tour',
      'A quick walk through the app, one screen at a time. You can start it again any time from Settings → Help.',
      'Start the tour')
    + card('sample', 'Add sample data',
      'Fills the app with example customers, jobs, hours and prices so you can try things safely. Add or remove it any time from Settings → Sample data.',
      'Add sample data');
  return both;
}

// Wired by renderNotesList after it writes the home screen.
function wireGettingStartedCards(root) {
  if (!root) return;
  root.querySelectorAll('[data-gs-dismiss]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();       // the card itself is not a nav target, but the
                                 // home click handler walks .note-card
      await Storage.dismissGettingStarted(btn.dataset.gsDismiss);
      renderNotesList();
    });
  });
  root.querySelectorAll('[data-gs-go]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const which = btn.dataset.gsGo;
      if (which === 'tour') { startTutorial(1); return; }
      btn.disabled = true;
      btn.textContent = 'Adding…';
      await Storage.seedSampleData();
      // Loading it counts as doing it — leaving the card offering to add data
      // that is now sitting on screen reads as if nothing happened.
      await Storage.dismissGettingStarted('sample');
      refreshSeedButtons();
      renderNotesList();
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
// Checkpoints. Enter and paste are rare and meaningful; a space would fire
// every few characters and cost far more than the debounce it replaced.
function wireSaveCheckpoints(el) {
  if (!el) return;
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') setTimeout(flushSave, 0); });
  // Deferred a tick so the pasted text is actually in .value when we read it.
  el.addEventListener('paste', () => setTimeout(flushSave, 0));
}
// Typing pauses used to commit after 400ms, so every glance away wrote a
// document (and each write echoes back through our own listener as a billed
// read). 1500ms cuts that several-fold. Saving on word boundaries would have
// been far WORSE — a space every ~5 characters is a write per word.
//
// The exposure window widens from 0.4s to 1.5s of typing, and only for a
// browser crash: blur, screen change, close, Enter, paste and backgrounding
// all flush immediately.
const SAVE_DEBOUNCE = 1500;
const SAVE_CEILING = 10000;   // a long unbroken burst still checkpoints
let lastCommitAt = 0;
function scheduleSave() {
  if (!currentId) return;
  if (saveTimer) clearTimeout(saveTimer);
  if (!lastCommitAt) lastCommitAt = Date.now();
  // Been typing without a break for a while? Commit now rather than deferring
  // again — otherwise a fast, continuous typist is never saved at all.
  if (Date.now() - lastCommitAt >= SAVE_CEILING) { saveTimer = null; commitSave(); return; }
  saveTimer = setTimeout(commitSave, SAVE_DEBOUNCE);
}
// Immediate save for the moments worth checkpointing: end of a line, a pasted
// block, leaving the app. Cancels the pending timer so nothing writes twice.
function flushSave() {
  if (!currentId) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  commitSave();
}
wireSaveCheckpoints(titleInput);
wireSaveCheckpoints(bodyInput);
// Backgrounding the app is where a mobile session usually ends — the tab may
// never come back. visibilitychange is the last reliable moment to write.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
});

function commitSave() {
  lastCommitAt = Date.now();   // the ceiling measures from the last real save
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
// { kind, id, noteId, customerId }
//   id      — what Cancel deletes (the customer, or the note)
//   noteId  — the note actually open in the editor. For a CUSTOMER these
//             differ: the editor shows the customer's default note, so
//             comparing currentId against `id` never matched and Cancel
//             never appeared for a new customer.
let pendingNewRecord = null;
function newGeneralNote() {
  const note = Storage.createNote();
  returnScreen = 'notes';
  showEditor(note, 'note');
  pendingNewRecord = { kind: 'note', id: note.id, noteId: note.id };
  updateCancelBtn();
  focusNewTitle();
}
// Straight into typing on a brand-new record. MUST be called synchronously
// from the tap handler: iOS only opens the keyboard for a programmatic focus
// inside the user-gesture window, so an await or rAF anywhere between the tap
// and this call silently breaks it. createNote/createCustomer and showEditor
// are all synchronous today — keep it that way.
function focusNewTitle() {
  if (!titleInput || titleInput.readOnly) return;
  titleInput.focus();
  // The field is empty (the "Title" placeholder isn't real text), so this puts
  // the caret at the start — it only matters if a value is ever pre-filled.
  try { titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length); }
  catch (e) {}
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
  // Started from HOME: going back should land on home, not the customers list
  pendingNewRecord = { kind: 'customer', id: customer.id, noteId: defaultNote.id, origin: 'home' };
  updateCancelBtn();
  focusNewTitle();
});
document.addEventListener('click', (e) => {
  if (fabMenu && !fabMenu.hidden && !fabMenu.contains(e.target) && e.target !== fab) closeFabMenu();
});
customersFab.addEventListener('click', () => {
  const { customer, defaultNote } = Storage.createCustomer();
  activeCustomerId = customer.id;
  returnScreen = 'customer-notes';
  showEditor(defaultNote, 'note');
  pendingNewRecord = { kind: 'customer', id: customer.id, noteId: defaultNote.id, origin: 'customers' };
  updateCancelBtn();
  focusNewTitle();
});
customerNotesFab.addEventListener('click', () => {
  if (!activeCustomerId) return;
  const note = Storage.createNote({ customerId: activeCustomerId });
  returnScreen = 'customer-notes';
  showEditor(note, 'note');
  pendingNewRecord = { kind: 'note', id: note.id, noteId: note.id, customerId: activeCustomerId };
  updateCancelBtn();
  focusNewTitle();
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
// Exception: the date row holds the native picker — leave the menu open under
// it, or the input the wheel is anchored to disappears mid-gesture.
if (editorMoreDropdown) editorMoreDropdown.addEventListener('click', (e) => {
  if (e.target.closest('#date-picker-btn')) return;
  closeMoreDropdown();
});
// Start every pick from empty, so a value left over from last time can't be
// re-committed by a dismissal.
if (datePickerInput) datePickerInput.addEventListener('pointerdown', () => {
  datePickerInput.value = '';
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
  // Skip the trick whenever the keyboard is ALREADY UP.
  //
  // The trick exists to stop a checkbox tap RAISING the keyboard. If it's
  // already up there is nothing to prevent, and applying it can only do harm:
  // making a focused field readonly mid-session dismisses the keyboard on iOS
  // (v2026.08.02-1433, when typing a title and then tapping the body lost it).
  //
  // ASK THE KEYBOARD, NOT THE FOCUS (v2026.08.02-1823). This used to test
  // `activeElement === bodyInput || titleInput` as a stand-in for "keyboard is
  // up", and the two are not the same thing. Dismissing the keyboard with
  // Android's back button, iOS's Done key or a swipe-down leaves the field
  // FOCUSED with the keyboard gone; the guard then skipped the trick and the
  // tap brought the keyboard back — the exact behaviour the trick exists to
  // prevent. The backup blur below was conditioned on the same stale
  // assumption, so it didn't fire either.
  //
  // keyboardIsUp() measures occupancy instead, reusing the heuristics
  // keyboardInset already had to work out for --kb-inset.
  if (keyboardIsUp()) return;
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

// Leaving a note used to throw its undo history away, so stepping out and
// straight back in lost it. The stack is now parked for the note you just
// left — ONE note, replaced on every exit, so opening anything else drops it.
//
// The body check on restore is the load-bearing part, not a nicety. Undo
// restores whole-text snapshots and the app is last-write-wins; if the note
// changed while it was closed (another device, another person), replaying a
// snapshot from before that change would silently erase it. That's the same
// reason an open note's undo clears when a sync touches it. Body only, because
// the stack only ever covered the body.
let undoStash = null;
function stashUndoForNote() {
  // Storage.getNote guards the emptied-note case: leaving a note with nothing
  // in it DELETES it a few lines above this call, and parking a stack for a
  // record that no longer exists is just litter.
  if (currentType === 'note' && currentId && undoStack.length && Storage.getNote(currentId)) {
    undoStash = { id: currentId, undo: undoStack, redo: redoStack, body: bodyInput.value };
  } else {
    undoStash = null;
  }
}
// True when the parked stack was handed back, so the caller skips resetUndo.
function restoreUndoForNote(record, type) {
  const s = undoStash;
  undoStash = null;                        // one-shot; exiting again re-parks it
  if (!s || type !== 'note' || record.id !== s.id) return false;
  if (splitTitleAndBody(record.body || '').body !== s.body) return false;
  undoStack = s.undo;
  redoStack = s.redo;
  undoLastRunType = null;                  // a fresh run starts on the next key
  updateUndoBtn();
  return true;
}
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

// ---------- autocorrect newline repair ----------
// Accepting a keyboard suggestion fires inputType 'insertReplacementText'. On
// Android the range the keyboard asks to replace sometimes runs one character
// past the word, and mid-paragraph that character is the line break — so the
// next line jumps up into the current one. Replacing a word must never change
// how many line breaks the note has, so when one goes missing we put it back.
//
// Exported shape kept pure and testable: given the text before and after, it
// returns the repaired text and where the caret belongs, or null when the edit
// was legitimate.
function repairReplacementNewlines(prev, next, caret) {
  const lost = (prev.split('\n').length - 1) - (next.split('\n').length - 1);
  if (lost <= 0) return null;
  // Narrow the edit to the part that actually differs.
  let p = 0;
  const max = Math.min(prev.length, next.length);
  while (p < max && prev[p] === next[p]) p++;
  let s = 0;
  while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  const removed = prev.slice(p, prev.length - s);
  let inserted = next.slice(p, next.length - s);
  if (!inserted) return null;                                  // a deletion, not a replacement
  if (!removed.includes('\n') || inserted.includes('\n')) return null;
  // The keyboard usually substitutes a space for the break it swallowed
  // ("teh\n" becomes "the "). Drop those, or the restored line ends in spaces.
  const trailingSpaces = inserted.length - inserted.replace(/ +$/, '').length;
  const strip = Math.min(lost, trailingSpaces);
  if (strip > 0) inserted = inserted.slice(0, inserted.length - strip);
  const end = p + inserted.length;
  return {
    text: next.slice(0, p) + inserted + '\n'.repeat(lost) + next.slice(p + inserted.length + strip),
    caret: (caret == null ? end : Math.min(caret, end)),
  };
}

let replacementPrev = null;   // text as it stood just before a suggestion landed
bodyInput.addEventListener('beforeinput', (e) => {
  replacementPrev = (e.inputType === 'insertReplacementText') ? bodyInput.value : null;
});
bodyInput.addEventListener('input', (e) => {
  if (e.inputType !== 'insertReplacementText' || replacementPrev === null) return;
  const fix = repairReplacementNewlines(replacementPrev, bodyInput.value, bodyInput.selectionStart);
  replacementPrev = null;
  if (!fix) return;
  // No pushUndo here: beforeinput already snapshotted this as a chunk edit, so
  // the suggestion and its repair undo together as one step.
  bodyInput.value = fix.text;
  bodyInput.setSelectionRange(fix.caret, fix.caret);
  scheduleSave();
});

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

// Where the record open in the editor was created from, so every exit path
// (back, popstate, Cancel, or discarding an empty new customer) returns there.
let newRecordOrigin = null;
function commitAndCleanupEditor() {
  let cancelledCustomer = false;
  newRecordOrigin = pendingNewRecord ? pendingNewRecord.origin : null;
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
  stashUndoForNote();     // park it before currentId/currentType are cleared
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
  // Navigating away with the system back button is you going off to do
  // something, same as tapping — but it isn't a tap, so the watcher won't see
  // it. Step aside and leave the resume pill.
  if (tutorialOverlay && !tutorialOverlay.hidden) pauseTutorial();
  // Our own history.back(), issued because a sheet was closed by its ✕ / a tap
  // outside / a Save. Consume it and do nothing — the screen must not move.
  if (modalBackSwallow > 0) { modalBackSwallow--; return; }
  // A sheet is open: this back press belongs to IT, because opening it pushed
  // its own history entry. Close the top one and leave the screen alone.
  if (modalStack.length) {
    const el = modalStack.pop();
    modalSyncing = true;            // don't let the observer echo this hide
    el.hidden = true;
    modalSyncing = false;
    if (el.id === 'trash-modal') renderTrashButton();
    return;
  }

  handlingPopstate = true;
  const screen = e.state && e.state.screen;
  currentPopstateTarget = screen;

  // Lightbox and file gallery sit above everything — back closes them first.
  if (fileLightbox && !fileLightbox.hidden) {
    fileLightbox.hidden = true;
    resetLightboxZoom();
    lightboxRecId = null;
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
      if (newRecordOrigin === 'home') goHome(); else showCustomers();
    } else if (newRecordOrigin === 'home') {
      goHome();
    } else {
      returnFromEditor();
    }
    newRecordOrigin = null;
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
  if (screen === 'hours') { showHoursView(); handlingPopstate = false; return; }
  if (screen === 'calendar') { showCalendar(); handlingPopstate = false; return; }
  if (screen === 'calendar-day') { showCalendarDay(e.state.date); handlingPopstate = false; return; }
  if (screen === 'section') { showSection(e.state.key); handlingPopstate = false; return; }
  if (screen === 'settings') { showSettings(); handlingPopstate = false; return; }
  showNotes();
  handlingPopstate = false;
});

// ---------- Cancel (discard a just-created note/customer) ----------
const editorCancelBtn = document.getElementById('editor-cancel-btn');
// Where a just-created record sits, for the breadcrumb. Crumb links already
// run commitAndCleanupEditor(), which discards an empty new record — so
// tapping Home mid-create behaves the same as Cancel.
function newRecordCrumbs(rec) {
  const crumbs = [{ label: 'Home', go: 'home' }];
  if (rec.kind === 'customer') {
    if (rec.origin === 'customers') crumbs.push({ label: 'Customers', go: 'customers' });
    crumbs.push({ label: 'New customer' });
  } else {
    if (rec.customerId && canViewAllRole()) {
      crumbs.push({ label: customerCrumbLabel(rec.customerId), go: 'customer', id: rec.customerId });
    }
    crumbs.push({ label: 'New note' });
  }
  return crumbs;
}
function updateCancelBtn() {
  if (!editorCancelBtn) return;
  const show = !!pendingNewRecord && currentType === 'note' && currentId === pendingNewRecord.noteId;
  editorCancelBtn.hidden = !show;
  const doneBtn = document.getElementById('editor-done-btn');
  if (doneBtn) doneBtn.hidden = !show;
  // Cancel already discards the record — showing 🗑 next to it is redundant.
  // (showEditor sets delete per role/note type; this only overrides while a
  // brand-new record is open.)
  if (show && deleteBtn) deleteBtn.style.display = 'none';
  // A real trail while creating, so you can still see (and use) where you came
  // from. Cancel used to live on this row and crowded it out on a phone; it's
  // a red ✕ in the corner now, so the row is free. The customer's own name is
  // skipped for notes — the trail has to stay short.
  if (show) renderCrumbs('crumbs-editor', newRecordCrumbs(pendingNewRecord));
}
// Done: keep what's here and leave. history.back() is the same path the Back
// button and Android's system back use, so save flushing and return-screen
// logic are shared. commitAndCleanupEditor only discards a record that is still
// completely empty, so anything typed survives.
const editorDoneBtn = document.getElementById('editor-done-btn');
if (editorDoneBtn) editorDoneBtn.addEventListener('click', () => {
  // Captured now: commitAndCleanupEditor clears pendingNewRecord on the way out.
  const rec = pendingNewRecord;
  // Drop the keyboard first: leaving it up over the destination screen looks
  // broken, and blur() also commits any in-flight IME composition.
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

  // Where "done" should leave you. Back alone returns you to where you came
  // FROM, which for a just-created record is rarely where you want to be:
  // finishing a new customer and landing on the home screen means hunting for
  // the customer you just made.
  //
  //   new customer            → that customer's note list
  //   new GENERAL note        → home
  //   note made in a customer → unchanged; back already lands on their list
  let go = null;
  if (rec && rec.kind === 'customer') {
    // Skipped when the record was discarded for being empty — back has already
    // put us somewhere sensible and there's no customer to show.
    go = () => { if (Storage.getCustomer(rec.id)) showCustomerNotes(rec.id); };
  } else if (rec && rec.kind === 'note' && !rec.customerId) {
    go = () => goHome();
  }

  if (appHistoryDepth > 0) {
    // back() still does the real work — flushing the save, discarding an empty
    // record, tearing down the editor — so none of that is duplicated here.
    // The destination has to wait until that has finished: this listener is
    // registered after the main popstate handler, which is synchronous, and
    // the timeout puts us on a later task so handlingPopstate is back to false.
    // Registered only when a back is actually issued, so it can never be left
    // waiting for a popstate that isn't coming.
    if (go) window.addEventListener('popstate', () => setTimeout(go, 0), { once: true });
    history.back();
  } else {
    commitAndCleanupEditor();
    if (go) go();
  }
});

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
    if (rec.origin === 'home') goHome(); else showCustomers();
  } else {
    Storage.deleteNote(rec.id);
    if (rec.customerId) showCustomerNotes(rec.customerId);
    else showNotes();
  }
});

deleteBtn.addEventListener('click', () => {
  if (!currentId) return;
  if (currentType === 'note' && currentIsDefault) return;
  // Say where it goes and that it comes back. The cascade is intentional (a
  // customer's notes travel with them and restore together), but that isn't
  // guessable — people looked for the notes in Orphaned notes and concluded
  // they'd been lost.
  const label = currentType === 'customer'
    ? 'Delete this customer?\n\nTheir notes will be deleted too. Everything goes to Settings → Trash, where you can restore it for 30 days.'
    : 'Delete this note?\n\nIt goes to Settings → Trash, where you can restore it for 30 days.';
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
// ---------- shared from another app ----------
// Android only: the share sheet POSTs to ./share-target, the service worker
// parks the payload in Cache Storage and redirects here with ?share=1.
// iOS never gets here — WebKit has not implemented Web Share Target.
const SHARE_CACHE = 'jobpilot-share';
const shareModal = document.getElementById('share-modal');
const shareCustomerSearch = document.getElementById('share-customer-search');
const shareCustomerList = document.getElementById('share-customer-list');
let sharePayload = null;      // { files: [File], title, text, url }

async function readSharePayload() {
  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const metaResp = await cache.match(new Request(new URL('__share/meta', location.href)));
  if (!metaResp) return null;
  const meta = await metaResp.json().catch(() => null);
  const files = [];
  for (let i = 0; i < ((meta && meta.count) || 0); i++) {
    const r = await cache.match(new Request(new URL('__share/file-' + i, location.href)));
    if (!r) continue;
    const blob = await r.blob();
    const name = decodeURIComponent(r.headers.get('x-filename') || 'file');
    files.push(new File([blob], name, { type: blob.type }));
  }
  return { files, title: (meta && meta.title) || '', text: (meta && meta.text) || '', url: (meta && meta.url) || '' };
}
async function clearSharePayload() {
  if (!('caches' in window)) return;
  await caches.delete(SHARE_CACHE).catch(() => {});
}
function shareSummaryText(p) {
  const bits = [];
  if (p.files.length) bits.push(p.files.length === 1 ? p.files[0].name : `${p.files.length} files`);
  const txt = [p.text, p.url].filter(Boolean).join(' ');
  if (txt) bits.push(txt.length > 60 ? txt.slice(0, 60) + '…' : txt);
  return bits.join(' · ') || 'Nothing to import.';
}
function renderShareCustomers(filter) {
  if (!shareCustomerList) return;
  const words = (filter || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const customers = Storage.listCustomers().filter(c => {
    if (!words.length) return true;
    const def = Storage.getDefaultNoteForCustomer(c.id);
    return words.every(w => (def ? def.body : '').toLowerCase().includes(w));
  }).slice(0, 40);
  shareCustomerList.innerHTML = customers.length
    ? customers.map(c => `<li class="member-item share-customer-item" data-id="${c.id}">
        <span class="member-email">${escapeHtml(customerCrumbLabel(c.id))}</span></li>`).join('')
    : '<li class="member-item">No customers found.</li>';
  shareCustomerList.querySelectorAll('.share-customer-item').forEach(li => {
    li.addEventListener('click', () => acceptShare(li.dataset.id));
  });
}
async function acceptShare(customerId) {
  const p = sharePayload;
  sharePayload = null;
  if (shareModal) shareModal.hidden = true;
  await clearSharePayload();
  if (!p || !customerId) return;
  // Files are LOCAL to this device by design (see files.js) — they don't sync.
  for (const f of p.files) {
    try { await LocalFiles.add(customerId, f); } catch (e) { console.warn('share file', e); }
  }
  // Text and links go into the customer's default note, which DOES sync.
  const txt = [p.title, p.text, p.url].filter(Boolean).join('\n').trim();
  if (txt) {
    const def = Storage.getDefaultNoteForCustomer(customerId);
    if (def) {
      const stamp = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
      Storage.updateNote(def.id, `${def.body || ''}\n\nShared ${stamp}\n${txt}`.trim());
    }
  }
  activeCustomerId = customerId;
  showCustomerNotes(customerId);
}
async function handleIncomingShare() {
  if (!/[?&]share=1\b/.test(location.search)) return;
  // Clean the URL first: a reload must not re-import the same payload.
  history.replaceState(history.state, '', location.pathname);
  const p = await readSharePayload().catch(() => null);
  if (!p || (!p.files.length && !p.text && !p.url && !p.title)) { await clearSharePayload(); return; }
  if (!isAdminRole() && !Storage.listCustomers().length) { await clearSharePayload(); return; }
  sharePayload = p;
  const summary = document.getElementById('share-summary');
  if (summary) summary.textContent = shareSummaryText(p);
  if (shareCustomerSearch) shareCustomerSearch.value = '';
  renderShareCustomers('');
  if (shareModal) shareModal.hidden = false;
}
if (shareCustomerSearch) {
  shareCustomerSearch.addEventListener('input', () => renderShareCustomers(shareCustomerSearch.value));
}
const shareModalClose = document.getElementById('share-modal-close');
// Dismissing drops the payload — leaving it parked would re-open this next launch.
const dismissShare = async () => { sharePayload = null; if (shareModal) shareModal.hidden = true; await clearSharePayload(); };
if (shareModalClose) shareModalClose.addEventListener('click', dismissShare);
if (shareModal) shareModal.addEventListener('click', (e) => { if (e.target === shareModal) dismissShare(); });

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

const duplicateNoteBtn = document.getElementById('duplicate-note-btn');
if (duplicateNoteBtn) duplicateNoteBtn.addEventListener('click', () => {
  if (!currentId || currentType !== 'note') return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  commitSave();
  const src = Storage.getNote(currentId);
  if (!src) return;
  const { title, body } = splitTitleAndBody(src.body || '');
  const copyBody = composeBody(title ? `${title} (copy)` : 'Copy', body);
  const copy = Storage.createNote({ customerId: src.customerId || null, body: copyBody });
  currentId = null; currentType = null; currentIsDefault = false;
  returnScreen = src.customerId ? 'customer-notes' : 'notes';
  if (src.customerId) activeCustomerId = src.customerId;
  showEditor(copy, 'note');
});

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

// Shown between "credentials accepted" and "account ready". That gap is the
// Firestore init and first snapshot, not the credential check — it can run for
// seconds on a phone, and leaving the sign-in form up makes it look like
// nothing happened.
//
// ONLY over the sign-in screen (v2026.08.01-0401). This card lives inside
// #signin-view, so switching it on used to force that screen active — which
// meant every app open with a restored session flashed the sign-in screen even
// though the user was never signing in. A restored session stays wherever it
// is (the home skeleton, which draws its own spinner); the card is strictly
// for the case where the sign-in form is already on screen.
const loadingCard = document.getElementById('loading-card');
function showLoadingCard(on) {
  if (!loadingCard || !signinCard) return;
  // The magic-link card has its own status text — don't fight it.
  if (linkinCard && !linkinCard.hidden) { loadingCard.hidden = true; return; }
  // Not already on the sign-in screen? Then this is a session being restored,
  // not a sign-in — don't drag the user onto the sign-in screen to show it.
  if (on && !signinView.classList.contains('active')) { loadingCard.hidden = true; return; }
  loadingCard.hidden = !on;
  signinCard.hidden = on;
  if (on) {
    hideAllScreens();
    signinView.classList.add('active');
  }
}

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
const SEARCH_CLEAR_IDS = ['home-search-input', 'customer-search', 'customer-notes-search', 'note-search-input', 'assign-customer-search', 'price-search', 'job-customer-search'];

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
  priceFilter = '';
  const ps = document.getElementById('price-search');
  if (ps) ps.value = '';
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
const COLLAPSIBLE_SEARCH_IDS = ['home-search-input', 'customer-search', 'customer-notes-search', 'note-search-input', 'price-search'];

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
  // Clear the flag first: a deliberate sign-out must show the form at once,
  // not sit through the restore grace period below.
  signoutBtn.addEventListener('click', async () => { clearSessionFlag(); await signOut(auth); });
}

// ---------- backup export ----------
// One file with everything the cloud holds. There was no export path at all
// before this (only the IIF and price CSVs), so a lost account meant lost
// notes. Restore is deliberately NOT implemented: importing would have to
// reconcile ids and could duplicate or clobber live data — this is a snapshot
// you can read, print or hand to someone, not a sync mechanism.
const backupBtn = document.getElementById('backup-btn');
const backupStatus = document.getElementById('backup-status');
if (backupBtn) backupBtn.addEventListener('click', () => {
  const customers = Storage.listCustomers().map(c => ({
    id: c.id,
    name: customerCrumbLabel(c.id),
    notes: Storage.listNotesByCustomer(c.id).map(n => ({ id: n.id, isDefault: !!n.isDefault, body: n.body, updated: n.updated })),
  }));
  const data = {
    app: 'JobPilot',
    version: APP_VERSION,
    exported: new Date().toISOString(),
    customers,
    generalNotes: Storage.listNotes().map(n => ({ id: n.id, body: n.body, updated: n.updated })),
    settings: Storage.getSettings(),
    priceTable: {
      vendors: Storage.getPriceConfig().vendors,
      items: Storage.listPriceItems().map(i => ({ id: i.id, name: i.name, cells: i.cells || {} })),
    },
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jobpilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const noteCount = data.generalNotes.length + customers.reduce((s, c) => s + c.notes.length, 0);
  if (backupStatus) backupStatus.textContent = `Saved ${customers.length} customers and ${noteCount} notes.`;
});

// ---------- customer contact strip ----------
// Phone numbers and emails written in a customer's default note become Call /
// Text / Email buttons. In the field you open a customer to phone them — no
// reason to make anyone retype a number that's already on screen.
const contactStripEl = document.getElementById('customer-contact-strip');
// Deliberately conservative: 10+ digits with common separators, so job numbers
// and measurements ("2x4", "3.5") don't turn into phone links.
const PHONE_RE = /(\+?\d[\d\s().-]{8,}\d)/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g;

function extractContacts(text) {
  const body = text || '';
  const emails = [...new Set((body.match(EMAIL_RE) || []))];
  const phones = [...new Set((body.match(PHONE_RE) || [])
    .map(p => p.trim())
    .filter(p => (p.replace(/\D/g, '').length >= 10 && p.replace(/\D/g, '').length <= 15)))];
  return { phones, emails };
}

function renderContactStrip(customerId) {
  if (!contactStripEl) return;
  const def = customerId ? Storage.getDefaultNoteForCustomer(customerId) : null;
  const { phones, emails } = extractContacts(def ? def.body : '');
  if (!phones.length && !emails.length) { contactStripEl.hidden = true; contactStripEl.innerHTML = ''; return; }
  const parts = [];
  phones.forEach(p => {
    const tel = p.replace(/[^\d+]/g, '');
    parts.push(`<a class="contact-btn" href="tel:${escapeHtml(tel)}">📞 Call</a>`);
    parts.push(`<a class="contact-btn" href="sms:${escapeHtml(tel)}">💬 Text</a>`);
    parts.push(`<span class="contact-value">${escapeHtml(p)}</span>`);
  });
  emails.forEach(e => {
    parts.push(`<a class="contact-btn" href="mailto:${escapeHtml(e)}">✉️ Email</a>`);
    parts.push(`<span class="contact-value">${escapeHtml(e)}</span>`);
  });
  contactStripEl.innerHTML = parts.join('');
  contactStripEl.hidden = false;
}

// ---------- sync status ----------
// Silence normally; "Saving…" while our writes are in flight; and when the
// device is offline, a plain statement that the change is safe here and will
// go up later — the app is offline-first, but a user in a basement had no way
// to tell a saved note from a stranded one.
const syncStatusEl = document.getElementById('sync-status');
function renderSyncStatus() {
  if (!syncStatusEl) return;
  const offline = !navigator.onLine;
  const pending = Storage.pendingWrites ? Storage.pendingWrites() : 0;
  if (offline) {
    syncStatusEl.textContent = 'Offline — saved on this device';
    syncStatusEl.className = 'sync-status sync-offline';
    syncStatusEl.hidden = false;
  } else if (pending > 0) {
    syncStatusEl.textContent = 'Saving…';
    syncStatusEl.className = 'sync-status sync-saving';
    syncStatusEl.hidden = false;
  } else {
    syncStatusEl.hidden = true;
  }
}
if (Storage.onSyncChange) Storage.onSyncChange(renderSyncStatus);
window.addEventListener('online', renderSyncStatus);
window.addEventListener('offline', renderSyncStatus);
renderSyncStatus();

// ---------- trash ----------
// Deleting is a soft delete (deletedAt); this is where things can be brought
// back or finished off. A customer and the notes deleted with them appear as
// one entry, so restoring puts the whole set back together.
// Settings shows a BUTTON, not the list. The list itself lives in a modal, so
// opening Settings no longer walks every deleted record just to draw rows
// nobody asked to see.
function renderTrashButton() {
  const btn = document.getElementById('trash-open-btn');
  if (!btn || !isAdminRole()) return;
  const n = Storage.listTrash().length;
  btn.textContent = n ? `Trash (${n})` : 'Trash is empty';
  btn.disabled = n === 0;
}
// What Settings (and a background sync) should call: always the button, and
// the list too if it happens to be open.
function refreshTrashUi() {
  renderTrashButton();
  const modal = document.getElementById('trash-modal');
  if (modal && !modal.hidden) renderTrashList();
}
function openTrashModal() {
  const modal = document.getElementById('trash-modal');
  if (!modal || !isAdminRole()) return;
  renderTrashList();
  modal.hidden = false;
}
function closeTrashModal() {
  const modal = document.getElementById('trash-modal');
  if (modal) modal.hidden = true;
  renderTrashButton();     // the count may have changed while it was open
}
const trashOpenBtn = document.getElementById('trash-open-btn');
if (trashOpenBtn) trashOpenBtn.addEventListener('click', openTrashModal);
const trashCloseBtn = document.getElementById('trash-close');
if (trashCloseBtn) trashCloseBtn.addEventListener('click', closeTrashModal);
const trashModalEl = document.getElementById('trash-modal');
if (trashModalEl) trashModalEl.addEventListener('click', (e) => {
  if (e.target === trashModalEl) closeTrashModal();
});

function renderTrashList() {
  const el = document.getElementById('trash-list');
  if (!el || !isAdminRole()) return;
  const items = Storage.listTrash();
  if (!items.length) {
    el.innerHTML = '<li class="member-item"><span class="member-email">Trash is empty.</span></li>';
    return;
  }
  const days = Storage.TRASH_DAYS;
  el.innerHTML = items.map(it => {
    const left = Math.max(0, days - Math.floor((Date.now() - new Date(it.deletedAt).getTime()) / 86400000));
    const extra = it.kind === 'customer'
      ? ` · customer${it.noteCount ? ` + ${it.noteCount} note${it.noteCount === 1 ? '' : 's'}` : ''}`
      : ' · note';
    return `<li class="member-item">
      <span class="member-email">${escapeHtml(it.name)}<em class="setting-check-hint">${escapeHtml(String(left))} day${left === 1 ? '' : 's'} left${extra}</em></span>
      <button class="trash-restore" data-kind="${it.kind}" data-id="${it.id}">Restore</button>
      <button class="member-remove-btn trash-purge" data-kind="${it.kind}" data-id="${it.id}" title="Delete forever">✕</button>
    </li>`;
  }).join('');
  el.querySelectorAll('.trash-restore').forEach(btn => {
    btn.addEventListener('click', async () => {
      await Storage.restoreFromTrash(btn.dataset.kind, btn.dataset.id);
      renderTrashList();
      renderTrashButton();
    });
  });
  el.querySelectorAll('.trash-purge').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this permanently? This cannot be undone.')) return;
      await Storage.purgeFromTrash(btn.dataset.kind, btn.dataset.id);
      renderTrashList();
      renderTrashButton();
    });
  });
}

// ---------- sample data ----------
const seedBtn = document.getElementById('seed-btn');
const unseedBtn = document.getElementById('unseed-btn');
const seedStatus = document.getElementById('seed-status');

function refreshSeedButtons() {
  if (!seedBtn || !unseedBtn) return;
  const has = Storage.hasSampleData();
  unseedBtn.hidden = !has;
  // REFRESH, not "add more": the sample set is a coherent whole with dates
  // rebased on today, and pressing the button twice used to leave two of every
  // customer, job and price row. Refreshing also re-dates it, so a sample
  // loaded last month lands back in view.
  seedBtn.textContent = has ? 'Refresh sample data' : 'Add sample data';
}

// "3 customers, 12 notes and 10 jobs" — Oxford-comma-free, empty categories
// dropped, so the sentence stays readable however much or little there is.
const SEED_NOUNS = {
  customers: ['customer', 'customers'],
  notes: ['note', 'notes'],
  jobs: ['calendar job', 'calendar jobs'],
  timelogs: ['hour record', 'hour records'],
  priceItems: ['price table row', 'price table rows'],
  employees: ['employee', 'employees'],
  keywords: ['keyword', 'keywords'],
  vendors: ['price table vendor', 'price table vendors'],
};
function describeSeedCounts(counts) {
  const parts = [];
  for (const [key, [one, many]] of Object.entries(SEED_NOUNS)) {
    const n = (counts && counts[key]) || 0;
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  }
  if (!parts.length) return 'nothing';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

if (seedBtn) {
  seedBtn.addEventListener('click', async () => {
    seedBtn.disabled = true;
    const refreshing = Storage.hasSampleData();
    if (seedStatus) seedStatus.textContent = refreshing ? 'Refreshing…' : 'Adding…';
    // Clear the old set first, or the second press doubles everything.
    if (refreshing) await Storage.removeSampleData();
    const counts = await Storage.seedSampleData();
    if (seedStatus) seedStatus.textContent = `Added ${describeSeedCounts(counts)}.`;
    seedBtn.disabled = false;
    refreshSeedButtons();
  });
}
if (unseedBtn) {
  unseedBtn.addEventListener('click', async () => {
    unseedBtn.disabled = true;
    // The plan is worked out BEFORE the prompt so the dialog names exactly what
    // will go, and the same plan is what gets deleted — no chance of the
    // confirmation describing one thing and the deletion doing another.
    // Employees, keywords and vendors are only listed when the seed added them
    // and you have not since changed them.
    let plan;
    try {
      plan = await Storage.sampleDataPlan();
    } catch (err) {
      console.warn(err);
      unseedBtn.disabled = false;
      if (seedStatus) seedStatus.textContent = 'Could not check what to remove. Try again.';
      return;
    }
    const what = describeSeedCounts(plan.counts);
    if (what === 'nothing') {
      unseedBtn.disabled = false;
      if (seedStatus) seedStatus.textContent = 'There is no sample data to remove.';
      refreshSeedButtons();
      return;
    }
    if (!confirm(`Remove ${what}?\n\nThis deletes only the sample data. Anything you created yourself is not affected.`)) {
      unseedBtn.disabled = false;
      return;
    }
    const counts = await Storage.removeSampleData(plan);
    if (seedStatus) seedStatus.textContent = `Removed ${describeSeedCounts(counts)}.`;
    unseedBtn.disabled = false;
    refreshSeedButtons();
  });
}

// (The first-run welcome MODAL was removed in v2026.08.19-0020 and replaced by
// the getting-started cards on the home screen — see gettingStartedCardsHtml.
// settings.onboardingSeen is no longer written; it is still READ, so anyone who
// already answered the old dialog never sees the cards.)

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
  // Calendar: everyone except the customer role (an employee sees their own
  // jobs). No existing attribute covered "all but customer".
  document.querySelectorAll('[data-role-cal]').forEach(el => {
    el.style.display = isCustomer ? 'none' : '';
  });
  // Orphan view write controls: admin only
  ['orphan-select-all-btn', 'orphan-delete-selected-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isAdminRole ? '' : 'none';
  });
}

// Customer -> app account links, so a customer can be shown their own jobs.
// Same shape as employeeLinks, keyed by customer id rather than by name.
function renderCustomerLinks() {
  const custSel = document.getElementById('customer-link-customer');
  const acctSel = document.getElementById('customer-link-account');
  const listEl = document.getElementById('customer-link-list');
  const addBtn = document.getElementById('customer-link-add');
  if (!custSel || !acctSel || !listEl) return;
  const links = Storage.getSettings().customerLinks || {};
  const customers = Storage.liveCustomers();
  const accounts = Storage.listMembers().filter(m => m.role === 'customer');

  custSel.innerHTML = customers.length
    ? customers.map(c => `<option value="${c.id}">${escapeHtml(customerCrumbLabel(c.id))}</option>`).join('')
    : '<option value="">No customers yet</option>';
  acctSel.innerHTML = accounts.length
    ? accounts.map(m => `<option value="${m.uid}">${escapeHtml(m.name || m.email || m.uid)}</option>`).join('')
    : '<option value="">No customer accounts yet</option>';

  const entries = Object.entries(links);
  listEl.innerHTML = entries.length
    ? entries.map(([cid, uid]) => {
        const acct = accounts.find(m => m.uid === uid);
        return `<li class="employee-card">
          <div class="employee-card-top">
            <span class="employee-name">${escapeHtml(customerCrumbLabel(cid))} → ${escapeHtml(acct ? (acct.name || acct.email || uid) : uid)}</span>
            <button data-unlink="${escapeHtml(cid)}" class="employee-remove" aria-label="Remove link">×</button>
          </div>
        </li>`;
      }).join('')
    : '<li class="keyword-empty">No customers linked yet.</li>';

  listEl.querySelectorAll('[data-unlink]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const next = { ...(Storage.getSettings().customerLinks || {}) };
      delete next[btn.dataset.unlink];
      await Storage.setSetting('customerLinks', next);
      renderCustomerLinks();
    });
  });
  if (addBtn && !addBtn.dataset.wired) {
    addBtn.dataset.wired = '1';
    addBtn.addEventListener('click', async () => {
      if (!custSel.value || !acctSel.value) return;
      const next = { ...(Storage.getSettings().customerLinks || {}) };
      next[custSel.value] = acctSel.value;
      await Storage.setSetting('customerLinks', next);
      renderCustomerLinks();
    });
  }
}

// Linking a name to an account only stamps jobs saved afterwards. This walks
// every job and re-stamps the ones whose links have since changed.
let relinkWired = false;
function wireEmployeeRelink() {
  const btn = document.getElementById('employee-relink-btn');
  const status = document.getElementById('employee-relink-status');
  if (!btn) return;
  btn.style.display = isAdminRole() ? '' : 'none';
  if (relinkWired) return;
  relinkWired = true;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (status) status.textContent = 'Checking every job…';
    try {
      const { scanned, updated } = await Storage.relinkJobEmployeeUids();
      if (status) {
        status.textContent = updated
          ? `Updated ${updated} of ${scanned} jobs — those people can see them now.`
          : `Checked ${scanned} jobs — all already linked correctly.`;
      }
    } catch (e) {
      console.warn('relink', e);
      if (status) status.textContent = 'Could not finish — check your connection and try again.';
    }
    btn.disabled = false;
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
  // .member-card, NOT .member-item — that class is shared with eight other
  // lists (customer pickers, share list, trash), so it can't be restructured
  // here. An email is the only thing identifying a user, and squeezing it
  // beside a role select meant it was always the part that got clipped; on its
  // own line it wraps in full.
  membersList.innerHTML = members.map(m => `
    <li class="member-card">
      <div class="member-card-top">
        <span class="member-card-email">${escapeHtml(m.email || m.uid)}</span>
        ${m.uid !== currentUid ? `<button class="member-remove-btn" data-uid="${m.uid}" title="Remove">✕</button>` : ''}
      </div>
      <label class="member-field">
        <span class="member-field-label">Role</span>
        <select class="member-role-select" data-uid="${m.uid}" ${m.uid === currentUid ? 'disabled' : ''}>
          <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
          <option value="employee" ${m.role === 'employee' ? 'selected' : ''}>Employee</option>
          <option value="bookkeeper" ${m.role === 'bookkeeper' ? 'selected' : ''}>Bookkeeper</option>
          <option value="customer" ${m.role === 'customer' ? 'selected' : ''}>Customer</option>
        </select>
      </label>
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
      : invites.map(inv => {
        // A founder invite is in this list so you can see and cancel it — but
        // it is NOT someone joining here, and saying "Invited as admin" would
        // read as exactly the thing it isn't.
        const what = inv.kind === 'newOrg'
          ? `Starting their own company${inv.companyName ? ` — ${escapeHtml(inv.companyName)}` : ''}`
            + ` · ${describeInviteExpiry(inv.expiresAt)}`
          : `Invited as ${escapeHtml(inv.role)}`;
        return `
        <li class="member-card">
          <div class="member-card-top">
            <span class="member-card-email">${escapeHtml(inv.email)}</span>
            <button class="member-remove-btn" data-email="${escapeHtml(inv.email)}" title="Cancel">✕</button>
          </div>
          <span class="member-field-label">${what}</span>
        </li>`;
      }).join('');
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

// A founder invite dies after a fortnight, so the pending list has to say how
// long is left — an invite that quietly stopped working looks identical to one
// that never arrived. Days, not a date: "expires in 3 days" is the thing you
// act on.
function describeInviteExpiry(expiresAt) {
  const ms = Number(expiresAt) || 0;
  if (!ms) return 'no expiry recorded';
  const left = ms - Date.now();
  if (left <= 0) return 'EXPIRED — cancel and send a new one';
  const days = Math.ceil(left / 86400000);
  if (days === 1) return 'expires today';
  return `expires in ${days} days`;
}

// ---------- company name ----------
// Any admin can rename their own company. That includes you: the original org
// predates names entirely, so this is also how it gets one.
const orgNameInput = document.getElementById('org-name-input');
const orgNameBtn = document.getElementById('org-name-save');
const orgNameRow = document.getElementById('org-name-row');
const orgNameStatus = document.getElementById('org-name-status');

function refreshOrgNameUi() {
  if (!orgNameRow) return;
  orgNameRow.hidden = !isAdminRole();
  if (orgNameInput) orgNameInput.value = Storage.getOrgName();
  if (orgNameStatus) orgNameStatus.textContent = '';
}
if (orgNameBtn) {
  orgNameBtn.addEventListener('click', async () => {
    const name = orgNameInput ? orgNameInput.value.trim() : '';
    orgNameBtn.disabled = true;
    try {
      await Storage.setOrgName(name);
      if (orgNameStatus) orgNameStatus.textContent = 'Saved.';
      // The Account line above reads from the same value.
      if (accountOrgEl) { accountOrgEl.textContent = name; accountOrgEl.hidden = !name; }
    } catch (e) {
      if (orgNameStatus) orgNameStatus.textContent = 'Failed: ' + (e.message || e);
    }
    orgNameBtn.disabled = false;
  });
}

// ---------- invite a new company (founder only) ----------
// This is the one action in the app that creates data outside your own org, so
// it is kept apart from the ordinary invite form and gated twice: the section
// is hidden unless Storage.canInviteNewOrg(), and firestore.rules refuses the
// write regardless of what the UI does.
const newOrgRow = document.getElementById('new-org-row');
const newOrgEmail = document.getElementById('new-org-email');
const newOrgName = document.getElementById('new-org-name');
const newOrgBtn = document.getElementById('new-org-btn');
const newOrgStatus = document.getElementById('new-org-status');

function refreshNewOrgUi() {
  if (!newOrgRow) return;
  newOrgRow.hidden = !Storage.canInviteNewOrg();
}

if (newOrgBtn) {
  newOrgBtn.addEventListener('click', async () => {
    const email = newOrgEmail ? newOrgEmail.value.trim() : '';
    const company = newOrgName ? newOrgName.value.trim() : '';
    if (!email) { if (newOrgStatus) newOrgStatus.textContent = 'Please enter an email.'; return; }
    if (!company) { if (newOrgStatus) newOrgStatus.textContent = 'Please enter a company name.'; return; }
    // A confirm, not because the write is dangerous to you, but because it is
    // irreversible for THEM once accepted — an org with their data in it can't
    // be un-created from here.
    if (!confirm(`Invite ${email} to start their own company, "${company}"?\n\nThey become the admin of a separate company with its own customers, calendar and hours. None of your data goes with it.`)) return;
    newOrgBtn.disabled = true;
    if (newOrgStatus) newOrgStatus.textContent = 'Sending…';
    try {
      await Storage.inviteNewOrg(email, company);
      // Same emailed sign-in link as an ordinary invite — it is the invite.
      // No localStorage write: this browser isn't the one that will sign in.
      try {
        await sendSignInLinkToEmail(auth, email, { url: APP_URL, handleCodeInApp: true });
        if (newOrgStatus) newOrgStatus.textContent = `Invited ${email} to start ${company} — sign-in link sent.`;
      } catch (mailErr) {
        console.error(mailErr);
        if (newOrgStatus) newOrgStatus.textContent = `Invite created, but the email failed: ${mailErr.message || mailErr}`;
      }
      if (newOrgEmail) newOrgEmail.value = '';
      if (newOrgName) newOrgName.value = '';
      renderMembersList();
    } catch (e) {
      if (newOrgStatus) newOrgStatus.textContent = 'Failed: ' + (e.message || e);
    }
    newOrgBtn.disabled = false;
  });
}

// ---------- theme (light / dark) ----------
// ---------- theme ----------
// Three states, one button. 'auto' is stored as the ABSENCE of the key so an
// existing install keeps whatever it already chose; only a fresh one gets auto.
function getThemePref() {
  const v = localStorage.getItem('na-theme');
  return (v === 'light' || v === 'dark') ? v : 'auto';
}
function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch { return true; }   // dark is this app's default — outdoor trade use
}
function resolvedTheme() {
  const p = getThemePref();
  return p === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : p;
}
function applyTheme() {
  const theme = resolvedTheme();
  document.body.classList.toggle('dark-mode', theme === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#1f2937' : '#ffffff');
  const btn = document.getElementById('theme-cycle-btn');
  if (btn) {
    const p = getThemePref();
    // Auto alone says nothing about what you're looking at, so show what it
    // currently resolves to.
    const label = p === 'auto' ? `Auto · ${theme === 'dark' ? 'Dark' : 'Light'}`
      : (p === 'dark' ? 'Dark' : 'Light');
    btn.textContent = label;
    btn.setAttribute('aria-label', `Theme: ${label}. Tap to change.`);
  }
}
function cycleThemePref() {
  const next = { light: 'dark', dark: 'auto', auto: 'light' }[getThemePref()];
  if (next === 'auto') localStorage.removeItem('na-theme');
  else localStorage.setItem('na-theme', next);
  applyTheme();
  pushUserPrefs();
}
const themeCycleBtn = document.getElementById('theme-cycle-btn');
if (themeCycleBtn) themeCycleBtn.addEventListener('click', cycleThemePref);
// Follow the phone live while on auto — no reload needed at sunset.
try {
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (getThemePref() === 'auto') applyTheme(); });
} catch { /* older browsers: auto still resolves on load */ }
applyTheme();

// ---------- clock format button ----------
function applyClockButton() {
  const btn = document.getElementById('clock-cycle-btn');
  if (!btn) return;
  const p = getClockPref();
  const label = p === 'auto' ? `Auto · ${getClock24() ? '24-hour' : '12-hour'}`
    : (p === '24' ? '24-hour' : '12-hour');
  btn.textContent = label;
  btn.setAttribute('aria-label', `Time format: ${label}. Tap to change.`);
}
function cycleClockPref() {
  const next = { '12': '24', '24': 'auto', 'auto': '12' }[getClockPref()];
  if (next === 'auto') localStorage.removeItem('na-clock-24');
  else localStorage.setItem('na-clock-24', next === '24' ? '1' : '0');
  applyClockButton();
  pushUserPrefs();
  // Redraw whichever calendar view is showing so the change is immediate.
  if (calendarDayView && calendarDayView.classList.contains('active')) renderCalendarDay();
  else if (calendarView && calendarView.classList.contains('active')) renderCalendar();
}
const clockCycleBtn = document.getElementById('clock-cycle-btn');
if (clockCycleBtn) clockCycleBtn.addEventListener('click', cycleClockPref);
applyClockButton();

const moveCheckedToggle = document.getElementById('setting-move-checked');
if (moveCheckedToggle) {
  moveCheckedToggle.addEventListener('change', () => {
    localStorage.setItem('na-move-checked', moveCheckedToggle.checked ? '1' : '0');
    pushUserPrefs();
  });
}

const collapseSearchToggle = document.getElementById('setting-collapse-search');
if (collapseSearchToggle) {
  collapseSearchToggle.addEventListener('change', () => {
    localStorage.setItem('na-collapse-search', collapseSearchToggle.checked ? '1' : '0');
    pushUserPrefs();
    refreshSearchCollapse();
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
  } else if (calendarView && calendarView.classList.contains('active')) {
    renderCalendar();
  } else if (calendarDayView && calendarDayView.classList.contains('active')) {
    renderCalendarDay();
  } else if (priceView && priceView.classList.contains('active')) {
    // An open cell holds text nobody has saved yet, and re-rendering rebuilds
    // the cell empty. A background sync must not eat a half-typed price —
    // same rule as #hours-view being left out of this function entirely.
    if (!openCellKey) renderPriceTable();
  } else if (orphanView && orphanView.classList.contains('active')) {
    renderOrphanList();
  } else if (settingsView.classList.contains('active')) {
    renderKeywordList();
    renderEmployeeList();
    renderMembersList();
    refreshTrashUi();
  }
}

let unsubStorage = null;
onAuthStateChanged(auth, async (user) => {
  if (unsubStorage) { unsubStorage(); unsubStorage = null; }
  if (user) showLoadingCard(true);     // before the awaits below, not after
  if (user) {
    // A real user arrived — stop any pending restore wait and remember that
    // this browser has a session, so the next cold start knows to wait.
    if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
    firstAuthEmission = false;
    markSession();
  }
  if (!user) {
    showLoadingCard(false);            // signing out returns to the form
    // Give a pending magic-link sign-in a chance to complete before showing the sign-in screen.
    await emailLinkSigninReady;
    if (auth.currentUser) return; // link sign-in succeeded; a new auth event will follow
    Storage.signedOut();
    prefsLoaded = false;     // don't write this account's prefs under the next
    // iOS Safari opens IndexedDB slowly during page load, so Firebase's FIRST
    // callback can be a spurious null even when a session is stored — the real
    // user turns up a beat later. Committing to the sign-in form on that null
    // is what made every app open flash the sign-in screen. When this browser
    // is known to have had a session, hold the boot splash and wait for the
    // second emission instead. A deliberate sign-out clears the flag, so this
    // never costs anyone a wait.
    // A link sign-in in flight owns the screen — never paint over its card.
    const linkinUp = !!(linkinCard && !linkinCard.hidden);
    if (firstAuthEmission && hadSession() && !linkinUp) {
      firstAuthEmission = false;
      showBoot();
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        clearSessionFlag();   // the session really is gone — don't stall again
        showSignin();
      }, RESTORE_GRACE_MS);
      return;
    }
    firstAuthEmission = false;
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
    showLoadingCard(false);
    if (bootView) bootView.classList.remove('active');
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
  await initUserPrefs();     // before the first render, so the theme is right
  showLoadingCard(false);
  showNotes();
  // Only after sign-in and the first snapshot: the picker needs the customer
  // list, and an unauthenticated user has nowhere to put a shared file.
  handleIncomingShare();
  // One-time catch-up: stamp customer names onto already-shared notes
  Storage.backfillAssignedCustomerNames();
  // Drop stale assignments left behind by removed members (field edit only)
  Storage.cleanupOrphanedAssignments();
  // Bin anything that has sat in Trash longer than 30 days
  Storage.purgeExpiredTrash();
  // Strip admin/bookkeeper uids from assignedTo — they see everything anyway
  Storage.cleanupElevatedAssignments();
  // First magic-link sign-in (or forgot-password): prompt to set a password.
  if (pendingPasswordPrompt) {
    pendingPasswordPrompt = false;
    showSetPasswordModal();
  }
  // (A new company's tour/sample-data offer used to be a modal fired from here.
  // It is the getting-started cards on the home screen now, which need no
  // trigger — renderNotesList decides whether to draw them.)
});

// ---------- init error banner ----------
const initErrorBanner = document.getElementById('init-error-banner');
const initErrorText = document.getElementById('init-error-text');
function showInitError(user, err) {
  if (!initErrorBanner) return;
  if (err && err.code === 'app/invite-expired') {
    // Distinct from no-access on purpose: "your invite ran out" tells them what
    // to ask for, where "no access" makes them wonder if they used the wrong
    // address.
    initErrorText.textContent =
      `The invitation for ${user.email || 'this account'} has expired. Ask for a new one and sign in again.`;
  } else if (err && err.code === 'app/invite-invalid') {
    initErrorText.textContent =
      `The invitation for ${user.email || 'this account'} can no longer be used. Ask for a new one.`;
  } else if (err && err.code === 'app/no-access') {
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
  clearSessionFlag();
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
const fileLightboxShare = document.getElementById('file-lightbox-share');
let fileObjectUrls = [];
let galleryCols = localStorage.getItem('jp-gallery-cols') === '2' ? 2 : 3;
let galleryImageIds = []; // ordered ids of image files in the current grid
let lightboxIndex = -1;   // position in galleryImageIds of the shown image
let lightboxRecId = null; // file record currently shown (for the share button)

// ---------- lightbox zoom ----------
// The image is laid out at fit size by CSS; zoom is a transform on top of it,
// with transform-origin at 0 0 so translate is in un-scaled pixels.
const LB_MAX_SCALE = 6;
const LB_TAP_SCALE = 2.5;
let lbScale = 1, lbX = 0, lbY = 0;

function applyLightboxTransform() {
  if (!fileLightboxImg) return;
  fileLightboxImg.style.transform =
    `translate(${lbX}px, ${lbY}px) scale(${lbScale})`;
  fileLightboxImg.classList.toggle('zoomed', lbScale > 1.01);
}

function resetLightboxZoom() {
  lbScale = 1; lbX = 0; lbY = 0;
  if (fileLightboxImg) {
    fileLightboxImg.style.transform = '';
    fileLightboxImg.classList.remove('zoomed');
  }
}

// Keeps the image inside the viewport: at 1x it stays put, when zoomed it may
// not be dragged past its own edges.
function clampLightboxPan() {
  if (!fileLightboxImg) return;
  const w = fileLightboxImg.clientWidth, h = fileLightboxImg.clientHeight;
  const vw = fileLightbox.clientWidth, vh = fileLightbox.clientHeight;
  // Position of the un-transformed image inside the flex-centred container.
  const baseX = (vw - w) / 2, baseY = (vh - h) / 2;
  const sw = w * lbScale, sh = h * lbScale;
  if (sw <= vw) lbX = 0; else lbX = Math.min(-baseX, Math.max(vw - sw - baseX, lbX));
  if (sh <= vh) lbY = 0; else lbY = Math.min(-baseY, Math.max(vh - sh - baseY, lbY));
}

// Scale around a viewport point so whatever is under the finger stays there.
function lightboxZoomTo(newScale, clientX, clientY) {
  const prev = lbScale;
  lbScale = Math.max(1, Math.min(LB_MAX_SCALE, newScale));
  const r = fileLightboxImg.getBoundingClientRect();
  // Point in un-scaled image coordinates that currently sits under (x, y).
  const ix = (clientX - r.left) / prev;
  const iy = (clientY - r.top) / prev;
  lbX += ix * (prev - lbScale);
  lbY += iy * (prev - lbScale);
  if (lbScale <= 1.01) { lbScale = 1; lbX = 0; lbY = 0; }
  clampLightboxPan();
  applyLightboxTransform();
}

function toggleLightboxZoom(clientX, clientY) {
  if (lbScale > 1.01) resetLightboxZoom();
  else lightboxZoomTo(LB_TAP_SCALE, clientX, clientY);
}

// One definition of each icon so the grid tiles and the photo viewer match.
const ICON_SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><line x1="8.3" y1="10.8" x2="15.7" y2="6.2"/><line x1="8.3" y1="13.2" x2="15.7" y2="17.8"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16"/><path d="M9.5 6.5V4.5h5v2"/><path d="M6.5 6.5l1 13h9l1-13"/><path d="M10.5 10v6M13.5 10v6"/></svg>';

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
  lightboxRecId = recId;
  resetLightboxZoom();
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
  lightboxRecId = rec.id;
  resetLightboxZoom();
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
        <button class="gallery-tile-btn gallery-share-btn" data-share="${r.id}" aria-label="Share file">${ICON_SHARE}</button>
        <button class="gallery-tile-btn gallery-delete-btn" data-del="${r.id}" aria-label="Delete file">${ICON_TRASH}</button>
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
  // Tapping the photo no longer closes it — the X button does. That leaves a
  // single tap doing nothing, so a double tap can never lose a race with it.
  const DOUBLE_TAP_MS = 400;   // gap allowed between the two taps
  const TAP_SLOP = 16;         // how far a finger may travel and still be a tap
  const TAP_MATCH = 40;        // how far apart the two taps may land

  // Android Chrome fires dblclick after a double TAP as well, which would undo
  // the zoom the touch handler below just applied. Anything close in time to a
  // touch is therefore ignored here; mouse-only double-clicks still work.
  let lastTouchAt = 0;
  fileLightbox.addEventListener('dblclick', (e) => {
    if (e.target.closest('.lightbox-btn, .lightbox-bar')) return;
    if (Date.now() - lastTouchAt < 1000) return;
    toggleLightboxZoom(e.clientX, e.clientY);
  });

  // Touch: phones don't fire dblclick reliably, so detect the double tap here.
  let touchX = 0, touchY = 0;
  let lastTapAt = 0, lastTapX = 0, lastTapY = 0;
  let panning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;
  let pinching = false, pinchStartDist = 0, pinchStartScale = 1;

  function dist(t) {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }
  function mid(t) {
    return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
  }

  fileLightbox.addEventListener('touchstart', (e) => {
    lastTouchAt = Date.now();
    if (e.target.closest('.lightbox-btn, .lightbox-bar')) return;
    if (e.touches.length === 2) {
      pinching = true;
      panning = false;
      lastTapAt = 0;              // a pinch is never half of a double tap
      pinchStartDist = dist(e.touches) || 1;
      pinchStartScale = lbScale;
      return;
    }
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
    if (lbScale > 1.01) {
      panning = true;
      panStartX = touchX; panStartY = touchY;
      panOriginX = lbX; panOriginY = lbY;
    }
  }, { passive: true });

  fileLightbox.addEventListener('touchmove', (e) => {
    if (pinching && e.touches.length === 2) {
      const m = mid(e.touches);
      lightboxZoomTo(pinchStartScale * (dist(e.touches) / pinchStartDist), m.x, m.y);
      e.preventDefault();
      return;
    }
    if (panning && e.touches.length === 1) {
      lbX = panOriginX + (e.touches[0].clientX - panStartX);
      lbY = panOriginY + (e.touches[0].clientY - panStartY);
      clampLightboxPan();
      applyLightboxTransform();
      e.preventDefault();
    }
  }, { passive: false });

  fileLightbox.addEventListener('touchend', (e) => {
    lastTouchAt = Date.now();
    if (e.target.closest('.lightbox-btn, .lightbox-bar')) return;
    if (pinching) {
      if (e.touches.length === 0) pinching = false;
      return;   // fingers lifting off a pinch — not a tap, not a swipe
    }
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const dx = endX - touchX;
    const dy = endY - touchY;
    const wasPanning = panning;
    panning = false;

    // A tap is judged only on where the finger started and finished, so a
    // wobble part-way through (common when zoomed in) still counts.
    const now = Date.now();
    const isTap = Math.hypot(dx, dy) < TAP_SLOP;
    if (isTap) {
      if (now - lastTapAt < DOUBLE_TAP_MS &&
          Math.abs(endX - lastTapX) < TAP_MATCH && Math.abs(endY - lastTapY) < TAP_MATCH) {
        lastTapAt = 0;
        toggleLightboxZoom(endX, endY);
      } else {
        lastTapAt = now; lastTapX = endX; lastTapY = endY;
      }
      return;   // single taps do nothing; close with the X
    }
    lastTapAt = 0;
    if (wasPanning || lbScale > 1.01) return;   // dragging a zoomed photo, not swiping
    // Horizontal swipe only: needs 50px+ of travel, mostly sideways.
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    lightboxStep(dx < 0 ? 1 : -1); // swipe left → next, right → previous
  }, { passive: true });
}

// The X in the corner is now the only way to dismiss the photo by tapping
// (Back / the phone's back gesture still work).
const fileLightboxClose = document.getElementById('file-lightbox-close');
if (fileLightboxClose) {
  fileLightboxClose.addEventListener('click', (ev) => {
    ev.stopPropagation();
    history.back();
  });
}

// Delete the photo currently open in the lightbox, then drop back to the grid.
const fileLightboxDelete = document.getElementById('file-lightbox-delete');
if (fileLightboxDelete) {
  fileLightboxDelete.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!lightboxRecId) return;
    if (!confirm('Delete this file from this device?')) return;
    const customerId = activeCustomerId;
    await LocalFiles.remove(lightboxRecId);
    lightboxRecId = null;
    history.back();                       // closes the viewer via the popstate handler
    if (customerId) renderFileGallery(customerId);
  });
}

// Share the photo currently open in the lightbox (same behaviour as the grid's
// per-tile share button, including the desktop download fallback).
if (fileLightboxShare) {
  fileLightboxShare.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!lightboxRecId) return;
    const rec = await LocalFiles.get(lightboxRecId);
    if (!rec) return;
    const result = await LocalFiles.share(rec);
    if (result === 'unsupported') {
      const url = URL.createObjectURL(rec.blob);
      fileObjectUrls.push(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = rec.name;
      a.click();
    }
  });
}

// "What's new" list in Settings — shows at most the 10 latest changelog entries.
const changelogList = document.getElementById('changelog-list');
if (changelogList) {
  changelogList.innerHTML = CHANGELOG.slice(0, 20).map(([ver, desc]) => `
    <li class="changelog-item"><span class="changelog-ver">${ver}</span> ${desc}</li>
  `).join('');
}

// ---------- Hours (calendar jobs → records → QuickBooks) ----------
// The hours entered on calendar jobs, rendered as a GRID that borrows the price
// table's chrome (see index.html and styles.css). One cell open at a time, tap
// elsewhere to move or close.
//
// Only the Hours column is editable, and an edit there goes straight back onto
// the job. Date, employee and customer are the job's, shown read-only —
// changing them here would mean two places to book work from.
//
// (Before v2026.08.18-2325 the rows came from parsing a general note titled
// "hours", and all four columns were editable. iif.js still exports
// parseHoursNote, unchanged, if that is ever wanted back.)
const iifBtn = document.getElementById('iif-btn');
const iifStatus = document.getElementById('iif-status');
const iifGrid = document.getElementById('iif-grid');
const iifScroll = document.getElementById('iif-scroll');
const iifDownloadBtn = document.getElementById('iif-download-btn');
const iifSaveHoursBtn = document.getElementById('iif-save-hours-btn');
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

// ---- where the rows come from: CALENDAR JOBS ----
// Until v2026.08.18-2325 this screen parsed a general note titled "hours".
// Hours are now typed per person on the job itself, so the job IS the record of
// what was worked and the note is out of the loop entirely.
//
// ONE ENTRY PER PERSON, not per job. Two people on a job usually work different
// hours (employeeHours is a per-name map), while an entry carries a single
// `hours` shared by everyone on it — so splitting here is what keeps the number
// attached to the right person. It also matches QuickBooks, which wants a row
// per person anyway.
//
// The shape returned is deliberately IDENTICAL to what parseHoursNote produced.
// That is why nothing downstream changed: the saved-record matching, the ticks,
// Save hours and the .iif writer all still see the entries they expect.
function jobEntriesInRange(range) {
  const from = range.from ? ymd(range.from) : '';
  const to = range.to ? ymd(range.to) : '';
  const jobs = Storage.listJobs()
    .filter(j => j.date && (!from || j.date >= from) && (!to || j.date <= to))
    .sort((a, b) => (a.date === b.date
      ? String(a.start || '').localeCompare(String(b.start || ''))
      : a.date.localeCompare(b.date)));
  const out = [];
  for (const j of jobs) {
    // The customer LABEL has to be the same one timelogs are keyed on
    // (customerCrumbLabel), or a job could never match its own saved record.
    const cust = j.customerId ? customerCrumbLabel(j.customerId) : (j.customerName || '');
    // A job with nobody on it still gets one row, so it can't silently vanish.
    const names = (j.employeeNames || []).length ? j.employeeNames : [''];
    const hrs = j.employeeHours || {};
    const d = parseYmd(j.date);
    for (const name of names) {
      const h = Number(hrs[name]);
      const hours = Number.isFinite(h) && h > 0 ? Math.round(h * 100) / 100 : 0;
      out.push({
        jobId: j.id,
        employeeName: name,           // which key in employeeHours an edit writes to
        date: d,
        dateFormatted: Number.isNaN(d.getTime()) ? '' : iifFormatDate(d),
        employees: name ? [name] : [],
        hours,
        // Blank, not "0", when nothing has been entered: the cell reads "—" and
        // you can see at a glance which jobs you still owe hours for.
        hoursFormatted: hours > 0 ? formatDuration(hours) : '',
        customer: cust,
        customerMatched: cust,
        // No parser means nothing to be unsure about — no score, no orange rows.
        confidence: null,
        raw: j.description || '',
      });
    }
  }
  return out;
}

// ---- zoom (its own key: resizing the hours chart shouldn't resize prices) ----
let iifZoom = parseFloat(localStorage.getItem('na-hours-zoom') || '1') || 1;
function applyIifZoomVar() {
  if (hoursView) hoursView.style.setProperty('--price-scale', String(iifZoom));
}
function nudgeIifZoom(delta) {
  iifZoom = Math.min(1.8, Math.max(0.7, Math.round((iifZoom + delta) * 10) / 10));
  localStorage.setItem('na-hours-zoom', String(iifZoom));
  applyIifZoomVar();
}

// ---- grid state ----
// `${entryIdx}:${employeeSlot}|${column}` — the open cell, mirroring the price
// table's openCellKey.
let openIifCell = null;

// One row per entry PER EMPLOYEE: a note line naming two people is two rows in
// QuickBooks. Editing date/customer/hours changes the shared entry (so both
// rows move together, which is right — it's one line of the note); editing the
// employee changes only that row's slot.
// Matching a saved timelog to a note line, by DATE + EMPLOYEE + CUSTOMER.
// Consequence worth knowing: hours is then the only field that can disagree,
// which is what makes a "discrepancy" a precise thing to show. The trade-off
// is that correcting a customer breaks the link — the old record shows as
// saved-but-not-in-the-note rather than quietly updating.
function iifLogKey(dateStr, employee, customer) {
  return [
    String(dateStr || ''),
    String(employee || '').trim().toLowerCase(),
    String(customer || '').trim().toLowerCase(),
  ].join('|');
}
function iifEntryLogKey(e, emp) {
  return iifLogKey(iifIsoDate(e), emp, e.customerMatched);
}
// Hours are floats derived from clock arithmetic; compare to the nearest
// minute rather than exactly, or 3.4999999 and 3.5 read as a discrepancy.
function sameHours(a, b) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.009; }

// One row per entry PER EMPLOYEE: a note line naming two people is two rows in
// QuickBooks. Editing date/customer/hours changes the shared entry (so both
// rows move together, which is right — it's one line of the note); editing the
// employee changes only that row's slot.
//
// Rows are the UNION of the note and what's already saved:
//   matched, same hours  → one green row  (kind 'saved')
//   matched, hours differ → green row (saved) + red row (what the job says)
//   job only             → plain row      (kind 'note')
//   saved only           → green row      (kind 'saved') so recorded hours
//                          can't vanish just because a job was deleted
// Several jobs sharing a key (two visits, same customer, same day) pair off IN
// ORDER against the records with that key; extras stay unmatched rather than
// silently merging.
function iifGridRows() {
  const byKey = new Map();
  for (const t of iifVisibleTimeLogs()) {
    if (!byKey.has(t._key)) byKey.set(t._key, []);
    byKey.get(t._key).push(t);
  }
  const rows = [];
  iifParsedEntries.forEach((e, idx) => {
    const emps = e.employees.length ? e.employees : [''];
    emps.forEach((emp, empIdx) => {
      const key = iifEntryLogKey(e, emp);
      const pool = byKey.get(key);
      const log = (pool && pool.length) ? pool.shift() : null;
      const base = { e, idx, emp, empIdx, first: empIdx === 0 };
      // A job with no hours entered makes no claim, so it can't DISAGREE with a
      // record — it just shows what's on record. Type a number into it and the
      // disagreement appears as normal.
      if (log && (!e.hours || sameHours(log.hours, e.hours))) {
        // In sync. One row, and it stays editable — correcting an already
        // saved line is exactly what you'd want to do next.
        rows.push({ ...base, kind: 'saved', log, editable: true });
      } else if (log) {
        // A PAIR: the same work described two ways. The saved row states what's
        // on record; the red row is what the job says now and is the one you
        // edit and re-save. `pair` marks them so only one can be ticked — they
        // are one piece of work, and exporting both would double it.
        rows.push({ ...base, kind: 'saved', log, editable: false, pair: true });
        rows.push({ ...base, kind: 'differs', log, editable: true, pair: true });
      } else {
        rows.push({ ...base, kind: 'note', editable: true });
      }
    });
  });
  // Anything saved that no note line claimed
  for (const list of byKey.values()) {
    for (const log of list) {
      rows.push({ log, kind: 'saved', orphan: true, first: true, editable: false });
    }
  }
  return rows;
}

// ---- which rows are ticked ----
// Keyed by ROW, not by entry+employee as before: orphan rows have no entry
// behind them, and the two halves of a pair need to be tickable separately.
// One map serves both Save hours and Download .iif, so "ticked" means the same
// thing for both: this row is the truth. Cleared on every re-parse.
let iifTickState = new Map();
let iifRenderedRows = [];
function iifRowTickId(row) {
  if (row.orphan) return `log:${row.log.id}`;
  if (row.kind === 'saved') return `saved:${row.log.id}`;
  if (row.kind === 'differs') return `differs:${row.idx}:${row.empIdx}`;
  return `note:${row.idx}:${row.empIdx}`;
}
function iifRowTicked(row) {
  const id = iifRowTickId(row);
  if (!iifTickState.has(id)) {
    // In a disagreeing pair the JOB is ticked by default — it's your most
    // recent word on the matter. Everything else starts ticked.
    iifTickState.set(id, !(row.kind === 'saved' && row.pair));
  }
  return iifTickState.get(id);
}
function setIifRowTick(row, on) {
  iifTickState.set(iifRowTickId(row), on);
  // Ticking one half of a pair unticks the other. Unticking leaves both off —
  // "neither of these" is a legitimate answer.
  if (on && row.pair) {
    const partner = row.kind === 'saved'
      ? `differs:${row.idx}:${row.empIdx}`
      : `saved:${row.log.id}`;
    iifTickState.set(partner, false);
  }
}
// Timelogs for the range currently on screen, keyed for matching.
function iifVisibleTimeLogs() {
  const r = iifRangeFromInputs();
  const from = r.from ? ymd(r.from) : '';
  const to = r.to ? ymd(r.to) : '';
  return Storage.listTimeLogsInRange(from, to).map(t => ({
    ...t,
    _key: iifLogKey(t.date, t.employeeName, t.customerName),
  }));
}
function iifShortDateFromIso(iso) {
  const d = parseYmd(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '—');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
// What a row displays, whichever side it came from.
function iifRowValues(row) {
  if (row.kind === 'saved') {
    const t = row.log;
    return {
      dateText: iifShortDateFromIso(t.date),
      dateIso: t.date,
      emp: t.employeeName || '',
      cust: t.customerName || '',
      hoursText: t.hoursFormatted || '',
      confidence: null,
    };
  }
  const e = row.e;
  return {
    dateText: iifShortDate(e),
    dateIso: iifIsoDate(e),
    emp: row.emp || '',
    cust: e.customerMatched || '',
    hoursText: e.hoursFormatted || '',
    confidence: e.confidence,
  };
}
function iifRowKey(idx, empIdx) { return `${idx}:${empIdx}`; }
// Save/Cancel are NOT rendered inside the cell — see #iif-cell-bar in the
// header and the comment there. Two earlier attempts (pointerdown instead of
// click, then moving the buttons above the input) both failed because they
// treated the wrong cause: the sticky tick/Date columns paint over the left
// edge of whatever cell is being edited, which is where the buttons sat.
// A native popup (date picker, drop list) closes by sending a tap THROUGH to
// the page underneath. That tap landed on whatever grid cell happened to be
// under it and opened it — "after I pick a date it goes to a random cell".
// Same idea as the price table's pinch suppression: ignore cell-opening taps
// for a moment after a popup has done its work.
let iifTapSuppressedUntil = 0;
function suppressIifTaps(ms = 400) { iifTapSuppressedUntil = Date.now() + ms; }
function iifTapsSuppressed() { return Date.now() < iifTapSuppressedUntil; }
// A parsed entry holds a real Date; the grid edits it as YYYY-MM-DD.
function iifIsoDate(e) {
  return (e.date instanceof Date && !Number.isNaN(e.date.getTime())) ? ymd(e.date) : '';
}
// DISPLAY ONLY — "Tue, Jul 21". The year is noise when you're checking a
// fortnight of work, and the weekday is what you actually reconcile against.
// e.dateFormatted stays MM/DD/YYYY: generateIIF writes it straight into the
// file and QuickBooks needs the full date there.
function iifShortDate(e) {
  if (!(e.date instanceof Date) || Number.isNaN(e.date.getTime())) return e.dateFormatted || '—';
  return e.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
// Accepts what trades actually write: "3.5" or "3:30".
function parseHoursInput(text) {
  const val = String(text || '').trim();
  if (!val) return null;
  const colon = val.match(/^(\d+):([0-5]?\d)$/);
  if (colon) return parseInt(colon[1], 10) + parseInt(colon[2], 10) / 60;
  const dec = val.match(/^(\d+(?:\.\d+)?)$/);
  if (dec) return parseFloat(dec[1]);
  return null;
}

function iifCellHtml(row, col) {
  const { idx, empIdx } = row;
  const v = iifRowValues(row);
  // HOURS IS THE ONLY EDITABLE COLUMN (v2026.08.18-2325). Date, employee and
  // customer are the calendar job's business — change them on the job and the
  // chart follows. Everything else carries no cell key, so nothing can open an
  // editor on it. A read-only ROW (a record with no job behind it, or the
  // record half of a disagreeing pair) is locked the same way.
  if (col !== 'hours' || !row.editable) {
    if (col === 'date') return `<td class="iif-date">${escapeHtml(v.dateText)}</td>`;
    if (col === 'employee') return `<td>${escapeHtml(v.emp || 'Nobody')}</td>`;
    if (col === 'customer') return `<td>${escapeHtml(v.cust || '—')}</td>`;
    if (col === 'hours') return `<td>${escapeHtml(v.hoursText || '—')}</td>`;
    return `<td>${row.orphan ? '<span class="iif-tag">no job</span>' : ''}</td>`;
  }
  const key = iifRowKey(idx, empIdx);
  const open = openIifCell === `${key}|hours`;
  const cellAttrs = `data-cellkey="${key}|hours" data-idx="${idx}" data-empidx="${empIdx}"`;
  if (open) {
    return `<td class="price-cell price-cell-editing" ${cellAttrs}>
      <input class="iif-edit-hours" type="text" inputmode="decimal" placeholder="3.5 or 3:30"
             value="${escapeHtml(v.hoursText)}" /></td>`;
  }
  return `<td class="price-cell" ${cellAttrs}>${escapeHtml(v.hoursText || '—')}</td>`;
}

function renderIIFEntries(entries) {
  if (!iifGrid) return;
  if (!entries.length) {
    iifGrid.innerHTML = '<tbody><tr><td class="price-empty-state">No entries found.</td></tr></tbody>';
    return;
  }
  const head = `<thead><tr>
    <th class="iif-check" aria-label="Include"></th>
    <th class="iif-date">Date</th>
    <th>Employee</th>
    <th>Customer</th>
    <th>Hours</th>
    <th aria-label="Flag"></th>
  </tr></thead>`;

  iifRenderedRows = iifGridRows();
  const body = iifRenderedRows.map((row, i) => {
    // Green = on record. Red = the job now says something different. (The
    // orange needs-review tint went with the parser — a job has no confidence
    // score, it just says what it says.)
    const cls = [
      row.kind === 'saved' ? 'iif-saved' : '',
      row.kind === 'differs' ? 'iif-differs' : '',
    ].filter(Boolean).join(' ');
    // EVERY row is tickable, so anything visible can be exported — including a
    // record whose job has since been deleted.
    const tick = `<input type="checkbox" class="iif-row-check" data-row="${i}" ${iifRowTicked(row) ? 'checked' : ''} />`;
    return `<tr class="${cls}">
      <td class="iif-check">${tick}</td>
      ${iifCellHtml(row, 'date')}
      ${iifCellHtml(row, 'employee')}
      ${iifCellHtml(row, 'customer')}
      ${iifCellHtml(row, 'hours')}
      ${iifCellHtml(row, 'flag')}
    </tr>`;
  }).join('');

  iifGrid.innerHTML = head + `<tbody>${body}</tbody>`;
  applyIifZoomVar();
  wireIifGrid();
}

// (The pinned "Note line" bar was removed in v2026.08.18-2325 along with
// saveIifNoteLine, which wrote a corrected line back into the hours note.
// There is no source line any more — a row IS a calendar job, and the job is
// edited in the calendar. #iif-src-bar went out of index.html with it.)

function closeIifCell(rerender = true) {
  // Closing removes the Save/Cancel bar from the header, so everything below
  // SHIFTS UP — and the tail of the very tap that closed it (the click that
  // follows pointerdown) then lands on whatever cell has moved under the
  // finger, opening that one. It presented as "Cancel does nothing"
  // (reopened the same cell), "jumps to another cell", or working fine,
  // depending on where the layout settled: not reproducible, because it
  // depended on finger position. Suppress cell-opening taps for a moment so
  // the tap that closed a cell cannot open the next one. Cell-to-cell moves
  // are unaffected — those call openIifCellAt directly, not through here.
  suppressIifTaps(500);
  iifOutsideTap.detach();
  openIifCell = null;
  renderIifCellBar(null);    // retire the header Save/Cancel
  if (rerender) renderIIFEntries(iifParsedEntries);
}

function openIifCellAt(cellKey) {
  openIifCell = cellKey;
  renderIIFEntries(iifParsedEntries);
  focusOpenIifCell();
  setTimeout(() => iifOutsideTap.attach(), 0);
}

// Bring the open cell to the TOP of the chart, so the row you're editing sits
// just under the column headers however far down the chart it started. The
// 55vh of trailing space on .iif-scroll is what lets the last rows get there.
// Two frames: opening a cell changes the header's height (the Save/Cancel bar
// appears), and measuring before that reflow lands the row in the wrong place.
function focusOpenIifCell() {
  const cell = iifGrid ? iifGrid.querySelector('.price-cell-editing') : null;
  if (!cell || !iifScroll) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const c = cell.getBoundingClientRect();
    const s = iifScroll.getBoundingClientRect();
    // Clear the sticky column header, nothing more.
    const headH = (iifGrid.querySelector('thead') || { getBoundingClientRect: () => ({ height: 0 }) })
      .getBoundingClientRect().height;
    iifScroll.scrollTop += (c.top - s.top) - headH - 4;
    // Horizontally, "inside the scroller" isn't enough: the tick and Date
    // columns are STICKY and paint over whatever is to their right, so a cell
    // can be technically visible and still be underneath them. Clear the far
    // edge of the last sticky column, not the edge of the scroller.
    const stickyEnd = (() => {
      const d = iifGrid.querySelector('tbody .iif-date');
      return d ? d.getBoundingClientRect().right : s.left;
    })();
    if (c.left < stickyEnd) iifScroll.scrollLeft -= (stickyEnd - c.left) + 8;
    else if (c.right > s.right) iifScroll.scrollLeft += (c.right - s.right) + 8;
    const input = cell.querySelector('input');
    if (!input) return;
    input.focus();
    // select() is only meaningful on a text field — calling it on type="date"
    // throws in some browsers.
    if (input.type === 'text') input.select();
  }));
}

const iifOutsideTap = makeOutsideTapWatcher({
  isOpen: () => !!openIifCell,
  // The include tick counts as "inside": tapping it with a cell open should
  // toggle the row, not close the editor and swallow the tap.
  editingSelector: '.price-cell-editing, .iif-check',
  cellSelector: '.iif-grid .price-cell',
  onCell: (other) => {
    if (!other.dataset.cellkey) return false;
    if (iifTapsSuppressed()) return true;   // a popup closing, not a real tap
    openIifCellAt(other.dataset.cellkey);
    return true;
  },
  onOutside: () => closeIifCell(),
});

// ---- the only commit left: hours ----
// Date, employee and customer belong to the calendar job and are not editable
// here, so commitIifDate / commitIifEmployee / commitIifCustomer (and
// resolveEmployeeName, which snapped a typed name to the configured spelling)
// went out in v2026.08.18-2325.
function commitIifHours(idx, text) {
  const e = iifParsedEntries[idx];
  if (!e) return;
  const hours = parseHoursInput(text);
  if (hours === null) return;
  e.hours = Math.round(hours * 100) / 100;
  e.hoursFormatted = e.hours > 0 ? formatDuration(e.hours) : '';
  writeHoursToJob(e);
}

// The job is the source of truth for this screen, so an edit has to land there
// too — otherwise reopening the chart would show the old number and quietly
// undo the correction. In-memory first (the redraw is instant), Firestore
// fire-and-forget, same as everywhere else in the app.
//
// Admin only. A bookkeeper can still correct a number for the export; it just
// doesn't rewrite the schedule, which isn't theirs to change.
function writeHoursToJob(e) {
  if (!isAdminRole()) return;
  if (!e || !e.jobId || !e.employeeName) return;
  const job = Storage.getJob(e.jobId);
  if (!job) return;
  const employeeHours = { ...(job.employeeHours || {}) };
  // Clearing the hours removes the person's entry rather than storing a 0 —
  // "no hours entered" and "worked zero hours" should not look the same.
  if (e.hours > 0) employeeHours[e.employeeName] = e.hours;
  else delete employeeHours[e.employeeName];
  // saveJob REBUILDS the document from what it is handed, so the whole job has
  // to go back — passing only the changed field would blank everything else.
  Promise.resolve(Storage.saveJob({ ...job, employeeHours }))
    .catch(err => console.warn('writeHoursToJob', err));
}

// Save/Cancel act on POINTERDOWN, not click.
//
// Tapping either button blurs the open input, which dismisses the keyboard,
// which changes --app-vh — and this screen is SIZED to --app-vh (it has to be;
// see the note-line fix in v2026.08.02-0734). So the whole screen reflows
// between pointerdown and pointerup, the button slides out from under your
// finger, the two events land on different elements, and the browser never
// dispatches a click at all. Cancel looked completely dead; Save only seemed
// to work because Enter is the other way to trigger it.
//
// preventDefault on pointerdown keeps the field focused so nothing moves until
// we've acted. The click listener is a fallback for anything without pointer
// events, and the `done` flag stops both paths firing.
//
// The price table wires the identical buttons with a plain click and is fine —
// #price-view isn't sized to the visible viewport, so it doesn't reflow when
// the keyboard closes. Don't "fix" that one to match.
// De-duped by TIME, not by a one-shot flag: these buttons now live in the
// header and persist for the whole session, so a permanent "already fired"
// flag would make them work exactly once.
function wireIifCellButton(el, fn) {
  if (!el) return;
  let last = 0;
  const run = (ev) => {
    const now = Date.now();
    if (now - last < 500) return;   // the click that follows our own pointerdown
    last = now;
    ev.preventDefault();
    fn();
  };
  el.addEventListener('pointerdown', run);
  el.addEventListener('click', run);
}

function wireIifGrid() {
  if (!iifGrid) return;
  iifGrid.querySelectorAll('.iif-row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const row = iifRenderedRows[parseInt(cb.dataset.row, 10)];
      if (!row) return;
      setIifRowTick(row, cb.checked);
      // Ticking half of a pair unticks the other half — redraw so you can see
      // that happen rather than discovering it in the exported file.
      if (row.pair) renderIIFEntries(iifParsedEntries);
    });
  });
  iifGrid.querySelectorAll('.price-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const key = cell.dataset.cellkey;
      // Already open: the editor inside owns the tap.
      if (!key || openIifCell === key) return;
      // That was a native popup closing, not a deliberate tap on this cell.
      if (iifTapsSuppressed()) return;
      openIifCellAt(key);
    });
  });
  const editing = iifGrid.querySelector('.price-cell-editing');
  if (!editing) return;
  const idx = parseInt(editing.dataset.idx, 10);
  const col = (editing.dataset.cellkey || '').split('|')[1];
  const save = () => {
    commitIifHours(idx, editing.querySelector('.iif-edit-hours').value);
    closeIifCell();
  };
  // The buttons live in the header bar, not in the cell — point them at THIS
  // cell's save for as long as it's open.
  iifCellSaveFn = save;
  renderIifCellBar(col);
  editing.querySelectorAll('input').forEach(input => {
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); save(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeIifCell(); }
    });
  });

  // (No native popups left to handle: Hours is a plain text field. The date
  // picker and the two drop lists went with the read-only columns.)
}

// ---- Save / Cancel for the open cell, in the sticky header ----
// Wired ONCE against elements that never get re-rendered, so no amount of grid
// redrawing can detach them. iifCellSaveFn points at whichever cell is open.
const iifCellBar = document.getElementById('iif-cell-bar');
const iifCellWhat = document.getElementById('iif-cell-what');
const iifCellHint = document.getElementById('iif-cell-hint');
let iifCellSaveFn = null;
const IIF_COL_LABEL = { date: 'Date', employee: 'Employee', customer: 'Customer', hours: 'Hours' };
function showIifCellHint(msg) {
  if (!iifCellHint) return;
  iifCellHint.textContent = msg || '';
  iifCellHint.hidden = !msg;
}
function renderIifCellBar(col) {
  if (!iifCellBar) return;
  if (!col) { iifCellBar.hidden = true; showIifCellHint(''); iifCellSaveFn = null; return; }
  if (iifCellWhat) iifCellWhat.textContent = `Editing ${IIF_COL_LABEL[col] || col}`;
  showIifCellHint('');
  iifCellBar.hidden = false;
}
// An exception thrown inside a re-render used to vanish into a console nobody
// can see on a phone, which looks identical to a dead button. Kept from the
// v2026.08.02-1506 diagnostic build: errors on this screen now say so.
window.addEventListener('error', (e) => {
  if (!hoursView || !hoursView.classList.contains('active')) return;
  if (iifStatus) iifStatus.textContent = 'error: ' + (e.message || 'unknown');
});

wireIifCellButton(document.getElementById('iif-cell-save'), () => {
  try {
    if (iifCellSaveFn) iifCellSaveFn();
  } catch (err) {
    if (iifStatus) iifStatus.textContent = 'save failed: ' + (err && err.message ? err.message : String(err));
  }
});
wireIifCellButton(document.getElementById('iif-cell-cancel'), () => {
  try {
    closeIifCell();
  } catch (err) {
    if (iifStatus) iifStatus.textContent = 'close failed: ' + (err && err.message ? err.message : String(err));
  }
});

const iifZoomIn = document.getElementById('iif-zoom-in');
const iifZoomOut = document.getElementById('iif-zoom-out');
if (iifZoomIn) iifZoomIn.addEventListener('click', () => nudgeIifZoom(0.1));
if (iifZoomOut) iifZoomOut.addEventListener('click', () => nudgeIifZoom(-0.1));

// Two-finger pinch, same as the price table — it was never wired here, because
// that code is bound by id to #price-scroll. Written as a helper rather than
// copied so a future third grid doesn't get a third copy; the price table
// keeps its own version, which is entangled with its long-press cancellation
// and works.
function wirePinchZoom(el, getZoom, setZoom, onGesture) {
  if (!el) return;
  const pts = new Map();
  let startDist = 0, startZoom = 1;
  const dist = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  el.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { startDist = dist(); startZoom = getZoom(); if (onGesture) onGesture(); }
  });
  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && startDist > 0) {
      e.preventDefault();
      if (onGesture) onGesture();
      setZoom(startZoom * (dist() / startDist));
    }
  });
  const drop = (e) => {
    // Keep suppressing past the release: lifting a pinch lands as a tap on
    // whatever is underneath, which would otherwise open a cell editor.
    if (pts.size >= 2 && onGesture) onGesture();
    pts.delete(e.pointerId);
    if (pts.size < 2) startDist = 0;
  };
  el.addEventListener('pointerup', drop);
  el.addEventListener('pointercancel', drop);
  el.addEventListener('pointerleave', drop);
}
function setIifZoom(z) {
  iifZoom = Math.min(1.8, Math.max(0.7, z));
  localStorage.setItem('na-hours-zoom', String(Math.round(iifZoom * 100) / 100));
  applyIifZoomVar();
}
wirePinchZoom(iifScroll, () => iifZoom, setIifZoom, () => suppressIifTaps(400));

function iifRangeFromInputs() {
  const parseInput = (el, endOfDay) => {
    if (!el || !el.value) return null;
    const [y, mo, d] = el.value.split('-').map(Number);
    return new Date(y, mo - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  };
  return { from: parseInput(iifFromDate, false), to: parseInput(iifToDate, true) };
}

// The calendar keeps a LIVE WINDOW of roughly three months; anything older was
// never loaded. Widening the range to last spring would otherwise show an empty
// chart rather than the jobs that are actually there, so pull each month the
// range touches. ensureJobMonth fetches once and remembers.
function ensureJobsForRange(range) {
  if (!range.from || !range.to) return Promise.resolve();
  const months = [];
  const d = new Date(range.from.getFullYear(), range.from.getMonth(), 1);
  const end = new Date(range.to.getFullYear(), range.to.getMonth(), 1);
  // Capped: a range of several years is a mis-typed date, not a request for
  // sixty round trips.
  for (let i = 0; i < 24 && d <= end; i++) {
    months.push(ymd(d));
    d.setMonth(d.getMonth() + 1);
  }
  return Promise.all(months.map(m =>
    Promise.resolve(Storage.ensureJobMonth(m)).catch(() => {})));
}

// Build the chart from the calendar jobs in the selected date range.
// (Named runIIFParse since the note-parsing days; it no longer parses anything.)
function runIIFParse() {
  iifStatus.innerHTML = '<span class="nav-spinner" style="width:16px;height:16px;border-width:2px;vertical-align:middle;"></span> Loading your calendar jobs…';
  closeIifCell(false);                       // a re-parse invalidates row indexes
  iifTickState = new Map();                  // ...and the ticks keyed on them
  iifRenderedRows = [];
  if (iifGrid) iifGrid.innerHTML = '';
  if (iifDownloadBtn) iifDownloadBtn.hidden = true;
  if (iifSaveHoursBtn) iifSaveHoursBtn.hidden = true;

  // Both fetches BEFORE drawing: the already-saved hours for this range (so the
  // grid is green/red in one pass rather than flashing everything as unsaved),
  // and any month of jobs outside the calendar's live window.
  const r0 = iifRangeFromInputs();
  Promise.all([
    Promise.resolve(
      Storage.ensureTimeLogRange(r0.from ? ymd(r0.from) : '', r0.to ? ymd(r0.to) : '')
    ).catch(() => {}),
    ensureJobsForRange(r0).catch(() => {}),
  ]).then(() => {
    const range = iifRangeFromInputs();
    iifParsedEntries = jobEntriesInRange(range);

    const total = iifParsedEntries.length;
    // Status is for the WAIT and for failure, not for narrating the result —
    // the chart itself already shows how many entries there are. Cleared here
    // so the line collapses (.iif-status:empty) instead of leaving a gap.
    iifStatus.textContent = total
      ? ''
      : 'No calendar jobs between these dates. Add jobs on the calendar and enter each person’s hours there.';
    renderIIFEntries(iifParsedEntries);
    if (iifDownloadBtn) iifDownloadBtn.hidden = total === 0;
    if (iifSaveHoursBtn) iifSaveHoursBtn.hidden = total === 0 || !isAdminRole();
  });
}

// ---- Save hours: the ticked job rows become timelog records ----
// One record per PERSON. A row that already has a matching record is UPDATED
// rather than duplicated — matching is by date + employee + customer, so the
// only thing that can change is the hours.
function iifRowsToSave() {
  const out = [];
  for (const row of iifRenderedRows) {
    // Green rows are already records — an in-sync one has nothing to write,
    // and the record half of a pair means "keep what's stored".
    if (row.kind !== 'note' && row.kind !== 'differs') continue;
    if (!iifRowTicked(row)) continue;
    const e = row.e, emp = row.emp;
    if (!emp) continue;                       // nobody to pay
    if (!e.hours || e.hours <= 0) continue;   // nothing to record
    if (!e.customerMatched) continue;
    const cust = Storage.listCustomers().find(c => customerCrumbLabel(c.id) === e.customerMatched);
    out.push({
      // A red row carries the record it disagrees with, so this UPDATES rather
      // than adding a second record for the same work.
      id: row.log ? row.log.id : null,
      date: iifIsoDate(e),
      employeeName: emp,
      customerId: cust ? cust.id : null,
      customerName: e.customerMatched,
      hours: e.hours,
      hoursFormatted: e.hoursFormatted,
      note: e.raw || '',
    });
  }
  return out;
}

// The .iif is built from the TICKED ROWS, not from the job entries. That's what
// makes every row exportable: a green row exports what's on record, a red row
// exports what the job says, and a record whose job has since been deleted can
// still reach QuickBooks. Pairs are mutually exclusive, so the same work can
// never appear twice.
function iifExportEntries() {
  return iifRenderedRows
    .filter(iifRowTicked)
    .map(row => {
      const v = iifRowValues(row);
      const d = parseYmd(v.dateIso);
      const hours = row.kind === 'saved' ? Number(row.log.hours) : Number(row.e.hours);
      return {
        dateFormatted: Number.isNaN(d.getTime()) ? '' : iifFormatDate(d),
        employees: v.emp ? [v.emp] : [],
        hours,
        hoursFormatted: v.hoursText,
        customerMatched: v.cust,
      };
    })
    // generateIIF skips these anyway; dropping them here keeps the count honest
    .filter(e => e.employees.length && e.hours > 0 && e.customerMatched && e.dateFormatted);
}
if (iifSaveHoursBtn) iifSaveHoursBtn.addEventListener('click', async () => {
  if (!isAdminRole()) return;
  const recs = iifRowsToSave();
  if (!recs.length) {
    iifStatus.textContent = 'Nothing new to save — every ticked row is already on record.';
    return;
  }
  const updates = recs.filter(r => r.id).length;
  const adds = recs.length - updates;
  iifSaveHoursBtn.disabled = true;
  iifStatus.innerHTML = '<span class="nav-spinner" style="width:16px;height:16px;border-width:2px;vertical-align:middle;"></span> Saving hours…';
  try {
    await Storage.saveTimeLogsBulk(recs);
    iifStatus.textContent = `Saved ${adds} new record${adds === 1 ? '' : 's'}` +
      (updates ? `, updated ${updates}` : '') + '.';
  } catch (err) {
    console.error(err);
    iifStatus.textContent = 'Could not save hours. If this is the first time, the Firestore rules may not be deployed yet.';
  }
  iifSaveHoursBtn.disabled = false;
  renderIIFEntries(iifParsedEntries);
});

// A SCREEN, not a sheet: you navigate to it, and the system back button (or
// ‹ Back) leaves it like any other screen. Entered fresh every time — the jobs
// are re-read, so an uncommitted cell edit does not survive leaving. (A
// COMMITTED one does: it was written to the job.)
function showHoursView() {
  if (!hoursView) return;
  // Same gate as the Settings card: admin writes, bookkeeper reads.
  if (!isAdminRole() && !isBookkeeperRole()) return;
  hideAllScreens();
  hoursView.classList.add('active');
  // Locks page scroll behind the fixed screen — same contract as editor-open.
  document.body.classList.add('hours-open');
  renderCrumbs('crumbs-hours', [
    { label: 'Home', go: 'home' },
    { label: 'Hours' },
  ]);
  applyIifZoomVar();
  if (!handlingPopstate) history.pushState({ screen: 'hours' }, '');

  runIIFParse();
}

if (iifBtn) iifBtn.addEventListener('click', showHoursView);
// (#editor-iif-btn — the Hours shortcut in a note's ⋯ menu — is permanently
// hidden as of v2026.08.18-2325: it only ever appeared on the "hours" note,
// which no longer means anything to this screen. Handler left wired in case
// the button is ever shown again.)
if (editorIifBtn) editorIifBtn.addEventListener('click', () => {
  if (editorView.classList.contains('active')) commitAndCleanupEditor();
  showHoursView();
});
// The range lives on this screen, so changing it re-reads straight away.
const iifRangeChanged = () => {
  if (hoursView && hoursView.classList.contains('active')) runIIFParse();
};
if (iifFromDate) iifFromDate.addEventListener('change', iifRangeChanged);
if (iifToDate) iifToDate.addEventListener('change', iifRangeChanged);

if (iifDownloadBtn) iifDownloadBtn.addEventListener('click', () => {
  const includedEntries = iifExportEntries();
  if (!includedEntries.length) {
    iifStatus.textContent = 'Nothing ticked to export.';
    return;
  }
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
// Resume pill (see "pausing the tour" below). Declared UP HERE with the other
// tutorial refs rather than beside its own functions: endTutorial reads them
// and is defined much earlier, and a const in the temporal dead zone would be
// a hard crash rather than a quiet miss. Same reasoning as hoursView.
const tutorialResume = document.getElementById('tutorial-resume');
const tutorialResumeBtn = document.getElementById('tutorial-resume-btn');
const tutorialResumeClose = document.getElementById('tutorial-resume-close');
let tutorialPaused = false;

let tutorialStepIndex = 0;
let tutorialPart = 1;
let tutorialStartPart = 1; // the part the user launched — back never goes before it
// The LINEAR tour is 1→5, ending on "Install on your phone". Parts 6 (Calendar)
// and 7 (Hours) sit outside it: one screen each, not daily reading for every
// role, and reached from that screen's own ⋯ menu. They always end on
// themselves, which is what tutorialSolo does.
const TUTORIAL_PARTS = 5;
const SOLO_PARTS = [6, 7];
let tutorialSolo = false;
// The step the user launched from. Normally 0; a skip-home launch starts
// later, and Back must not reverse into a step we just said doesn't apply.
let tutorialFloorIndex = 0;

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
          text: 'General notes aren’t tied to a customer — shopping lists, reminders, your hours. They live right here on the home screen.',
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

  // part 6 — the calendar. OUTSIDE the 1→5 chain: one screen, and not daily
  // reading for every role. Reached from the calendar's own ⋯ menu or Settings.
  if (part === 6) {
    const canEditJobs = () => Storage.getRole() === 'admin';
    const aDayWithJobs = () => {
      const jobs = Storage.listJobs();
      return jobs.length ? jobs[0].date : null;
    };
    // Navigate only when we're not already there. showCalendar/showCalendarDay
    // each push a history entry, so calling them once per step would bury the
    // back button under one entry per bubble.
    const goMonth = () => {
      if (!calendarView.classList.contains('active')) showCalendar();
      return true;
    };
    const goDay = () => {
      const d = aDayWithJobs();
      if (!d) return false;
      if (!calendarDayView.classList.contains('active')) showCalendarDay(d);
      return true;
    };
    return [
      {
        screen: 'home',
        setup: () => { goHome(); return true; },
        target: () => document.querySelector('#notes-list .note-card[data-nav="calendar"]'),
        text: 'The calendar is who is working where, and when. It’s a plan — hours you actually worked are recorded separately.',
      },
      {
        screen: 'calendar',
        setup: goMonth,
        target: () => document.querySelector('#cal-grid .cal-cells'),
        text: 'A month at a time. Each day lists its jobs, and everyone on a job gets a coloured tag — the same colour every time, so you can read the week without reading the names.',
      },
      {
        screen: 'calendar',
        setup: goMonth,
        target: () => document.querySelector('#cal-grid .cal-cue-down'),
        text: 'Swipe up for next month and down for last, the way the page moves. These strips name the month you’re heading to, and you can tap them instead.',
      },
      {
        screen: 'calendar',
        setup: goMonth,
        target: () => document.getElementById('cal-today'),
        text: 'Today brings you back to this month from wherever you’ve wandered.',
      },
      {
        screen: 'calendar',
        requires: canEditJobs,
        setup: goMonth,
        target: () => document.getElementById('cal-fab'),
        text: 'Add a job with +. Only the date is required — customer, address, times and who’s going can all come later. Tapping an empty day starts one on that day.',
      },
      {
        screen: 'calendar-day',
        group: 'caljobs',
        requires: () => Storage.listJobs().length > 0,
        fallback: {
          target: () => document.getElementById('cal-fab'),
          text: 'Schedule a job first, then run this part again to see the day view.',
        },
        setup: goDay,
        target: () => document.querySelector('#calendar-day-view .cal-block'),
        text: 'Tap a day to open it as a timeline. Each job sits at its start time and is as tall as it is long, so a clash is something you can see rather than work out.',
      },
      {
        screen: 'calendar-day',
        group: 'caljobs',
        requires: () => Storage.listJobs().length > 0,
        setup: goDay,
        target: () => document.querySelector('#calendar-day-view .cal-day-cues .cal-cue-side'),
        text: 'Swipe sideways for the next or previous day. The cue on each side names the day you’re going to.',
      },
      {
        screen: 'calendar-day',
        group: 'caljobs',
        requires: () => Storage.listJobs().length > 0 && canEditJobs(),
        setup: goDay,
        target: () => document.querySelector('#calendar-day-view .cal-block'),
        text: 'Press and hold a job to pick it up and drag it to a new time; drag the corner to change how long it runs. Both snap to quarter hours. A quick tap opens it for editing.',
      },
      {
        screen: 'settings',
        requires: () => Storage.getRole() === 'admin',
        setup: () => { showSettings(); return true; },
        target: () => document.getElementById('employee-list'),
        text: 'Names you schedule come from this list. Link a name to someone’s account and they can open JobPilot and see their own jobs — leave it unlinked for a subcontractor who doesn’t use the app.',
      },
    ];
  }

  // part 7 — the hours chart. Also outside the chain, and admin/bookkeeper
  // only in practice: the home card and Settings entry are already gated.
  if (part === 7) {
    // Since v2026.08.18-2325 the chart reads CALENDAR JOBS, so the thing that
    // has to exist is a job in the range, not a note.
    const hasJobs = () => Storage.listJobs().length > 0;
    // Two reasons this is async and guarded. showHoursView pushes history, so
    // it must run once for the part, not once per bubble. And its load waits on
    // a fetch of already-saved hours, so 120ms later the grid is still empty
    // and the footer buttons are still hidden — a step measuring then would
    // find nothing and skip itself.
    const goHours = async () => {
      if (!isAdminRole() && !isBookkeeperRole()) return false;
      if (!hoursView.classList.contains('active')) showHoursView();
      for (let i = 0; i < 20 && !document.querySelector('#iif-grid tbody tr'); i++) {
        await new Promise(r => setTimeout(r, 50));
      }
      return true;
    };
    const noJobsFallback = {
      target: () => document.querySelector('#notes-list .note-card[data-nav="calendar"]'),
      text: 'This reads your calendar. Book a job, put each person’s hours on it, then run this part again.',
    };
    return [
      {
        screen: 'home',
        setup: () => { goHome(); return true; },
        target: () => document.querySelector('#notes-list .note-card[data-nav="hours"]'),
        text: 'Hours collects what everyone actually worked — the hours you enter on each calendar job — so you can check it and send it to QuickBooks.',
      },
      {
        screen: 'hours',
        group: 'hoursjobs',
        requires: hasJobs,
        fallback: noJobsFallback,
        setup: goHours,
        target: () => document.getElementById('iif-from-date'),
        text: 'From and To decide which jobs are shown. It opens on the last two weeks; widen it when you’re catching up.',
      },
      {
        screen: 'hours',
        group: 'hoursjobs',
        requires: hasJobs,
        setup: goHours,
        target: () => document.getElementById('iif-grid'),
        text: 'One row per person per job. A row with no hours yet shows a dash — that is a job you still owe hours for.',
      },
      {
        screen: 'hours',
        group: 'hoursjobs',
        requires: hasJobs,
        setup: goHours,
        target: () => document.querySelector('#iif-grid .price-cell'),
        text: 'Hours is the only thing you change here, and the number goes straight back onto the job. Date, employee and customer belong to the job — fix those on the calendar.',
      },
      {
        screen: 'hours',
        group: 'hoursjobs',
        requires: () => hasJobs() && Storage.getRole() === 'admin',
        setup: goHours,
        target: () => document.getElementById('iif-save-hours-btn'),
        text: 'Save hours records the ticked rows. Saved rows turn green. If the job’s hours change later, the record stays green and the job’s new number appears in red beside it — tick whichever one is right.',
      },
      {
        screen: 'hours',
        group: 'hoursjobs',
        requires: hasJobs,
        setup: goHours,
        target: () => document.getElementById('iif-download-btn'),
        text: 'Download .iif writes the ticked rows as a QuickBooks import file. Untick anything you’re not ready to send.',
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
        // Launched from the editor's own ⋯ menu, the note in front of you IS
        // the subject — switching to a different one would be baffling.
        if (editorView.classList.contains('active') && currentType === 'note' && currentId) return true;
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
  // Reversing must respect the launch floor too — skipping backwards past it
  // would land on the very step a skip-home launch left out.
  const floor = tutorialPart === tutorialStartPart ? tutorialFloorIndex : 0;
  if (next >= floor && next < steps.length) { runTutorialStep(next); return; }
  if (tutorialDirection > 0 && !tutorialSolo && tutorialPart < TUTORIAL_PARTS) {
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

  // Navigate if needed. Awaited, so a setup may wait for an async render
  // (the hours grid parses before it draws) — a plain setup returning false
  // still skips exactly as before.
  if (step.setup) {
    const ok = await step.setup();
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
  // Counted from the step you STARTED on, so a skip-home launch reads
  // "1 of 5" rather than opening on "2 of 6" and looking like it lost one.
  if (tutorialProgress) {
    const floor = tutorialPart === tutorialStartPart ? tutorialFloorIndex : 0;
    tutorialProgress.textContent = `Part ${tutorialPart} \u00b7 ${index + 1 - floor} of ${stepCount - floor}`;
  }
  // Back is always visible, greyed when there's nothing before this step
  // (step 1 of the part the user launched).
  if (tutorialBack) {
    tutorialBack.hidden = false;
    tutorialBack.textContent = '\u2190';
    tutorialBack.disabled = (index <= tutorialFloorIndex && tutorialPart === tutorialStartPart);
  }
  // Last bubble of parts 1 and 2 chains into the next part \u2014 unless this is a
  // solo run, which ends on its own part.
  if (tutorialNext) {
    const last = index === stepCount - 1;
    tutorialNext.textContent = !last ? 'Got it \u2192'
      : ((!tutorialSolo && tutorialPart < TUTORIAL_PARTS) ? 'Next part \u2192' : 'Done \u2713');
    tutorialNext.disabled = false;
  }
  tutorialOverlay.hidden = false;
  showResumePill(false);
  // Live only while a step is on screen, so nothing is listening once the tour
  // is paused or finished. Attached AFTER the tap that got us here has fully
  // finished (setup + two frames), so it can't pause on its own arrival.
  attachTutorialTapWatch();
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
  detachTutorialTapWatch();
  if (tutorialOverlay) tutorialOverlay.hidden = true;
  showResumePill(false);
  tutorialPaused = false;
  tutorialStepIndex = 0;
  tutorialPart = 1;
  tutorialStartPart = 1;
  tutorialGroupShown = {};
  tutorialSolo = false;
  tutorialFloorIndex = 0;
}

// ---------- pausing the tour so people can actually try things ----------
//
// The overlay has always been `pointer-events: none`, so the app was never
// blocked during a tour — people tapped things and the tour simply didn't
// notice: the spotlight (an inline box-shadow) stayed painted on a screen they
// had left, the bubble hung over unrelated content, and Next then yanked them
// back to wherever the tour wanted them.
//
// So: touch anything outside the bubble and the tour steps aside, leaving one
// unobtrusive "Resume tutorial" pill. Resuming re-runs the current step, which
// already navigates and re-measures, so you land back exactly where you were.
function showResumePill(on) {
  if (tutorialResume) tutorialResume.hidden = !on;
}
function pauseTutorial() {
  if (tutorialPaused || !tutorialOverlay || tutorialOverlay.hidden) return;
  tutorialPaused = true;
  detachTutorialTapWatch();
  clearHighlights();
  tutorialOverlay.hidden = true;
  showResumePill(true);
}
function resumeTutorial() {
  if (!tutorialPaused) return;
  tutorialPaused = false;
  showResumePill(false);
  runTutorialStep(tutorialStepIndex);
}
if (tutorialResumeBtn) tutorialResumeBtn.addEventListener('click', resumeTutorial);
if (tutorialResumeClose) tutorialResumeClose.addEventListener('click', endTutorial);

// Judged on pointer-UP with a tap threshold, never on pointer-down: putting a
// finger on the screen to SCROLL would otherwise pause the tour on every
// swipe. Reading a long screen is part of following a step; only a deliberate
// tap counts as "doing something". Same reasoning (and the same constants) as
// the price table's outside-tap watcher.
let tutorialTapStart = null;
function tutorialTapDown(e) {
  tutorialTapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
}
function tutorialTapUp(e) {
  const s = tutorialTapStart;
  tutorialTapStart = null;
  if (!s || !tutorialOverlay || tutorialOverlay.hidden) return;
  if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_SLOP_PX) return;  // a drag
  if (Date.now() - s.t > TAP_MAX_MS) return;                              // a long press
  if (e.target.closest && e.target.closest('#tutorial-bubble')) return;   // tour's own controls
  pauseTutorial();
}
function attachTutorialTapWatch() {
  document.addEventListener('pointerdown', tutorialTapDown, true);
  document.addEventListener('pointerup', tutorialTapUp, true);
}
function detachTutorialTapWatch() {
  document.removeEventListener('pointerdown', tutorialTapDown, true);
  document.removeEventListener('pointerup', tutorialTapUp, true);
  tutorialTapStart = null;
}

// Start a tutorial part programmatically (getting-started cards, Settings → Help)
function startTutorial(part, opts = {}) {
  tutorialPart = part || 1;
  tutorialStartPart = tutorialPart;
  tutorialDirection = 1;
  tutorialGroupShown = {};
  // Solo either because the caller said so, or because the part isn't in the
  // linear chain at all.
  tutorialSolo = !!opts.solo || SOLO_PARTS.includes(tutorialPart);
  // Launched from inside the feature: drop the opening step that points at the
  // home card, since you're looking at the thing it points to. Found by SCREEN
  // rather than by a fixed index, so reordering steps can't silently break it.
  tutorialStepIndex = 0;
  if (opts.skipHome) {
    const steps = tutorialSteps(tutorialPart);
    const firstOnScreen = steps.findIndex(s => s.screen !== 'home');
    if (firstOnScreen > 0) tutorialStepIndex = firstOnScreen;
  }
  tutorialFloorIndex = tutorialStepIndex;
  clearAllSearches();
  runTutorialStep(tutorialStepIndex);
}

if (tutorialNext) tutorialNext.addEventListener('click', () => {
  clearHighlights();
  tutorialDirection = 1;
  const steps = tutorialSteps(tutorialPart);
  if (tutorialStepIndex + 1 >= steps.length) {
    if (!tutorialSolo && tutorialPart < TUTORIAL_PARTS) {
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
  if (tutorialStepIndex <= tutorialFloorIndex) {
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

// Any button carrying data-tutorial-part starts that part — Settings' Help
// list, and the "How this works" item in a feature's own ⋯ menu. The two
// optional attributes are what make an in-feature launch behave differently;
// the Settings buttons carry neither, so their behaviour is unchanged.
document.querySelectorAll('[data-tutorial-part]').forEach(btn => {
  btn.addEventListener('click', () => {
    closeAllMoreMenus();          // the tour is about to point at things behind it
    startTutorial(parseInt(btn.dataset.tutorialPart, 10) || 1, {
      solo: btn.hasAttribute('data-tutorial-solo'),
      skipHome: btn.hasAttribute('data-tutorial-skip-home'),
    });
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

// ---------- deploy check ----------
// Browsers throttle their own service-worker update checks, and a phone that
// resumes from background rather than launching fresh can sit on an old
// version for a long time. So ask GitHub directly what's deployed.
//
// It reads sw.js rather than a version.json: one less file to keep in step
// with the version bump, and it can't drift from what's actually live.
function parseSwVersion(text) {
  const m = /const\s+VERSION\s*=\s*'na-([^']+)'/.exec(String(text || ''));
  return m ? 'v' + m[1] : null;
}
let lastDeployCheck = 0;
async function checkDeployedVersion() {
  if (!navigator.onLine) return;
  if (Date.now() - lastDeployCheck < 30000) return;   // don't spam on every visit
  lastDeployCheck = Date.now();
  try {
    // The query string is REQUIRED: our own service worker answers same-origin
    // requests cache-first, so 'sw.js' would come back from the stale cache.
    // A URL it has never cached falls through to the network.
    const resp = await fetch('sw.js?ts=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) return;
    const deployed = parseSwVersion(await resp.text());
    if (!deployed || deployed === APP_VERSION) return;
    if (swReg) {
      await swReg.update().catch(() => {});
      // If the new worker is already parked, take it now; otherwise the
      // updatefound → controllerchange path picks it up and reloads.
      applyWaitingUpdate();
    }
  } catch (e) { /* offline or blocked — try again next time */ }
}
// iOS restores a suspended PWA without firing visibilitychange, so pageshow is
// the event that catches a phone coming back after days in the background.
window.addEventListener('pageshow', () => { checkDeployedVersion(); wakeSync(); });

// --- Reviving the data connection after the OS froze us -----------------
//
// checkDeployedVersion above asks "is there newer CODE?". This asks the other
// half of the question: "is there newer DATA?" — which nothing used to ask.
//
// Android Chrome discards backgrounded tabs and PWAs; iOS suspends them. Either
// way the Firestore websocket dies, the listeners stay attached to nothing, and
// the cache keeps serving the last thing it saw. The app looks perfectly
// healthy while showing stale data. Reported as: prices entered on a desktop
// didn't appear on an Android until the home ⟳ (a full reload) was pressed.
//
// Only after a real absence — a glance at a notification and back is not a
// freeze, and reconnecting on every tab switch would churn the connection for
// nothing. Storage.reconnect() throttles again on its own side, because a
// single wake-up can fire pageshow AND visibilitychange.
let lastHiddenAt = 0;
const WAKE_AFTER_MS = 30000;
function wakeSync() {
  if (!lastHiddenAt || Date.now() - lastHiddenAt < WAKE_AFTER_MS) return;
  lastHiddenAt = 0;
  Storage.reconnect();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') lastHiddenAt = Date.now();
  else wakeSync();
});
// A phone coming back from a dead zone has the same broken stream as one
// coming back from the background, and fires neither of the events above.
window.addEventListener('online', () => { Storage.reconnect(); });

// Manual refresh — replaces the browser's pull-to-refresh, which fired by
// accident on non-scrolling screens. Checks for a new app version first: if
// one is waiting, the SW takes over and reloads by itself, so we only force a
// reload when nothing turned up.
const refreshBtn = document.getElementById('refresh-btn');
if (refreshBtn) {
  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.classList.contains('spinning')) return;
    refreshBtn.classList.add('spinning');
    try { if (swReg) await swReg.update(); } catch (e) {}
    setTimeout(() => window.location.reload(), 400);
  });
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
