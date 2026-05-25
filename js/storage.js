// storage.js — Firestore-backed store with an in-memory cache that lets the
// rest of the app keep its existing synchronous API. Real-time snapshot
// listeners keep the cache fresh across tabs and devices.
import { db } from "./firebase-init.js";
import {
  collection, doc, onSnapshot, setDoc, deleteDoc, getDocs,
  serverTimestamp, writeBatch, getDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const DEFAULT_SETTINGS = {
  recentCount: 4,
  aggregatorCount: 4,
  pinnedOrder: ["aggregator", "recent", "notes"],
  keywords: [],
  customerSort: "alpha",
};

const _cache = { notes: [], customers: [], settings: { ...DEFAULT_SETTINGS } };
const _listeners = new Set();
let _uid = null;
let _unsubs = [];
let _ready = false;

function emit() { for (const cb of _listeners) cb(); }
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function nowIso() { return new Date().toISOString(); }

function notesCol() { return collection(db, `users/${_uid}/notes`); }
function customersCol() { return collection(db, `users/${_uid}/customers`); }
function settingsDoc() { return doc(db, `users/${_uid}/settings/preferences`); }

function attachListeners() {
  detachListeners();
  _unsubs.push(onSnapshot(notesCol(), (snap) => {
    _cache.notes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _ready = true;
    emit();
  }));
  _unsubs.push(onSnapshot(customersCol(), (snap) => {
    _cache.customers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    emit();
  }));
  _unsubs.push(onSnapshot(settingsDoc(), (snap) => {
    if (snap.exists()) {
      _cache.settings = { ...DEFAULT_SETTINGS, ...snap.data() };
    } else {
      _cache.settings = { ...DEFAULT_SETTINGS };
    }
    emit();
  }));
}

function detachListeners() {
  for (const u of _unsubs) { try { u(); } catch (e) {} }
  _unsubs = [];
}

// ---------- public API ----------
export const Storage = {
  onChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); },
  isReady() { return _ready; },

  async init(userId) {
    _uid = userId;
    _ready = false;
    _cache.notes = [];
    _cache.customers = [];
    _cache.settings = { ...DEFAULT_SETTINGS };
    attachListeners();
  },
  signedOut() {
    detachListeners();
    _uid = null;
    _ready = false;
    _cache.notes = [];
    _cache.customers = [];
    _cache.settings = { ...DEFAULT_SETTINGS };
    emit();
  },

  // ---------- Notes ----------
  listNotes() {
    return _cache.notes
      .filter(n => !n.customerId)
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
    const next = { ..._cache.notes[i], body, updated: nowIso() };
    _cache.notes[i] = next;
    emit();
    setDoc(doc(notesCol(), id), stripId(next)).catch(err => console.warn("updateNote", err));
    return next;
  },

  deleteNote(id) {
    _cache.notes = _cache.notes.filter(n => n.id !== id);
    emit();
    deleteDoc(doc(notesCol(), id)).catch(err => console.warn("deleteNote", err));
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

  createCustomer() {
    const cid = uid();
    const now = nowIso();
    const customer = { id: cid, created: now, updated: now };
    _cache.customers.push(customer);
    const defId = uid();
    const defaultNote = {
      id: defId,
      body: "",
      customerId: cid,
      isDefault: true,
      created: now,
      updated: now,
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
      const paragraphs = (note.body || "").split(/\n[ \t]*\n/);
      for (const para of paragraphs) {
        const trimmed = para.replace(/^\s+|\s+$/g, "");
        if (!trimmed) continue;
        const firstLine = trimmed.split("\n")[0];
        const lower = firstLine.toLowerCase();
        if (!lower.startsWith(kwLower)) continue;
        const next = lower[kwLower.length];
        if (next !== undefined && /[a-z0-9]/.test(next)) continue;
        results.push({
          noteId: note.id, customerId: note.customerId,
          paragraph: trimmed, updated: note.updated,
        });
      }
    }
    results.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
    return results;
  },

  // ---------- Settings (single doc) ----------
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

  // ---------- Bulk import ----------
  // rows = array of { body: string } — each becomes a customer + default note
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
      const note = { body, customerId: cid, isDefault: true, created: now, updated: now };
      batch.set(doc(customersCol(), cid), customer);
      batch.set(doc(notesCol(), nid), note);
      // Update cache so UI reflects immediately
      _cache.customers.push({ id: cid, ...customer });
      _cache.notes.push({ id: nid, ...note });
      created++;
    }
    emit();
    try {
      await batch.commit();
    } catch (e) {
      console.warn("importCustomers batch", e);
    }
    return created;
  },

  // ---------- Migration from localStorage (one-time) ----------
  async maybeMigrateFromLocalStorage() {
    if (_cache.notes.length > 0 || _cache.customers.length > 0) return false;
    const raw = localStorage.getItem("note-aggregator/v1");
    if (!raw) return false;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return false; }
    if (!parsed || (!Array.isArray(parsed.notes) && !Array.isArray(parsed.customers))) return false;
    const batch = writeBatch(db);
    for (const c of parsed.customers || []) {
      batch.set(doc(customersCol(), c.id), {
        created: c.created || nowIso(),
        updated: c.updated || nowIso(),
      });
    }
    for (const n of parsed.notes || []) {
      batch.set(doc(notesCol(), n.id), {
        body: n.body || "",
        customerId: n.customerId || null,
        isDefault: !!n.isDefault,
        created: n.created || nowIso(),
        updated: n.updated || nowIso(),
      });
    }
    // Carry over old settings too
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
        const parsed = JSON.parse(oldOrderRaw);
        if (Array.isArray(parsed)) newSettings.pinnedOrder = parsed;
      } catch {
        if (oldOrderRaw === "aggregator-first") newSettings.pinnedOrder = ["aggregator", "recent", "notes"];
        if (oldOrderRaw === "recent-first") newSettings.pinnedOrder = ["recent", "aggregator", "notes"];
      }
    }
    if (oldSort === "alpha" || oldSort === "recent") newSettings.customerSort = oldSort;
    batch.set(settingsDoc(), newSettings);
    try {
      await batch.commit();
      // Clear localStorage so we don't re-migrate
      localStorage.removeItem("note-aggregator/v1");
      return true;
    } catch (e) {
      console.warn("migration failed", e);
      return false;
    }
  },
};

function stripId(rec) {
  const { id, ...rest } = rec;
  return rest;
}
