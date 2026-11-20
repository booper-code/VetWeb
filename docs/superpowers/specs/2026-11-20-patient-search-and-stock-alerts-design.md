# Clinic-wide patient search and stock alerts, v1

Build and verify patient search first, then expiry and reorder alerts. Keep the
follow-up queue and unrelated working-tree changes intact. Use fictional demo
records and local emulators only for development and verification; no production
or hosted staging access, deployment, GitHub work, or AI clerk implementation.

## Approaches

- **Bounded, on-demand reads (v1):** Read one clinic collection in stable,
  document-ID-ordered pages. Filter locally and show when the scan is partial.
  This works for legacy records without rewriting them and needs no new service.
  It uses more reads than an index, so one action is capped at five 50-record
  pages, with an explicit Continue button for additional pages.
- **Derived search/alert indexes (deferred):** Faster for large clinics, but
  require a backfill and a way to keep indexes in sync with every write path,
  including stock changes from billing and treatment.
- **Lot-level expiry (deferred):** Accurate for separately tracked batches, but
  requires a lot ledger and changes to receiving and dispensing. The current
  inventory has one stock total per item and cannot infer lot quantities or dates.

## Patient search

- Add a dedicated **Search clinic patients** control to Patient Records. Leave
  the existing loaded-directory filter, active/discharged tabs, and PDF scope
  unchanged.
- On explicit submit of at least two characters, search patient name, owner name,
  and patient ID using case-insensitive substring matching. Include both active
  and discharged patients in the same scan. Show the patient name, owner name,
  ID, and status so similar matches can be distinguished before opening a record.
- Opening a result uses the existing scoped dossier flow. Do not add scanned
  non-matches to the loaded directory or put search text or results into URLs,
  persistent app storage, or logs.
- Show progress, partial results, completion, and retry. Don't say “no matches”
  until the scan is complete. Reset for a new query or workspace; ignore
  late results from replaced queries, clinic switches, or signed-out sessions.
- Cloud scans require an online clinic member and server reads. When offline,
  the existing loaded directory still works as before but is not represented as
  clinic-wide. The fictional demo searches its session records without Firebase.

## Expiry and reorder alerts

- Add an optional **Expiry date** to medicine and supply items, editable in the
  existing audited inventory create/edit flow by online owners and editors.
  It represents the earliest expiry among units currently in stock. Staff update
  it when stock changes; it is not a batch ledger. Legacy items may remain
  undated. Clearing a date removes it from alerts. Viewers cannot edit.
- In Inventory, provide a **Stock alerts** panel and link to it from the overview
  without scanning in the background. On request, check inventory beyond the
  loaded page. Return one row per alerted item with all applicable reasons.
  Show coverage, progress, and retry; never treat a partial or failed scan as a
  clean bill of health. Refresh repeats the scan to pick up inventory changes.
- For stocked categories, reorder at or below a positive reorder threshold
  (zero disables the threshold, matching the existing dashboard). For items
  with units on hand, flag valid dates before the Manila calendar day as
  **Expired**, dates today as **Expires today**, and future dates up to 30 days
  away as **Expiring soon**. Dates are calendar dates, not elapsed-hour windows.
  Services and grooming do not participate. Missing expiry means unknown, not
  verified safe. No automatic purchase, dispensing restriction, or notification.
- Validate expiry on write, keep legacy items readable, and preserve existing
  audit, revision, billing, and treatment stock invariants. Use server reads
  for cloud alerts; demo alerts and edits remain session-only.

## Local acceptance checks

- Patient search finds a discharged patient beyond the initial loaded page,
  opens the right dossier, handles stale responses, and does not expose records
  across clinics. Verify the partial and complete empty states.
- Stock alerts cover items beyond the initial page, including a row with both
  expiry and reorder reasons. Verify date editing and clearing, Manila and
  threshold boundaries, legacy undated items, excluded service categories,
  and viewer/non-member write denial in the local emulator.
- Exercise both workflows in a local browser and run targeted unit, rules,
  type, lint, and build checks. No new dependencies or data backfill.
