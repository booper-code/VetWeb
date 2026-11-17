# Appointments and manual reminders — local feature

**Not deployed.** The user requested local development only. Staging and the
shared Firebase backend retain their earlier versions. Real-account appointment
reads/writes require publishing the matching reviewed rules together with the UI;
do not deploy or change live data without renewed authorization.

## Included

- New **Appointments & Reminders** navigation and dashboard due cards.
- Create/edit appointments linked to an existing patient; six visit types,
  duration, scheduling notes, and scheduled/completed/cancelled/no-show states.
- Completed appointments require an explicit actual visit time, independently
  of server-recorded entry/update/audit times. Past appointments can be entered
  after the day's work. The actual visit cannot be in the future.
- Patient links use a scoped point read when the patient is not on a loaded
  page, including discharged patients. Creation's selector intentionally covers
  loaded patient pages only; load the relevant active/history page first.
- Date-range reads are bounded to 50 records per page, ordered by Firestore
  timestamp (ties handled by Firestore document cursors). Status/type/header
  search filter loaded rows only. Counts explicitly describe loaded records,
  never whole-clinic totals.
- The default window is the last 30 through next 30 days. Refresh advances this
  default window on a new day; manually selected custom windows stay fixed.
  Users can choose up to a year per query window, and page through it.
- Manual reminder text, a draft-email link, WhatsApp links only for an explicit
  +country-code contact, and a calendar download. Nothing sends a message or
  confirms delivery automatically. Calendar exports omit contact details and
  private scheduling notes.
- Owners/editors can write online; viewers can read but not edit. Offline
  reads use cached query data with an incomplete/outdated warning. No write
  queue is created. The offline demo uses session-only memory, with no Firebase
  or R2 dependency.
- Revision conflicts, workspace changes and duplicate submissions are guarded.
  Failed saves retain the form; cancelled appointments remain as history.
  Late query results cannot undo a newer committed revision or resurrect an
  appointment just moved outside the selected window. Leaving the schedule
  also cancels delayed patient navigation rather than interrupting another view.
- Appointments use the enforced head/event audit protocol and are included in
  the owner JSON backup. Hard deletes are denied, even for owners.

## Deliberate limits

- Marking complete **does not** record vaccination, diagnosis, treatment, stock
  use or payment automatically. Completed rows may open the pre-linked
  **Record treatment & stock** form in the patient dossier; saving it is a
  separate explicit action and still does not add payments.
- No medically calculated vaccine schedule, dose recommendation, automatic
  follow-up generation, background reminders, push notifications, email service,
  staff assignment, availability/overlap enforcement or AI execution.
- Dates are entered/displayed in the **device's named timezone**, shown on screen,
  and stored as UTC Firestore timestamps. There is not yet a clinic-configurable
  timezone. DST gaps are rejected; local-day queries respect DST boundaries.
- No periodic polling: schedule snapshots refresh on entry, date-range change,
  explicit refresh and paging. A dashboard left open is not a live alert system.
  Its date-based grouping recalculates on window focus/visibility return without
  fetching more records; refresh is still needed for a current server snapshot.
- Contact fields are patient snapshots. Verify the recipient before opening an
  external app. Local phone numbers are not silently assigned a country code.
- Cached records may be incomplete, particularly on a device that has never
  loaded that date range online. Calendar imports are manual and may not honor
  later cancellation/sequence updates in every calendar application.
- Audit remains metadata-only and can be bypassed by project administrators.

## Implementation

- `types.ts`: appointment/draft types.
- `lib/appointment-values.ts`: validation, date windows, reminders and safe ICS.
- `lib/appointments.ts`: bounded queries and validated audited save action.
- `lib/useAppointments.ts`: demo/cloud state, scope and paging guards.
- `components/AppointmentsView.tsx`, `components/AppointmentReminders.tsx`:
  human review/save workflow and dashboard summaries.
- `firestore.rules`: schema, role, patient binding, immutable creation metadata,
  occurrence-time and audit enforcement.

Queries use the existing single-field `dueAt` index, not a status/type composite
index. No Firebase plan change or paid backend was introduced. Saves read the
patient and current appointment, execute the audited transaction and attempt a
timestamp readback; they consume ordinary Firestore operations. They are not a
global quota mechanism.

## Verification

See `docs/TESTING.md`. The new suites cover:

- Validation, DST/calendar boundaries, reminders, mail/WhatsApp safety and ICS.
- Real React form/hook behavior: scope changes, failures, duplicate submissions,
  date changes, demo isolation, viewer/offline denial and backup inclusion.
- Emulator: canonical patient linking, owner/editor/viewer/outsider isolation,
  stale/concurrent updates, forged metadata/schema, future occurrence times,
  cancellation after patient deletion, equal-timestamp pagination and cached
  read-only access.
- Static-export browser flow with external traffic blocked: demo scheduling,
  dashboard due card, patient dossier link, calendar download, backdated
  completion, cancellation and mobile layout.

Final local results (2026-11-15): appointment unit/React tests 21 passed,
appointment emulator tests 23 passed (suite parent included), expanded existing
workflow tests 72 passed, actual static-export demo browser/mobile test 1 passed,
and Chromium/emulator cleanup tests 4 passed. The rest of the rules suite,
image/backup/offline/validation suites, type-check and both builds also pass.
Lint: no errors, 1 pre-existing warning. See `docs/CURRENT-HANDOFF.md`.
None of these checks establishes live deployment or production readiness.

Next feature preparation: `docs/AI-ACTION-PLAN.md`. Structured clinical
treatment entry is now a separate local feature linked from completed rows; full
payments and receipts remain separate work, not hidden side effects here.
