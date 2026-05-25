# Note Aggregator

A mobile-first PWA for notes, customer records, and keyword-aggregated paragraphs across customer notes.

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

Data is currently stored in `localStorage`. The next phase migrates the data layer to Firebase Firestore behind the same `storage.js` interface.
