# PWA Calendar Feature — Spec

## Overview
Add a job-scheduling calendar to the existing PWA, backed by Firebase/Firestore (already in use, with offline persistence enabled).

## Data Sources (existing)
- Employee list (already in PWA)
- Customer + address list (already in PWA)

## Calendar Grid
- Custom-built grid (not a third-party library like FullCalendar)
- Month view, navigated with arrow buttons
- Smooth-scroll/swipe transition between months (hybrid approach — not true infinite scroll)
- Each day cell:
  - Shows one cell per job (not one cell per employee)
  - No cap on number of employees per job
  - Shows employee name(s)/initials working that day, colour-coded per employee
  - Days with no one scheduled are shown greyed out
  - Cell is tappable, opens Day Detail view

## Day Detail View
- Styled similar to Google Calendar's day view
- Lists jobs for that day
- Each job entry includes:
  - Employee(s) working (multiple employees per job supported)
  - Customer (pulled from existing customer list)
  - Address (pulled from customer record)
  - Optional short description

## Adding an Event
- Month view: "+" button in lower right opens new-event screen
- Month view: tapping an empty day goes straight to new-event screen, pre-filled with that date
- Day view: "+" button in lower right opens new-event screen

### Add New Event Screen (fields, top to bottom)
1. Date (pre-filled if triggered from a specific day, still editable)
2. Start time
3. End time
4. Description box (optional)
5. Employee list with checkboxes (multi-select, from existing employee list)
6. Customer search-and-select box (address auto-fills from customer record)

All fields are optional except Date — an event can be saved with just a date and nothing else. Views showing job info (grid cells, day detail) display a placeholder wherever a field has no data entered.

On save: writes a new document to the `jobs` collection with date, start/end time, description, employeeIds array, customerId.

## Data Model (draft)
**Job**
- date
- employeeIds: array (supports multiple employees per job)
- customerId (reference to existing customer list)
- address (from customer record, or manual override for one-off jobs)
- description: optional text

**Employee** (existing collection)
- name
- assigned colour (for calendar colour-coding)

**Customer** (existing collection)
- name
- address(es)

## Open Questions / Not Yet Decided
- Cap on number of employee tags *visually shown* per grid cell before collapsing to "+N" (no functional cap, just display)
- Whether customer picker needs to support one-off addresses not in the existing list
- Whether customers with multiple addresses need an address sub-selector
- Exact placeholder text/style for empty fields (e.g. grid cell with no employee assigned)
