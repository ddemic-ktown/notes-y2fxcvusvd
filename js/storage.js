// storage.js — Firestore-backed store with in-memory cache.
// Multi-user org structure: all data lives under orgs/{orgId}/
import { db } from "./firebase-init.js";
import {
  collection, doc, onSnapshot, setDoc, deleteDoc, getDocs,
  writeBatch, getDoc, query, where, disableNetwork, enableNetwork,
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
  jobs: [],
  // Hours actually worked, one doc per person per line. Fetched on demand for
  // the range the Hours screen is showing rather than kept on a live listener:
  // it serves exactly one screen, which you open deliberately.
  timelogs: [],
};
const _listeners = new Set();
let _lastReconnect = 0;      // throttles Storage.reconnect()
let _lastPriceFetch = 0;     // throttles Storage.refreshPriceTable()
let _onRoleChange = null;
let _uid = null;
let _orgId = null;
let _role = null; // 'admin' | 'employee' | 'customer'
let _unsubs = [];
let _jobsUnsub = null;              // tracked apart so it can be replaced alone
let _hotFrom = '', _hotTo = '';     // the live window, YYYY-MM-DD
const _fetchedMonths = new Set();   // 'YYYY-MM' already pulled by getDocs
const _fetchedLogRanges = new Set(); // 'from|to' timelog ranges already pulled
let _ready = false;
let _customersReady = false;
let _notesError = null;

function emit() { for (const cb of _listeners) cb(); }

// ---------- write tracking (for the sync indicator) ----------
// The app is offline-first and silent about it: a note saved in a basement
// looks identical to one that reached the server. Count our own in-flight
// writes so the UI can say "Saving…" and, when offline, reassure the user the
// change is safe on the device.
let _pendingWrites = 0;
const _syncListeners = new Set();
function emitSync() { for (const cb of _syncListeners) cb(); }
function tracked(promise) {
  _pendingWrites++;
  emitSync();
  return promise.finally(() => { _pendingWrites = Math.max(0, _pendingWrites - 1); emitSync(); });
}
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
function jobsCol()       { return collection(db, `orgs/${_orgId}/jobs`); }
function timelogsCol()   { return collection(db, `orgs/${_orgId}/timelogs`); }

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
  // Calendar jobs. Admin/bookkeeper see everything; an employee's query must be
  // scoped to their own uid to match the rules (same reasoning as notes —
  // Firestore rejects an unscoped listener when the rule depends on a
  // per-document field). Customers get no calendar at all.
  // Jobs are split in two: a LIVE listener over a small hot window, and
  // one-off fetches for older months (see fetchJobMonth). Listening to the
  // whole collection meant every job ever created was re-read at every
  // sign-in, for a calendar that only ever shows one month.
  //
  // Widening the live query instead was considered and rejected: a different
  // cutoff is a DIFFERENT query with its own sync state, so each widen
  // re-reads the whole new range — scrolling back N months costs O(N²).
  attachJobsListener();
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
  if (_jobsUnsub) { try { _jobsUnsub(); } catch (e) {} _jobsUnsub = null; }
  _fetchedMonths.clear();
  _fetchedLogRanges.clear();
}

// ---------- calendar jobs: hot window + archive ----------
function ymdOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// One month back through one month forward. The month grid draws trailing days
// of the neighbouring months, so a single-month window would show gaps.
function hotWindow(today = new Date()) {
  const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const to = new Date(today.getFullYear(), today.getMonth() + 2, 0);
  return { from: ymdOf(from), to: ymdOf(to) };
}
// The live listener owns its window; anything older was fetched once and must
// survive the listener's next snapshot, so merge by id instead of replacing.
function mergeHotJobs(docs) {
  const fresh = new Map(docs.map(d => [d.id, d]));
  const kept = _cache.jobs.filter(j => {
    const inWindow = j.date >= _hotFrom && j.date <= _hotTo;
    return !inWindow && !fresh.has(j.id);      // archived, and not superseded
  });
  _cache.jobs = kept.concat(docs);
}
function attachJobsListener() {
  if (_jobsUnsub) { try { _jobsUnsub(); } catch (e) {} _jobsUnsub = null; }
  if (!_role) return;
  const w = hotWindow();
  _hotFrom = w.from; _hotTo = w.to;
  // Employees keep an unbounded array-contains query: adding a date range on
  // top would need a COMPOSITE INDEX (deploy step, and the calendar breaks
  // until it exists), for little gain — they only match their own jobs.
  const q = (_role === 'admin' || _role === 'bookkeeper')
    ? query(jobsCol(), where('date', '>=', _hotFrom), where('date', '<=', _hotTo))
    : _role === 'customer'
      ? query(jobsCol(), where('customerUids', 'array-contains', _uid))
      : query(jobsCol(), where('employeeUids', 'array-contains', _uid));
  _jobsUnsub = onSnapshot(q, (snap) => {
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (_role === 'admin' || _role === 'bookkeeper') mergeHotJobs(docs);
    else _cache.jobs = docs;                   // employee query covers everything
    emit();
  }, (err) => { console.warn('jobs listener', err); });
}

// ---------- org bootstrap ----------
// Invite-only mode: when false, users with no membership and no invite are rejected
// instead of getting their own new org. To allow public self-signup later, set this
// to true AND update firestore.rules — see "Enabling self-signup" in HANDOFF.md.
const ALLOW_SELF_SIGNUP = false;

// THE FOUNDER — the one account that may hand someone a whole new company.
// A `newOrg` invite creates a separate org with the invitee as its admin, so
// this is the most powerful thing in the app and it is NOT a role: a new
// company's owner is an admin too, and keying it on a role would let every
// company you start spawn further companies. Must match isFounder() in
// firestore.rules — the rule is the real enforcement; this copy only decides
// whether the UI is shown.
const FOUNDER_EMAIL = 'davor.demic@gmail.com';
function emailIsFounder(email) {
  return String(email || '').trim().toLowerCase() === FOUNDER_EMAIL;
}
// The email → document id mangling used by both invite collections. It was
// written out by hand in five places; a single slip would have silently made an
// invite unfindable, which looks exactly like "the invite never arrived".
// TRIMS: a pasted address with a trailing space would otherwise key the invite
// under a document id nothing can ever match — the invite would appear to send
// and then simply never work, with nothing to see anywhere.
function emailKeyOf(email) {
  return String(email || '').trim().toLowerCase().replace(/\./g, ',');
}
function cleanEmail(email) { return String(email || '').trim(); }
let _userEmail = null;
let _orgName = '';
let _orgCreatedAt = null;

