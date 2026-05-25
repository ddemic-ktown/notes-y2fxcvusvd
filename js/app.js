// app.js — bootstraps auth, wires UI, and re-renders on Firestore cache updates.
import { Storage } from "./storage.js";
import { auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged } from "./firebase-init.js";

const APP_VERSION = 'v13';

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
const datePopover = document.getElementById('date-picker-popover');
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

// ---------- editor state ----------
let currentId = null;
let currentType = null;
let currentIsDefault = false;
let returnScreen = 'notes';
let activeCustomerId = null;
let activeKeyword = null;
let customerNotesReturnTo = { screen: 'customers' };
let saveTimer = null;
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
}

function showAggregator(keyword) {
  activeKeyword = keyword;
  returnScreen = 'aggregator';
  hideAllScreens();
  aggregatorTitle.textContent = keyword;
  renderAggregatorList(keyword);
  aggregatorView.classList.add('active');
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
}

function showNotes() {
  returnScreen = 'notes';
  activeCustomerId = null;
  hideAllScreens();
  listView.classList.add('active');
  renderNotesList();
}

const isDesktop = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function showCustomers() {
  returnScreen = 'customers';
  activeCustomerId = null;
  hideAllScreens();
  customersView.classList.add('active');
  renderCustomersList();
  if (isDesktop) setTimeout(() => customerSearchInput.focus(), 50);
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
    customerNotesBackBtn.textContent = `← ${customerNotesReturnTo.keyword}`;
  } else {
    customerNotesBackBtn.textContent = '← Customers';
  }
  hideAllScreens();
  customerNotesView.classList.add('active');
  renderCustomerNotesList(customerId);
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
    backBtn.textContent = `← ${backLabel}`;
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
  dateTodayBtn.style.display = showNoteOnly ? '' : 'none';
  datePickerBtn.style.display = showNoteOnly ? '' : 'none';
  closeDatePopover();

  const sameAsBack = returnScreen === 'customer-notes'
    && record.customerId && record.customerId === activeCustomerId;
  if (type === 'note' && record.customerId && !sameAsBack) {
    const def = Storage.getDefaultNoteForCustomer(record.customerId);
    const name = def ? splitTitleAndBody(def.body).title.trim() : '';
    customerLinkBtn.textContent = name || 'Customer';
    customerLinkBtn.dataset.customerId = record.customerId;
    customerLinkBtn.hidden = false;
  } else {
    customerLinkBtn.hidden = true;
    delete customerLinkBtn.dataset.customerId;
  }

  deleteBtn.style.display = (type === 'note' && currentIsDefault) ? 'none' : '';

  hideAllScreens();
  editorView.classList.add('active');

  setTimeout(() => {
    // If a cursor hint was passed (e.g. came from an aggregator match), jump
    // to the matching paragraph inside the body textarea.
    if (cursorHint && cursorHint.paragraph && type === 'note') {
      const bodyVal = bodyInput.value;
      const lines = cursorHint.paragraph.split('\n');
      // Try progressively shorter suffixes — if the paragraph straddles the
      // title (line 1) and body, dropping leading lines lets us find the body part.
      for (let start = 0; start < lines.length; start++) {
        const candidate = lines.slice(start).join('\n');
        if (!candidate) continue;
        const idx = bodyVal.indexOf(candidate);
        if (idx !== -1) {
          bodyInput.focus();
          bodyInput.setSelectionRange(idx, idx);
          const before = bodyVal.substring(0, idx);
          const lineHeight = parseFloat(getComputedStyle(bodyInput).lineHeight) || 22;
          const lineCount = (before.match(/\n/g) || []).length;
          const target = lineCount * lineHeight - bodyInput.clientHeight / 2 + lineHeight;
          bodyInput.scrollTop = Math.max(0, target);
          return;
        }
      }
      // Fallback: paragraph was entirely on the title line — focus that.
      titleInput.focus();
      return;
    }
    const titleEmpty = !titleInput.value;
    const bodyEmpty = !bodyInput.value;
    if (titleEmpty && bodyEmpty) titleInput.focus();
    else {
      bodyInput.focus();
      const end = bodyInput.value.length;
      bodyInput.setSelectionRange(end, end);
    }
  }, 50);
}

function returnFromEditor() {
  if (returnScreen === 'aggregator' && activeKeyword) showAggregator(activeKeyword);
  else if (returnScreen === 'customer-notes' && activeCustomerId) showCustomerNotes(activeCustomerId);
  else if (returnScreen === 'customers') showCustomers();
  else showNotes();
}

// ---------- list rendering ----------
function renderNotesList() {
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
      const list = stripKeywordToList(m.paragraph, kw);
      previewHtml = `<span class="match-customer">${escapeHtml(customer)}</span> - ${escapeHtml(list || '(empty)')}`;
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

  const pinnedBlock = getPinnedOrder().map(key => {
    if (key === 'aggregator') return keywordHtml;
    if (key === 'recent') return recentHtml;
    if (key === 'notes') return notesHtml;
    return '';
  }).join('');
  notesList.innerHTML = customersCard + pinnedBlock;

  notesList.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.dataset.nav === 'customers') showCustomers();
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
  return haystack.includes(term);
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
  showNotes();
}
document.querySelectorAll('.home-btn').forEach(btn => {
  if (btn.id === 'editor-home-btn') {
    btn.addEventListener('click', () => { commitAndCleanupEditor(); goHome(); });
  } else {
    btn.addEventListener('click', goHome);
  }
});

