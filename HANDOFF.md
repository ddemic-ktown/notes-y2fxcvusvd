# Company Organizer Ninja — Handoff Document

**Status as of:** May 2026, version v47  
**Live URL:** https://ddemic-ktown.github.io/notes-y2fxcvusvd/  
**GitHub repo:** https://github.com/ddemic-ktown/notes-y2fxcvusvd  
**Firebase project:** note-aggregator  
**Firebase console:** https://console.firebase.google.com/project/note-aggregator  

---

## 1. What This App Is

A mobile-first Progressive Web App (PWA) for small business owners and tradespeople to manage their day-to-day operations. Key use cases include notes, tracking hours, materials, todos, and customer records.

- **Free-form notes** — write anything: job notes, reminders, observations
- **Hour tracking** — log time spent on jobs per customer
- **Materials tracking** — record materials used or needed per job
- **Todo lists** — track outstanding tasks per customer or job
- **Customer records** — each customer has a default note for contact info, plus additional notes
- **Keyword aggregator** — scans all customer notes for configured keywords and surfaces matching paragraphs on the home screen. Examples: `todo` (outstanding tasks), `material` (materials needed), `hours` (time tracking), `invoice` (billing reminders), `call` (follow-up calls)
- **Multi-user orgs** — admin, employee, and customer roles with per-note assignment
- **Syncs across devices** via Firebase Firestore with Google sign-in

---

## 2. Where Everything Lives

### Local
- **Project folder:** `~/Downloads/notes-y2fxcvusvd/`
- **Plan document:** `~/Downloads/notes-y2fxcvusvd/app-store-plan.md`

### Remote
- **GitHub repo:** https://github.com/ddemic-ktown/notes-y2fxcvusvd
- **Live URL:** https://ddemic-ktown.github.io/notes-y2fxcvusvd/
- **Firebase project ID:** `note-aggregator`

### GitHub auth
- Active account: `ddemic-ktown` via `gh` CLI
- Push with: `git -c user.email="ddemic@yahoo.com" -c user.name="ddemic-ktown" commit -m "..."`

---

## 3. Architecture

### Files
```
notes-y2fxcvusvd/
├── index.html              # Single-page shell with all screens as <section>s
├── styles.css              # Mobile-first stylesheet, dark mode default
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker (offline cache + auto-update)
├── firestore.rules         # Security rules (deploy via Firebase console)
├── app-store-plan.md       # Business/launch plan document
├── icons/                  # PWA icons
├── js/
│   ├── firebase-init.js    # Firebase app/auth/Firestore initialization
│   ├── storage.js          # All data ops — in-memory cache + Firestore listeners
│   └── app.js              # UI wiring, screen routing, editor logic, settings
└── HANDOFF.md              # This file
```

### Key architectural decisions

1. **No build step.** Plain ES modules, no framework. Edit a file, commit, push, GitHub Pages serves it.

2. **`storage.js` is the single seam.** All data reads/writes go through `Storage.*`. Maintains an in-memory cache populated by Firestore `onSnapshot` listeners.

3. **Multi-user org structure.** All data lives under `orgs/{orgId}/`. Each user who signs in gets their own org (admin role). Users can invite others as admin, employee, or customer.

4. **Sign-in flow.** `onAuthStateChanged` → `Storage.init(uid, email)` → resolves org (creates or joins via invite) → attaches Firestore listeners → migrates old data if needed → renders home screen.

5. **PWA + auto-update.** Service worker caches assets. Both `sw.js` (`VERSION`) and `app.js` (`APP_VERSION`) must be bumped together on every push.

---

## 4. Data Model (Firestore)

```
orgs/{orgId}/
├── members/{uid}              → { role, email, name, joinedAt }
├── invites/{emailKey}         → { email, role, invitedAt, invitedBy }
├── notes/{noteId}             → { body, customerId, isDefault, assignedTo[], created, updated }
├── customers/{customerId}     → { created, updated }
└── settings/preferences       → { recentCount, aggregatorCount, pinnedOrder, keywords, customerSort }

users/{uid}                    → { orgId }  (pointer to user's org)
inviteLookup/{emailKey}        → { orgId, role, email }  (for invite resolution on sign-in)
```

### Roles
- **admin** — full access to everything
- **employee** — read/write notes and customers; only sees notes assigned to them or with empty assignedTo
- **customer** — read-only; only sees notes assigned to them or with empty assignedTo

### Per-note assignment
Each note has `assignedTo: [uid, ...]`. Empty array = admin-only (not visible to employees or customers). A user must be explicitly listed in `assignedTo` to see the note. Admins always see everything regardless.

