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
};
const _listeners = new Set();
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

// ---------- listeners ----------
function attachListeners() {
  detachListeners();
  // Admins can listen to the full notes collection. Employee/customer roles must
  // scope the query itself (assignedTo array-contains uid) to match firestore.rules —
  // Firestore rejects an unscoped collection listener when the rule depends on a
  // per-document field like assignedTo, rather than silently filtering results.
  const notesQuery = _role === 'admin'
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
  // Only admins may read customer records (firestore.rules) — skip the listener otherwise.
  if (_role !== 'admin') {
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
    emit();
  }));
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
// Returns orgId. Creates org if none exists for this user, or joins via invite.
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

  // 3. No org — create a new one, user becomes admin
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

  assignNoteToCustomer(noteId, customerId) {
    const i = _cache.notes.findIndex(n => n.id === noteId);
    if (i === -1) return null;
    const next = { ..._cache.notes[i], customerId, updated: nowIso() };
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

  // ---------- Aggregator ----------
  aggregateParagraphsByKeyword(keyword) {
    if (!keyword) return [];
    const kwLower = keyword.toLowerCase();
    const results = [];
    for (const note of _cache.notes) {
      if (!note.customerId) continue;
      if (_customersReady && !_cache.customers.find(c => c.id === note.customerId)) {
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
              noteId: note.id, customerId: note.customerId,
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
    // Also clear their user pointer if it points to this org
    const userSnap = await getDoc(doc(db, `users/${memberUid}`));
    if (userSnap.exists() && userSnap.data().orgId === _orgId) {
      await deleteDoc(doc(db, `users/${memberUid}`));
    }
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
