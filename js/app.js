// app.js — bootstraps auth, wires UI, and re-renders on Firestore cache updates.
import { Storage } from "./storage.js";
import { auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged } from "./firebase-init.js";

const APP_VERSION = 'v56';

// ---------- DOM refs ----------
const listView = document.getElementById('list-view');
const customersView = document.getElementById('customers-view');
const customerNotesView = document.getElementById('customer-notes-view');
const settingsView = document.getElementById('settings-view');
const aggregatorView = document.getElementById('aggregator-view');
const aggregatorList = document.getElementById('aggregator-list');
const aggregatorTitle = document.getElementById('aggregator-title');
const editorView = document.getElementById('editor-view');
const signinView = document.getElementById('signin-view');
const signinBtn = document.getElementById('signin-btn');
const signinError = document.getElementById('signin-error');
const signoutBtn = document.getElementById('signout-btn');
const accountEmailEl = document.getElementById('account-email');

const notesList = document.getElementById('notes-list');
const customersList = document.getElementById('customers-list');
const customerNotesList = document.getElementById('customer-notes-list');
const customerNotesTitle = document.getElementById('customer-notes-title');

const titleInput = document.getElementById('editor-title');
const bodyInput = document.getElementById('editor-body');

const fab = document.getElementById('fab');
const customersFab = document.getElementById('customers-fab');
const customerNotesFab = document.getElementById('customer-notes-fab');

const backBtn = document.getElementById('back-btn');
const customerNotesBackBtn = document.getElementById('customer-notes-back-btn');
const sortAlphaBtn = document.getElementById('sort-alpha');
const sortRecentBtn = document.getElementById('sort-recent');
const customerSearchInput = document.getElementById('customer-search');
const homeSearchInput = document.getElementById('home-search-input');
const settingsBtn = document.getElementById('settings-btn');
const recentCountInput = document.getElementById('setting-recent-count');
const aggregatorCountInput = document.getElementById('setting-aggregator-count');
const pinnedOrderListEl = document.getElementById('pinned-order-list');
const keywordInput = document.getElementById('keyword-input');
const keywordAddBtn = document.getElementById('keyword-add-btn');
const keywordListEl = document.getElementById('keyword-list');
const importCsvInput = document.getElementById('import-csv');
const importCsvBtn = document.getElementById('import-csv-btn');
const importHasHeader = document.getElementById('import-has-header');
const importStatus = document.getElementById('import-status');
const checkboxBtn = document.getElementById('checkbox-btn');
const customerLinkBtn = document.getElementById('customer-link-btn');
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
async function setRecentCount(n) { await Storage.setSetting('recentCount', n); }

function getAggregatorCount() {
  const n = parseInt(Storage.getSettings().aggregatorCount, 10);
  if (Number.isNaN(n) || n < 0) return 4;
  return Math.min(n, 50);
}
async function setAggregatorCount(n) { await Storage.setSetting('aggregatorCount', n); }

function getPinnedOrder() {
  const raw = Storage.getSettings().pinnedOrder;
  if (!Array.isArray(raw)) return DEFAULT_PINNED_ORDER.slice();
  const filtered = raw.filter(k => k in PINNED_SECTIONS);
  for (const k of DEFAULT_PINNED_ORDER) {
    if (!filtered.includes(k)) filtered.push(k);
  }
  return filtered;
}
async function setPinnedOrder(arr) { await Storage.setSetting('pinnedOrder', arr); }
async function movePinnedSection(key, direction) {
  const order = getPinnedOrder();
  const i = order.indexOf(key);
  if (i === -1) return;
  const j = i + direction;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  await setPinnedOrder(order);
}
function renderPinnedOrderList() {
  const order = getPinnedOrder();
  pinnedOrderListEl.innerHTML = order.map((key, idx) => {
    const label = PINNED_SECTIONS[key] || key;
    const upDis = idx === 0 ? 'disabled' : '';
    const downDis = idx === order.length - 1 ? 'disabled' : '';
    return `
      <li class="reorder-item" data-key="${key}">
        <span class="reorder-label">${escapeHtml(label)}</span>
        <button class="reorder-up" ${upDis} aria-label="Move up">↑</button>
        <button class="reorder-down" ${downDis} aria-label="Move down">↓</button>
      </li>
    `;
  }).join('');
  pinnedOrderListEl.querySelectorAll('.reorder-up').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.closest('.reorder-item').dataset.key;
      await movePinnedSection(key, -1);
      renderPinnedOrderList();
    });
  });
  pinnedOrderListEl.querySelectorAll('.reorder-down').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.closest('.reorder-item').dataset.key;
      await movePinnedSection(key, 1);
      renderPinnedOrderList();
    });
  });
}

