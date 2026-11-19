# Checkout and Balance Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify existing balances once and record, receipt, and correct new payments in the existing patient Billing tab.

**Architecture:** Keep the raw legacy balance and bills on the patient record, and add a small canonical `billing` state to that record plus append-only clinic-scoped `billingEntries`. The authenticated client commits each entry and its patient/stock changes atomically; security rules independently enforce the allowed transition. Billing stays client-side and the demo uses the same reducer with session-memory fixtures.

**Tech Stack:** Next.js 16.4.6, React 19, TypeScript, Firebase 12.19.0, Firestore rules and emulators, jsPDF, Node test runner, Chromium Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-checkout-and-balance-verification-design.md`

## Global Constraints

- Local development only; no deployment, live-data migration, payment processing, or AI integration. Keep GitHub on hold. Leave pending `.github/workflows/verify.yml` and `docs/TESTING.md` edits alone.
- One workspace, one eligible signed-in account, no additional approval role. Keep existing clinic, edit, viewer, and audit boundaries. No offline mutation queue.
- PHP integer centavos; billing timezone `Asia/Manila`. An explicit cutoff is inclusive of old activity; the start of the first charge day for an implicit zero opening is not. No write-offs, refunds, credits, or automatic treatment charges.
- Do not freeze the old write path in a releasable commit before the new Billing UI replaces it. Run tests with local emulators and fictional static-export data. Before writing UI code, read `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` per `AGENTS.md`.

## Review Focus

1. Legacy missing or malformed amount displayed as zero: use the raw field at the transaction/rules boundary; never initialize it implicitly (Tasks 1–2).
2. Payment right at cutoff or Manila midnight in a browser in another timezone: preserve the intended clinic date and reject duplicate-eligible backdated payments (Tasks 1–2, 4).
3. Save response lost, then retry after another payment or a clinic switch: replay only the exact reviewed operation and never update the wrong workspace (Tasks 2, 4).
4. Billing reversal after a genuine dispense: correct finances without inventing a return; a confirmed physical return restores exactly the charged stock once (Tasks 2–3).
5. Old-tab patient edits, patient deletes, and unauthenticated/direct ledger writes: protect financial state even if the UI is bypassed (Tasks 2 and 4).

## File map

| Files | Responsibility |
| --- | --- |
| `lib/billing-values.ts`, `tests/billing-values.test.mjs` | Shared types, fixed-point money, clinic time, transition and replay helpers. |
| `lib/clinical-mutations.ts`, `lib/billing.ts`, `firestore.rules`, `tests/billing.rules.test.mjs`, `package.json` | Reuse existing audit writes inside the same transaction; read/write/retry ledger entries and protect finance state. |
| `lib/clinic-pages.ts`, `types.ts`, `lib/backup.ts`, `firebase.json`, `firestore.indexes.json`, `docs/BILLING.md` | Project the current balance into patient views; export the ledger, register its history index, document constraints and data shape. |
| `app/page.tsx`, `components/PatientRecordsView.tsx`, `components/PatientBilling.tsx`, `lib/useBilling.ts`, `lib/pdf.ts` | Replace legacy editing and receipt actions; hold reviewer intent, session scope, and demo state. |
| `tests/billing-workflow.test.mjs`, `tests/billing.browser.test.mjs` | Exercise review, scope, receipt, and no-network demo integration. |

### Task 1: Money, opening boundaries, and transitions

**Interfaces:** `lib/billing-values.ts` exports `BILLING_TIME_ZONE = 'Asia/Manila'`, `parsePhpMinor(value: string): number`, `readLegacyBalance(raw: unknown): { kind: 'valid'; minor: number } | { kind: 'invalid' }`, `parseBillingLocalTime(value: string): number` (epoch milliseconds), `billingDayStartMs(value: number): number`, and `calculateBillingTransition(current: BillingState | null, rawLegacy: unknown, draft: ResolvedBillingDraft, nowMs: number): BillingTransition`. Throw on invalid inputs rather than coercing or rounding silently.

**Data contract:** `BillingState` has `lastEntryId: string`, `seq`, `openingMinor`, `balanceMinor`, `cutoffMs` (numbers), and `cutoffKind: 'reviewed' | 'implicit-zero'`. `BillingDraft` is a `kind`-discriminated union: `opening {verifiedMinor, source, cutoffMs, reason?}`, `opening-correction {verifiedMinor, source, reason}`, `payment {amountMinor, method, occurredAtMs, reference?, note?}`, `charge { lines: {itemCode, quantity, expectedRevision, unitPriceMinor}[] }`, or `reversal {originalEntryId, reason, returnStock, expectedStockRevisions: Record<string, number>}`. `ResolvedBillingDraft` augments charge lines with canonical `itemName`, `category`, and `stock`, and reversal with original `{kind: 'payment' | 'charge', amountMinor, stockMoves}`. `BillingTransition` returns `{next: Omit<BillingState, 'lastEntryId'>, deltaMinor: number, stockMoves: {itemCode: string; quantityDelta: number}[]}`. IDs, actor, and server-recorded time are assigned by Task 2, not by the reducer.

- [ ] Write pure tests `legacy amounts are not rounded or invented`, `Manila time is independent of the host`, and `opening cutoff and balances are enforced`, using `tests/appointment-values.test.mjs`'s transpilation pattern. Pin `parsePhpMinor('1200.05') === 120005`, throw on `'1200.005'` and negative or unsafe inputs, classify `undefined`, `NaN`, and `2.001` as invalid, and classify `0` as valid. Pin Manila `2026-11-19T00:00` to `Date.parse('2026-11-18T16:00:00Z')`; reject an impossible date and an explicit-cutoff equality, and allow implicit-zero day-start equality. From verified `120000`, a `50000` payment leaves `70000`; overpayment, future payment, and a correction that makes the balance negative throw. Add one test for each reversal type's money sign and stock effect.

  ```js
  assert.equal(parsePhpMinor('1200.05'), 120005);
  assert.throws(() => parsePhpMinor('1200.005'));
  assert.deepEqual(readLegacyBalance(undefined), { kind: 'invalid' });
  assert.equal(parseBillingLocalTime('2026-11-19T00:00'), Date.parse('2026-11-18T16:00:00Z'));
  ```

- [ ] Run `node --test tests/billing-values.test.mjs`; confirm it fails for missing billing helpers before implementing.
- [ ] Implement the exports and data types above. Use strict local date inputs converted to epoch milliseconds, and checked safe integers for quantity, subtotals, balances, and time. Do not send `undefined` optional fields to Firestore.
- [ ] Rerun `node --test tests/billing-values.test.mjs`; require zero failures.
- [ ] Checkpoint only the value helpers and tests, if local commits are authorized.

### Task 2: Atomic billing persistence and rule enforcement

**Interfaces:** `lib/billing.ts` exports `BillingOperation = {clinicId: string; patientId: string; operationId: string; expectedPatientRevision: number; draft: BillingDraft}`, `commitBilling(input: BillingOperation): Promise<BillingCommit>`, `loadBillingHistory(input: {clinicId: string; patientId: string; after?: BillingCursor}): Promise<BillingPage>`, and `loadPaymentReceipt(input: {clinicId: string; patientId: string; entryId: string}): Promise<PaymentReceipt>`. `BillingCommit` returns `{entry: BillingEntry, state: BillingState, patientRevision: number, stock: {itemCode: string; stock: number; revision: number}[]}`. `BillingPage` provides up to 25 `entries` in descending `seq` and a `next` cursor (`BillingCursor | null`). `PaymentReceipt` holds `id`, `clinicName`, `patientName`, `occurredAtMs`, `businessDayMs`, `timeZone`, `method`, `amountMinor`, `balanceAfterMinor`, and `reversed`.

**Storage contract:** `patients/{id}.billing` owns the summary. Freeze raw `balance` and `billableItems` as legacy input/history. `BillingEntry` is the decoded `billingEntries/{operationId}` document with `id` from its document ID, `clinicId`, `patientId`, `actorUid`, `recordedAtMs` decoded from a server timestamp, `seq`, `kind`, `balanceBeforeMinor`, `balanceAfterMinor`, and applicable kind-specific fields; persist a canonical reviewed-operation fingerprint for exact replay. Include the checkout receipt snapshot only on payments. Store the payment's actual timestamp, Manila midnight as a UTC instant, and the `Asia/Manila` label. A reversal has ID `reverse_${originalEntryId}` and binds to an eligible original in the same patient, making duplicate reversal impossible even across tabs. Limit a new charge to **two catalog lines per confirmed save** for bounded rule reads, including mixed stock/service lines. If more are selected, refuse the unsaved cart and ask staff to split it explicitly rather than committing partial charges.

- [ ] Add `tests/billing.rules.test.mjs` to `test:rules` in `package.json`. Use the loopback fixture style from `tests/appointments.rules.test.mjs`. Test an authorized verification, payment and receipt for one signed-in account; deny foreign/viewer reads of entries, viewer writes, replay with changed intent, duplicate reversal, entry-only and summary-only batches, forged actor/time/amount/day, a manual opening cutoff override, generic writes changing frozen fields, and hard deletion after opening or nonzero legacy debt. Use hand-built direct batches for rule-denial tests rather than asserting UI/service validation. Explicitly test two editor accounts or sessions racing at the same revision; one write wins, the other reports a conflict. After a successful write followed by a simulated lost response, retry the same ID after the ledger advances and assert the same receipt ID and exactly one payment. Add two-stock charge and two-stock return success cases, stale stock and wrong return-quantity failures, and `returnStock: false` leaving stock unchanged.

  ```js
  // "same reviewed payment replays after the next ledger commit"
  assert.equal(replay.entry.id, first.entry.id);
  assert.equal(history.entries.filter(entry => entry.id === first.entry.id).length, 1);
  assert.equal(replay.state.balanceMinor, expectedBalanceAfterBothPayments);
  assert.equal(freshPatient.billing.balanceMinor, expectedBalanceAfterBothPayments);
  ```

- [ ] Run `npm run test:rules` with Node and Java from `docs/TESTING.md`; confirm the new behavioral tests fail while existing nonbilling scenarios remain available. The two emulator commands must not run concurrently.
- [ ] Extract a reusable audited-write staging helper from `lib/clinical-mutations.ts` for an existing transaction. Keep its existing public exports and per-record behavior. In `lib/billing.ts` read patient, operation, original entry as needed, and all catalog/stock/audit snapshots before writes. Read an already-committed ID before rejecting an old revision; return it only for the identical signed-in intent. Return the original entry but the current summary and affected stock revisions on replay, never old balance/stock snapshots as current state. Return the receipt snapshot from committed data, never a failed draft. On receipt reprint require a fresh read of the payment and deterministic reversal entry.
- [ ] In `firestore.rules`, require both directions of the ledger/summary pairing, the next sequence bound to the patient, canonical catalog and applicable stock deltas, exactly one allowed transition, same-clinic permissions, `request.time` for audit, and immutable entries. Use the raw legacy field for auto-zero eligibility; on explicit review compare valid claimed original centavos to the stored number. Verify the business date is Manila midnight and the actual instant is within that day. Unverified positive or invalid balances cannot bypass verification. Scope finance reads to current clinic editors; keep patient summaries readable under existing membership rules. Protect new and funded patient records from hard deletion without changing normal discharge.
- [ ] Register the patient/seq billing index in `firestore.indexes.json` and `firebase.json`; include top-level `billingEntries` in `lib/backup.ts`. Plan the patient normalizer to expose the computed balance from `billing.balanceMinor / 100`; for general writes preserve the original finance fields from the transaction snapshot, not from the normalized form. Add a backup assertion for the new collection.
- [ ] Rerun `npm run test:rules` and `npm run test:workflows`; require green, in particular the complete two-stock commits under the rules limits of 10 document accesses per operation and 20 per atomic request. If the authorized two-stock case cannot fit, stop and revisit the transaction design; never loosen rule validation or split charge from stock to go green.
- [ ] Keep this checkpoint isolated and undeployable until the Billing UI cutover in Task 3; do not publish an intermediate rules or UI version.

### Task 3: Adopt the checkout flow and generate receipts

**Interfaces:** `lib/useBilling.ts` exports `useBilling({clinicId, clinicName, uid, patient, canEdit, online, workspaceGeneration, onCommitted})`. Its controller exposes `entries: BillingEntry[]`, `submit(input: BillingOperation): Promise<BillingCommit>`, `receipt(entryId: string): Promise<PaymentReceipt>`, `refresh(): Promise<void>`, and `loadMore(): Promise<void>`. `onCommitted(result: BillingCommit): void` updates the active page only. `components/PatientBilling.tsx` takes `patient: PatientRecord`, `inventory: InventoryItem[]`, `canEdit: boolean`, and the controller. `lib/pdf.ts` exports `exportPaymentReceiptPdf(receipt: PaymentReceipt): Promise<void>` and uses a deterministic payment acknowledgment title, receipt ID and formatting from the committed snapshot.

- [ ] Add `tests/billing-workflow.test.mjs` with the existing jsdom React test pattern. Test that `Not now` does not call submit; a discrepancy requires amount/source/reason/cutoff; the reviewed **PHP 1,500.00 → PHP 1,200.00** is not a payment; payment submits only after review of exact method, time, and balance; an uncertain retry reuses the ID; a changed draft or conflict requires renewed review; a failed save keeps the draft and does not expose receipt actions. Test that `Clear balance` cannot appear, legacy lines are read-only, a paid receipt reprints from stored values even if clinic/patient names change, and reversed receipts visibly say `Reversed`. Include focus and accessible names for review actions.

  ```js
  // "mismatch confirmation posts an opening, not a payment"
  assert.deepEqual(submissions.map(({ draft }) => [draft.kind, draft.verifiedMinor]), [['opening', 120000]]);
  assert.doesNotMatch(billingRegion.textContent, /Print receipt/);
  ```

- [ ] Run `node --test tests/billing-workflow.test.mjs`; require the new checks to fail for missing checkout behavior.
- [ ] Wire the billing controller into `app/page.tsx` and mount the focused Billing component inside `components/PatientRecordsView.tsx`. Remove `savePatientAndInventory` and legacy `onSaveBilling` after replacing its charge and remove flows. Publish balance/stock revisions back to the currently selected clinic only and never overwrite a newer revision; confirm general patient saves and dossier exports still display the canonical balance. Demo state is session-only and uses the same value transitions with no Firebase imports or writes from the demo actions. Render `Asia/Manila`, validate reviewed cutoff/amount before submit, and use logical focus when opening or dismissing the static-approved dialog's real counterpart.
- [ ] Add the jsPDF export to `lib/pdf.ts`, using `PHP`, stable saved ID and receipt facts, and an explicit reversed state. Do not present verification or an uncommitted result as a receipt.
- [ ] Rerun `node --test tests/billing-workflow.test.mjs`, `npm run test:workflows`, and `npm run test:records`; require green. Update the old billing mutation harness cases to exercise the replacement controller with equivalent clinic-switch, logout and wipe regression coverage, not just remove them.
- [ ] Checkpoint the working billing cutover and authority changes together, if local commits are authorized.

### Task 4: Static-export checkout regression and operator notes

- [ ] Create `tests/billing.browser.test.mjs` and add `test:billing:browser` to `package.json`. Add a fictional, explicit legacy balance in the billing demo fixture. Borrow the static server pattern from `tests/appointments.browser.test.mjs`, but allow only the test server's exact origin, block service workers, and fix the browser clock with timezone set to a non-Manila zone. Test `Not now` → reopen → mismatch with source and cutoff → try exact cutoff payment (blocked) → post a partial cash payment after the cutoff → download receipt → reverse payment → verify balance and history. Assert no Firebase/R2 traffic, no persisted demo changes after sign-out, and no horizontal overflow at 390px. In `tests/billing-workflow.test.mjs`, explicitly exercise late result and old callback after switch, logout, and wipe, including the same patient ID in two clinics.
- [ ] Run the new browser/workflow tests first against the unverified cutover. Require useful assertions against the documented flow; if they fail, isolate and fix against the actual failure, without relaxing coverage.
- [ ] Add `docs/BILLING.md`: how to verify and choose a cutoff, how identical retry and stale review behave, what reversal means, the two-line limit, ledger history/receipt data and backup coverage, emulator and local run commands, and explicit exclusions. No updates to the pending GitHub workflow or `docs/TESTING.md`.
- [ ] Run `node --test tests/billing-values.test.mjs tests/billing-workflow.test.mjs`, `npm run test:rules`, `npm run test:workflows`, `npm run test:consultations`, `npm run test:appointments`, `npm run test:records`, `npm run lint -- --max-warnings=1`, `npx --no-install tsc --noEmit`, `npm run build`, then `npm run build:staging`; after the fresh export run `npm run test:billing:browser`, `npm run test:appointments:browser`, and `npm run test:theme`. Report any skipped checks or known Windows backup-mode/symlink failures separately. No live or remote verification.
- [ ] Inspect final scope and `git diff --check`; checkpoint only if approved, and leave the branch local.
