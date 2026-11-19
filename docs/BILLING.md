# Checkout and payments

The patient dossier's **Patient billing** section records money the clinic has already received. It does not collect funds, issue refunds or generate tax invoices. Checkout runs in a single clinic workspace with the existing signed-in account.

## Verify an existing balance

1. Compare the displayed balance with a source the clinic trusts, such as its paper ledger or an earlier export.
2. Choose that source and enter the time the amount is accurate **through** in `Asia/Manila`. If the amount differs, enter the verified figure and the reason. Review the before/after amounts before confirming.
3. Use **Not now** if you cannot verify it. There is no automatic migration or assumption that a missing amount is zero.

A verified opening that includes activity through Nov 18 at 6 p.m. can be followed by a backdated payment received Nov 19 at 10 a.m. A payment received on or before the cutoff is blocked because it might already be reflected. If the source balance missed an earlier payment, correct the opening amount with evidence and a reason; the correction does not appear as new money collected. Opening verification and correction never change stock.

## Record and correct new entries

- Record full or partial payments using the actual time, method and optional reference. Review the remaining balance before confirming. Use **Print receipt** from the saved payment; reprints keep the original payment ID and details, and identify reversed entries.
- Use **Mark paid in full** when the known outstanding balance was fully paid but some installments are not itemized. Choose the date it was fully paid in Manila and confirm the amount being cleared. This leaves already recorded payments untouched, does not print a payment receipt, and is not counted as daily collections. Reverse the entry and record it again if the settlement was wrong.
- If a save response is uncertain, **Retry same review** reuses its operation ID. Closing the dialog or switching clinics in the same session keeps that review and blocks replacement entries for its patient. After signing out or reloading the app, check the saved history before re-entering an uncertain payment: the pending review only lives in session memory. If the patient or stock changed, reload the affected records and confirm a new review.
- **Reverse entry** preserves the mistake and reason in history. It does not issue a refund. A stock-linked charge reversal restores stock only when the original quantities were physically returned and the user explicitly confirms that return.
- Confirm one or two catalog lines at a time. Split a larger cart yourself before saving; the app never partially commits a reviewed charge. Charging a medicine or supply in checkout is a new dispense. Do not enter the same item here if it was already dispensed through clinical activity. Items used in a billing stock movement stay in the catalog so a future physical return can restore the original item.

## Storage and verification

New entries are clinic- and patient-scoped and append-only. Patient summaries preserve the original balance input and legacy charge history. The existing clinic JSON export includes `billingEntries`; exporting is not a restore. Shared account entries identify the signed-in account, not the individual behind it. There is no offline write queue. The demo uses fictional session-only billing data.

Local checks: `node --test tests/billing-values.test.mjs tests/billing-workflow.test.mjs`, `npm run test:rules`, and `npm run build:staging` followed by `npm run test:billing:browser`. The last check exercises the actual static export without live Firebase or image-service requests. Do not publish new rules or indexes separately from the checkout UI.

## End-of-Day Close

Owners and editors can open **End-of-Day Close** from **Overview** and select a Manila business day. Collections use the received date and exclude reversed payments and unitemized settlements. Corrections appear on their recording day. Outstanding balances are current regardless of the selected date. Use **Load more** if a section is incomplete and **Refresh report** after changes. The report never locks a day. **No linked treatment** means the completed visit has no explicitly linked completed treatment record; it does not mean no treatment happened.

Report checks: `node --test tests/end-of-day-values.test.mjs tests/end-of-day-workflow.test.mjs` and, after `npm run build:staging`, `node --test tests/end-of-day.browser.test.mjs`.