function getCustomerSort() {
  const v = Storage.getSettings().customerSort;
  return v === 'recent' ? 'recent' : 'alpha';
}
async function setCustomerSort(v) {
  await Storage.setSetting('customerSort', v === 'recent' ? 'recent' : 'alpha');
}

let customerSearchTerm = '';
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
function hideAllScreens() {
  listView.classList.remove('active');
  customersView.classList.remove('active');
  customerNotesView.classList.remove('active');
  settingsView.classList.remove('active');
  aggregatorView.classList.remove('active');
  editorView.classList.remove('active');
  if (signinView) signinView.classList.remove('active');
  // Body class controls page-level scroll lock for editor screen
  document.body.classList.remove('editor-open');
}

function showAggregator(keyword) {
  activeKeyword = keyword;
  returnScreen = 'aggregator';
  hideAllScreens();
  aggregatorTitle.textContent = keyword;
  renderAggregatorList(keyword);
  aggregatorView.classList.add('active');
  history.pushState({ screen: 'aggregator', keyword }, '');
}

function renderAggregatorList(keyword) {
  const matches = Storage.aggregateParagraphsByKeyword(keyword);
  if (matches.length === 0) {
    aggregatorList.innerHTML = `<p class="empty-state">No paragraphs starting with “${escapeHtml(keyword)}” yet.</p>`;
    return;
  }
  aggregatorList.innerHTML = matches.map((m, idx) => {
    const def = Storage.getDefaultNoteForCustomer(m.customerId);
    const customerName = def ? (splitTitleAndBody(def.body).title || '').trim() : '';
    const tag = customerName ? escapeHtml(customerName) : 'Unnamed customer';
    return `
      <article class="note-card aggregator-match" data-note-id="${m.noteId}" data-match-idx="${idx}">
        <span class="customer-tag">${tag}</span>
        <p class="match-body">${escapeHtml(m.paragraph)}</p>
        <p class="note-date" style="margin-top:6px">${formatDateTime(m.updated)}</p>
      </article>
    `;
  }).join('');
  aggregatorList.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => {
      const note = Storage.getNote(card.dataset.noteId);
      if (!note) return;
      const match = matches[parseInt(card.dataset.matchIdx, 10)];
      returnScreen = 'aggregator';
      showEditor(note, 'note', match ? { paragraph: match.paragraph } : undefined);
    });
  });
}

function showSettings() {
  hideAllScreens();
  recentCountInput.value = getRecentCount();
  aggregatorCountInput.value = getAggregatorCount();
  renderPinnedOrderList();
  renderKeywordList();
  if (accountEmailEl && auth.currentUser) accountEmailEl.textContent = auth.currentUser.email || '';
  settingsView.classList.add('active');
  history.pushState({ screen: 'settings' }, '');
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
  if (swReg) swReg.update().catch(() => {});
}

const isDesktop = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function showCustomers() {
  returnScreen = 'customers';
  activeCustomerId = null;
  hideAllScreens();
  customersView.classList.add('active');
  renderCustomersList();
  if (isDesktop) setTimeout(() => customerSearchInput.focus(), 50);
  history.pushState({ screen: 'customers' }, '');
}

function showCustomerNotes(customerId, returnTo) {
  const customer = Storage.getCustomer(customerId);
  if (!customer) { showCustomers(); return; }
  const def = Storage.ensureDefaultNoteForCustomer(customerId);
  const { title } = splitTitleAndBody(def.body);
  activeCustomerId = customerId;
  returnScreen = 'customer-notes';
  customerNotesReturnTo = returnTo || { screen: 'customers' };
  customerNotesTitle.textContent = title.trim() ? title.trim() : 'Unnamed customer';
  if (customerNotesReturnTo.screen === 'aggregator' && customerNotesReturnTo.keyword) {
    customerNotesBackBtn.textContent = `Back to ${customerNotesReturnTo.keyword}`;
  } else {
    customerNotesBackBtn.textContent = 'Back to Customers';
  }
  hideAllScreens();
  customerNotesView.classList.add('active');
  renderCustomerNotesList(customerId);
  history.pushState({ screen: 'customer-notes', customerId, returnTo: customerNotesReturnTo }, '');
}

