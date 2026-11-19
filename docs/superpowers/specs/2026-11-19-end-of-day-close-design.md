# End-of-Day Close and Mark paid in full

## Purpose

Give clinic staff a read-only close report they can revisit later, and a separate patient billing shortcut for a balance known to be fully paid when the clinic does not want to itemize every installment. Neither action locks a business day or changes who can correct records.

## Approaches

- **Selected: separate settlement and report.** Record the balance clearance once, with its confirmed full-payment date, and keep it out of payment-method collections. Report directly from bounded reads of clinic records, so subsequent corrections are visible.
- **Not selected: record all missing installments as one normal payment.** Faster to build, but it assigns money to a day and method the clinic has not attested to. Keep normal payment entry for money received on a known date and method.
- **Not selected: saved close snapshots.** They would introduce a second set of totals and rules for reopening or restating a close. V1 has no snapshots, lock, or historical debt reconstruction.

## End-of-Day Close

An owner or editor opens the report in the existing workspace. It defaults to today in `Asia/Manila` and allows earlier dates. On mobile, the sections stack:

```text
End-of-Day Close · Read-only       [Manila business day] [Refresh]
Recorded collections by method   | Payment corrections recorded this day
Paid in full, not itemized       | Current outstanding balances (not historical)
Completed visits · No linked treatment                           [Open patient]
```

- **Recorded collections:** Sum posted, unreversed payments by method on their received business day, including backdated entries. Use integer centavos. Do not count charges, opening entries, opening corrections, or unitemized settlements. Once a payment is reversed, remove it from the original day's collections and show the reversal on the Manila day it was recorded as a separate correction, not a refund or a second deduction. Charge reversals are not collection corrections.
- **Paid in full, not itemized:** Show these entries separately on their confirmed full-payment date, with a warning that installment dates and methods were not itemized and are not included in collections. Mark reversed settlements as reversed and show their correction separately on the day it was recorded.
- **Current outstanding balances:** Include all patients in the clinic, not just loaded or active patients. Sum positive current ledger balances; show known unverified legacy amounts and unknown amounts separately. Never turn an unknown balance into zero or represent current debt as debt on the selected date.
- **No linked treatment:** Use the completed appointment's actual visit time within the selected Manila day, not its scheduled date. An explicitly linked, completed structured treatment for the same patient counts regardless of when it was entered. Exclude cancelled visits. Link each unmatched visit to the patient's dossier, and do not imply that no treatment occurred.

## Mark paid in full

In **Patient billing**, an owner or editor can clear a known positive ledger balance by choosing the date it was fully paid and confirming once. Show the exact balance to be cleared and warn: “Installment dates and methods won’t be recorded. This won’t be counted in daily collections.” Do not ask for an installment list or a payment method. Leave prior itemized payments intact. An unverified or unknown opening balance must be verified first; corrections to the old balance period continue through the existing opening-balance flow.

Save a distinct, append-only settlement with the entered Manila business date and the normal server recording time. Atomically clear exactly the balance reviewed by staff. If the balance changed in the meantime, reload and ask for confirmation again. Preserve existing retry protection, clinic roles and audit history. There is no stock move or ordinary payment receipt. If the date or settlement was wrong, staff can reverse the entry and record it correctly; the reversal restores the amount cleared, does not issue a refund, and never changes stock.

## Coverage, access, and checks

- Use bounded, indexed, clinic-scoped reads with stable cursors for the selected day's payments, settlements, recorded reversals and completed visits. Use bounded lookups for reversal originals and explicit treatment links; page patient documents by ID without filtering out legacy records. Do not use dashboard pages as a reporting source.
- Show loading, failed, partial and last-refreshed states per section. Do not present incomplete reads as whole-clinic totals or failed treatment lookups as missing links. Use fresh server reads for cloud reports; label offline data unavailable or stale, not complete. Drop late responses after switching date, clinic or account.
- Viewers cannot open the report or settle balances. Keep existing rule boundaries and use only local emulators and fictional demo data. No deploys, pushes, live reads/writes or rule publishing.
- Test Manila midnight from another device timezone, backdating, same-day and later reversals, settlement and reversal without revenue or stock changes, unknown debt, incomplete coverage, cancelled or unlinked visits, double submission, stale settlement balance, tenant and role isolation, and date/workspace-switch races. Exercise the local emulators and the exported Chromium demo.