// How long a founder invite stays usable. Long enough that someone can get to
// it after a holiday, short enough that a forgotten invite isn't a live key to
// a brand new company a year later. Mirrored by the expiresAt check in
// firestore.rules, which is the actual enforcement.
const NEW_ORG_INVITE_DAYS = 14;

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
    const emailKey = emailKeyOf(userEmail);
    // Search all orgs for an invite — we store invite lookup at top level
    const inviteLookupRef = doc(db, `inviteLookup/${emailKey}`);
    const inviteLookup = await getDoc(inviteLookupRef);
    if (inviteLookup.exists()) {
      const invite = inviteLookup.data();
      // A FOUNDER INVITE: don't join anyone's org — start your own.
      // Everything goes in ONE batch, so either the whole company exists (org
      // doc, your admin membership, your sign-in pointer, invite consumed) or
      // none of it does. A half-created org with no admin would be unreachable
      // and unfixable from inside the app.
      if (invite.kind === 'newOrg') {
        // The id was decided when the invite was SENT and is pinned by the
        // rules, so this invite can create that one org and no other.
        const newOrgId = invite.newOrgId;
        if (!newOrgId) {
          const err = new Error('This invite is from an older version and can no longer be used. Ask for a new one.');
          err.code = 'app/invite-invalid';
          throw err;
        }
        // Checked here as well as in the rules: the rules produce a bare
        // permission-denied, which reads as a bug rather than as "your invite
        // ran out". The rules remain the thing that actually stops it.
        const expiresAt = Number(invite.expiresAt) || 0;
        if (!expiresAt || Date.now() >= expiresAt) {
          const err = new Error('This invitation has expired.');
          err.code = 'app/invite-expired';
          throw err;
        }
        const batch = writeBatch(db);
        batch.set(doc(db, `orgs/${newOrgId}`), {
          createdAt: nowIso(),
          createdBy: userId,
          name: invite.companyName || '',
          // Who started this company, and from where. Kept so the origin of an
          // org is answerable later without digging through auth logs.
          foundedByInviteFrom: invite.issuedBy || null,
          foundedByInviteOrg: invite.issuedByOrg || null,
        });
        batch.set(doc(db, `orgs/${newOrgId}/members/${userId}`), {
          role: 'admin', email: userEmail, name: userEmail, joinedAt: nowIso(),
        });
        batch.set(userDocRef, { orgId: newOrgId });
        // The copy in the ISSUING org's pending list, so it stops showing there.
        // Deletable by the invitee because the doc id is their own email key.
        if (invite.issuedByOrg) {
          batch.delete(doc(db, `orgs/${invite.issuedByOrg}/invites/${emailKey}`));
        }
        batch.delete(inviteLookupRef);
        await batch.commit();
        // Same reason as the self-signup path below: give Firestore a moment to
        // propagate the membership, or the listeners attach before the rules can
        // see that this person is a member and every read is refused.
        await new Promise(r => setTimeout(r, 1000));
        return { orgId: newOrgId, role: 'admin' };
      }
      const { orgId, role } = invite;
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
  // Sync status for the header indicator
  onSyncChange(cb) { _syncListeners.add(cb); return () => _syncListeners.delete(cb); },
  pendingWrites() { return _pendingWrites; },
  // Called when THIS user's role changes while the app is open:
  // cb(newRole, previousRole); newRole is null if they were removed.
  onRoleChange(cb) { _onRoleChange = cb; },
  isReady() { return _ready; },

  // Revive the realtime stream after the OS froze the app.
  //
  // Android Chrome discards backgrounded tabs and PWAs (and iOS suspends them),
  // which kills the Firestore websocket. The listeners are still attached and
  // the cache still serves reads, so the app looks fine and quietly shows
  // yesterday's data — the symptom that started this: prices entered on a
  // desktop never reached a phone until the home ⟳ forced a full reload.
  //
  // disableNetwork/enableNetwork tears the connection down and builds it again.
  // Listeners resume from their RESUME TOKENS, so the server sends only what
  // changed while we were away — this is not a re-read of the collection.
  // Throttled because resume events can arrive in bursts (pageshow AND
  // visibilitychange for the same wake-up).
  async reconnect() {
    if (!_orgId) return;                                  // not signed in yet
    if (Date.now() - _lastReconnect < 10000) return;
    _lastReconnect = Date.now();
    try {
      await disableNetwork(db);
      await enableNetwork(db);
    } catch (e) { console.warn('reconnect', e); }
  },

  getNotesError() { return _notesError; },
  getRole() { return _role; },
  getOrgId() { return _orgId; },
  getUid() { return _uid; },

  async init(userId, userEmail) {
    _uid = userId;
    _userEmail = userEmail || null;
    _orgName = '';
    _orgCreatedAt = null;
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
    _cache.jobs = [];
    _cache.timelogs = [];

    const { orgId, role } = await resolveOrg(userId, userEmail);
    _orgId = orgId;
    _role = role;

    attachListeners();
    // The org doc is one small read and it is the only place the company name
    // lives. Not a listener: the name changes about never, and a rename is
    // picked up on the next sign-in.
    getDoc(orgDoc())
      .then(snap => {
        if (!snap.exists()) return;
        _orgName = snap.data().name || '';
        _orgCreatedAt = snap.data().createdAt || null;
        emit();
      })
      .catch(err => console.warn('loadOrgDoc', err));
  },

  // The company's name, as typed on the invite that created it. Empty for the
  // original org, which predates names.
  getOrgName() { return _orgName; },
  // How many days old this company is, or null if the org doc has no createdAt
  // (or hasn't loaded yet). Callers treat null as OLD — the getting-started
  // cards fail closed rather than surprising an established company.
  getOrgAgeDays() {
    if (!_orgCreatedAt) return null;
    const t = Date.parse(_orgCreatedAt);
    if (Number.isNaN(t)) return null;
    return (Date.now() - t) / 86400000;
  },
  async setOrgName(name) {
    if (_role !== 'admin' || !_orgId) return;
    _orgName = String(name || '').trim();
    emit();
    await tracked(setDoc(orgDoc(), { name: _orgName }, { merge: true }))
      .catch(err => console.warn('setOrgName', err));
  },
  // Whether the signed-in account may hand someone a whole new company. The
  // rules enforce this independently — this only decides whether to show the UI.
  canInviteNewOrg() { return emailIsFounder(_userEmail); },

  // ---------- per-user preferences ----------
  // Stored at users/{uid}/prefs/app, NOT under orgs/ — these belong to the
  // person, so they follow them into a different org. The existing
  // users/{userId}/{document=**} rule already covers it, so no rules deploy.
  // A subcollection rather than a field on users/{uid}: that doc is the
  // sign-in pointer used by the old-path migration and shouldn't be shared.
  async loadUserPrefs() {
    if (!_uid) return null;
    try {
      const snap = await getDoc(doc(db, "users", _uid, "prefs", "app"));
      return snap.exists() ? (snap.data() || null) : null;
    } catch (err) { console.warn("loadUserPrefs", err); return null; }
  },
  async saveUserPrefs(values) {
    if (!_uid) return;
    const payload = { ...values, updated: nowIso() };
    await tracked(setDoc(doc(db, "users", _uid, "prefs", "app"), payload))
      .catch(err => console.warn("saveUserPrefs", err));
  },

  signedOut() {
    detachListeners();
    _uid = null; _orgId = null; _role = null;
    _userEmail = null; _orgName = ''; _orgCreatedAt = null;
    _ready = false;
    _customersReady = false;
    _notesError = null;
    _cache.notes = []; _cache.customers = [];
    _cache.settings = { ...DEFAULT_SETTINGS };
    _cache.members = []; _cache.invites = [];
    _cache.priceConfig = { vendors: [], sharedWith: [] };
    _cache.priceItems = [];
    _cache.jobs = [];
    _cache.timelogs = [];
    emit();
  },

  // ---------- Notes ----------
  // Deleting sets deletedAt instead of removing the document, so a mistake is
  // recoverable (deleting a customer used to cascade to every note they had,
  // with only a confirm dialog in the way). Every list filters them out; the
  // Trash screen is the only place they appear, and a sweep on admin sign-in
  // purges anything older than TRASH_DAYS.
  liveNotes() { return _cache.notes.filter(n => !n.deletedAt); },
  liveCustomers() { return _cache.customers.filter(c => !c.deletedAt); },
  listNotes() {
    return this.liveNotes()
      .filter(n => !n.customerId)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  },
  listAllNotes() {
    return this.liveNotes()
      .slice()
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  },
  listNotesByCustomer(customerId) {
    const all = this.liveNotes().filter(n => n.customerId === customerId);
    const defaults = all.filter(n => n.isDefault);
    const rest = all.filter(n => !n.isDefault)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
    return [...defaults, ...rest];
  },
  listRecentCustomerNotes(limit = 4) {
    return this.liveNotes()
      .filter(n => n.customerId)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
      .slice(0, limit);
  },
  getNote(id) { return _cache.notes.find(n => n.id === id && !n.deletedAt) || null; },

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
    tracked(setDoc(doc(notesCol(), id), stripId(note))).catch(err => console.warn("createNote", err));
    return note;
  },

  updateNote(id, body) {
    const i = _cache.notes.findIndex(n => n.id === id);
    if (i === -1) return null;
    if (_cache.notes[i].body === body) return _cache.notes[i]; // no change — don't update timestamp
    const next = { ..._cache.notes[i], body, updated: nowIso() };
    _cache.notes[i] = next;
    emit();
    tracked(setDoc(doc(notesCol(), id), stripId(next))).catch(err => console.warn("updateNote", err));
    // Admin renamed a customer (default note title) — propagate to that customer's notes
    if (_role === 'admin' && next.isDefault && next.customerId) {
      const name = this.getCustomerNameSnapshot(next.customerId);
      _cache.notes.forEach((n, idx) => {
        if (n.customerId === next.customerId && !n.isDefault && (n.customerName || '') !== name) {
          const updated = { ...n, customerName: name };
          _cache.notes[idx] = updated;
          tracked(setDoc(doc(notesCol(), n.id), stripId(updated))).catch(err => console.warn("propagate customerName", err));
        }
      });
    }
    return next;
  },

  deleteNote(id) {
    const i = _cache.notes.findIndex(n => n.id === id);
    if (i === -1) return;
    const next = { ..._cache.notes[i], deletedAt: nowIso() };
    _cache.notes[i] = next;
    emit();
    tracked(setDoc(doc(notesCol(), id), stripId(next))).catch(err => console.warn("deleteNote", err));
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
    tracked(setDoc(doc(notesCol(), noteId), stripId(next))).catch(err => console.warn("assignNoteToCustomer", err));
    return next;
  },

  ensureDefaultNoteForCustomer(customerId) {
    let def = _cache.notes.find(n => n.customerId === customerId && n.isDefault);
    if (def) return def;
    return this.createNote({ customerId, isDefault: true, body: "" });
  },

  // ---------- Customers ----------
  listCustomers() {
    return this.liveCustomers().slice().sort((a, b) =>
      new Date(b.updated).getTime() - new Date(a.updated).getTime()
    );
  },
  getCustomer(id) { return _cache.customers.find(c => c.id === id && !c.deletedAt) || null; },
  getDefaultNoteForCustomer(customerId) {
    return this.liveNotes().find(n => n.customerId === customerId && n.isDefault) || null;
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
    tracked(setDoc(doc(customersCol(), cid), stripId(customer))).catch(err => console.warn("createCustomer.customer", err));
    tracked(setDoc(doc(notesCol(), defId), stripId(defaultNote))).catch(err => console.warn("createCustomer.note", err));
    return { customer, defaultNote };
  },

  updateCustomer(id, patch) {
    const i = _cache.customers.findIndex(c => c.id === id);
    if (i === -1) return null;
    const next = { ..._cache.customers[i], ...patch, updated: nowIso() };
    _cache.customers[i] = next;
    emit();
    tracked(setDoc(doc(customersCol(), id), stripId(next))).catch(err => console.warn("updateCustomer", err));
    return next;
  },

  // Marks the customer AND their notes, stamping the same trashedWith id so
  // restoring the customer brings the whole set back together.
  deleteCustomer(id) {
    const now = nowIso();
    const ci = _cache.customers.findIndex(c => c.id === id);
    if (ci !== -1) {
      const nextC = { ..._cache.customers[ci], deletedAt: now };
      _cache.customers[ci] = nextC;
      tracked(setDoc(doc(customersCol(), id), stripId(nextC))).catch(err => console.warn("deleteCustomer.customer", err));
    }
    _cache.notes.forEach((n, idx) => {
      if (n.customerId === id && !n.deletedAt) {
        const nextN = { ...n, deletedAt: now, trashedWith: id };
        _cache.notes[idx] = nextN;
        tracked(setDoc(doc(notesCol(), n.id), stripId(nextN))).catch(err => console.warn("deleteCustomer.note", err));
      }
    });
    emit();
  },

  // ---------- Trash ----------
  TRASH_DAYS: 30,
  listTrash() {
    const notes = _cache.notes.filter(n => n.deletedAt);
    const customers = _cache.customers.filter(c => c.deletedAt);
    // A customer and the notes deleted with them show as ONE entry
    const grouped = customers.map(c => ({
      kind: 'customer', id: c.id, deletedAt: c.deletedAt,
      name: (() => {
        const def = _cache.notes.find(n => n.customerId === c.id && n.isDefault);
        const title = def ? (def.body || '').split('\n')[0].trim() : '';
        return title || 'Unnamed customer';
      })(),
      noteCount: notes.filter(n => n.trashedWith === c.id).length,
    }));
    const loose = notes.filter(n => !n.trashedWith).map(n => ({
      kind: 'note', id: n.id, deletedAt: n.deletedAt,
      name: (n.body || '').split('\n')[0].trim() || 'Untitled note',
    }));
    return [...grouped, ...loose].sort((a, b) =>
      new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
  },
  async restoreFromTrash(kind, id) {
    if (kind === 'customer') {
      const ci = _cache.customers.findIndex(c => c.id === id);
      if (ci !== -1) {
        const c = { ..._cache.customers[ci] };
        delete c.deletedAt;
        _cache.customers[ci] = c;
        tracked(setDoc(doc(customersCol(), id), stripId(c))).catch(err => console.warn("restore.customer", err));
      }
      _cache.notes.forEach((n, idx) => {
        if (n.trashedWith === id) {
          const nn = { ...n };
          delete nn.deletedAt; delete nn.trashedWith;
          _cache.notes[idx] = nn;
          tracked(setDoc(doc(notesCol(), n.id), stripId(nn))).catch(err => console.warn("restore.note", err));
        }
      });
    } else {
      const i = _cache.notes.findIndex(n => n.id === id);
      if (i !== -1) {
        const nn = { ..._cache.notes[i] };
        delete nn.deletedAt; delete nn.trashedWith;
        _cache.notes[i] = nn;
        tracked(setDoc(doc(notesCol(), id), stripId(nn))).catch(err => console.warn("restore.note", err));
      }
    }
    emit();
  },
  async purgeFromTrash(kind, id) {
    if (kind === 'customer') {
      const noteIds = _cache.notes.filter(n => n.trashedWith === id).map(n => n.id);
      _cache.customers = _cache.customers.filter(c => c.id !== id);
      _cache.notes = _cache.notes.filter(n => n.trashedWith !== id);
      emit();
      tracked(deleteDoc(doc(customersCol(), id))).catch(err => console.warn("purge.customer", err));
      for (const nid of noteIds) tracked(deleteDoc(doc(notesCol(), nid))).catch(err => console.warn("purge.note", err));
    } else {
      _cache.notes = _cache.notes.filter(n => n.id !== id);
      emit();
      tracked(deleteDoc(doc(notesCol(), id))).catch(err => console.warn("purge.note", err));
    }
  },
  // Hard-delete anything binned more than TRASH_DAYS ago (admin sign-in sweep)
  purgeExpiredTrash() {
    if (_role !== 'admin') return 0;
    const cutoff = Date.now() - this.TRASH_DAYS * 24 * 60 * 60 * 1000;
    let purged = 0;
    const expired = (d) => d && new Date(d).getTime() < cutoff;
    _cache.customers.filter(c => expired(c.deletedAt)).forEach(c => { this.purgeFromTrash('customer', c.id); purged++; });
    _cache.notes.filter(n => expired(n.deletedAt) && !n.trashedWith).forEach(n => { this.purgeFromTrash('note', n.id); purged++; });
    return purged;
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
  // Belt to reconnect()'s braces: a one-off authoritative fetch when the price
  // screen opens, so entering it always shows what the server has rather than
  // whatever the cache was left holding.
  //
  // This is NOT free — it costs one read per row, unlike reconnect(), which
  // resumes from a token. Hence the throttle, and hence it runs only on this
  // screen rather than on every navigation.
  async refreshPriceTable() {
    if (!_orgId || !this.canViewPriceTable()) return;
    if (Date.now() - _lastPriceFetch < 15000) return;
    _lastPriceFetch = Date.now();
    try {
      const [cfgSnap, itemSnap] = await Promise.all([
        getDoc(priceConfigDoc()),
        getDocs(priceItemsCol()),
      ]);
      _cache.priceConfig = cfgSnap.exists()
        ? { vendors: [], sharedWith: [], ...cfgSnap.data() }
        : { vendors: [], sharedWith: [] };
      _cache.priceItems = itemSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    } catch (e) { console.warn('refreshPriceTable', e); }
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
  // Drop `itemId` immediately before `beforeItemId` (null = drop at the end).
  // Uses a midpoint order so a drag costs ONE document write instead of
  // renumbering every row it passed. Orders are plain numbers, so fractions
  // are free — but they halve each time, so renormalize when the gap gets too
  // small to split reliably.
  async reorderPriceItem(itemId, beforeItemId) {
    if (itemId === beforeItemId) return null;
    let items = this.listPriceItems();
    const moving = items.find(i => i.id === itemId);
    if (!moving) return null;
    const place = async () => {
      const rest = items.filter(i => i.id !== itemId);
      const at = beforeItemId ? rest.findIndex(i => i.id === beforeItemId) : rest.length;
      if (beforeItemId && at === -1) return null;
      const prev = at > 0 ? (rest[at - 1].order ?? 0) : null;
      const next = at < rest.length ? (rest[at].order ?? 0) : null;
      let order;
      if (prev == null && next == null) order = 0;
      else if (prev == null) order = next - 1;
      else if (next == null) order = prev + 1;
      else {
        if (next - prev < 1e-6) return false;      // out of room — renormalize
        order = (prev + next) / 2;
      }
      return this.savePriceItem(itemId, { order });
    };
    const done = await place();
    if (done !== false) return done;
    for (let i = 0; i < items.length; i++) {
      if ((items[i].order ?? 0) !== i) await this.savePriceItem(items[i].id, { order: i });
    }
    items = this.listPriceItems();
    return place();
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

  // ---------- Calendar jobs ----------
  // Jobs are scheduled by Time Logger NAME (what you type and what the grid
  // shows). employeeUids is derived from the optional name→account links in
  // settings: rules and the employee's own query work on uids, because a name
  // string means nothing to the server. A name with no linked account still
  // schedules fine — that person just can't see their schedule in the app.
  // Pull one older month, once. Old jobs essentially never change, so they get
  // a one-off read rather than a live subscription — that's what keeps the
  // cost linear as you scroll back. Trade-off: a history month edited on
  // another device won't update live here until a reload.
  async ensureJobMonth(dateStr) {
    if (!_orgId || _role === 'customer') return;
    if (_role !== 'admin' && _role !== 'bookkeeper') return;   // employee query is unbounded already
    const key = String(dateStr || '').slice(0, 7);             // YYYY-MM
    if (!/^\d{4}-\d{2}$/.test(key)) return;
    if (_fetchedMonths.has(key)) return;
    // Inside the live window? The listener already has it.
    const [y, m] = key.split('-').map(Number);
    const from = `${key}-01`;
    const to = ymdOf(new Date(y, m, 0));
    if (from >= _hotFrom && to <= _hotTo) return;
    _fetchedMonths.add(key);                                   // claim it before awaiting
    try {
      const snap = await getDocs(query(jobsCol(), where('date', '>=', from), where('date', '<=', to)));
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const have = new Set(_cache.jobs.map(j => j.id));
      const added = docs.filter(d => !have.has(d.id));
      if (added.length) { _cache.jobs = _cache.jobs.concat(added); emit(); }
    } catch (err) {
      _fetchedMonths.delete(key);                              // let it retry
      console.warn('ensureJobMonth', err);
    }
  },
  listJobs() {
    return _cache.jobs.filter(j => !j.deletedAt);
  },
  // Who you're most likely to be booking next. Ranked by how many jobs you
  // scheduled for them inside the window, then by how recently — a customer you
  // book every week should outrank a one-off from yesterday. The window is
  // measured on `updated` (when you did the scheduling), not on the job's date,
  // so booking next month's work today still counts as activity today.
  recentJobCustomerIds(limit = 5, windowDays = 30) {
    const cutoff = Date.now() - windowDays * 86400000;
    const alive = new Set(this.liveCustomers().map(c => c.id));
    const stats = new Map();
    for (const j of this.listJobs()) {
      if (!j.customerId || !alive.has(j.customerId)) continue;
      const t = new Date(j.updated || j.created || 0).getTime() || 0;
      const s = stats.get(j.customerId) || { id: j.customerId, count: 0, last: 0 };
      if (t >= cutoff) s.count++;
      if (t > s.last) s.last = t;
      stats.set(j.customerId, s);
    }
    return [...stats.values()]
      .sort((a, b) => (b.count - a.count) || (b.last - a.last))
      .slice(0, Math.max(0, limit))
      .map(s => s.id);
  },
  listJobsByDate(dateStr) {
    return this.listJobs()
      .filter(j => j.date === dateStr)
      .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  },
  listJobsInRange(fromStr, toStr) {
    return this.listJobs().filter(j => j.date >= fromStr && j.date <= toStr);
  },
  getJob(id) { return _cache.jobs.find(j => j.id === id && !j.deletedAt) || null; },
  // settings.employeeLinks: { [employeeName]: uid }
  employeeUidsFor(names) {
    const links = _cache.settings.employeeLinks || {};
    return [...new Set((names || []).map(n => links[n]).filter(Boolean))];
  },
  // settings.customerLinks: { [customerId]: uid } — same idea for the customer
  // role, so a customer can be shown the jobs booked for them.
  customerUidsFor(customerId) {
    const links = _cache.settings.customerLinks || {};
    const u = customerId ? links[customerId] : null;
    return u ? [u] : [];
  },
  async saveJob(job) {
    const id = job.id || uid();
    const now = nowIso();
    const existing = _cache.jobs.find(j => j.id === id);
    const next = {
      id,
      date: job.date,
      start: job.start || '',
      end: job.end || '',
      description: job.description || '',
      employeeNames: Array.isArray(job.employeeNames) ? job.employeeNames : [],
      // { [employeeName]: hours } — only for people actually on the job, and
      // only when a number was entered. A plan, not a timelog: this is what you
      // jotted on the job, separate from the hours note records.
      employeeHours: (job.employeeHours && typeof job.employeeHours === 'object') ? job.employeeHours : {},
      employeeUids: this.employeeUidsFor(job.employeeNames),
      customerUids: this.customerUidsFor(job.customerId),
      customerId: job.customerId || null,
      customerName: job.customerName || '',
      address: job.address || '',
      created: existing ? existing.created : now,
      updated: now,
    };
    const i = _cache.jobs.findIndex(j => j.id === id);
    if (i === -1) _cache.jobs.push(next); else _cache.jobs[i] = next;
    emit();
    await tracked(setDoc(doc(jobsCol(), id), stripId(next))).catch(err => console.warn("saveJob", err));
    return next;
  },
  // Backfill employeeUids across ALL jobs, not just the loaded window. Linking
  // a name to an account in settings only affects jobs saved afterwards — this
  // re-stamps the older ones so that person can finally see them. Admin only
  // (rules enforce it). Returns { scanned, updated }.
  async relinkJobEmployeeUids() {
    if (_role !== 'admin') return { scanned: 0, updated: 0 };
    const snap = await getDocs(jobsCol());
    let updated = 0;
    const same = (a, b) => a.length === b.length && a.every(v => b.includes(v));
    for (const d of snap.docs) {
      const data = d.data() || {};
      if (data.deletedAt) continue;
      const want = this.employeeUidsFor(data.employeeNames || []);
      const have = Array.isArray(data.employeeUids) ? data.employeeUids : [];
      const wantCust = this.customerUidsFor(data.customerId || null);
      const haveCust = Array.isArray(data.customerUids) ? data.customerUids : [];
      if (same(want, have) && same(wantCust, haveCust)) continue;
      await tracked(setDoc(doc(jobsCol(), d.id), { employeeUids: want, customerUids: wantCust }, { merge: true }))
        .catch(err => console.warn('relinkJobEmployeeUids', err));
      const i = _cache.jobs.findIndex(j => j.id === d.id);
      if (i !== -1) _cache.jobs[i] = { ..._cache.jobs[i], employeeUids: want, customerUids: wantCust };
      updated++;
    }
    if (updated) emit();
    return { scanned: snap.size, updated };
  },
  async deleteJob(id) {
    _cache.jobs = _cache.jobs.filter(j => j.id !== id);
    emit();
    await tracked(deleteDoc(doc(jobsCol(), id))).catch(err => console.warn("deleteJob", err));
  },

  // ---------- Time logs (hours actually worked) ----------
  // A job is a plan; a timelog is a fact. Separate collections so deleting a
  // cancelled job can never touch recorded hours. ONE DOCUMENT PER PERSON: two
  // people on one line of the hours note is two records, because that's two
  // rows in QuickBooks and two people's pay.
  //
  // Fetched on demand for the range the Hours screen is showing — no live
  // listener, because this serves one screen that you open deliberately, and a
  // permanent listener would re-read every record at every sign-in for a
  // screen most sessions never visit.
  async ensureTimeLogRange(fromStr, toStr) {
    if (!_orgId || _role === 'customer') return;
    if (!fromStr || !toStr) return;
    const key = `${fromStr}|${toStr}`;
    if (_fetchedLogRanges.has(key)) return;
    _fetchedLogRanges.add(key);                       // claim it before awaiting
    try {
      const q = (_role === 'admin' || _role === 'bookkeeper')
        ? query(timelogsCol(), where('date', '>=', fromStr), where('date', '<=', toStr))
        : query(timelogsCol(), where('employeeUids', 'array-contains', _uid));
      const snap = await getDocs(q);
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const have = new Set(_cache.timelogs.map(t => t.id));
      const added = docs.filter(d => !have.has(d.id));
      if (added.length) { _cache.timelogs = _cache.timelogs.concat(added); emit(); }
    } catch (err) {
      _fetchedLogRanges.delete(key);                  // let it retry
      console.warn('ensureTimeLogRange', err);
    }
  },
  listTimeLogs() { return _cache.timelogs.slice(); },
  listTimeLogsInRange(fromStr, toStr) {
    return _cache.timelogs.filter(t =>
      (!fromStr || t.date >= fromStr) && (!toStr || t.date <= toStr));
  },
  getTimeLog(id) { return _cache.timelogs.find(t => t.id === id) || null; },
  async saveTimeLog(rec) {
    const id = rec.id || uid();
    const now = nowIso();
    const existing = _cache.timelogs.find(t => t.id === id);
    const next = {
      id,
      date: rec.date,                                  // 'YYYY-MM-DD'
      employeeName: rec.employeeName || '',
      // Rules filter on uids, never on the name — see the jobs comment.
      employeeUids: this.employeeUidsFor([rec.employeeName].filter(Boolean)),
      customerId: rec.customerId || null,
      customerName: rec.customerName || '',
      hours: Number(rec.hours) || 0,
      hoursFormatted: rec.hoursFormatted || '',
      note: rec.note || '',                            // the source line, for context
      created: existing ? existing.created : now,
      updated: now,
    };
    const i = _cache.timelogs.findIndex(t => t.id === id);
    if (i === -1) _cache.timelogs.push(next); else _cache.timelogs[i] = next;
    emit();
    await tracked(setDoc(doc(timelogsCol(), id), stripId(next)))
      .catch(err => console.warn('saveTimeLog', err));
    return next;
  },
  // Sequential rather than a batch: it keeps the cache and the write path
  // identical to the single-record case, and a partial failure leaves the
  // records that did save intact instead of rolling the lot back.
  async saveTimeLogsBulk(recs) {
    const out = [];
    for (const r of recs) out.push(await this.saveTimeLog(r));
    return out;
  },
  async deleteTimeLog(id) {
    _cache.timelogs = _cache.timelogs.filter(t => t.id !== id);
    emit();
    await tracked(deleteDoc(doc(timelogsCol(), id))).catch(err => console.warn('deleteTimeLog', err));
  },

  // ---------- Sample data ----------
  // A full demo org, not just a few notes: customers, notes, employees,
  // keywords, calendar jobs, recorded hours and a price table, so every screen
  // has something real-looking to show and the tutorial has targets to point
  // at. Everything is tagged so it can be taken back out in one press — see
  // SEED_TAG below.
  //
  // DATES ARE REBASED ON TODAY every time it runs. Fixed dates would drift out
  // of the calendar's live window and out of the Hours screen's default
  // fortnight within a month, and the sample would look empty.
  //
  // Documents (customers, notes, jobs, timelogs, price items) carry
  // `demo: true`. Settings-shaped things (employees, keywords, price vendors)
  // can't carry a flag, so what the seed added is recorded in
  // settings.demoSeed and removed by matching that record — and only ever
  // seeded when you have none of your own, so a real setup can't be replaced.
  async seedSampleData() {
    if (_role !== 'admin') return null;
    const now = nowIso();
    const today = new Date();
    // Day offsets from today. Negative = worked (has hours and, mostly, a
    // record); positive = booked but not yet worked.
    const day = (n) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
      return ymdOf(d);
    };

    const counts = {
      customers: 0, notes: 0, jobs: 0, timelogs: 0, priceItems: 0,
      employees: 0, keywords: 0, vendors: 0,
    };
    // What the seed added to settings, so removeSampleData can undo exactly
    // that and nothing else.
    const demoSeed = { employees: [], keywords: [], vendorIds: [] };

    // ---- customers and their notes ----
    // Four, deliberately different: a couple with two jobs on the go, a
    // straightforward one-job customer, a business (contact person instead of a
    // second name), and a property manager who books several small jobs.
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
      {
        def: 'Ridgeview Property Management\n8 Ridgeview Road, Unit 3\n(403) 555-0110\nMaint. requests go to Priya',
        notes: [
          'Unit 12 — leaking tap\nCartridge replaced, watch for weeping.\n\ntodo: invoice through the office, not the tenant',
          'Common area punch list\n☑ replace hallway bulbs\n☐ reseal back step\n☐ quote parkade lighting\n\nmaterials: 6 LED bulbs, tube of urethane sealant',
        ],
      },
    ];
    // Keyed by the customer's display name (its default note's first line), so
    // the jobs and hour records below can find the id they need.
    const custIds = {};
    const custAddr = {};
    for (const s of samples) {
      const cid = uid();
      const name = (s.def.split('\n')[0] || '').trim();
      custIds[name] = cid;
      custAddr[name] = (s.def.split('\n')[1] || '').trim();
      const customer = { id: cid, created: now, updated: now, demo: true };
      _cache.customers.push(customer);
      tracked(setDoc(doc(customersCol(), cid), stripId(customer))).catch(err => console.warn("seed.customer", err));
      counts.customers++;
      const defId = uid();
      const defaultNote = {
        id: defId, body: s.def, customerId: cid, isDefault: true,
        assignedTo: [], created: now, updated: now, demo: true,
      };
      _cache.notes.push(defaultNote);
      tracked(setDoc(doc(notesCol(), defId), stripId(defaultNote))).catch(err => console.warn("seed.defnote", err));
      counts.notes++;
      for (const body of s.notes) {
        const nid = uid();
        const note = {
          id: nid, body, customerId: cid, isDefault: false, assignedTo: [],
          customerName: name, created: now, updated: now, demo: true,
        };
        _cache.notes.push(note);
        tracked(setDoc(doc(notesCol(), nid), stripId(note))).catch(err => console.warn("seed.note", err));
        counts.notes++;
      }
    }

    // ---- general notes (no customer) ----
    // The third is mostly checkboxes, so the editor's tick behaviour has an
    // obvious place to be tried.
    const generals = [
      'Shop list\ntodo: pick up 2x4s and deck screws\n☐ return borrowed nailer',
      'Ideas\nmaterials: try the composite decking sample from the supplier\nCall back about the trailer hitch.',
      'Truck checks\n☑ oil change\n☑ new wiper blades\n☐ book winter tires\n☐ replace the missing 10mm socket\n\ntodo: renew the trailer registration',
    ];
    for (const body of generals) {
      const nid = uid();
      const note = {
        id: nid, body, customerId: null, isDefault: false, assignedTo: [],
        customerName: '', created: now, updated: now, demo: true,
      };
      _cache.notes.push(note);
      tracked(setDoc(doc(notesCol(), nid), stripId(note))).catch(err => console.warn("seed.general", err));
      counts.notes++;
    }

    // ---- employees (settings) ----
    // Only when there are none: these names end up in the EMP column of a real
    // QuickBooks import, and replacing someone's configured spelling would
    // break their import. One apprentice among journeymen so the two IIF item
    // mappings are both exercised.
    const SEED_EMPLOYEES = [
      { name: 'Sam Rivera',  type: 'journeyman', colour: '#2563eb' },
      { name: 'Janet Wu',    type: 'journeyman', colour: '#16a34a' },
      { name: 'Tyler Novak', type: 'apprentice', colour: '#d97706' },
    ];
    const existingEmps = Array.isArray(_cache.settings.employees) ? _cache.settings.employees : [];
    const empNames = existingEmps.length
      ? existingEmps.map(e => (typeof e === 'string' ? e : e.name))
      : SEED_EMPLOYEES.map(e => e.name);
    if (!existingEmps.length) {
      _cache.settings = { ..._cache.settings, employees: SEED_EMPLOYEES };
      demoSeed.employees = SEED_EMPLOYEES.map(e => e.name);
      counts.employees = SEED_EMPLOYEES.length;
    }
    // Jobs are scheduled against whatever names are actually configured, so the
    // sample works on an org that already has its own crew.
    const emp = (i) => empNames[i % empNames.length];

    // ---- keywords (settings) ----
    const SEED_KEYWORDS = ['todo', 'materials'];
    const kw = Array.isArray(_cache.settings.keywords) ? _cache.settings.keywords : [];
    if (kw.length === 0) {
      _cache.settings = { ..._cache.settings, keywords: SEED_KEYWORDS };
      demoSeed.keywords = SEED_KEYWORDS.slice();
      counts.keywords = SEED_KEYWORDS.length;
    }

    // ---- calendar jobs ----
    // Chosen to cover the shapes the calendar and the Hours chart have to
    // handle, not just to fill space:
    //   · timed and untimed (an untimed job sits in the strip above the day
    //     timeline instead of on it)
    //   · one person and several, with DIFFERENT hours each
    //   · two jobs on the same day for the same customer — that's the case the
    //     Hours chart's pair-off-in-order matching exists for
    //   · past jobs with hours, one past job WITHOUT (the "you still owe hours
    //     for this" dash), and upcoming jobs with none yet
    const jobSpecs = [
      { d: -12, start: '08:00', end: '16:30', cust: 'Bill & Karen Eagle',
        emps: [0, 1], hours: [8.5, 8.5], desc: 'Framing — kitchen wall opened up' },
      { d: -11, start: '08:00', end: '12:00', cust: 'Anne Bull',
        emps: [2], hours: [4], desc: 'Rough-in inspection' },
      { d: -9, start: '', end: '', cust: 'Ridgeview Property Management',
        emps: [1], hours: [2], desc: 'Unit 12 tap — no set time, fit in when passing' },
      { d: -6, start: '07:30', end: '15:00', cust: 'Bill & Karen Eagle',
        emps: [0, 2], hours: [7.5, 7], desc: 'Drywall delivery and hang' },
      { d: -5, start: '09:00', end: '11:00', cust: 'Sunrise Cafe',
        emps: [0], hours: [2], desc: 'Site visit — measure for string lights' },
      { d: -5, start: '13:00', end: '16:00', cust: 'Sunrise Cafe',
        emps: [0], hours: [3], desc: 'Second visit same day — ran the cable' },
      { d: -3, start: '08:00', end: '16:00', cust: 'Ridgeview Property Management',
        emps: [1, 2], hours: [null, null], desc: 'Common area punch list — hours not entered yet' },
      { d: 2, start: '08:00', end: '17:00', cust: 'Bill & Karen Eagle',
        emps: [0, 1], hours: [null, null], desc: 'Cabinet install — booked' },
      { d: 4, start: '', end: '', cust: 'Anne Bull',
        emps: [2], hours: [null], desc: 'Drop off the vanity' },
      { d: 6, start: '10:00', end: '14:00', cust: 'Sunrise Cafe',
        emps: [0, 2], hours: [null, null], desc: 'Hang the lights before the weekend' },
    ];
    const seededJobs = [];
    for (const spec of jobSpecs) {
      const id = uid();
      const names = spec.emps.map(i => emp(i));
      const employeeHours = {};
      names.forEach((n, i) => {
        const h = spec.hours[i];
        if (h != null) employeeHours[n] = h;
      });
      const job = {
        id,
        date: day(spec.d),
        start: spec.start,
        end: spec.end,
        description: spec.desc,
        employeeNames: names,
        employeeHours,
        // Demo employees aren't linked to real accounts, so nothing to filter
        // on — the fields still have to EXIST for the read rules to evaluate.
        employeeUids: [],
        customerUids: [],
        customerId: custIds[spec.cust] || null,
        customerName: spec.cust,
        address: custAddr[spec.cust] || '',
        created: now, updated: now, demo: true,
      };
      _cache.jobs.push(job);
      seededJobs.push({ job, names, hours: spec.hours });
      tracked(setDoc(doc(jobsCol(), id), stripId(job))).catch(err => console.warn("seed.job", err));
      counts.jobs++;
    }

    // ---- recorded hours ----
    // Deliberately NOT a clean copy of the jobs — the point is to show the
    // three states the Hours chart distinguishes:
    //   · a record that agrees with its job          → one green row
    //   · a record that disagrees                    → green row + red row
    //   · a record with no job behind it             → green "no job" row
    // The disagreement lands on the FIRST person of the -6 job; the -5 pair and
    // the -3 job are left unrecorded so there is something to save.
    const disagreeOn = day(-6);
    for (const { job, names } of seededJobs) {
      if (job.date > day(-4)) continue;                 // upcoming work isn't recorded
      for (const n of names) {
        const h = job.employeeHours[n];
        if (h == null) continue;                        // nothing entered on the job
        if (job.date === day(-5)) continue;             // left for you to save
        const recorded = (job.date === disagreeOn && n === names[0]) ? h - 1 : h;
        const id = uid();
        const log = {
          id,
          date: job.date,
          employeeName: n,
          employeeUids: [],
          customerId: job.customerId,
          customerName: job.customerName,
          hours: recorded,
          hoursFormatted: String(recorded),
          note: job.description,
          created: now, updated: now, demo: true,
        };
        _cache.timelogs.push(log);
        tracked(setDoc(doc(timelogsCol(), id), stripId(log))).catch(err => console.warn("seed.timelog", err));
        counts.timelogs++;
      }
    }
    // One record with no job at all — a day someone worked that never made it
    // onto the calendar. It still has to reach QuickBooks.
    {
      const id = uid();
      const orphan = {
        id,
        date: day(-8),
        employeeName: emp(1),
        employeeUids: [],
        customerId: custIds['Anne Bull'] || null,
        customerName: 'Anne Bull',
        hours: 5,
        hoursFormatted: '5',
        note: 'Called out — no job was booked for this',
        created: now, updated: now, demo: true,
      };
      _cache.timelogs.push(orphan);
      tracked(setDoc(doc(timelogsCol(), id), stripId(orphan))).catch(err => console.warn("seed.timelog", err));
      counts.timelogs++;
    }

    // ---- price table ----
    // Vendors are columns in one shared config doc, so like employees they are
    // only seeded into an empty table. Items always seed: they're their own
    // documents and carry demo:true.
    const cfg = this.getPriceConfig();
    let vendors = cfg.vendors;
    if (!vendors.length) {
      vendors = [
        { id: uid(), name: 'Beacon Supply', order: 0 },
        { id: uid(), name: 'Northgate',     order: 1 },
        { id: uid(), name: 'Trade Depot',   order: 2 },
      ];
      demoSeed.vendorIds = vendors.map(v => v.id);
      counts.vendors = vendors.length;
      await this.savePriceConfig({ vendors });
    }
    // [price, days ago, availability]. null = no price from that vendor.
    // Several cells carry two or three entries so the history sheet has
    // something to show, and all four availability states appear.
    const V = vendors.map(v => v.id);
    const priceSpecs = [
      { name: '2x4x8 SPF stud', cells: [
        [[4.29, 30, 'yes'], [4.65, 9, 'yes'], [4.49, 2, 'yes']],
        [[4.55, 12, 'yes']],
        [[4.19, 4, 'soon']],
      ] },
      { name: '1/2" drywall sheet', cells: [
        [[16.80, 21, 'yes'], [17.95, 3, 'yes']],
        [[18.40, 5, 'later']],
        null,
      ] },
      { name: 'Deck screws 5lb', cells: [
        [[42.00, 16, 'yes']],
        [[39.75, 6, 'yes'], [41.20, 1, 'no']],
        [[40.50, 8, 'yes']],
      ] },
      { name: 'Cedar 5/4x6 decking (lin ft)', cells: [
        [[3.85, 40, 'yes'], [4.40, 11, 'later']],
        null,
        [[4.10, 7, 'yes']],
      ] },
      { name: 'Vanity 30" white', cells: [
        null,
        [[289.00, 14, 'soon']],
        [[319.00, 2, 'yes']],
      ] },
      { name: 'LED bulb A19 (6 pack)', cells: [
        [[18.99, 25, 'yes']],
        [[17.49, 10, 'yes']],
        [[21.00, 3, 'no']],
      ] },
    ];
    priceSpecs.forEach((spec, row) => {
      const id = uid();
      const cells = {};
      spec.cells.forEach((entries, col) => {
        if (!entries || !V[col]) return;
        cells[V[col]] = entries.map(([price, ago, avail]) => ({
          price,
          date: day(-ago),
          avail,
          // `added` breaks ties when two entries share a date; spacing them
          // keeps "newest" deterministic rather than dependent on write order.
          added: new Date(Date.now() - ago * 86400000).toISOString(),
        }));
      });
      const item = { id, name: spec.name, order: row, cells, created: now, updated: now, demo: true };
      _cache.priceItems.push(item);
      tracked(setDoc(doc(priceItemsCol(), id), stripId(item))).catch(err => console.warn("seed.priceItem", err));
      counts.priceItems++;
    });

    // Record what went into settings LAST, so a failure earlier can't leave a
    // removal record pointing at things that were never created.
    if (demoSeed.employees.length || demoSeed.keywords.length || demoSeed.vendorIds.length) {
      _cache.settings = { ..._cache.settings, demoSeed };
    }
    if (counts.employees || counts.keywords || demoSeed.vendorIds.length) {
      setDoc(settingsDoc(), _cache.settings, { merge: true }).catch(err => console.warn("seed.settings", err));
    }
    emit();
    return counts;
  },

  hasSampleData() {
    return _cache.notes.some(n => n.demo)
      || _cache.customers.some(c => c.demo)
      || _cache.jobs.some(j => j.demo)
      || _cache.timelogs.some(t => t.demo)
      || _cache.priceItems.some(i => i.demo);
  },

  // What removeSampleData would delete. Returns both the COUNTS (for the
  // confirmation dialog) and the documents themselves, so the dialog and the
  // deletion agree exactly — the caller passes the plan straight back into
  // removeSampleData rather than letting it recount.
  //
  // Jobs and timelogs are swept FROM THE SERVER, not from the cache: the jobs
  // listener only covers a three-month window and timelogs are fetched on
  // demand, so cache-only deletion would silently strand demo records outside
  // whatever happened to be loaded. That's a full read of both collections, but
  // only on an explicit press of a button that isn't even shown unless sample
  // data exists.
  async sampleDataPlan() {
    const notes = _cache.notes.filter(n => n.demo);
    const customers = _cache.customers.filter(c => c.demo);
    const items = _cache.priceItems.filter(i => i.demo);
    let jobs = _cache.jobs.filter(j => j.demo);
    let logs = _cache.timelogs.filter(t => t.demo);
    if (_orgId && _role === 'admin') {
      try {
        const [jSnap, tSnap] = await Promise.all([getDocs(jobsCol()), getDocs(timelogsCol())]);
        jobs = jSnap.docs.filter(d => d.data().demo).map(d => ({ id: d.id, ...d.data() }));
        logs = tSnap.docs.filter(d => d.data().demo).map(d => ({ id: d.id, ...d.data() }));
      } catch (err) {
        console.warn('sampleDataPlan', err);   // fall back to what's cached
      }
    }
    const ds = _cache.settings.demoSeed || {};
    const emps = Array.isArray(_cache.settings.employees) ? _cache.settings.employees : [];
    const empNames = emps.map(e => (typeof e === 'string' ? e : e.name));
    const kws = Array.isArray(_cache.settings.keywords) ? _cache.settings.keywords : [];
    const cfgVendors = this.getPriceConfig().vendors;
    // Only what is still there and still recognisable: anything renamed or
    // removed by hand since seeding is left alone.
    const employees = (ds.employees || []).filter(n => empNames.includes(n));
    const keywords = (ds.keywords || []).filter(k => kws.includes(k));
    const vendorIds = (ds.vendorIds || []).filter(id => cfgVendors.some(v => v.id === id));
    return {
      docs: { notes, customers, jobs, logs, items },
      settings: { employees, keywords, vendorIds },
      counts: {
        customers: customers.length,
        notes: notes.length,
        jobs: jobs.length,
        timelogs: logs.length,
        priceItems: items.length,
        employees: employees.length,
        keywords: keywords.length,
        vendors: vendorIds.length,
      },
    };
  },

  // Removes the demo documents, and the settings entries the seed recorded in
  // settings.demoSeed — matched by name/id, so anything you renamed or added
  // yourself survives.
  async removeSampleData(plan) {
    if (_role !== 'admin') return null;
    const p = plan || await this.sampleDataPlan();
    const { notes, customers, jobs, logs, items } = p.docs;

    const gone = (list) => new Set(list.map(x => x.id));
    const goneNotes = gone(notes), goneCust = gone(customers);
    const goneJobs = gone(jobs), goneLogs = gone(logs), goneItems = gone(items);
    _cache.notes = _cache.notes.filter(n => !goneNotes.has(n.id));
    _cache.customers = _cache.customers.filter(c => !goneCust.has(c.id));
    _cache.jobs = _cache.jobs.filter(j => !goneJobs.has(j.id));
    _cache.timelogs = _cache.timelogs.filter(t => !goneLogs.has(t.id));
    _cache.priceItems = _cache.priceItems.filter(i => !goneItems.has(i.id));

    // ---- settings the seed added ----
    const { employees, keywords, vendorIds } = p.settings;
    let settingsChanged = false;
    if (employees.length) {
      const emps = Array.isArray(_cache.settings.employees) ? _cache.settings.employees : [];
      _cache.settings = {
        ..._cache.settings,
        employees: emps.filter(e => !employees.includes(typeof e === 'string' ? e : e.name)),
      };
      settingsChanged = true;
    }
    if (keywords.length) {
      const kws = Array.isArray(_cache.settings.keywords) ? _cache.settings.keywords : [];
      _cache.settings = { ..._cache.settings, keywords: kws.filter(k => !keywords.includes(k)) };
      settingsChanged = true;
    }
    if (_cache.settings.demoSeed) {
      // null, not delete: this goes out with { merge: true }, which would leave
      // an omitted key sitting on the server.
      _cache.settings = { ..._cache.settings, demoSeed: null };
      settingsChanged = true;
    }
    if (settingsChanged) {
      tracked(setDoc(settingsDoc(), _cache.settings, { merge: true })).catch(err => console.warn("unseed.settings", err));
    }
    // Vendor columns live in the price config, and dropping a column has to
    // drop its cells from every REMAINING row too, or the deleted vendor's
    // prices sit there invisibly and come back if the column is re-added.
    if (vendorIds.length) {
      const cfg = this.getPriceConfig();
      await this.savePriceConfig({ vendors: cfg.vendors.filter(v => !vendorIds.includes(v.id)) });
      for (const item of _cache.priceItems.slice()) {
        if (!item.cells) continue;
        const cells = { ...item.cells };
        let touched = false;
        for (const vid of vendorIds) {
          if (vid in cells) { delete cells[vid]; touched = true; }
        }
        if (touched) await this.savePriceItem(item.id, { cells });
      }
    }

    emit();
    for (const n of notes) tracked(deleteDoc(doc(notesCol(), n.id))).catch(err => console.warn("unseed.note", err));
    for (const c of customers) tracked(deleteDoc(doc(customersCol(), c.id))).catch(err => console.warn("unseed.customer", err));
    for (const j of jobs) tracked(deleteDoc(doc(jobsCol(), j.id))).catch(err => console.warn("unseed.job", err));
    for (const t of logs) tracked(deleteDoc(doc(timelogsCol(), t.id))).catch(err => console.warn("unseed.timelog", err));
    for (const i of items) tracked(deleteDoc(doc(priceItemsCol(), i.id))).catch(err => console.warn("unseed.priceItem", err));
    return p.counts;
  },

  isOrgEmpty() {
    return _cache.notes.length === 0 && _cache.customers.length === 0;
  },

  // ---------- Aggregator ----------
  aggregateParagraphsByKeyword(keyword) {
    if (!keyword) return [];
    const kwLower = keyword.toLowerCase();
    const results = [];
    for (const note of this.liveNotes()) {
      // General notes (no customerId) ARE aggregated — the app labels them
      // with the note title (plus the owner's name when it isn't the viewer's).
      if (note.customerId && _customersReady && !this.liveCustomers().find(c => c.id === note.customerId)) {
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
    return this.liveNotes().filter(n =>
      n.customerId && !this.liveCustomers().find(c => c.id === n.customerId)
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
      await tracked(setDoc(settingsDoc(), _cache.settings, { merge: true }));
    } catch (err) {
      console.warn("writeSettings", err);
    }
  },

  async setSetting(key, value) {
    _cache.settings = { ...DEFAULT_SETTINGS, ..._cache.settings, [key]: value };
    emit();
    try {
      await tracked(setDoc(settingsDoc(), _cache.settings, { merge: true }));
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
    tracked(setDoc(doc(notesCol(), noteId), stripId(next))).catch(err => console.warn("assignUsersToNote", err));
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
      tracked(setDoc(doc(notesCol(), n.id), stripId(updated))).catch(err => console.warn("backfill customerName", err));
    });
  },
  getMember(uid) { return _cache.members.find(m => m.uid === uid) || null; },

  // Which getting-started cards this PERSON has dismissed, kept on their own
  // member doc rather than in org settings. Two admins of a new company each
  // get the offer and each dismiss it for themselves; and because it lives on
  // the server (streamed by the members listener) a dismissal on the phone is
  // already gone on the laptop.
  gettingStartedDismissed() {
    const me = _cache.members.find(m => m.uid === _uid);
    const gs = (me && me.gettingStarted) || {};
    return { tour: !!gs.tour, sample: !!gs.sample };
  },
  async dismissGettingStarted(card) {
    if (!_uid || !_orgId) return;
    if (card !== 'tour' && card !== 'sample') return;
    const next = { ...this.gettingStartedDismissed(), [card]: true };
    // Mirror into the cache so the card goes NOW — the listener round-trip is
    // fast but not instant, and a ✕ that visibly does nothing gets pressed again.
    const i = _cache.members.findIndex(m => m.uid === _uid);
    if (i !== -1) _cache.members[i] = { ..._cache.members[i], gettingStarted: next };
    emit();
    await tracked(setDoc(doc(membersCol(), _uid), { gettingStarted: next }, { merge: true }))
      .catch(err => console.warn('dismissGettingStarted', err));
  },

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
      tracked(setDoc(doc(notesCol(), n.id), stripId(updated))).catch(err => console.warn("unassign", err));
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
      tracked(setDoc(doc(notesCol(), n.id), stripId(updated))).catch(err => console.warn("cleanup assignments", err));
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
      tracked(setDoc(doc(notesCol(), n.id), stripId(updated))).catch(err => console.warn("cleanup elevated assignments", err));
    });
    emit();
  },

  // ---------- Invites ----------
  listInvites() { return _cache.invites.slice(); },

  async inviteUser(email, role) {
    if (!email || !role) return;
    const emailKey = emailKeyOf(email);
    const clean = cleanEmail(email);
    const batch = writeBatch(db);
    // Store in org's invites collection
    batch.set(doc(invitesCol(), emailKey), { email: clean, role, invitedAt: nowIso(), invitedBy: _uid });
    // Store lookup so sign-in can find it
    batch.set(doc(db, `inviteLookup/${emailKey}`), { orgId: _orgId, role, email: clean });
    await batch.commit();
  },

  // Invite someone to start THEIR OWN COMPANY — a separate org they administer,
  // with none of your data in it. The lookup row names no target org, because
  // the org doesn't exist yet; resolveOrg creates it when they first sign in.
  //
  // A copy goes in this org's invites collection purely so it appears in your
  // pending list and can be cancelled. It is NOT an invitation to join here,
  // and the sign-in path never reads it — hence role:'admin' AND kind:'newOrg',
  // so anything that treats it as an ordinary invite still shows something
  // sensible rather than a blank.
  async inviteNewOrg(email, companyName) {
    if (!email) return;
    if (!this.canInviteNewOrg()) {
      const err = new Error('Only the founder account can start a new company.');
      err.code = 'app/not-founder';
      throw err;
    }
    const emailKey = emailKeyOf(email);
    const clean = cleanEmail(email);
    const name = String(companyName || '').trim();
    // The new org's id is chosen HERE, not at sign-in, and the rules pin the
    // creation to it — so one invite buys exactly one company.
    const newOrgId = uid();
    const expiresAt = Date.now() + NEW_ORG_INVITE_DAYS * 86400000;
    const batch = writeBatch(db);
    batch.set(doc(invitesCol(), emailKey), {
      email: clean, role: 'admin', kind: 'newOrg', companyName: name,
      newOrgId, expiresAt, invitedAt: nowIso(), invitedBy: _uid,
    });
    batch.set(doc(db, `inviteLookup/${emailKey}`), {
      kind: 'newOrg', email: clean, companyName: name,
      newOrgId, expiresAt, issuedByOrg: _orgId, issuedBy: _uid,
    });
    await batch.commit();
  },

  async cancelInvite(email) {
    const emailKey = emailKeyOf(email);
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
