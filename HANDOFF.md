# Note Aggregator — Handoff Document

**For:** the next agent picking up this project after Rebecca Bultsma (the user).
**Status as of:** May 25, 2026, version v14.
**User context:** Rebecca was building this app for someone else (the `ddemic-ktown` GitHub account owner). All deployment + Firebase work happens under that account, not hers.

---

## 1. What this app is

A mobile-first Progressive Web App (PWA) for a trades-person or any small-business owner who needs:

- **Free-form notes** (like Google Keep / SimpleNote).
- **Customer records** — each customer is essentially a "default note" (`isDefault: true`) whose first line is treated as the customer name and the rest of the body holds contact info. Each customer also has their own list of additional notes.
- **Keyword aggregation** — user-configurable keywords (set in Settings). Any paragraph in any customer note whose first line starts with that keyword gets aggregated onto a card on the home screen and into a dedicated detail view per keyword.
- **Home-screen layout** — a pinned Customers card, configurable pinned sections (Aggregator notes, Recent customer notes, Generic notes), and a Settings cog.

The data lives in **Firebase Firestore**, gated by **Google sign-in**. Each authenticated user only sees their own data via security rules.

---

## 2. Where everything lives

### Local filesystem
- **Project root:** `~/note-aggregator/` on Rebecca's Mac (`/Users/rebeccabultsma/note-aggregator/`).
- **Backup snapshot taken May 24, 2026 (before Firebase migration):**
  - `~/note-aggregator-backup-2026-05-25/` (folder)
  - `~/note-aggregator-backup-2026-05-25.zip` (also emailed to ddemic@yahoo.com)

### Remote
- **GitHub repo:** https://github.com/ddemic-ktown/notes-y2fxcvusvd (public)
- **Live URL:** https://ddemic-ktown.github.io/notes-y2fxcvusvd/
- **Firebase project ID:** `note-aggregator`
- **Firebase console:** https://console.firebase.google.com/project/note-aggregator

