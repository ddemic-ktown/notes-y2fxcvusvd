// storage.js — Firestore-backed store with in-memory cache.
// Multi-user org structure: all data lives under orgs/{orgId}/
import { db } from "./firebase-init.js";
import {
  collection, doc, onSnapshot, setDoc, deleteDoc, getDocs,
  writeBatch, getDoc, query, where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const DEFAULT_SETTINGS = {
  recentCount: 4,
  aggregatorCount: 4,
  pinnedOrder: ["aggregator", "recent", "notes"],
  keywords: [],
  customerSort: "alpha",
};

const _cache = {
  notes: [], customers: [], settings: { ...DEFAULT_SETTINGS },
  members: [], invites: [],
  // Price table: one small config doc (vendor columns + share list) and one
  // doc per ITEM (row). Split by row so a price edit rewrites only that row,
  // two people on different rows can't clobber each other, and the 1 MiB
  // per-document limit is unreachable.
  priceConfig: { vendors: [], sharedWith: [] },
  priceItems: [],
};
const _listeners = new Set();
let _onRoleChange = null;
let _uid = null;
let _orgId = null;
let _role = null; // 'admin' | 'employee' | 'customer'
let _unsubs = [];
let _ready = false;
let _customersReady = false;
let _notesError = null;

function emit() { for (const cb of _listeners) cb(); }
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function nowIso() { return new Date().toISOString(); }

// ---------- Firestore path helpers ----------
function notesCol()     { return collection(db, `orgs/${_orgId}/notes`); }
function customersCol() { return collection(db, `orgs/${_orgId}/customers`); }
function settingsDoc()  { return doc(db, `orgs/${_orgId}/settings/preferences`); }
function membersCol()   { return collection(db, `orgs/${_orgId}/members`); }
function invitesCol()   { return collection(db, `orgs/${_orgId}/invites`); }
function orgDoc()       { return doc(db, `orgs/${_orgId}`); }
function priceConfigDoc(){ return doc(db, `orgs/${_orgId}/priceMeta/config`); }
function priceItemsCol() { return collection(db, `orgs/${_orgId}/priceItems`); }

// ---------- listeners ----------
function attachListeners() {
  detachListeners();
  // Admins can listen to the full notes collection. Employee/customer roles must
  // scope the query itself (assignedTo array-contains uid) to match firestore.rules —
  // Firestore rejects an unscoped collection listener when the rule depends on a
  // per-document field like assignedTo, rather than silently filtering results.
  const notesQuery = (_role === 'admin' || _role === 'bookkeeper')
    ? notesCol()
    : query(notesCol(), where('assignedTo', 'array-contains', _uid));
  _unsubs.push(onSnapshot(notesQuery, (snap) => {
    _cache.notes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _notesError = null;
    _ready = true;
    emit();
  }, (err) => {
    console.warn('notes listener error', err);
    _cache.notes = [];
    _notesError = (err && (err.message || err.code)) ? `${err.code || 'error'}: ${err.message || err}` : String(err);
    _ready = true;
    emit();
  }));
  // Only admins and bookkeepers may read customer records (firestore.rules) — skip otherwise.
  if (_role !== 'admin' && _role !== 'bookkeeper') {
    _customersReady = true;
  } else {
    _unsubs.push(onSnapshot(customersCol(), (snap) => {
      _cache.customers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _customersReady = true;
      emit();
    }));
  }
  _unsubs.push(onSnapshot(settingsDoc(), (snap) => {
    _cache.settings = snap.exists() ? { ...DEFAULT_SETTINGS, ...snap.data() } : { ...DEFAULT_SETTINGS };
    emit();
  }));
  _unsubs.push(onSnapshot(membersCol(), (snap) => {
    _cache.members = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    // An admin can change our role (or remove us) while the app is open.
    // Firestore rules apply the new role instantly, so the UI and the data
    // listeners must follow — otherwise the screen shows powers the server
    // now rejects. Re-attach listeners (the notes query differs per role)
    // and tell the app to re-apply its role-based UI.
    const me = _cache.members.find(m => m.uid === _uid);
    const newRole = me ? me.role : null;
    if (newRole !== _role) {
      const prevRole = _role;
      _role = newRole;
      if (!newRole) {
        // Removed from the org entirely
        emit();
        if (_onRoleChange) _onRoleChange(null, prevRole);
        return;
      }
      // Re-attach on a fresh tick — we're inside a listener callback that
      // detachListeners() would otherwise tear down mid-flight.
      setTimeout(() => {
        if (_role !== newRole) return; // superseded by a later change
        attachListeners();
        if (_onRoleChange) _onRoleChange(newRole, prevRole);
      }, 0);
      return;
    }
    emit();
  }));
  // Price table: admins and bookkeepers always; employees only when the table
  // has been shared with them (rules enforce it — a denied listener would just
  // error, so employees attach and tolerate the error until shared).
  if (_role !== 'customer') {
    _unsubs.push(onSnapshot(priceConfigDoc(), (snap) => {
      _cache.priceConfig = snap.exists()
        ? { vendors: [], sharedWith: [], ...snap.data() }
        : { vendors: [], sharedWith: [] };
      emit();
    }, (err) => { console.warn('priceConfig listener', err); }));
    _unsubs.push(onSnapshot(priceItemsCol(), (snap) => {
      _cache.priceItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    }, (err) => { console.warn('priceItems listener', err); }));
  }
  // Only admins may read invites (firestore.rules) — skip the listener for other roles.
  if (_role === 'admin') {
    _unsubs.push(onSnapshot(invitesCol(), (snap) => {
      _cache.invites = snap.docs.map(d => ({ email: d.id, ...d.data() }));
      emit();
    }));
  }
}

function detachListeners() {
  for (const u of _unsubs) { try { u(); } catch (e) {} }
  _unsubs = [];
}

// ---------- org bootstrap ----------
// Invite-only mode: when false, users with no membership and no invite are rejected
// instead of getting their own new org. To allow public self-signup later, set this
// to true AND update firestore.rules — see "Enabling self-signup" in HANDOFF.md.
const ALLOW_SELF_SIGNUP = false;

// Returns orgId. Joins via invite, or (if self-signup enabled) creates a new org.
async function resolveOrg(userId, userEmail) {
  // 1. Check if user already has an org membership doc anywhere
  //    We store a pointer in a top-level user doc: users/{uid}/orgId
  const userDocRef = doc(db, `users/${userId}`);
  const userSnap = await getDoc(userDocRef);
  if (userSnap.exists() && userSnap.data().orgId) {
    const existingOrgId = userSnap.data().orgId;
    // Confirm membership still exists
    const memberSnap = await getDoc(doc(db, `orgs/${existingOrgId}/members/${userId}`));
    if (memberSnap.exists()) {
      return { orgId: existingOrgId, role: memberSnap.data().role };
    }
  }

  // 2. Check for a pending invite by email
  if (userEmail) {
    const emailKey = userEmail.toLowerCase().replace(/\./g, ',');
    // Search all orgs for an invite — we store invite lookup at top level
    const inviteLookupRef = doc(db, `inviteLookup/${emailKey}`);
    const inviteLookup = await getDoc(inviteLookupRef);
    if (inviteLookup.exists()) {
      const { orgId, role } = inviteLookup.data();
      // Accept invite: add member, write user pointer, delete invite lookup
      const batch = writeBatch(db);
      batch.set(doc(db, `orgs/${orgId}/members/${userId}`), {
        role, email: userEmail, name: userEmail, joinedAt: nowIso(),
      });
      batch.set(userDocRef, { orgId });
      batch.delete(doc(db, `orgs/${orgId}/invites/${emailKey}`));
      batch.delete(inviteLookupRef);
      await batch.commit();
      return { orgId, role };
    }
  }

  // 3. No membership, no invite
  if (!ALLOW_SELF_SIGNUP) {
    const err = new Error('No membership or invite found for this account.');
    err.code = 'app/no-access';
    throw err;
  }

  // Self-signup: create a new org, user becomes admin
  const newOrgId = uid();
  const batch = writeBatch(db);
  batch.set(doc(db, `orgs/${newOrgId}`), { createdAt: nowIso(), createdBy: userId });
  batch.set(doc(db, `orgs/${newOrgId}/members/${userId}`), {
    role: 'admin', email: userEmail || '', name: userEmail || '', joinedAt: nowIso(),
  });
  batch.set(userDocRef, { orgId: newOrgId });
  await batch.commit();
  // Small delay to let Firestore propagate membership before attaching listeners
  await new Promise(r => setTimeout(r, 1000));
  return { orgId: newOrgId, role: 'admin' };
}

// ---------- public API ----------
export const Storage = {
  onChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); },
  // Called when THIS user's role changes while the app is open:
  // cb(newRole, previousRole); newRole is null if they were removed.
  onRoleChange(cb) { _onRoleChange = cb; },
  isReady() { return _ready; },
  getNotesError() { return _notesError; },
  getRole() { return _role; },
  getOrgId() { return _orgId; },
  getUid() { return _uid; },

  async init(userId, userEmail) {
    _uid = userId;
    _ready = false;
    _customersReady = false;
    _notesError = null;
    _cache.notes = [];
    _cache.customers = [];
    _cache.settings = { ...DEFAULT_SETTINGS };
    _cache.members = [];
    _cache.invites = [];
    _cache.priceConfig = { vendors: [], sharedWith: [] };
    _cache.priceItems = [];

    const { orgId, role } = await resolveOrg(userId, userEmail);
    _orgId = orgId;
    _role = role;

    attachListeners();
  },

  signedOut() {
    detachListeners();
    _uid = null; _orgId = null; _role = null;
    _ready = false;
    _customersReady = false;
    _notesError = null;
    _cache.notes = []; _cache.customers = [];
    _cache.settings = { ...DEFAULT_SETTINGS };
    _cache.members = []; _cache.invites = [];
    _cache.priceConfig = { vendors: [], sharedWith: [] };
    _cache.priceItems = [];
    emit();
  },

  // ---------- Notes ----------
  listNotes() {
    return _cache.notes
      .filter(n => !n.customerId)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  },
  listAllNotes() {
    return _cache.notes
      .slice()
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  },
  listNotesByCustomer(customerId) {
    const all = _cache.notes.filter(n => n.customerId === customerId);
    const defaults = all.filter(n => n.isDefault);
    const rest = all.filter(n => !n.isDefault)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
    return [...defaults, ...rest];
  },
  listRecentCustomerNotes(limit = 4) {
    return _cache.notes
      .filter(n => n.customerId)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
      .slice(0, limit);
  },
  getNote(id) { return _cache.notes.find(n => n.id === id) || null; },

  createNote(opts = {}) {
    const id = uid();
    const now = nowIso();
    const note = {
      id,
      body: opts.body || "",
      customerId: opts.customerId || null,
      isDefault: !!opts.isDefault,
      // Employees may only create notes assigned to themselves (firestore.rules)
      assignedTo: _role === 'employee' ? [_uid] : [],
      customerName: opts.customerId ? this.getCustomerNameSnapshot(opts.customerId) : '',
      created: now,
      updated: now,
    };
    _cache.notes.push(note);
    emit();
    setDoc(doc(notesCol(), id), stripId(note)).catch(err => console.warn("createNote", err));
    return note;
  },

  updateNote(id, body) {
    const i = _cache.notes.findIndex(n => n.id === id);
    if (i === -1) return null;
    if (_cache.notes[i].body === body) return _cache.notes[i]; // no change — don't update timestamp
    const next = { ..._cache.notes[i], body, updated: nowIso() };
    _cache.notes[i] = next;
    emit();
    setDoc(doc(notesCol(), id), stripId(next)).catch(err => console.warn("updateNote", err));
    // Admin renamed a customer (default note title) — propagate to that customer's notes
    if (_role === 'admin' && next.isDefault && next.customerId) {
      const name = this.getCustomerNameSnapshot(next.customerId);
      _cache.notes.forEach((n, idx) => {
        if (n.customerId === next.customerId && !n.isDefault && (n.customerName || '') !== name) {
          const updated = { ...n, customerName: name };
          _cache.notes[idx] = updated;
          setDoc(doc(notesCol(), n.id), stripId(updated)).catch(err => console.warn("propagate customerName", err));
        }
      });
    }
    return next;
  },

  deleteNote(id) {
    _cache.notes = _cache.notes.filter(n => n.id !== id);
    emit();
    deleteDoc(doc(notesCol(), id)).catch(err => console.warn("deleteNote", err));
  },

  // customerId === null moves the note back to the general pool.
  assignNoteToCustomer(noteId, customerId) {
    const i = _cache.notes.findIndex(n => n.id === noteId);
    if (i === -1) return null;
    // Stamp the denormalized customer name so non-admin viewers see the
    // NEW customer, not a stale snapshot from before the move.
    const next = {
      ..._cache.notes[i], customerId: customerId || null, updated: nowIso(),
      customerName: customerId ? this.getCustomerNameSnapshot(customerId) : '',
    };
    _cache.notes[i] = next;
    emit();
    setDoc(doc(notesCol(), noteId), stripId(next)).catch(err => console.warn("assignNoteToCustomer", err));
    return next;
  },

  ensureDefaultNoteForCustomer(customerId) {
    let def = _cache.notes.find(n => n.customerId === customerId && n.isDefault);
    if (def) return def;
    return this.createNote({ customerId, isDefault: true, body: "" });
  },

  // ---------- Customers ----------
  listCustomers() {
    return _cache.customers.slice().sort((a, b) =>
      new Date(b.updated).getTime() - new Date(a.updated).getTime()
    );
  },
  getCustomer(id) { return _cache.customers.find(c => c.id === id) || null; },
  getDefaultNoteForCustomer(customerId) {
    return _cache.notes.find(n => n.customerId === customerId && n.isDefault) || null;
  },

  // Denormalized customer name (first line of the default note) so non-admin
  // viewers can display it without read access to the default note.
  getCustomerNameSnapshot(customerId) {
    const def = this.getDefaultNoteForCustomer(customerId);
    if (!def) return '';
    const nl = (def.body || '').indexOf('\n');
    return (nl === -1 ? (def.body || '') : def.body.slice(0, nl)).trim();
  },

  createCustomer() {
    const cid = uid();
    const now = nowIso();
    const customer = { id: cid, created: now, updated: now };
    _cache.customers.push(customer);
    const defId = uid();
    const defaultNote = {
      id: defId, body: "", customerId: cid, isDefault: true,
      assignedTo: [], created: now, updated: now,
    };
    _cache.notes.push(defaultNote);
    emit();
    setDoc(doc(customersCol(), cid), stripId(customer)).catch(err => console.warn("createCustomer.customer", err));
    setDoc(doc(notesCol(), defId), stripId(defaultNote)).catch(err => console.warn("createCustomer.note", err));
    return { customer, defaultNote };
  },

  updateCustomer(id, patch) {
    const i = _cache.customers.findIndex(c => c.id === id);
    if (i === -1) return null;
    const next = { ..._cache.customers[i], ...patch, updated: nowIso() };
    _cache.customers[i] = next;
    emit();
    setDoc(doc(customersCol(), id), stripId(next)).catch(err => console.warn("updateCustomer", err));
    return next;
  },

  deleteCustomer(id) {
    _cache.customers = _cache.customers.filter(c => c.id !== id);
    const noteIds = _cache.notes.filter(n => n.customerId === id).map(n => n.id);
    _cache.notes = _cache.notes.filter(n => n.customerId !== id);
    emit();
    deleteDoc(doc(customersCol(), id)).catch(err => console.warn("deleteCustomer.customer", err));
    for (const nid of noteIds) {
      deleteDoc(doc(notesCol(), nid)).catch(err => console.warn("deleteCustomer.note", err));
    }
  },

  // ---------- Price table ----------
  // Rows = items (one doc each), columns = vendors (in the config doc).
  // A cell is an ARRAY of entries { price, date, avail, added }; the grid shows
  // the newest by date, the history sheet shows them all.
  // avail: 'yes' | 'no' | 'soon' (2–3 days) | 'later' (>3 days)
  getPriceConfig() {
    const c = _cache.priceConfig || {};
    return { vendors: Array.isArray(c.vendors) ? c.vendors : [], sharedWith: Array.isArray(c.sharedWith) ? c.sharedWith : [] };
  },
  listPriceItems() {
    return _cache.priceItems.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  },
  // Admins always; employees when the table is shared with them.
  canEditPriceTable() {
    if (_role === 'admin') return true;
    if (_role === 'employee') return this.getPriceConfig().sharedWith.includes(_uid);
    return false;
  },
  canViewPriceTable() {
    return _role === 'admin' || _role === 'bookkeeper' || this.canEditPriceTable();
  },
  // Newest entry in a cell, by date then insertion time
  latestPriceEntry(item, vendorId) {
    const arr = (item && item.cells && item.cells[vendorId]) || [];
    if (!arr.length) return null;
    return arr.slice().sort((a, b) => {
      const d = String(b.date || '').localeCompare(String(a.date || ''));
      if (d !== 0) return d;
      return String(b.added || '').localeCompare(String(a.added || ''));
    })[0];
  },
  priceHistory(item, vendorId) {
    const arr = (item && item.cells && item.cells[vendorId]) || [];
    return arr.slice().sort((a, b) => {
      const d = String(b.date || '').localeCompare(String(a.date || ''));
      if (d !== 0) return d;
      return String(b.added || '').localeCompare(String(a.added || ''));
    });
  },

  async savePriceConfig(next) {
    _cache.priceConfig = { vendors: [], sharedWith: [], ..._cache.priceConfig, ...next };
    emit();
    await setDoc(priceConfigDoc(), _cache.priceConfig, { merge: true })
      .catch(err => console.warn("savePriceConfig", err));
  },
  async addPriceVendor(name) {
    const n = (name || '').trim();
    if (!n) return null;
    const cfg = this.getPriceConfig();
    const vendor = { id: uid(), name: n, order: cfg.vendors.length };
    await this.savePriceConfig({ vendors: [...cfg.vendors, vendor] });
    return vendor;
  },
  async renamePriceVendor(vendorId, name) {
    const cfg = this.getPriceConfig();
    await this.savePriceConfig({ vendors: cfg.vendors.map(v => v.id === vendorId ? { ...v, name: (name || '').trim() || v.name } : v) });
  },
  async removePriceVendor(vendorId) {
    const cfg = this.getPriceConfig();
    await this.savePriceConfig({ vendors: cfg.vendors.filter(v => v.id !== vendorId) });
    // Drop that column's data from every row
    for (const item of _cache.priceItems) {
      if (item.cells && item.cells[vendorId]) {
        const cells = { ...item.cells };
        delete cells[vendorId];
        await this.savePriceItem(item.id, { cells });
      }
    }
  },
  async addPriceItem(name) {
    const n = (name || '').trim();
    if (!n) return null;
    const id = uid();
    const now = nowIso();
    const item = { id, name: n, order: _cache.priceItems.length, cells: {}, created: now, updated: now };
    _cache.priceItems.push(item);
    emit();
    await setDoc(doc(priceItemsCol(), id), stripId(item)).catch(err => console.warn("addPriceItem", err));
    return item;
  },
  async savePriceItem(itemId, patch) {
    const i = _cache.priceItems.findIndex(n => n.id === itemId);
    if (i === -1) return null;
    const next = { ..._cache.priceItems[i], ...patch, updated: nowIso() };
    _cache.priceItems[i] = next;
    emit();
    await setDoc(doc(priceItemsCol(), itemId), stripId(next)).catch(err => console.warn("savePriceItem", err));
    return next;
  },
  async removePriceItem(itemId) {
    _cache.priceItems = _cache.priceItems.filter(n => n.id !== itemId);
    emit();
    await deleteDoc(doc(priceItemsCol(), itemId)).catch(err => console.warn("removePriceItem", err));
  },
  // Add one price entry to a cell. price may be null/'' — "not available" often
  // has no figure attached.
  async addPriceEntry(itemId, vendorId, { price, date, avail }) {
    const item = _cache.priceItems.find(n => n.id === itemId);
    if (!item) return null;
    const entry = {
      price: (price === '' || price == null) ? null : Number(price),
      date: date || nowIso().slice(0, 10),
      avail: ['yes', 'no', 'soon', 'later'].includes(avail) ? avail : 'yes',
      added: nowIso(),
    };
    const cells = { ...(item.cells || {}) };
    cells[vendorId] = [...(cells[vendorId] || []), entry];
    await this.savePriceItem(itemId, { cells });
    return entry;
  },
  async removePriceEntry(itemId, vendorId, added) {
    const item = _cache.priceItems.find(n => n.id === itemId);
    if (!item || !item.cells || !item.cells[vendorId]) return;
    const cells = { ...item.cells };
    cells[vendorId] = cells[vendorId].filter(e => e.added !== added);
    await this.savePriceItem(itemId, { cells });
  },

  // ---------- Sample data ----------
  // Everything created here carries demo:true so it can be removed in one go.
  // Admin only (firestore.rules); no "hours" note is created — that's the Time
  // Logger's input and fake hours could reach a real IIF export.
  async seedSampleData() {
    if (_role !== 'admin') return { customers: 0, notes: 0 };
    const now = nowIso();
    const samples = [
      {
        def: 'Bill & Karen Eagle\n148 Eagle Crescent\n(403) 555-0142\nbill.eagle@example.com',
        notes: [
          'Kitchen reno\nStarted framing Tuesday.\n\ntodo: order cabinet handles\n☐ confirm sink cutout size\n☐ call inspector before drywall\n\nmaterials: 12 sheets 1/2" drywall, 3 boxes screws',
          'Deck quote\nRough estimate 22x14 cedar deck.\n\ntodo: send written quote by Friday',
        ],
      },
      {
        def: 'Anne Bull\n77 Bull Crescent\n(403) 555-0199',
        notes: [
          'Basement bathroom\nRough-in inspection passed.\n\nmaterials: vanity, 2 shutoff valves, silicone\n\ntodo: pick up vanity from supplier',
        ],
      },
      {
        def: 'Sunrise Cafe\n1120 Main Street\n(403) 555-0177\nAsk for Dana',
        notes: [
          'Patio lighting\nOwner wants string lights before the long weekend.\n\ntodo: quote transformer + 60ft cable\n☑ site visit done',
        ],
      },
    ];
    let noteCount = 0;
    for (const s of samples) {
      const cid = uid();
      const customer = { id: cid, created: now, updated: now, demo: true };
      _cache.customers.push(customer);
      setDoc(doc(customersCol(), cid), stripId(customer)).catch(err => console.warn("seed.customer", err));
      const defId = uid();
      const defaultNote = {
        id: defId, body: s.def, customerId: cid, isDefault: true,
        assignedTo: [], created: now, updated: now, demo: true,
      };
      _cache.notes.push(defaultNote);
      setDoc(doc(notesCol(), defId), stripId(defaultNote)).catch(err => console.warn("seed.defnote", err));
      noteCount++;
      for (const body of s.notes) {
        const nid = uid();
        const note = {
          id: nid, body, customerId: cid, isDefault: false, assignedTo: [],
          customerName: (s.def.split('\n')[0] || '').trim(),
          created: now, updated: now, demo: true,
        };
        _cache.notes.push(note);
        setDoc(doc(notesCol(), nid), stripId(note)).catch(err => console.warn("seed.note", err));
        noteCount++;
      }
    }
    // A couple of general notes (no customer)
    const generals = [
      'Shop list\ntodo: pick up 2x4s and deck screws\n☐ return borrowed nailer',
      'Ideas\nmaterials: try the composite decking sample from the supplier\nCall back about the trailer hitch.',
    ];
    for (const body of generals) {
      const nid = uid();
      const note = {
        id: nid, body, customerId: null, isDefault: false, assignedTo: [],
        customerName: '', created: now, updated: now, demo: true,
      };
      _cache.notes.push(note);
      setDoc(doc(notesCol(), nid), stripId(note)).catch(err => console.warn("seed.general", err));
      noteCount++;
    }
    // Seed keywords so the aggregator section has something to show
    const kw = Array.isArray(_cache.settings.keywords) ? _cache.settings.keywords : [];
    if (kw.length === 0) {
      _cache.settings = { ..._cache.settings, keywords: ['todo', 'materials'] };
      setDoc(settingsDoc(), _cache.settings, { merge: true }).catch(err => console.warn("seed.keywords", err));
    }
    emit();
    return { customers: samples.length, notes: noteCount };
  },

  hasSampleData() {
    return _cache.notes.some(n => n.demo) || _cache.customers.some(c => c.demo);
  },

  async removeSampleData() {
    if (_role !== 'admin') return { customers: 0, notes: 0 };
    const notes = _cache.notes.filter(n => n.demo);
    const customers = _cache.customers.filter(c => c.demo);
    _cache.notes = _cache.notes.filter(n => !n.demo);
    _cache.customers = _cache.customers.filter(c => !c.demo);
    emit();
    for (const n of notes) deleteDoc(doc(notesCol(), n.id)).catch(err => console.warn("unseed.note", err));
    for (const c of customers) deleteDoc(doc(customersCol(), c.id)).catch(err => console.warn("unseed.customer", err));
    return { customers: customers.length, notes: notes.length };
  },

  isOrgEmpty() {
    return _cache.notes.length === 0 && _cache.customers.length === 0;
  },

  // ---------- Aggregator ----------
  aggregateParagraphsByKeyword(keyword) {
    if (!keyword) return [];
    const kwLower = keyword.toLowerCase();
    const results = [];
    for (const note of _cache.notes) {
      // General notes (no customerId) ARE aggregated — the app labels them
      // with the note title (plus the owner's name when it isn't the viewer's).
      if (note.customerId && _customersReady && !_cache.customers.find(c => c.id === note.customerId)) {
        // Orphaned note — skip it in aggregation results.
        // The app will prompt the user to delete or ignore orphaned notes.
        continue;
      }
      const lines = (note.body || "").split("\n");
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const lineLower = line.trimStart().toLowerCase();
        if (lineLower.startsWith(kwLower)) {
          const next = lineLower[kwLower.length];
          if (next === undefined || !/[a-z0-9]/.test(next)) {
            let paraLines = [];
            let j = i;
            while (j < lines.length && lines[j].trim() !== "") {
              paraLines.push(lines[j]);
              j++;
            }
            results.push({
              noteId: note.id, customerId: note.customerId || null,
              paragraph: paraLines.join("\n"), updated: note.updated,
            });
            i = j;
            continue;
          }
        }
        i++;
      }
    }
    results.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
    return results;
  },

  listOrphanedNotes() {
    if (!_customersReady) return [];
    return _cache.notes.filter(n =>
      n.customerId && !_cache.customers.find(c => c.id === n.customerId)
    );
  },

  // ---------- Settings ----------
  getSettings() { return { ...DEFAULT_SETTINGS, ..._cache.settings }; },
  // Update a setting in the local cache only (instant UI), leaving the
  // Firestore write to a later writeSettings() — used by the debounced
  // home-screen steppers so rapid taps cost one write, not one per tap.
  setSettingLocal(key, value) {
    _cache.settings = { ...DEFAULT_SETTINGS, ..._cache.settings, [key]: value };
    emit();
  },
  async writeSettings() {
    try {
      await setDoc(settingsDoc(), _cache.settings, { merge: true });
    } catch (err) {
      console.warn("writeSettings", err);
    }
  },

  async setSetting(key, value) {
    _cache.settings = { ...DEFAULT_SETTINGS, ..._cache.settings, [key]: value };
    emit();
    try {
      await setDoc(settingsDoc(), _cache.settings, { merge: true });
    } catch (err) {
      console.warn("setSetting", err);
    }
  },

  // ---------- Members ----------
  listMembers() { return _cache.members.slice(); },

  assignUsersToNote(noteId, uids) {
    const i = _cache.notes.findIndex(n => n.id === noteId);
    if (i === -1) return;
    const note = _cache.notes[i];
    // Refresh the denormalized customer name at share time
    const customerName = note.customerId ? this.getCustomerNameSnapshot(note.customerId) : (note.customerName || '');
    const next = { ...note, assignedTo: uids, customerName };
    _cache.notes[i] = next;
    emit();
    setDoc(doc(notesCol(), noteId), stripId(next)).catch(err => console.warn("assignUsersToNote", err));
  },

  // One-time catch-up: stamp customerName onto already-shared notes that lack it.
  backfillAssignedCustomerNames() {
    if (_role !== 'admin') return;
    _cache.notes.forEach((n, idx) => {
      if (!n.customerId || n.isDefault) return;
      if (!Array.isArray(n.assignedTo) || n.assignedTo.length === 0) return;
      const name = this.getCustomerNameSnapshot(n.customerId);
      if ((n.customerName || '') === name) return;
      const updated = { ...n, customerName: name };
      _cache.notes[idx] = updated;
      setDoc(doc(notesCol(), n.id), stripId(updated)).catch(err => console.warn("backfill customerName", err));
    });
  },
  getMember(uid) { return _cache.members.find(m => m.uid === uid) || null; },

  async updateMemberRole(memberUid, role) {
    const ref = doc(membersCol(), memberUid);
    await setDoc(ref, { role }, { merge: true });
  },

  async removeMember(memberUid) {
    await deleteDoc(doc(membersCol(), memberUid));
    // Un-share: strip their uid from all notes' assignedTo (edits the field only — nothing is deleted)
    this.unassignUidFromAllNotes(memberUid);
    // Best-effort: clear their user pointer if it points to this org.
    // NOTE: firestore.rules only allow the user themselves to write users/{uid},
    // so this usually fails — harmless under invite-only (stale pointer still gets "no access").
    try {
      const userSnap = await getDoc(doc(db, `users/${memberUid}`));
      if (userSnap.exists() && userSnap.data().orgId === _orgId) {
        await deleteDoc(doc(db, `users/${memberUid}`));
      }
    } catch (e) {
      console.warn('removeMember: could not clear user pointer (expected under current rules)', e);
    }
  },

  // Remove a uid from every note's assignedTo list. Field edit only; no deletions.
  unassignUidFromAllNotes(memberUid) {
    _cache.notes.forEach((n, idx) => {
      if (!Array.isArray(n.assignedTo) || !n.assignedTo.includes(memberUid)) return;
      const updated = { ...n, assignedTo: n.assignedTo.filter(u => u !== memberUid) };
      _cache.notes[idx] = updated;
      setDoc(doc(notesCol(), n.id), stripId(updated)).catch(err => console.warn("unassign", err));
    });
    emit();
  },

  // Sweep: drop uids that are no longer members from all assignedTo lists.
  // (assignedTo only ever contains member uids — the assign modal lists members,
  // and employee self-assignment requires membership — so this is safe.)
  cleanupOrphanedAssignments() {
    if (_role !== 'admin') return;
    const memberUids = new Set(_cache.members.map(m => m.uid));
    _cache.notes.forEach((n, idx) => {
      if (!Array.isArray(n.assignedTo) || n.assignedTo.length === 0) return;
      const kept = n.assignedTo.filter(u => memberUids.has(u));
      if (kept.length === n.assignedTo.length) return;
      const updated = { ...n, assignedTo: kept };
      _cache.notes[idx] = updated;
      setDoc(doc(notesCol(), n.id), stripId(updated)).catch(err => console.warn("cleanup assignments", err));
    });
    emit();
  },

  // Sweep: admins/bookkeepers see every note, so their uids don't belong in
  // assignedTo lists. Strips them from all notes (field edit only; no deletions).
  cleanupElevatedAssignments() {
    if (_role !== 'admin') return;
    const elevated = new Set(
      _cache.members.filter(m => m.role === 'admin' || m.role === 'bookkeeper').map(m => m.uid)
    );
    if (elevated.size === 0) return;
    _cache.notes.forEach((n, idx) => {
      if (!Array.isArray(n.assignedTo) || n.assignedTo.length === 0) return;
      const kept = n.assignedTo.filter(u => !elevated.has(u));
      if (kept.length === n.assignedTo.length) return;
      const updated = { ...n, assignedTo: kept };
      _cache.notes[idx] = updated;
      setDoc(doc(notesCol(), n.id), stripId(updated)).catch(err => console.warn("cleanup elevated assignments", err));
    });
    emit();
  },

  // ---------- Invites ----------
  listInvites() { return _cache.invites.slice(); },

  async inviteUser(email, role) {
    if (!email || !role) return;
    const emailKey = email.toLowerCase().replace(/\./g, ',');
    const batch = writeBatch(db);
    // Store in org's invites collection
    batch.set(doc(invitesCol(), emailKey), { email, role, invitedAt: nowIso(), invitedBy: _uid });
    // Store lookup so sign-in can find it
    batch.set(doc(db, `inviteLookup/${emailKey}`), { orgId: _orgId, role, email });
    await batch.commit();
  },

  async cancelInvite(email) {
    const emailKey = email.toLowerCase().replace(/\./g, ',');
    const batch = writeBatch(db);
    batch.delete(doc(invitesCol(), emailKey));
    batch.delete(doc(db, `inviteLookup/${emailKey}`));
    await batch.commit();
  },

  // ---------- Bulk import ----------
  async importCustomers(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const batch = writeBatch(db);
    const now = nowIso();
    let created = 0;
    for (const row of rows) {
      const body = (row && typeof row.body === "string") ? row.body : "";
      if (!body.trim()) continue;
      const cid = uid();
      const nid = uid();
      const customer = { created: now, updated: now };
      const note = { body, customerId: cid, isDefault: true, assignedTo: [], created: now, updated: now };
      batch.set(doc(customersCol(), cid), customer);
      batch.set(doc(notesCol(), nid), note);
      _cache.customers.push({ id: cid, ...customer });
      _cache.notes.push({ id: nid, ...note });
      created++;
    }
    emit();
    try { await batch.commit(); } catch (e) { console.warn("importCustomers batch", e); }
    return created;
  },

  // ---------- Migration from old users/{uid}/ path ----------
  async maybeMigrateFromOldPath(userId) {
    // Only migrate if org has no notes/customers yet
    if (_cache.notes.length > 0 || _cache.customers.length > 0) return false;

    const oldNotesSnap = await getDocs(collection(db, `users/${userId}/notes`));
    const oldCustomersSnap = await getDocs(collection(db, `users/${userId}/customers`));
    const oldSettingsSnap = await getDoc(doc(db, `users/${userId}/settings/preferences`));

    if (oldNotesSnap.empty && oldCustomersSnap.empty) {
      // Try localStorage migration as before
      return this._maybeMigrateFromLocalStorage();
    }

    const batch = writeBatch(db);
    for (const d of oldCustomersSnap.docs) {
      batch.set(doc(customersCol(), d.id), d.data());
    }
    for (const d of oldNotesSnap.docs) {
      const data = d.data();
      batch.set(doc(notesCol(), d.id), { assignedTo: [], ...data });
    }
    if (oldSettingsSnap.exists()) {
      batch.set(settingsDoc(), oldSettingsSnap.data());
    }
    try {
      await batch.commit();
      return true;
    } catch (e) {
      console.warn("migration from old path failed", e);
      return false;
    }
  },

  async _maybeMigrateFromLocalStorage() {
    const raw = localStorage.getItem("note-aggregator/v1");
    if (!raw) return false;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return false; }
    if (!parsed || (!Array.isArray(parsed.notes) && !Array.isArray(parsed.customers))) return false;
    const batch = writeBatch(db);
    for (const c of parsed.customers || []) {
      batch.set(doc(customersCol(), c.id), { created: c.created || nowIso(), updated: c.updated || nowIso() });
    }
    for (const n of parsed.notes || []) {
      batch.set(doc(notesCol(), n.id), {
        body: n.body || "", customerId: n.customerId || null,
        isDefault: !!n.isDefault, assignedTo: [],
        created: n.created || nowIso(), updated: n.updated || nowIso(),
      });
    }
    const oldRecent = parseInt(localStorage.getItem("note-aggregator/recent-count"), 10);
    const oldAgg = parseInt(localStorage.getItem("note-aggregator/aggregator-count"), 10);
    const oldKwsRaw = localStorage.getItem("note-aggregator/keywords");
    const oldOrderRaw = localStorage.getItem("note-aggregator/pinned-order");
    const oldSort = localStorage.getItem("note-aggregator/customer-sort");
    const newSettings = { ...DEFAULT_SETTINGS };
    if (!Number.isNaN(oldRecent)) newSettings.recentCount = oldRecent;
    if (!Number.isNaN(oldAgg)) newSettings.aggregatorCount = oldAgg;
    if (oldKwsRaw) { try { newSettings.keywords = JSON.parse(oldKwsRaw); } catch {} }
    if (oldOrderRaw) {
      try {
        const p = JSON.parse(oldOrderRaw);
        if (Array.isArray(p)) newSettings.pinnedOrder = p;
      } catch {
        if (oldOrderRaw === "aggregator-first") newSettings.pinnedOrder = ["aggregator", "recent", "notes"];
      }
    }
    if (oldSort === "alpha" || oldSort === "recent") newSettings.customerSort = oldSort;
    batch.set(settingsDoc(), newSettings);
    try {
      await batch.commit();
      localStorage.removeItem("note-aggregator/v1");
      return true;
    } catch (e) {
      console.warn("localStorage migration failed", e);
      return false;
    }
  },
};

function stripId(rec) {
  const { id, ...rest } = rec;
  return rest;
}
