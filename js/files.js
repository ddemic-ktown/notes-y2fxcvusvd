// files.js — per-customer files stored LOCALLY on this device (IndexedDB).
// Files never sync to the cloud: they exist only on the device that added them.
// Sharing uses the phone's native share sheet (Web Share API).

const DB_NAME = 'jobpilot-files';
const DB_VERSION = 1;
const STORE = 'files';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('byCustomer', 'customerId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function txStore(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const LocalFiles = {
  // Ask the browser to protect this origin's storage from automatic eviction.
  // Best-effort — iOS in particular gives no hard guarantee.
  async requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        return await navigator.storage.persist();
      }
    } catch (e) { /* non-fatal */ }
    return false;
  },

  async add(customerId, file) {
    const db = await openDB();
    const rec = {
      id: uid(),
      customerId,
      name: file.name || 'file',
      type: file.type || 'application/octet-stream',
      size: file.size || 0,
      blob: file,
      addedAt: new Date().toISOString(),
    };
    await new Promise((resolve, reject) => {
      const req = txStore(db, 'readwrite').put(rec);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    return rec;
  },

  async list(customerId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = txStore(db, 'readonly').index('byCustomer').getAll(customerId);
      req.onsuccess = () => {
        const recs = req.result || [];
        recs.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
        resolve(recs);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async get(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = txStore(db, 'readonly').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async remove(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = txStore(db, 'readwrite').delete(id);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
  },

  // Share via the phone's native share sheet. Returns:
  // 'shared' | 'unsupported' | 'cancelled'
  async share(rec) {
    const file = new File([rec.blob], rec.name, { type: rec.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return 'shared';
      } catch (e) {
        return 'cancelled'; // user dismissed the sheet
      }
    }
    return 'unsupported';
  },
};
