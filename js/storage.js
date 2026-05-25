// storage.js — single seam for all data reads/writes.
// Phase 1: localStorage. Phase 2 (later): swap internals for cloud sync.
const Storage = (() => {
  const KEY = 'note-aggregator/v1';

  const empty = () => ({ notes: [], customers: [] });

  const load = () => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return empty();
      const parsed = JSON.parse(raw);
      return {
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        customers: Array.isArray(parsed.customers) ? parsed.customers : [],
      };
    } catch (e) {
      console.warn('Storage load failed, starting fresh', e);
      return empty();
    }
  };

  const save = (data) => localStorage.setItem(KEY, JSON.stringify(data));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // Notes with customerId == null are "global" (home screen). Others belong to a customer.
  const listNotes = () => {
    return load().notes
      .filter(n => !n.customerId)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  };

  const listNotesByCustomer = (customerId) => {
    const all = load().notes.filter(n => n.customerId === customerId);
    const defaults = all.filter(n => n.isDefault);
    const rest = all.filter(n => !n.isDefault)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
    return [...defaults, ...rest];
  };

  const getNote = (id) => load().notes.find(n => n.id === id) || null;

  const listRecentCustomerNotes = (limit = 4) => {
    return load().notes
      .filter(n => n.customerId)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
      .slice(0, limit);
  };

  // Returns paragraphs (across all customer notes) whose first line starts with `keyword`
  // followed by either end-of-line or a non-alphanumeric character.
  const aggregateParagraphsByKeyword = (keyword) => {
    if (!keyword) return [];
    const kwLower = keyword.toLowerCase();
    const data = load();
    const results = [];
    for (const note of data.notes) {
      if (!note.customerId) continue;
      const paragraphs = (note.body || '').split(/\n[ \t]*\n/);
      for (const para of paragraphs) {
        const trimmed = para.replace(/^\s+|\s+$/g, '');
        if (!trimmed) continue;
        const firstLine = trimmed.split('\n')[0];
        const lower = firstLine.toLowerCase();
        if (!lower.startsWith(kwLower)) continue;
        const next = lower[kwLower.length];
        if (next !== undefined && /[a-z0-9]/.test(next)) continue;
        results.push({
          noteId: note.id,
          customerId: note.customerId,
          paragraph: trimmed,
          updated: note.updated,
        });
      }
    }
    results.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
    return results;
  };

  const createNote = (opts = {}) => {
    const data = load();
    const now = new Date().toISOString();
    const note = {
      id: uid(),
      body: opts.body || '',
      customerId: opts.customerId || null,
      isDefault: !!opts.isDefault,
      created: now,
      updated: now,
    };
    data.notes.push(note);
    save(data);
    return note;
  };

  const ensureDefaultNoteForCustomer = (customerId) => {
    const data = load();
    let def = data.notes.find(n => n.customerId === customerId && n.isDefault);
    if (def) return def;
    const now = new Date().toISOString();
    def = {
      id: uid(),
      body: 'Current',
      customerId,
      isDefault: true,
      created: now,
      updated: now,
    };
    data.notes.push(def);
    save(data);
    return def;
  };

  const updateNote = (id, body) => {
    const data = load();
    const i = data.notes.findIndex(n => n.id === id);
    if (i === -1) return null;
    data.notes[i] = { ...data.notes[i], body, updated: new Date().toISOString() };
    save(data);
    return data.notes[i];
  };

  const deleteNote = (id) => {
    const data = load();
    data.notes = data.notes.filter(n => n.id !== id);
    save(data);
  };

  // --- Customers ---
  const listCustomers = () => {
    return load().customers.slice().sort((a, b) =>
      new Date(b.updated).getTime() - new Date(a.updated).getTime()
    );
  };

  const getCustomer = (id) => load().customers.find(c => c.id === id) || null;

  const getDefaultNoteForCustomer = (customerId) => {
    return load().notes.find(n => n.customerId === customerId && n.isDefault) || null;
  };

  const createCustomer = () => {
    const data = load();
    const now = new Date().toISOString();
    const customer = { id: uid(), created: now, updated: now };
    data.customers.push(customer);
    const defaultNote = {
      id: uid(),
      body: '',
      customerId: customer.id,
      isDefault: true,
      created: now,
      updated: now,
    };
    data.notes.push(defaultNote);
    save(data);
    return { customer, defaultNote };
  };

  const updateCustomer = (id, patch) => {
    const data = load();
    const i = data.customers.findIndex(c => c.id === id);
    if (i === -1) return null;
    data.customers[i] = { ...data.customers[i], ...patch, updated: new Date().toISOString() };
    save(data);
    return data.customers[i];
  };

  const deleteCustomer = (id) => {
    const data = load();
    data.customers = data.customers.filter(c => c.id !== id);
    // Cascade: remove all notes attached to this customer
    data.notes = data.notes.filter(n => n.customerId !== id);
    save(data);
  };

  return {
    listNotes, listNotesByCustomer, listRecentCustomerNotes, aggregateParagraphsByKeyword,
    getNote, createNote, updateNote, deleteNote,
    ensureDefaultNoteForCustomer,
    listCustomers, getCustomer, getDefaultNoteForCustomer,
    createCustomer, updateCustomer, deleteCustomer,
  };
})();