### GitHub auth
Both `rbultsma` (Rebecca's GitHub account) and `ddemic-ktown` (the project owner) are logged in via `gh` CLI. The active account is `ddemic-ktown`. Push uses HTTPS with the gh credential helper (`gh auth setup-git` was run). To switch accounts: `gh auth switch -u <user>`.

When committing, the email/name are pinned per-commit so authorship is correct:
```bash
git -c user.email="ddemic@yahoo.com" -c user.name="ddemic-ktown" commit -m "..."
```

---

## 3. Architecture

### Files
```
note-aggregator/
├── index.html              # Single-page shell with all screens as <section>s
├── styles.css              # Mobile-first stylesheet
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker (offline cache + auto-update)
├── firestore.rules         # Security rules (deployed via Firebase console, not gh)
├── icons/                  # PWA icons (PNG, generated with Python/PIL)
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── icon-512-maskable.png
│   ├── apple-touch-icon.png
│   └── favicon.png
├── js/
│   ├── firebase-init.js    # Firebase app/auth/Firestore initialization (ESM, loads SDK from gstatic)
│   ├── storage.js          # Single seam for ALL data ops — in-memory cache + real-time Firestore listeners
│   └── app.js              # Everything else: UI wiring, screen routing, editor logic, settings
├── README.md
└── HANDOFF.md              # This file
```

### Key architectural decisions

1. **No build step.** Plain ES modules served as static files. `index.html` loads `js/app.js` as `type="module"`; that module imports `storage.js` and `firebase-init.js`. The Firebase SDK is pulled from `https://www.gstatic.com/firebasejs/10.14.1/` via dynamic ESM imports. This keeps the workflow simple: edit a file, commit, push, GitHub Pages serves it.

2. **`storage.js` is the single seam.** All data reads/writes go through `Storage.*` methods. The module maintains an in-memory cache populated by Firestore `onSnapshot` listeners. Cache reads are synchronous (so the rest of the app can use `Storage.listNotes()` etc. without `await`); writes update the cache immediately and fire-and-forget the Firestore write. Real-time listeners merge in changes from other devices.

3. **Sign-in flow.** `onAuthStateChanged` in `app.js` drives the boot sequence:
   - Not signed in → `signin-view` is the only visible screen.
   - Signed in → `Storage.init(uid)` attaches listeners, we wait for the first snapshot, then `Storage.maybeMigrateFromLocalStorage()` runs (one-time migration from the old localStorage data model), then we show the notes home screen.
   - On every cache update, `rerenderCurrent()` re-renders the currently visible list/screen (unless the editor is active — we don't redraw mid-edit).

4. **PWA + auto-update.** The service worker (`sw.js`) caches same-origin assets with cache-first strategy and Firebase SDK URLs with stale-while-revalidate. Both `sw.js` (`VERSION = 'na-vNN'`) and `app.js` (`APP_VERSION = 'vNN'`) are bumped together on every push so the SW cache invalidates and the home toolbar shows the new version. Since v13, the SW registration in `app.js` listens for `updatefound` and reloads the page when a new SW finishes installing — installed PWAs update themselves on next launch.

---

## 4. Data model (Firestore)

All paths are user-scoped:

```
users/{uid}/
├── notes/{noteId}                # All notes — global notes have customerId=null
│   ├── body: string              # First line acts as title (split on \n)
│   ├── customerId: string|null   # If set, this note belongs to a customer
│   ├── isDefault: boolean        # The "default note" per customer that holds contact info
│   ├── created: ISO timestamp
│   └── updated: ISO timestamp
├── customers/{customerId}        # Minimal — most info lives in the default note
│   ├── created: ISO timestamp
│   └── updated: ISO timestamp
└── settings/preferences          # Single doc holding all UI settings
    ├── recentCount: number       # 0–20, default 4
    ├── aggregatorCount: number   # 0–50, default 4
    ├── pinnedOrder: string[]     # subset/permutation of ['aggregator','recent','notes']
    ├── keywords: string[]        # Aggregator keywords, case-insensitive de-duped
    └── customerSort: 'alpha'|'recent'
```

### Conventions
- IDs are generated client-side via `Date.now().toString(36) + random` (see `uid()` in `storage.js`).
- `created` / `updated` are ISO strings, not Firestore timestamps (chosen for code simplicity; if you ever want server-side sort guarantees, switch to `serverTimestamp()`).
- A "customer" is fully defined by their default note. The customer doc itself only carries timestamps. The default note's body's first line is rendered as the customer's name everywhere it matters (sort, card title, back-button labels, customer-link chip).
- Empty default-note-body customers are auto-deleted when the user backs out without typing anything — see `commitAndCleanupEditor()` in `app.js`.

### Firestore security rules

Deployed in the Firebase console (Firestore Database → Rules). Source of truth is `firestore.rules`:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

**Important:** rules are NOT auto-deployed when you push to GitHub. If you change `firestore.rules`, you must paste the new content into the Firebase console manually (or set up `firebase-tools` CLI with `firebase deploy --only firestore:rules`).

---

## 5. Screens and how they connect

| Screen DOM id | Purpose |
|---|---|
| `signin-view` | Shown when not authenticated; Google sign-in button. |
| `list-view` | Home screen. Renders: Customers nav card → pinned sections (order from settings) → global notes. |
| `customers-view` | Customer list with toolbar (search input, A–Z / Recent sort buttons, +FAB). |
| `customer-notes-view` | Per-customer note list. Header shows the customer's name (from their default note's first line). |
| `aggregator-view` | Per-keyword detail view — list of matched paragraphs across all customers. |
| `editor-view` | The note editor. **Positioned `fixed; inset: 0`** so its toolbar can never scroll off. Body has class `editor-open` while active (locks page scroll). |
| `settings-view` | Counts, pinned section order, keyword list, CSV import, sign-out. |

### Editor toolbar
Two rows on every screen size:
- **Row 1 (nav):** `← BackLabel` (hidden if back would just go home), `⌂` home, `[Customer chip ›]` (hidden if back already goes to that customer's notes), `Today`, `Date…`, `🗑` delete (hidden for the pinned default note).
- **Row 2 (tools):** `Find in note` input, match counter, `↑`/`↓` prev/next, `☐` checkbox toggle.

### Return-path tracking
The editor remembers where it was opened from in module-level state (`returnScreen`, `activeCustomerId`, `activeKeyword`). The back arrow's label is set dynamically in `showEditor()`. The customer-notes screen has its own `customerNotesReturnTo` so it knows whether to return to the customer list or the aggregator detail (depending on how the user arrived).

---

## 6. Notable features and where they live

- **Date insertion** — `Today` button (`dateTodayBtn`) and `Date…` button (`datePickerBtn`) in editor toolbar. Today inserts immediately. Date… opens a `<input type="date">` popover; the picker's `change` event inserts and closes the popover — no separate Insert button.
- **In-note search** — Always-visible input on row 2 of editor toolbar. Finds matches with `findMatches()`, navigates with `gotoMatch()`. To preserve focus in the search input while highlighting matches, `gotoMatch()` calls `bodyInput.setSelectionRange()` WITHOUT calling `bodyInput.focus()` — the selection renders in the inactive-selection gray color, which is the intended UX. Manual scroll-to-line math compensates for the lack of focus auto-scroll.
- **Checkbox toggling** — The `☐` toolbar button operates on the current line or all lines in the current selection. Clicking on an existing `☐ ` or `☑ ` at the start of a line toggles it via a click handler on `bodyInput`.
- **Aggregator** — `Storage.aggregateParagraphsByKeyword(kw)` scans all customer notes (filters by `customerId` non-null), splits each body on blank lines, matches paragraphs whose first line starts with the keyword (word-bounded). The home card shows the customer name + comma-joined list from the first match. The detail view (`aggregator-view`) shows every match with the customer-name tag, full paragraph, and date.
- **Open-at-paragraph** — When a user taps a match card on the aggregator detail view, `showEditor(note, 'note', { paragraph })` runs. After the 50ms focus delay, the code searches the body textarea for the paragraph (or progressively shorter suffixes if the paragraph spans the title line), positions the cursor there, and scrolls.
- **CSV import** — Settings → "Import customers from CSV". Each row becomes a customer; non-empty cells are joined by newlines into the customer's default-note body. Parsed inline in `app.js` via `parseCsv()` (handles quoted fields with embedded commas). Storage method: `Storage.importCustomers(rows)` — uses a Firestore `writeBatch`.
- **Per-device migration** — On first sign-in (or any sign-in where Firestore has no data and localStorage does), `Storage.maybeMigrateFromLocalStorage()` runs. Migrates notes, customers, and the old localStorage settings keys (`note-aggregator/recent-count`, `note-aggregator/aggregator-count`, `note-aggregator/keywords`, `note-aggregator/pinned-order`, `note-aggregator/customer-sort`) into the Firestore settings doc. Then clears the localStorage entry so it doesn't re-migrate.

---

## 7. Version bumping protocol

**Every time you push a change, bump TWO numbers:**

1. `APP_VERSION` in `js/app.js` (the const near the top): `'v14'` → `'v15'`
2. `VERSION` in `sw.js`: `'na-v14'` → `'na-v15'`

This is what makes the service worker invalidate its cache, install a new SW, and trigger the auto-reload logic. If you forget, users on installed PWAs may keep seeing the old version even after a successful GitHub push.

The number shown in the home toolbar (top right of the home screen) reflects `APP_VERSION` and is useful for confirming the user is actually running the latest deployed code.

---

## 8. Deployment flow

```bash
# Confirm you're on the right gh account
gh auth status     # should show ddemic-ktown active

# Make changes locally, then:
cd ~/note-aggregator
git add -A
git -c user.email="ddemic@yahoo.com" -c user.name="ddemic-ktown" commit -m "<message>"
git push

# GitHub Pages rebuilds in ~30 seconds. Poll if you want:
for i in 1 2 3 4 5; do sleep 15; gh api repos/ddemic-ktown/notes-y2fxcvusvd/pages | grep -o '"status":"[^"]*"'; done
```

GitHub's push endpoint had Internal Server Error several times on May 25 — usually clears in a few minutes; just retry. Don't spam retries.

### Local dev server
```bash
cd ~/note-aggregator
python3 -m http.server 8000
# then http://localhost:8000
```

`localhost` is already in Firebase's authorized domains, so Google sign-in works from there. Service worker behavior on `localhost` can be flaky during dev; if you change `sw.js`, hard-refresh (Cmd+Shift+R) or unregister via DevTools → Application → Service Workers.

---

## 9. Firebase config

`js/firebase-init.js` contains:
```js
const firebaseConfig = {
  apiKey: "AIzaSyBha2lna5MA_AzE5EfScLbWTEadVj6vzoA",
  authDomain: "note-aggregator.firebaseapp.com",
  projectId: "note-aggregator",
  storageBucket: "note-aggregator.firebasestorage.app",
  messagingSenderId: "985348478275",
  appId: "1:985348478275:web:1f91fd3ae65971546dcbf6"
};
```

**These keys are safe to commit publicly** — they identify the project, not authorize access. Security comes from Firestore rules + Google auth.

### Things that must be configured in the Firebase console (NOT in code)
- Firestore database created (region `nam5` or wherever they picked)
- Security rules deployed (paste contents of `firestore.rules` into Firestore → Rules tab)
- Google sign-in provider enabled (Authentication → Sign-in method → Google → Enable + support email)
- Authorized domains include: `localhost`, `note-aggregator.firebaseapp.com`, `note-aggregator.web.app`, `ddemic-ktown.github.io`

---

## 10. Important user preferences and constraints (read these before suggesting changes)

These reflect feedback Rebecca gave during the iteration:

- **Iterate in small, testable chunks.** She prefers one change per ask, asks questions one at a time, and tests on the live site between changes. Don't bundle five UI changes into one commit.
- **Mobile is the primary surface.** The app is intended to be installed as a PWA on Android. Test mobile layout before considering anything "done."
- **No long explanations unless asked.** Confirm what you did and offer the next move. Don't lecture about CSS or PWAs.
- **Don't ask clarifying questions before doing work** unless the choice is truly user-visible. Auto-mode bias toward action.
- **The "fixed toolbar" requirement is non-negotiable.** The editor toolbar must always be visible at the top regardless of note length, cursor position, or keyboard state. Several attempts before the v12 → v14 lineage finally worked. If you change the editor layout, re-verify this on Android.
- **Email confirmations:** when the user asks you to email something to `ddemic@yahoo.com`, use the `mcp__gmail__send_email` tool with both `body` and `htmlBody` (HTML for proper line reflow per Rebecca's standing preference for email formatting).

---

## 11. Known weak spots / future work

- **No conflict resolution.** If the same note is edited on two devices simultaneously, last-write-wins. For a single-user app this is fine; if it's ever shared, add a real CRDT.
- **No undo.** Deleting a customer cascades to all their notes. Confirm dialogs are the only safety net.
- **CSV import has no dedupe.** Re-importing the same data creates duplicates. If the user imports a master list a second time after adding notes, it'll create parallel customers.
- **The customer-link chip layout when hidden** (i.e., for a global note opened from home) leaves the right-side toolbar buttons clumped to the left of row 1. Not broken, just visually loose. A spacer or `:has()` rule could fix it.
- **Offline cold-start.** Firestore's IndexedDB cache + the SW caching of gstatic SDK URLs should make cold-offline boot work, but I never confirmed it end-to-end. If Rebecca reports "doesn't work in airplane mode after a day," that's the likely cause — investigate `enableIndexedDbPersistence` / `persistentLocalCache` setup in `firebase-init.js`.
- **Service worker scope.** It's set to `./` which is the repo path. If you ever move the app to a custom domain, double-check `start_url` and `scope` in `manifest.json`.
- **No way to rename the default-note title from the customer card directly.** You have to tap the card → enter the customer notes screen → tap the pinned default note → edit. This is intentional but if it gets cumbersome, surface inline edit.

---

## 12. The most recent unresolved item

As of v14, the user reported on Android: "when I open a long note, the toolbar still isn't visible at first." The chain of fixes was:
1. `position: sticky` on `.app-header` — didn't fully work.
2. `position: fixed; inset: 0` on `#editor-view.active` (v12) — better but still had issues with body scroll.
3. `body.editor-open { position: fixed; overflow: hidden; height: 100dvh; }` toggled by JS when entering/leaving editor (v14) — should fully lock page-level scroll.

The user left without confirming v14 fixed it. **If they report the toolbar still slips off-screen:**
- Verify `document.body.classList.add('editor-open')` is firing on entry (check element class in DevTools).
- Check whether Android Chrome's URL bar / keyboard insets are affecting `100dvh` rendering.
- Consider explicitly setting `bodyInput.scrollTop = bodyInput.scrollHeight` after focus to ensure the textarea's internal scroll matches the cursor position.
- As a last resort, use `position: sticky` on the toolbar combined with `overflow-anchor: none` on the body to prevent automatic re-anchoring.

---

## 13. How to continue with Rebecca's preferred workflow

1. **Read the most recent few messages of her chat** for what was last requested.
2. **Make the smallest viable change.** Bump both version constants. Commit. Push.
3. **Confirm what changed in one sentence**, mention the version it landed in, and ask "next?"
4. If a UI change is mobile-only, verify on a mobile-emulated viewport before reporting it as done.
5. If the user goes silent for a while, **do not** keep iterating speculatively. Wait for a concrete ask.

---

## 14. Quick-reference commands

```bash
# Status
git log --oneline -5
gh auth status

# Local dev
python3 -m http.server 8000 -d ~/note-aggregator

# Pages status
gh api repos/ddemic-ktown/notes-y2fxcvusvd/pages | jq '.status, .html_url'

# Live URL test
curl -s -o /dev/null -w "%{http_code}\n" https://ddemic-ktown.github.io/notes-y2fxcvusvd/

# Firestore probe (returns 403 if rules are in place and you're unauth)
curl -s "https://firestore.googleapis.com/v1/projects/note-aggregator/databases/(default)/documents/users/test"
```

---

End of handoff.