---

## 5. Screens

| Screen DOM id         | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `signin-view`         | Google sign-in                                       |
| `list-view`           | Home screen — customers card, aggregator, notes      |
| `customers-view`      | Customer list with search and sort                   |
| `customer-notes-view` | Per-customer note list                               |
| `aggregator-view`     | Per-keyword detail — matched paragraphs              |
| `editor-view`         | Note editor with search, checkboxes, assign button   |
| `settings-view`       | Settings — counts, keywords, users, invite, theme    |

---

## 6. Notable Features

- **Keyword aggregator** — scans customer notes line-by-line for keyword matches (not just blank-line-separated paragraphs)
- **Auto-continue lists** — pressing Enter on a line starting with `- ` or `☐ ` continues the list
- **Search highlighting** — overlay div behind textarea shows yellow highlights for all matches, orange for current
- **Dark mode** — default, toggled in Settings, persisted in localStorage
- **Android back button** — handled via History API pushState/popstate
- **Section labels** — home screen shows "Aggregators:", "Recent Notes:", "General Notes:" above each section
- **Assign users** — admin can assign notes to specific members via Assign button in editor toolbar
- **Users tab in Settings** — list members, change roles, remove, invite by email

---

## 7. Version Bumping Protocol

**Every push must bump TWO numbers:**

1. `APP_VERSION` in `js/app.js` (e.g. `'v44'` → `'v45'`)
2. `VERSION` in `sw.js` (e.g. `'na-v44'` → `'na-v45'`)

**For AI assistants:** on every code change, without being asked:
- Bump both version numbers (`APP_VERSION` in `app.js` and `VERSION` in `sw.js`)
- Update the "Current version" line below to match
- Update the "Status as of" line at the top of this file to reflect the new version
- In the chat response, explicitly state the new version number (e.g. "Updated to v47")

Current version: **v47**

---

## 8. Deployment Flow

```bash
# Confirm gh account
gh auth status   # should show ddemic-ktown

# Make changes, bump versions, then:
cd ~/Downloads/notes-y2fxcvusvd
git add -A
git -c user.email="ddemic@yahoo.com" -c user.name="ddemic-ktown" commit -m "vXX: description"
git push
```

GitHub Pages rebuilds in ~30 seconds.

### Firestore rules
Rules are NOT auto-deployed on push. If `firestore.rules` changes, paste contents into Firebase console → Firestore Database → Rules tab → Publish.

### Local dev server
```bash
cd ~/Downloads/notes-y2fxcvusvd
python3 -m http.server 8000
# then http://localhost:8000
```

---

## 9. Firebase Config

In `js/firebase-init.js`:
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

These keys are safe to commit publicly. Security comes from Firestore rules + Google auth.

### Firebase console configuration (not in code)
- Firestore database enabled
- Security rules deployed (paste `firestore.rules` into Firestore → Rules)
- Google sign-in enabled (Authentication → Sign-in method)
- Authorized domains: `localhost`, `note-aggregator.firebaseapp.com`, `ddemic-ktown.github.io`

---

## 10. Known Issues / Future Work

- **Subscription gate:** Currently any Google user can create a free org. When Stripe is added, org creation should be gated behind a valid subscription.
- **No conflict resolution:** Last-write-wins on simultaneous edits. Fine for single-user orgs.
- **No undo:** Deleting a customer cascades to all their notes.
- **Migration:** On first sign-in after v38+, existing data migrates from `users/{uid}/` to `orgs/{orgId}/` automatically. If it fails, old data is still in `users/{uid}/` — safe to retry by signing out and back in.

---

## 11. How to Continue in a New Session

1. Read this file
2. Read `app-store-plan.md` for the broader business context
3. Run `git log --oneline -5` to see recent commits
4. Ask the user what they want to work on
5. Make the smallest viable change, bump versions, commit, push
6. Always summarize planned changes and ask before editing files

---

## 12. Quick Reference Commands

```bash
# Status
git log --oneline -5
gh auth status

# Local dev
python3 -m http.server 8000 -d ~/Downloads/notes-y2fxcvusvd

# Push
cd ~/Downloads/notes-y2fxcvusvd
git add -A
git -c user.email="ddemic@yahoo.com" -c user.name="ddemic-ktown" commit -m "vXX: message"
git push

# Pages status
gh api repos/ddemic-ktown/notes-y2fxcvusvd/pages | grep -o '"status":"[^"]*"'
```
