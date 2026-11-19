# Checkout, opening balances, and payment receipts

**Status:** Design approved, including the opening cutoff. Local development only; no deployment, live-data migration, payment processing, or AI integration.

## Goal

Make it possible to accept and record a full or partial in-person payment, see the remaining balance, and print a receipt from the existing patient dossier. Preserve the approved one-time balance check without a second login or a new approval role. Establish a source for a later day-end collections report.

## Approaches

- **Record payments against the existing mutable balance:** Small UI change, but existing clear-balance and remove-charge paths could still erase financial history or make receipts disagree with balances. Rejected.
- **Add an append-only billing history with one-time verification:** Keep the Billing tab and existing checkout workflow, but record every new balance change as a linked entry. Keep old balances and charge history readable without claiming old payments happened. Recommended.
- **Reconstruct every balance from old bills:** Historical payment and correction records do not exist, so replaying bills could revive amounts already collected. Rejected.

## Patient Billing flow

1. **Verify an existing balance.** For a patient with a positive pre-upgrade balance, show **Verify opening balance** before the first new payment or charge. Show the original amount and ask what clinic record the signed-in user checked and what date and time it reflects. For a match, confirm that amount. For a mismatch, require a verified amount and reason, and show original → verified before confirmation. No attachment or second user is required. **Not now** leaves the account unchanged.
2. **Record a payment.** Show the current verified balance, payment amount, method (cash, e-wallet, bank transfer, card, or other), optional reference and note, actual receipt time, and remaining balance. Require a positive amount no greater than the current balance. Plainly label that this records money already received; it does not collect it. Backdating is allowed only after the opening cutoff and not into the future. The server records when and by whom the entry was saved.
3. **Show payment history and receipt.** List committed charges, payments, and corrections separately from legacy charge history. Generate a PDF payment acknowledgment from the committed entry with a stable receipt ID, clinic and patient, payment date, amount in `PHP`, method, and balance immediately after that payment. Reprints use the saved details and identify a reversed payment. No tax-invoice or compliance claim.
4. **Correct mistakes visibly.** Replace **Clear balance** and hard removal of charges with audited corrections. Reverse an erroneous payment once, in full, with a reason; re-enter the correct payment separately if needed. This does not issue a refund. Do not reverse legacy charge lines individually or count them again in the new ledger.

### Opening cutoff and legacy amounts

- **Opening cutoff:** The verified amount includes known activity through the date and time shown on the review. Reject payments at or before that time. For example, staff using a paper ledger through yesterday's closing time can record an unentered payment from this morning, but cannot record yesterday's payment again. If an earlier payment was not reflected, reconcile it against the source amount rather than overriding the cutoff. New patients begin at zero. For an existing patient with an explicit, valid zero, initialize at the first new charge without requiring a second screen; use the start of that charge's clinic day as the implicit boundary, and reject payments before that day.
- **Legacy amounts:** Check the original stored field, not the display fallback that turns invalid or missing values into zero. Automatically convert only valid nonnegative values exactly representable in centavos. If the value is missing, negative, or has fractional centavos, require a verified amount, source, cutoff, and reason. If the user has no source, leave the account unverified without inventing a balance.
- **Corrections:** Allow an audited correction to a mistaken verified opening amount, against the same cutoff, with before/after values, source, and reason. Reject corrections that would create a negative balance. Do not count a correction as a payment or change old receipts. No debt write-offs, cutoff overrides, or general-purpose balance adjustments in this version.
- **Time policy:** Use `Asia/Manila` as the visible billing timezone for this first scope, not the device timezone. Preserve the actual event time, its clinic business date, and the timezone with each payment so ordinary reprints and later reports agree. Support for more clinic billing timezones is deferred.

### Stock and financial corrections

- Preserve the existing bounded **new dispense and charge** transaction: charge and stock changes either both commit or neither does. A service charge has no stock effect. Payment, payment reversal, and opening balance verification never change stock. Do not auto-charge an already-recorded treatment or dispense its stock again; linking existing treatments to charges is deferred.
- For a new charge reversal, keep the original line and reason. For stock-linked charges, require the user to explicitly confirm whether stock was physically returned; never infer a return from a billing correction. Restore only the original quantities from that charge, at most once and in the same transaction when a return is confirmed. If a reversal would leave a credit balance, block it with an explanation; overpayment, credit, and refund workflows are out of scope.

## Permissions, data, and failure handling

- Use the current signed-in clinic account and existing clinic edit permissions for verification, charges, payments, and corrections. A single eligible account can do all of them. Preserve tenant isolation and existing viewer/audit permissions; expose detailed payment references only to accounts allowed to edit that clinic, not to viewers.
- Use integer centavos and immutable, clinic- and patient-bound ledger entries. Each entry identifies the operation, actor, and server timestamp. Preserve the original and verified opening amounts, the source checked, and the reason for any mismatch. Within the new ledger, `balance = verified opening + net charges − net payments`. Legacy history is evidence, not another term in this calculation.
- Update the balance and append the entry atomically. Enforce valid transitions and clinic authorization at the data boundary, not just in the dialog. Financial changes cannot use general patient writes or imports. Preserve the existing balance display while making it clear that a legacy balance is unverified. Prevent hard deletion of patients with new billing history; keep normal discharge available.
- Bind confirmation to the amount and revision that was reviewed. If an account or related stock record changes before saving, reject the stale operation, show the refreshed state, and ask for a new confirmation. A stable operation ID must make retries after an uncertain result safe; double-clicks or retries must not add a second payment, correction, or receipt.
- No offline queue or silent fallback to an online write. Keep failed form input and give a clear outcome. The offline demo uses session-only sample data. Include new billing data in the existing clinic JSON backup.

## Acceptance checks

- Matching, differing, postponed, missing, and invalid opening balances; same account can verify and then record a payment; opening checks and opening corrections never create revenue or stock changes.
- Full and partial payments; cutoff and timezone boundaries; ambiguous network retry, racing payments, stale confirmations, duplicate reversal, and overpayment; receipts agree with committed records and can be reprinted.
- Charge and stock succeed or fail together, with the existing two-stock-item limit; reversal checks distinguish returned stock from financial correction only.
- Direct general patient edits cannot bypass billing controls; cross-clinic access and viewer writes fail. Patient record edits, discharge, and clinic switching still work. Test rules in the emulator and the visible flow with fictional browser demo data.

## Later work

Day-end close and collections by method, then follow-up queue, whole-clinic patient search, and stock expiry/reordering. Keep the End-of-Day Clerk separate until the underlying transactions are verified. See `docs/NEXT-TASKS.md` and `docs/AI-ACTION-PLAN.md`.
