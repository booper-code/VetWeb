# End-of-Day Close and Mark paid in full Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reversible, unitemized full-settlement shortcut and an accurate, read-only Manila business-day report.

**Architecture:** Extend the audited patient ledger with a dedicated settlement entry, not another payment method. Build the report from separate bounded pages of clinic data, with an in-memory equivalent for the exported demo. Render it inside the existing client workspace, not a new route or backend.

**Tech Stack:** Next.js 16.4.6, React 19, TypeScript, Firebase 12.19.0, Node test runner, local Firebase emulators, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-11-19-end-of-day-close-design.md`

## Global Constraints

- Use `Asia/Manila`, integer centavos, existing owner/editor roles, and the same signed-in account. Do not lock or save a close snapshot. No new approval, ordinary settlement receipt, stock movement, or refund.
- Preserve existing checkout and unrelated edits, particularly `.github/workflows/verify.yml` and `docs/TESTING.md`. Recheck `published-main` at `32a5666` and the pending checkout baseline before execution. Do not start in a clean worktree missing those changes.
- No new dependencies, pushes, deployments, live reads/writes or rule publication. Use only the local emulators and fictional demo. Checkpoints below are verified diffs; do not stage or commit pre-existing changes.
- Before editing workspace code, follow the bundled Next.js guide at `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`.

## Review Focus

- A patient is charged while the confirmation is open: don't quietly clear the larger balance (Task 2).
- A settlement falls on the same Manila day as the opening cutoff: the date is not an invented received time; a prior calendar day still needs the opening flow (Task 1).
- A cash payment is reversed after leaving the browser: a fresh read updates the original day and shows exactly one distinct correction on the later day (Tasks 4–5).
- Two completed visits share an actual timestamp, and only one has a valid treatment link: don't skip either visit at a page boundary (Task 4).
- A failed lookup, sign-out, or role/date/workspace switch occurs while pages are loading: don't render old money or a false unlinked warning (Tasks 4–5).

---

## File Map

| Change | Responsibility |
| --- | --- |
| `lib/billing-values.ts`, `lib/billing.ts`, `lib/demo-billing.ts`, `firestore.rules` | Settlement request, audited transition, demo parity and server validation |
| `components/PatientBilling.tsx`, `docs/BILLING.md` | Shortcut, explicit warning, history and reversal instructions |
| `lib/end-of-day-values.ts` | Report row types and pure aggregation |
| `lib/end-of-day.ts`, `firestore.indexes.json` | Fresh Firestore reads, lookups, and query indexes |
| `lib/useEndOfDay.ts`, `components/EndOfDayClose.tsx`, `components/DashboardHome.tsx`, `app/page.tsx`, `lib/useAppointments.ts` | Scoped report load state, view, navigation and full demo input |
| `tests/billing-{values,workflow}.test.mjs`, `tests/billing.rules.test.mjs` | Settlement transition, form, and emulator behavior |
| `tests/end-of-day-{values,workflow}.test.mjs`, `tests/end-of-day.browser.test.mjs` | Report model, UI races, and exported demo |

### Task 1: Audited unitemized settlement

**Interfaces:** Keep `calculateBillingTransition`, `commitBilling` and `createDemoBilling` signatures. Add draft `{ kind: 'unitemized-settlement'; businessDayMs: number; amountMinor: number }`, ledger variant `{ kind: 'unitemized-settlement'; businessDayMs: number }` atop existing common fields, and `parseBillingDay(value: string): number` in `lib/billing-values.ts`. Allow this original kind in the existing reversal. Add `allEntries(): BillingEntry[]` to the demo ledger.

- [ ] **Write transition tests** in `tests/billing-values.test.mjs`: `settlement clears exactly the reviewed balance without stock`: `assert.equal(next.balanceMinor, 0)`, `assert.equal(deltaMinor, -70000)`, `assert.deepEqual(stockMoves, [])`, unchanged opening/cutoff, and reversal restores `70000`. `settlement rejects unknown, stale, prior and future balances or dates`: reject no ledger, zero, mismatch to `70000`, non-midnight, prior cutoff day and future Manila day. Accept the cutoff's own calendar day. Assert `parseBillingDay('2026-11-19') === Date.parse('2026-11-18T16:00:00Z')` and reject `'2026-02-30'`.
- [ ] **Write emulator tests** in the existing `tests/billing.rules.test.mjs`: real commit and same-ID retry leave one settlement at zero; no normal receipt and unchanged inventory. Reject direct forged amount, extra method or stock data, stale revision, foreign patient/original, duplicate reversal and viewer/outsider writes. Reverse as editor and assert the exact restored amount. Test direct invalid writes through the rules, not just client guards.
- [ ] **Run red:** `node --test tests/billing-values.test.mjs` and `npm run test:rules`; the settlement cases must fail for missing behavior.
- [ ] **Implement:** `parseBillingDay` reuses strict Manila time parsing at `00:00`. Require a positive existing balance and reviewed `amountMinor === old.balanceMinor`, valid midnight no later than today's Manila day, and `businessDayMs >= billingDayStartMs(old.cutoffMs)`. Rules enforce the cutoff as `businessDayMs + 86400000 > old.cutoffMs`, plus existing server time, audited patient mutation, no change to opening/cutoff, and `stockMoves == []`. Store no invented `occurredAtMs` or method. Reuse deterministic `reverse_${originalEntryId}`; restoring a settlement adds, rather than subtracts, its original amount and cannot return stock. Preserve receipt validation, fingerprint and retry logic; implement matching demo behavior.
- [ ] **Run green/checkpoint:** Repeat the two red commands and `npx --no-install tsc --noEmit`; all pass. Review the settlement diff for no other kinds gaining new capabilities.

### Task 2: Patient billing shortcut

**Interfaces:** Consume Task 1 types through the existing `PatientBilling({ patient, inventory, canEdit, billing })` and `BillingSession.submit`. No new gateway action or review stage.

- [ ] **Write workflow tests** in `tests/billing-workflow.test.mjs`: `mark paid in full confirms once without installment details` opens an eligible `70000` balance, shows the fixed warning, no method field, and submits once on double click with `{ kind: 'unitemized-settlement', amountMinor: 70000, businessDayMs: Date.parse('2026-11-18T16:00:00Z') }`. `stale settlement must be reconfirmed` changes the patient revision while open and asserts no submit before refresh and a new confirmation. Also assert no shortcut for unverified, zero or read-only; history has **Paid in full — installments not itemized** and **Reverse entry**, but no **Print receipt** for the settlement.
- [ ] **Run red:** `node --test tests/billing-workflow.test.mjs`; new assertions fail against current billing.
- [ ] **Implement** in `components/PatientBilling.tsx`: use the existing dialog with `Fully paid on (Asia/Manila)`, today's editable Manila date, reviewed amount and “Installment dates and methods won’t be recorded. This won’t be counted in daily collections.” Clarify that the whole current balance must be covered and not already reflected. Freeze displayed amount and revision when opened, validate at confirm, and pass the explicit operation to the existing submission path without waiting for a React state update. Retain the in-flight guard, same-review retry, stale-record reload and focus restoration. Keep reversal at the existing audited action and make the copy distinct from a refund. Document the shortcut in `docs/BILLING.md`.
- [ ] **Run green/checkpoint:** `node --test tests/billing-values.test.mjs tests/billing-workflow.test.mjs`; all pass.

### Task 3: Report model

**Interfaces (`lib/end-of-day-values.ts`):**
- `CloseKind = 'entries' | 'corrections' | 'balances' | 'visits'`.
- `CloseOriginal = Extract<BillingEntry, { kind: 'payment' | 'unitemized-settlement' | 'charge' }>`; `CloseDayEntry = { entry: Exclude<CloseOriginal, { kind: 'charge' }>; reversed: boolean }`; `CloseCorrection = { entry: Extract<BillingEntry, { kind: 'reversal' }>; original: CloseOriginal }`.
- `CloseBalance = { id: string; ledgerMinor: unknown; legacyBalance: unknown }`; `CloseVisit = { id: string; patientId: string; patientName: string; occurredAtMs: number; linkedTreatment: boolean }`.
- `CloseRows = { entries: CloseDayEntry; corrections: CloseCorrection; balances: CloseBalance; visits: CloseVisit }`.
- `summarizeCollections(rows: readonly CloseDayEntry[]): Record<PaymentMethod, bigint>`, `summarizeBalances(rows: readonly CloseBalance[]): { ledgerMinor: bigint; unverifiedMinor: bigint; unverifiedCount: number; unknownCount: number }`, `formatCloseMinor(minor: bigint): string`.

- [ ] **Write model tests** in `tests/end-of-day-values.test.mjs`: `collections sum unreversed posted payments only`: `assert.deepEqual(totals, { cash: 50000n, 'e-wallet': 0n, 'bank-transfer': 0n, card: 25n, other: 0n })` for cash, card, reversed payment and active settlement fixtures. `debt keeps legacy and unknown separate`: `assert.deepEqual(summary, { ledgerMinor: 70000n, unverifiedMinor: 455n, unverifiedCount: 2, unknownCount: 2 })` for verified `70000` and `0`, legacy `4.55` and `0`, missing and malformed. Verified ledger takes precedence even at zero. `assert.equal(formatCloseMinor(9007199254740993n), 'PHP 90,071,992,547,409.93')`.
- [ ] **Run red:** `node --test tests/end-of-day-values.test.mjs`; missing report module or exports fail.
- [ ] **Implement** signatures above. Use `readLegacyBalance` only for legacy fallback; parse no report amount from formatted UI data. Sum with `bigint` and format whole pesos and centavos separately. Caller must never use a partial sum as a final total.
- [ ] **Run green/checkpoint:** `node --test tests/end-of-day-values.test.mjs`; all pass.

### Task 4: Clinic-scoped report reads

**Interfaces (`lib/end-of-day.ts`):** `CLOSE_PAGE_SIZE = 25`; `CloseCursor = QueryDocumentSnapshot<DocumentData> | number` (Firestore snapshot or demo offset); `ClosePage<K extends CloseKind> = { rows: CloseRows[K][]; next: CloseCursor | null }`; `ClosePageLoader = <K extends CloseKind>(kind: K, params: { clinicId: string; uid: string; dayStartMs: number; after: CloseCursor | null }) => Promise<ClosePage<K>>`. Export `loadEndOfDayPage: ClosePageLoader` and `createDemoEndOfDayLoader(input: { entries: BillingEntry[]; patients: PatientRecord[]; appointments: Appointment[]; consultations: Consultation[] }): ClosePageLoader`.

- [ ] **Write emulator coverage** inside `tests/billing.rules.test.mjs`, reusing its local-only fixture and compiler. `close reads by actual Manila day and paginates stable ties`: at `2026-11-18T16:00:00Z`, include a later-recorded payment and completed visit at the boundary, exclude rows at `2026-11-19T16:00:00Z`, exclude cancelled visits, charges and openings, and page through 26 identically timed completed visits without drops. A same-patient explicit `Completed` treatment recorded days later matches; draft, unlinked or wrong-patient treatment does not. Assert raw unknown balance stays unknown and a discharged patient is included. `close links active entries to later corrections without treating them as refunds`: original date marks a payment/settlement reversed; correction date returns each once, not charge reversals. Assert a missing reversal original fails that page, different clinic rows are excluded, and viewer/outsider cannot read ledger sections. Assert the expected composite definitions are present in `firestore.indexes.json` (emulator behavior alone does not prove production index availability).
- [ ] **Write demo loader test** in `tests/end-of-day-values.test.mjs`: `demo close matches cloud day and link semantics without initializing Firebase` shows a cross-midnight correction on the recorded day, not the earlier entry day, and a completed visit with `linkedTreatment: false`. Stub `initializeFirebase` to throw if called.
- [ ] **Run red:** `npm run test:rules` and `node --test tests/end-of-day-values.test.mjs`; report loader cases fail before loaders/indexes exist.
- [ ] **Implement reads:** Check authenticated UID (never query the demo clinic over the network). Use `getDocsFromServer`, `limit(25)`, `startAfter(lastSnapshot)`, and an explicit document-ID tiebreaker. `entries`: billing `kind in ['payment','unitemized-settlement']` and exact `businessDayMs`. `corrections`: billing `kind == 'reversal'` and `[start,end)` `recordedAt`. `visits`: appointment `status == 'completed'` and `[start,end)` `occurredAt`. Order by each day/time field ascending then ID. `balances`: all patient documents ordered by ID. Matching clinic collection-scope indexes: `billingEntries(kind,businessDayMs)`, `billingEntries(kind,recordedAt)`, `appointments(status,occurredAt)`, ascending, retaining the checkout index. A full-size page has a cursor; exhaustion is only established by the next short/empty page.
- [ ] **Implement lookups and demo:** Batch up to 25 entry/reversal document IDs in each lookup using the same clinic path. Validate reversal ID, original ID, clinic and patient before using them; fail on a missing or inconsistent original before filtering charge reversals. For each completed visit, look up `appointmentId`, `patientId` and `status == 'Completed'` with `limit(1)`, running at most five visit lookups at a time. A failed lookup fails the page; never treat it as no link. Use raw patient balance data in cloud. Demo loader uses only its complete in-memory input, normalizes draft/status/date the same way, orders deterministically, and applies the same page contract.
- [ ] **Run green/checkpoint:** `npm run test:rules` and `node --test tests/end-of-day-values.test.mjs` pass. Verify no network calls in the demo loader.

### Task 5: Report view, navigation, and exported demo

**Interfaces:** In `lib/useEndOfDay.ts`, export `useEndOfDay({ clinicId, uid, workspaceGeneration, isCurrent, enabled, online, load }: { clinicId: string; uid: string; workspaceGeneration: number; isCurrent: (generation: number) => boolean; enabled: boolean; online: boolean; load: ClosePageLoader })`, returning `day: string`, `setDay(day: string): void`, `refresh(): void`, `loadMore(kind: CloseKind): void`, `dayError: string`, and `sections: { [K in CloseKind]: { rows: CloseRows[K][]; status: 'idle' | 'loading' | 'partial' | 'complete' | 'error' | 'offline'; refreshedAtMs: number | null; error: string } }`. In `components/EndOfDayClose.tsx`, export view props `{ report: ReturnType<typeof useEndOfDay>; onOpenPatient: (id: string, stillOpen: () => boolean) => Promise<void>; onBack: () => void }`. In `useAppointments`, expose `demoRecords(): Appointment[]` (full demo collection, empty for cloud).

- [ ] **Write workflow tests** in `tests/end-of-day-workflow.test.mjs` using `domHarness` and deferred loaders: `partial and failed sections never look final` asserts no totals before terminal page, no “No linked treatment” on failed lookup, no offline fresh total, and a refresh replaces old data. `stale response cannot render after date, account, clinic or role change` changes each scope while requests are unresolved and asserts no old rows, totals or patient navigation. Include empty and duplicate-page boundaries and a Manila midnight fixture with browser zone `America/Los_Angeles`.
- [ ] **Write browser test** in `tests/end-of-day.browser.test.mjs` using the local static server/network guard in `tests/billing.browser.test.mjs`: record an itemized payment, settle the remainder with one confirmation, and verify older Manila date selection, separate warning, method total, current debt, an unmatched visit link and a linked visit that does not appear. Reverse a payment after the selected day and verify the original attributed amount disappears and the later correction is separate. Reverse the settlement and verify debt reopens. Assert mobile viewport has no page-level horizontal scroll, no unexpected non-local app requests, and no uncaught page errors.
- [ ] **Run red:** `node --test tests/end-of-day-workflow.test.mjs`; run `npm run build:staging`, then `node --test tests/end-of-day.browser.test.mjs`; expected failures are the missing report and its navigation, not fixture or browser setup.
- [ ] **Implement report state:** Start with current Manila date; validate `YYYY-MM-DD` and reject future days before load. Fetch one page per section initially and expose **Load more** until complete. Deduplicate stable row IDs on paging. Tie visible state and pending responses to clinic, UID, selected day, refresh generation, access and online status; invalidate old requests immediately on switch or unmount. Show timestamps for source reads and note that refreshing recomputes the report; it is not a saved snapshot. Hide stale or incomplete financial totals, but keep other complete sections usable.
- [ ] **Implement view and wiring:** Add **End-of-Day Close** to `DashboardHome` for demo and owner/editor; guard its `app/page.tsx` tab and key it by clinic/user. The offline view is explicit, not a permission upgrade. Use existing patient opening with a still-open guard and error feedback. Show separate labeled sections for collections, corrections, settlements, current debt and **No linked treatment**. Build the demo loader from the full demo ledger, patients, consultations and `demoRecords()`, never the appointment window. Use existing responsive styling and keep report actions read-only.
- [ ] **Run green/checkpoint:** `node --test tests/end-of-day-values.test.mjs tests/end-of-day-workflow.test.mjs`, `npm run build:staging`, then `node --test tests/end-of-day.browser.test.mjs` and `npm run test:billing:browser`; all pass.
- [ ] **Verify final integration:** Run `npm run test:rules`, `npm run test:appointments`, `npm run test:consultations`, `npm run test:workflows`, the billing unit/workflow tests, `npx --no-install tsc --noEmit`, `npm run build`, and `git diff --check`. Confirm the unrelated workflow/docs changes still match the preflight diff, and report exactly what passed or was not run. No live smoke test.