recentCountInput.addEventListener('input', () => {
  let n = parseInt(recentCountInput.value, 10);
  if (Number.isNaN(n)) return;
  if (n < 0) n = 0;
  if (n > 20) n = 20;
  setRecentCount(n);
});
recentCountInput.addEventListener('blur', () => { recentCountInput.value = getRecentCount(); });

aggregatorCountInput.addEventListener('input', () => {
  let n = parseInt(aggregatorCountInput.value, 10);
  if (Number.isNaN(n)) return;
  if (n < 0) n = 0;
  if (n > 50) n = 50;
  setAggregatorCount(n);
});
aggregatorCountInput.addEventListener('blur', () => { aggregatorCountInput.value = getAggregatorCount(); });

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
function openDatePopover() {
  const rect = datePickerBtn.getBoundingClientRect();
  datePopover.style.top = `${rect.bottom + 4}px`;
  datePopover.style.right = `${window.innerWidth - rect.right}px`;
  datePopover.style.left = 'auto';
  datePickerInput.value = '';
  datePopover.hidden = false;
  setTimeout(() => {
    datePickerInput.focus();
    if (typeof datePickerInput.showPicker === 'function') {
      try { datePickerInput.showPicker(); } catch (e) {}
    }
  }, 30);
}
function closeDatePopover() { datePopover.hidden = true; }

dateTodayBtn.addEventListener('click', () => {
  insertDateAtCursor(formatDateForInsert(new Date()));
});
datePickerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (datePopover.hidden) openDatePopover();
  else closeDatePopover();
});
datePickerInput.addEventListener('change', () => {
  if (!datePickerInput.value) return;
  const [y, m, d] = datePickerInput.value.split('-').map(Number);
  insertDateAtCursor(formatDateForInsert(new Date(y, m - 1, d)));
  closeDatePopover();
});
document.addEventListener('click', (e) => {
  if (datePopover.hidden) return;
  if (datePopover.contains(e.target)) return;
  if (e.target === datePickerBtn) return;
  closeDatePopover();
});

function findMatches(term) {
  searchMatches = [];
  if (!term) return;
  const body = bodyInput.value;
  const termLower = term.toLowerCase();
  const bodyLower = body.toLowerCase();
  let i = 0;
  while ((i = bodyLower.indexOf(termLower, i)) !== -1) {
    searchMatches.push({ start: i, end: i + term.length });
    i += Math.max(term.length, 1);
  }
}
function updateSearchCount() {
  if (!noteSearchInput.value) noteSearchCount.textContent = '';
  else if (searchMatches.length === 0) noteSearchCount.textContent = '0';
  else noteSearchCount.textContent = `${searchIndex + 1}/${searchMatches.length}`;
}
function gotoMatch(index) {
  if (searchMatches.length === 0) { updateSearchCount(); return; }
  const n = searchMatches.length;
  searchIndex = ((index % n) + n) % n;
  const m = searchMatches[searchIndex];
  bodyInput.setSelectionRange(m.start, m.end);
  const before = bodyInput.value.substring(0, m.start);
  const lineHeight = parseFloat(getComputedStyle(bodyInput).lineHeight) || 22;
  const lineCount = (before.match(/\n/g) || []).length;
  const target = lineCount * lineHeight - bodyInput.clientHeight / 2 + lineHeight;
  bodyInput.scrollTop = Math.max(0, target);
  updateSearchCount();
}
function resetNoteSearch() {
  noteSearchInput.value = '';
  searchMatches = [];
  searchIndex = 0;
  updateSearchCount();
}
noteSearchInput.addEventListener('input', () => {
  findMatches(noteSearchInput.value);
  if (searchMatches.length > 0) gotoMatch(0);
  else updateSearchCount();
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
  // Signed in
  await Storage.init(user.uid);
  // Wait for initial snapshots before migrating, so we know the Firestore is empty
  await new Promise((resolve) => {
    const un = Storage.onChange(() => {
      if (Storage.isReady()) { un(); resolve(); }
    });
  });
  await Storage.maybeMigrateFromLocalStorage();
  unsubStorage = Storage.onChange(rerenderCurrent);
  showNotes();
});

window.addEventListener('beforeunload', () => {
  if (currentId) commitSave();
});

// Display app version in the home toolbar
const appVersionEl = document.getElementById('app-version');
if (appVersionEl) appVersionEl.textContent = APP_VERSION;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // Check for updates on every load
    reg.update().catch(() => {});
    // When a new SW is found, auto-reload once it's installed so the user
    // gets the latest UI without manual cache clearing.
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
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