function showEditor(record, type, cursorHint) {
  currentId = record.id;
  currentType = type;
  currentIsDefault = !!record.isDefault;

  if (type === 'note') {
    const { title, body } = splitTitleAndBody(record.body);
    titleInput.placeholder = currentIsDefault ? 'Title (default note)' : 'Title';
    bodyInput.placeholder = 'Start typing…';
    titleInput.value = title;
    bodyInput.value = body;
  } else {
    titleInput.placeholder = 'Customer name';
    bodyInput.placeholder = 'Address';
    titleInput.value = record.name || '';
    bodyInput.value = record.address || '';
  }

  let backLabel = null;
  if (returnScreen === 'customer-notes' && (record.customerId || activeCustomerId)) {
    const cid = record.customerId || activeCustomerId;
    const def = Storage.getDefaultNoteForCustomer(cid);
    const name = def ? (splitTitleAndBody(def.body).title || '').trim() : '';
    backLabel = name || 'Customer notes';
  } else if (returnScreen === 'customers') {
    backLabel = 'Customers';
  } else if (returnScreen === 'aggregator' && activeKeyword) {
    backLabel = activeKeyword;
  }
  if (backLabel) {
    backBtn.textContent = `Back to ${backLabel}`;
    backBtn.style.display = '';
  } else {
    backBtn.style.display = 'none';
  }

  resetNoteSearch();
  const showNoteOnly = (type === 'note');
  noteSearchInput.style.display = showNoteOnly ? '' : 'none';
  noteSearchCount.style.display = showNoteOnly ? '' : 'none';
  searchPrevBtn.style.display = showNoteOnly ? '' : 'none';
  searchNextBtn.style.display = showNoteOnly ? '' : 'none';
  if (editorMoreBtn) editorMoreBtn.closest('.editor-more-wrap').style.display = showNoteOnly ? '' : 'none';
  closeMoreDropdown();

  const sameAsBack = returnScreen === 'customer-notes'
    && record.customerId && record.customerId === activeCustomerId;
  if (type === 'note' && record.customerId && !sameAsBack) {
    const def = Storage.getDefaultNoteForCustomer(record.customerId);
    const name = def ? splitTitleAndBody(def.body).title.trim() : '';
    customerLinkBtn.textContent = 'Go to: ' + ((name && name.length > 0) ? name : 'Customer');
    customerLinkBtn.dataset.customerId = record.customerId;
    customerLinkBtn.hidden = false;
  } else {
    customerLinkBtn.hidden = true;
    delete customerLinkBtn.dataset.customerId;
  }

  deleteBtn.style.display = (type === 'note' && currentIsDefault) ? 'none' : '';
  const assignBtnEl = document.getElementById('assign-btn');
  if (assignBtnEl) assignBtnEl.hidden = (Storage.getRole() !== 'admin' || type !== 'note');
  const assignCustomerBtnEl = document.getElementById('assign-customer-btn');
  if (assignCustomerBtnEl) assignCustomerBtnEl.hidden = !(type === 'note' && !record.customerId);

  hideAllScreens();
  editorView.classList.add('active');
  document.body.classList.add('editor-open');
  // Ensure page-level scroll is reset so the toolbar is at the top
  window.scrollTo(0, 0);
  history.pushState({ screen: 'editor' }, '');

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
  if (returnScreen === 'aggregator' && activeKeyword) showAggregator(activeKeyword);
  else if (returnScreen === 'customer-notes' && activeCustomerId) showCustomerNotes(activeCustomerId);
  else if (returnScreen === 'customers') showCustomers();
  else showNotes();
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
      }
    });
  });
}

