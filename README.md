# Note Aggregator

A mobile-first PWA for notes, customer records, and keyword-aggregated paragraphs across customer notes. Data is synced via Firebase Firestore with Google sign-in.

## Run locally
```
python3 -m http.server 8000
```
Then open http://localhost:8000

## Features
- Notes (free-form, autosave, full-text search within a note)
- Customers with their own notes (each customer has a pinned default note for contact info)
- Keyword "aggregator" cards on the home screen — paragraphs starting with a configured keyword across all customer notes
- Date insertion, checkbox toggling, alphabetical / recent sort, per-customer search
- Settings: pinned section ordering, count of pinned sections, aggregator keywords
- Sign in with Google; data syncs across devices via Firestore

## Firebase setup

Required Firebase services on `note-aggregator` project:
- **Firestore** (enabled, any region)
- **Authentication → Google** (enabled)
- **Authentication → Authorized domains** must include `ddemic-ktown.github.io` (and `localhost` for development)

### Deploy Firestore security rules

The rules in `firestore.rules` lock each user's data to their own `users/{uid}/...` subtree. Paste this into the Firebase console (Firestore Database → Rules tab) and Publish:

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
