# Planned: controlled end-of-day assistant

**Design only. No assistant, tool execution, provider calls or automatic writes
are implemented by the appointments feature.** Existing clinical AI screens
remain predefined demo output, not clinical analysis.

## Working assumption confirmed by the user

Staff may open the app occasionally and enter a day's work afterwards.
The desired AI role is to select predefined actions from staff instructions,
not receive unrestricted database access or invent changes autonomously.
Build reliable human-operated workflows first; add the assistant afterwards.

## Required flow

1. Staff explicitly select the clinic and provide notes.
2. Resolve patients/items using narrowly scoped, bounded lookups. Similar names,
   uncertain quantities, missing dates, and ambiguous recipients require a
   question. Never resolve an identity from a guess.
3. The model returns typed **proposals**, not executable code or Firestore
   paths. Show resolved names and canonical IDs, actual occurrence date/time,
   amounts/units, stock changes and appointment dates in a review screen.
4. Staff confirm individual actions or the clearly described batch. Revalidate
   permission, workspace generation, inputs and current revisions when applying.
   A confirmation is not permission to apply a materially different proposal.
5. Execute only allowlisted application handlers through the user's normal
   authenticated session. Firebase rules remain the authorization boundary.
   No Admin SDK credentials, arbitrary Firestore tools, SQL, shell, URL fetches
   or arbitrary JavaScript execution are exposed to the model.
6. Show committed, failed and not-attempted results separately. Each proposal
   needs a stable operation ID to prevent duplicate charges, dispensing or
   appointments after retries. Do not describe independent operations as one
   atomic transaction. Keep patient/stock business actions atomic within their
   tested transaction limits.

Treat patient notes, uploaded text, retrieved data and model output as
untrusted data, not new instructions or authorization.

## Initial action scope

- Create/reschedule/cancel an appointment using the validated domain service
  in `lib/appointments.ts` (now available for human workflows).
- Add a structured treatment entry, **after** that workflow exists.
- Record dispensing and payments, **after** complete payment/stock workflows
  and concurrency/idempotency tests exist.

Appointment completion is only an attendance/scheduling state. It cannot serve
as proof a vaccine or medication was administered. Do not silently create clinical
treatment, stock or payment entries from the scheduling action.

Initially exclude hard deletion, ownership/member changes, refunds, payroll,
bulk migration and autonomous clinical decisions. Reversal must use explicit,
audited compensating actions; do not promise a universal undo.

## Data/time/privacy requirements

- Separate `occurredAt` (what staff say actually happened) from server entry/
  audit timestamps. Allow explicit backdated entry; prohibit invented occurrence
  times. Show the timezone used and require confirmation for relative phrases.
- Only send the minimum relevant fields to an approved provider. Access to a
  clinic record is not consent to send the whole record or its images externally.
- Choose a provider, retention/privacy policy, consent and free-tier/cost limits
  before sending any real data. Provider integration is a separate approval.
- Respect the owner-controlled AI switch, viewers' read-only permissions, demo
  isolation and shared-device cleanup. Demo automation must remain cloud-free.
- Audit committed actions without placing raw clinical prompts in the immutable
  metadata log. Administrative credentials still bypass application rules;
  this is not compliance-certified auditing.

## Recommended development order

1. Appointments and manual reminders (current local feature).
2. Structured clinical activity/treatment entries and actual-event timestamps.
3. Complete charges/payments/receipts/voids and inventory reconciliation.
4. End-of-day assistant: first proposals only, then confirmed allowlisted actions.
5. Automated external reminders only after separate consent, delivery checks,
   verified domains and quota/cost controls.