// ---------- list rendering ----------
function renderNotesList() {
  if (homeSearchTerm.trim()) { renderHomeSearchResults(homeSearchTerm); return; }
  if (!Storage.isReady()) {
    notesList.innerHTML = '<p class="empty-state" style="font-style:normal">Loading your data…</p>';
    return;
  }
  const notes = Storage.listNotes();
  const customersCount = Storage.listCustomers().length;

  const customersCard = `
    <article class="note-card nav-card" data-nav="customers">
      <div class="note-head">
        <p class="note-title">Customers</p>
        <span class="note-chevron">›</span>
      </div>
      <p class="note-preview">${customersCount} ${customersCount === 1 ? 'customer' : 'customers'}</p>
    </article>
  `;

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
      const def = Storage.getDefaultNoteForCustomer(m.customerId);
      const customerName = def ? (splitTitleAndBody(def.body).title || '').trim() : '';
      const customer = customerName || 'Unnamed customer';
      const note = Storage.getNote(m.noteId);
      const noteTitle = note ? (splitTitleAndBody(note.body).title || '').trim() : '';
      const list = stripKeywordToList(m.paragraph, kw);
      const notePart = noteTitle ? ` - ${escapeHtml(noteTitle)}` : '';
      previewHtml = `<span class="match-customer">${escapeHtml(customer)}</span>${notePart} - ${escapeHtml(list || '(empty)')}`;
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
    return `
      <article class="note-card home-pinned" data-id="${n.id}" data-kind="note">
        <span class="customer-tag">${tag}</span>
        <div class="note-head">
          <p class="note-title">${safeTitle}</p>
          <span class="note-date">${formatDateTime(n.updated)}</span>
        </div>
        ${safePreview ? `<p class="note-preview">${safePreview}</p>` : ''}
      </article>
    `;
  }).join('');

  let notesHtml = '';
  if (notes.length === 0) {
    notesHtml = '<p class="empty-state">No notes yet. Tap <strong>+</strong> to add one.</p>';
  } else {
    notesHtml = notes.map(n => renderNoteCard(n)).join('');
  }

  const sectionLabel = (text) => `<p class="section-label">${text}</p>`;
  const pinnedBlock = getPinnedOrder().map(key => {
    if (key === 'aggregator') return sectionLabel('Aggregators:') + keywordHtml;
    if (key === 'recent') return sectionLabel('Recent Notes:') + recentHtml;
    if (key === 'notes') return sectionLabel('General Notes:') + notesHtml;
    return '';
  }).join('');
  notesList.innerHTML = customersCard + pinnedBlock;

  notesList.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.dataset.nav === 'customers') {
        const chevron = card.querySelector('.note-chevron');
        if (chevron) chevron.innerHTML = '<span class="nav-spinner"></span>';
        setTimeout(showCustomers, 0);
      }
      else if (card.dataset.keyword) showAggregator(card.dataset.keyword);
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
  return `
    <article class="note-card ${pinned}" data-id="${n.id}" data-kind="note">
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
  const notes = Storage.listNotesByCustomer(customerId);
  customerNotesList.innerHTML = notes.map(renderNoteCard).join('');
  customerNotesList.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => {
      const note = Storage.getNote(card.dataset.id);
      if (note) showEditor(note, 'note');
    });
  });
}

// ---------- editor save / back / delete ----------
function scheduleSave() {
  if (!currentId) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(commitSave, 400);
}
function commitSave() {
  if (!currentId) return;
  if (currentType === 'note') {
    Storage.updateNote(currentId, composeBody(titleInput.value, bodyInput.value));
  } else if (currentType === 'customer') {
    Storage.updateCustomer(currentId, {
      name: titleInput.value, address: bodyInput.value,
    });
  }
}

fab.addEventListener('click', () => {
  const note = Storage.createNote();
  returnScreen = 'notes';
  showEditor(note, 'note');
});
customersFab.addEventListener('click', () => {
  const { customer, defaultNote } = Storage.createCustomer();
  activeCustomerId = customer.id;
  returnScreen = 'customer-notes';
  showEditor(defaultNote, 'note');
});
customerNotesFab.addEventListener('click', () => {
  if (!activeCustomerId) return;
  const note = Storage.createNote({ customerId: activeCustomerId });
  returnScreen = 'customer-notes';
  showEditor(note, 'note');
});

customerNotesBackBtn.addEventListener('click', () => {
  const ret = customerNotesReturnTo;
  if (ret && ret.screen === 'aggregator' && ret.keyword) showAggregator(ret.keyword);
  else showCustomers();
});
settingsBtn.addEventListener('click', showSettings);

function goHome() {
  activeCustomerId = null;
  activeKeyword = null;
  homeSearchTerm = '';
  if (homeSearchInput) homeSearchInput.value = '';
  showNotes();
}
document.querySelectorAll('.home-btn').forEach(btn => {
  btn.addEventListener('click', goHome);
});
const editorHomeBtnEl = document.getElementById('editor-home-btn');
if (editorHomeBtnEl) editorHomeBtnEl.addEventListener('click', () => { commitAndCleanupEditor(); goHome(); });

recentCountInput.addEventListener('input', () => {
  let n = parseInt(recentCountInput.value, 10);
  if (Number.isNaN(n)) return;
  if (n < 0) n = 0;
  if (n > 20) n = 20;
  setRecentCount(n);
});
recentCountInput.addEventListener('blur', () => { recentCountInput.value = getRecentCount(); });

document.getElementById('recent-count-down').addEventListener('click', () => {
  const n = Math.max(0, getRecentCount() - 1);
  setRecentCount(n); recentCountInput.value = n;
});
document.getElementById('recent-count-up').addEventListener('click', () => {
  const n = Math.min(20, getRecentCount() + 1);
  setRecentCount(n); recentCountInput.value = n;
});

aggregatorCountInput.addEventListener('input', () => {
  let n = parseInt(aggregatorCountInput.value, 10);
  if (Number.isNaN(n)) return;
  if (n < 0) n = 0;
  if (n > 50) n = 50;
  setAggregatorCount(n);
});
aggregatorCountInput.addEventListener('blur', () => { aggregatorCountInput.value = getAggregatorCount(); });

document.getElementById('aggregator-count-down').addEventListener('click', () => {
  const n = Math.max(0, getAggregatorCount() - 1);
  setAggregatorCount(n); aggregatorCountInput.value = n;
});
document.getElementById('aggregator-count-up').addEventListener('click', () => {
  const n = Math.min(50, getAggregatorCount() + 1);
  setAggregatorCount(n); aggregatorCountInput.value = n;
});

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
  if (!currentId) return;
  toggleCheckboxOnSelection();
});

function formatDateForInsert(d) {
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
function insertDateAtCursor(dateStr) {
  if (!currentId) return;
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
if (editorMoreDropdown) editorMoreDropdown.addEventListener('click', () => {
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
}
function gotoMatch(index) {
  if (searchMatches.length === 0) { updateSearchCount(); renderHighlights(); return; }
  const n = searchMatches.length;
  searchIndex = ((index % n) + n) % n;
  const m = searchMatches[searchIndex];
  if (m.inTitle) {
    titleInput.focus();
    titleInput.setSelectionRange(m.start, m.end);
  } else {
    bodyInput.setSelectionRange(m.start, m.end);
    const before = bodyInput.value.substring(0, m.start);
    const lineHeight = parseFloat(getComputedStyle(bodyInput).lineHeight) || 22;
    const lineCount = (before.match(/\n/g) || []).length;
    const target = lineCount * lineHeight - bodyInput.clientHeight / 2 + lineHeight;
    bodyInput.scrollTop = Math.max(0, target);
  }
  updateSearchCount();
  renderHighlights();
}
function resetNoteSearch() {
  noteSearchInput.value = '';
  searchMatches = [];
  searchIndex = 0;
  updateSearchCount();
  renderHighlights();
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
searchPrevBtn.addEventListener('click', () => { gotoMatch(searchIndex - 1); noteSearchInput.focus(); });
searchNextBtn.addEventListener('click', () => { gotoMatch(searchIndex + 1); noteSearchInput.focus(); });
bodyInput.addEventListener('input', () => {
  if (noteSearchInput.value) {
    findMatches(noteSearchInput.value);
    if (searchIndex >= searchMatches.length) searchIndex = Math.max(0, searchMatches.length - 1);
    updateSearchCount();
  }
});

customerLinkBtn.addEventListener('click', () => {
  const cid = customerLinkBtn.dataset.customerId;
  if (!cid) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  commitSave();
  let returnTo = { screen: 'customers' };
  if (returnScreen === 'aggregator' && activeKeyword) {
    returnTo = { screen: 'aggregator', keyword: activeKeyword };
  }
  currentId = null;
  currentType = null;
  currentIsDefault = false;
  showCustomerNotes(cid, returnTo);
});

bodyInput.addEventListener('click', () => {
  const value = bodyInput.value;
  const pos = bodyInput.selectionStart;
  if (pos == null) return;
  const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
  const col = pos - lineStart;
  if (col > 2) return;
  const head = value.substring(lineStart, lineStart + 2);
  let replacement = null;
  if (head === '☐ ') replacement = '☑ ';
  else if (head === '☑ ') replacement = '☐ ';
  if (!replacement) return;
  bodyInput.value = value.substring(0, lineStart) + replacement + value.substring(lineStart + 2);
  bodyInput.selectionStart = bodyInput.selectionEnd = pos;
  scheduleSave();
});

function toggleCheckboxOnSelection() {
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
  return cancelledCustomer;
}

backBtn.addEventListener('click', () => {
  const cancelledCustomer = commitAndCleanupEditor();
  if (cancelledCustomer) {
    activeCustomerId = null;
    showCustomers();
    return;
  }
  returnFromEditor();
});

// Android/browser back button support
window.addEventListener('popstate', (e) => {
  const screen = e.state && e.state.screen;
  if (!screen) {
    // No state — let browser handle it (exits app)
    return;
  }
  if (screen === 'home') {
    showNotes();
    return;
  }
  if (editorView.classList.contains('active')) {
    const cancelledCustomer = commitAndCleanupEditor();
    if (cancelledCustomer) {
      activeCustomerId = null;
      showCustomers();
    } else {
      returnFromEditor();
    }
    return;
  }
  if (screen === 'editor') {
    returnFromEditor();
    return;
  }
  if (screen === 'settings' || screen === 'aggregator' || screen === 'customers' || screen === 'customer-notes') {
    showNotes();
    return;
  }
  showNotes();
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
  const members = Storage.listMembers().filter(m => m.role !== 'admin');

  if (members.length === 0) {
    assignMembersList.innerHTML = '<li style="font-size:14px;color:var(--ink-soft)">No non-admin members yet.</li>';
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
  if (customers.length === 0) {
    assignCustomerList.innerHTML = '<li style="padding:10px;font-size:14px;color:var(--ink-soft)">No customers found.</li>';
    return;
  }
  assignCustomerList.innerHTML = customers.map(c => {
    const def = Storage.getDefaultNoteForCustomer(c.id);
    const name = def ? (splitTitleAndBody(def.body).title || '').trim() : '';
    const display = name || 'Unnamed customer';
    return `<li class="assign-customer-item" data-id="${c.id}" style="padding:12px 16px;cursor:pointer;font-size:15px;border-bottom:1px solid var(--line);">${escapeHtml(display)}</li>`;
  }).join('');
  assignCustomerList.querySelectorAll('.assign-customer-item').forEach(item => {
    item.addEventListener('click', () => {
      if (!currentId) return;
      commitSave();
      Storage.assignNoteToCustomer(currentId, item.dataset.id);
      assignCustomerModal.hidden = true;
      currentId = null; currentType = null; currentIsDefault = false;
      activeCustomerId = item.dataset.id;
      returnScreen = 'customer-notes';
      showCustomerNotes(item.dataset.id);
    });
  });
}

if (assignCustomerBtn) assignCustomerBtn.addEventListener('click', () => {
  if (!assignCustomerModal) return;
  if (assignCustomerSearch) assignCustomerSearch.value = '';
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
  signinView.classList.add('active');
}

if (signinBtn) {
  signinBtn.addEventListener('click', async () => {
    signinError.textContent = '';
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error(err);
      signinError.textContent = err && err.message ? err.message : 'Sign-in failed.';
    }
  });
}
if (signoutBtn) {
  signoutBtn.addEventListener('click', async () => { await signOut(auth); });
}

// ---------- role-based UI ----------
function applyRoleUI(role) {
  const isCustomer = role === 'customer';
  // Hide write controls for customers
  const writeControls = [
    document.getElementById('customers-fab'),
    document.getElementById('customer-notes-fab'),
    document.getElementById('delete-btn'),
    document.getElementById('list-fab'),
  ];
  writeControls.forEach(el => { if (el) el.style.display = isCustomer ? 'none' : ''; });
}

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
      if (inviteEmailInput) inviteEmailInput.value = '';
      if (inviteStatus) inviteStatus.textContent = `Invited ${email}.`;
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
  if (editorView.classList.contains('active')) return;
  if (listView.classList.contains('active')) renderNotesList();
  else if (customersView.classList.contains('active')) renderCustomersList();
  else if (customerNotesView.classList.contains('active') && activeCustomerId) {
    showCustomerNotes(activeCustomerId, customerNotesReturnTo);
  } else if (aggregatorView.classList.contains('active') && activeKeyword) {
    renderAggregatorList(activeKeyword);
  } else if (settingsView.classList.contains('active')) {
    recentCountInput.value = getRecentCount();
    aggregatorCountInput.value = getAggregatorCount();
    renderPinnedOrderList();
    renderKeywordList();
    renderMembersList();
  }
}

let unsubStorage = null;
onAuthStateChanged(auth, async (user) => {
  if (unsubStorage) { unsubStorage(); unsubStorage = null; }
  if (!user) {
    Storage.signedOut();
    showSignin();
    return;
  }
  // Signed in — resolve org (creates or joins), then migrate if needed
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
  // Hide write controls for customer role
  applyRoleUI(Storage.getRole());
  showNotes();
});

window.addEventListener('beforeunload', () => {
  if (currentId) commitSave();
});

// Display app version in the home toolbar
const appVersionEl = document.getElementById('app-version');
if (appVersionEl) appVersionEl.textContent = APP_VERSION;

// ---------- tutorial ----------
const tutorialOverlay = document.getElementById('tutorial-overlay');
const tutorialBubble = document.getElementById('tutorial-bubble');
const tutorialText = document.getElementById('tutorial-text');
const tutorialNext = document.getElementById('tutorial-next');
const tutorialClose = document.getElementById('tutorial-close');
const tutorialBtn = document.getElementById('tutorial-btn');

let tutorialStepIndex = 0;

function tutorialSteps() {
  return [
    {
      screen: 'home',
      target: () => document.querySelector('#notes-list .note-card[data-nav="customers"]'),
      text: 'Click here to view and add customers.',
    },
    {
      screen: 'home',
      target: () => document.getElementById('settings-btn'),
      text: 'You can change settings, import contacts, and do other cool things here.',
    },
    {
      screen: 'customers',
      setup: () => showCustomers(),
      target: () => document.querySelector('#customers-list .note-card'),
      text: 'You can search or scroll to select a customer.',
    },
    {
      screen: 'customers',
      target: () => document.getElementById('customers-fab'),
      text: 'You can add new customers by clicking here.',
    },
    {
      screen: 'customer-notes',
      setup: () => {
        const customers = Storage.listCustomers();
        if (!customers.length) return false;
        const c = customers[0];
        showCustomerNotes(c.id);
        return true;
      },
      target: () => document.querySelector('#customer-notes-list .note-card'),
      text: 'Each customer has a default note. The title should be the customer\'s name.',
    },
    {
      screen: 'customer-notes',
      target: () => document.getElementById('customer-notes-fab'),
      text: 'You can add new notes by tapping the + right here.',
    },
  ];
}

function positionBubble(targetEl) {
  if (!targetEl || !tutorialBubble) return;
  const r = targetEl.getBoundingClientRect();
  const bw = tutorialBubble.offsetWidth || 260;
  const bh = tutorialBubble.offsetHeight || 120;
  const margin = 12;
  const arrowSize = 18;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceBelow = vh - r.bottom - margin;
  const spaceAbove = r.top - margin;
  const spaceRight = vw - r.right - margin;

  let placement;
  if (spaceBelow >= bh + arrowSize) placement = 'below';
  else if (spaceAbove >= bh + arrowSize) placement = 'above';
  else if (spaceRight >= bw + arrowSize) placement = 'right';
  else placement = 'left';

  let top, left;
  const targetCX = r.left + r.width / 2;
  const targetCY = r.top + r.height / 2;

  if (placement === 'below') {
    top = r.bottom + arrowSize;
    left = Math.max(8, Math.min(targetCX - bw / 2, vw - bw - 8));
    const arrowH = Math.max(8, Math.min(targetCX - left - 8, bw - 24));
    tutorialBubble.className = 'tutorial-bubble arrow-up';
    tutorialBubble.style.setProperty('--arrow-h', arrowH + 'px');
  } else if (placement === 'above') {
    top = r.top - bh - arrowSize;
    left = Math.max(8, Math.min(targetCX - bw / 2, vw - bw - 8));
    const arrowH = Math.max(8, Math.min(targetCX - left - 8, bw - 24));
    tutorialBubble.className = 'tutorial-bubble arrow-down';
    tutorialBubble.style.setProperty('--arrow-h', arrowH + 'px');
  } else if (placement === 'right') {
    left = r.right + arrowSize;
    top = Math.max(8, Math.min(targetCY - bh / 2, vh - bh - 8));
    const arrowV = Math.max(8, Math.min(targetCY - top - 8, bh - 24));
    tutorialBubble.className = 'tutorial-bubble arrow-left';
    tutorialBubble.style.setProperty('--arrow-v', arrowV + 'px');
  } else {
    left = r.left - bw - arrowSize;
    top = Math.max(8, Math.min(targetCY - bh / 2, vh - bh - 8));
    const arrowV = Math.max(8, Math.min(targetCY - top - 8, bh - 24));
    tutorialBubble.className = 'tutorial-bubble arrow-right';
    tutorialBubble.style.setProperty('--arrow-v', arrowV + 'px');
  }

  tutorialBubble.style.top = Math.max(8, top) + 'px';
  tutorialBubble.style.left = Math.max(8, left) + 'px';
}

async function runTutorialStep(index) {
  const steps = tutorialSteps();
  if (index >= steps.length) { endTutorial(); return; }
  const step = steps[index];

  // Navigate if needed
  if (step.setup) {
    const ok = step.setup();
    if (ok === false) { endTutorial(); return; }
  } else if (step.screen === 'home') {
    goHome();
  }

  // Scroll to top so targets are visible
  window.scrollTo(0, 0);

  // Wait for render
  await new Promise(r => setTimeout(r, 120));

  const target = step.target();
  if (!target) { endTutorial(); return; }

  // Scroll target into view if needed
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  await new Promise(r => setTimeout(r, 80));

  tutorialText.textContent = step.text;
  tutorialOverlay.hidden = false;
  // Render bubble off-screen first to measure height
  tutorialBubble.style.top = '-9999px';
  tutorialBubble.style.left = '-9999px';
  await new Promise(r => setTimeout(r, 30));
  positionBubble(target);

  // Highlight target
  target.style.outline = '3px solid var(--accent, #2563eb)';
  target.style.outlineOffset = '3px';
  target.dataset.tutorialHighlight = '1';
}

function clearHighlights() {
  document.querySelectorAll('[data-tutorial-highlight]').forEach(el => {
    el.style.outline = '';
    el.style.outlineOffset = '';
    delete el.dataset.tutorialHighlight;
  });
}

function endTutorial() {
  clearHighlights();
  if (tutorialOverlay) tutorialOverlay.hidden = true;
  tutorialStepIndex = 0;
}

if (tutorialNext) tutorialNext.addEventListener('click', () => {
  clearHighlights();
  tutorialStepIndex++;
  runTutorialStep(tutorialStepIndex);
});

if (tutorialClose) tutorialClose.addEventListener('click', endTutorial);

if (tutorialBtn) tutorialBtn.addEventListener('click', () => {
  tutorialStepIndex = 0;
  runTutorialStep(0);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    swReg = reg;
    reg.update().catch(() => {});
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      // Show "newer version detected" immediately while the new SW installs
      if (appVersionEl) appVersionEl.textContent = APP_VERSION + ' — newer version detected';
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          // Don't interrupt active edits
          if (editorView.classList.contains('active')) return;
          window.location.reload();
        }
      });
    });
  }).catch(() => {});
}
