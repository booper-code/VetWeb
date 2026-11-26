# Live Consultation History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make consultation history update across sessions and page in visit order without hiding legacy records.

**Architecture:** Write a uniform sort field, backfill it with an explicit per-clinic readiness gate, and choose between bounded document-ID and chronological listeners. Only confirmed snapshots replace the displayed prefix.

**Tech Stack:** Next.js, React, TypeScript, Firebase Firestore, Node test runner, and the local Firebase Emulator Suite.

**Spec:** `docs/superpowers/specs/2026-11-26-consultation-history-design.md`

## Global Constraints

- Preserve existing Owner / Member behavior, demo behavior, and audit rules for normal consultation edits.
- No changes to production or shared staging, and no deployment in this slice.
- Run the Firestore rules and offline browser suites sequentially because they share ports.
- Existing working-tree changes belong to the current workspace; preserve them and review targeted diffs rather than staging whole edited files.

## Review Focus

- Ambiguous day/month and impossible leap days stay visible as unknown; a genuine leap day remains dated.
- An old client cannot create a row that vanishes after readiness; a raced backfill never overwrites the new version.
- Equal timestamps straddling two pages, plus remote inserts or deletes, leave no duplicate or missing rows at the boundary.
- A cached `ready` marker cannot switch a new workspace into a query that could hide unmigrated rows.
- Late callbacks and a pending subscription start cannot restore consultations after account switch or access denial.

### Task 1: Classify dates and preserve the sort key on audited writes

**Files:** `lib/consultation-values.ts`, `lib/consultations.ts`, `types.ts`, `app/page.tsx`, `firestore.rules`, `tests/consultation-values.test.mjs`, `tests/clinical-audit.rules.test.mjs`.

**Produces:** `legacyConsultationSortDate(value: string): Date | null`; mapped `Consultation.historySortAt?: string | null`; Firestore `historySortAt: Timestamp | null`; clinic marker `clinics/{clinicId}/workspaceConfig/consultationHistory` with `{ state: 'preparing' | 'ready' }`.

- [ ] Add date tests: `2024-02-29` and `2/29/2024` return `2024-02-29T00:00:00.000Z`; `29/2/2024` returns the same; `2/3/2024`, `2023-02-29`, and empty string return `null`.
- [ ] Add rules coverage: Owners and Members can read the marker and perform audited writes. Only an empty clinic can initialize a ready marker in its Owner bootstrap; neither role can write it for an existing clinic. A missing key fails on creates once preparing starts; structured keys unequal to `occurredAt` fail. An existing key cannot be removed or changed through a legacy status toggle. Before preparing, existing fixtures without the field still work.
- [ ] Run `npm run test:consultations` and `npm run test:rules`; see the new cases fail for the missing behavior.
- [ ] Implement strict deterministic date classification, write the exact timestamp for structured visits, and map storage timestamps to strings only for UI use. Update the legacy status toggle to persist only the intended changes through the audited write path and preserve the stored sort key. Add targeted rules for the marker and field; retain clinic membership and audit checks.
- [ ] Rerun both commands; verify that the new cases pass and existing audited operations still pass.

### Task 2: Build a guarded, resumable backfill

**Files:** `scripts/backfill-consultation-history.mjs`, `tests/clinic-pages.rules.test.mjs`, `docs/TESTING.md`.

**Consumes:** Task 1 date classifier, key, and marker; Firestore document update-time preconditions.

- [ ] Add an integration case with synthetic structured, unambiguous legacy, ambiguous legacy, and missing-date rows. Assert dry run makes no writes; apply writes only the new field and marker; repeat run is idempotent; a changed document causes a precondition failure and leaves the marker at `preparing` until a successful rerun. Assert non-loopback and non-demo inputs are rejected before requests.
- [ ] Run `npm run test:rules`; confirm the backfill cases fail before adding the command.
- [ ] Implement `node scripts/backfill-consultation-history.mjs --project <demo-project> --clinic <fixture-id> [--apply]`. Default to aggregate-only dry run. In apply, set `preparing`, page by document ID, skip already-correct rows, and update only `historySortAt` with version preconditions. Verify every row using a fresh scan, then mark `ready`. On error stop with a nonzero exit and leave the marker unchanged from its current stage.
- [ ] Run `npm run test:rules` and document the emulator invocation and resume behavior in `docs/TESTING.md`.

### Task 3: Serve a bounded live history in the workspace

**Files:** `lib/clinic-pages.ts`, `lib/useClinicPages.ts`, `app/page.tsx`, `components/DashboardHome.tsx`, `components/ClinicalActivity.tsx`, `firestore.indexes.json` if needed, `tests/clinic-pages-hook.test.mjs`, `tests/clinic-pages.rules.test.mjs`, `tests/offline-browser.test.mjs`.

**Consumes:** Task 1 marker and mapped sort key. **Produces:** a consultation prefix subscription aligned with the existing `clinicPages.load('consultations')` / `PageControls` entry point.

- [ ] Extend the hook harness: cached marker leaves ID mode in place; server-ready switches to chronological mode; an earlier callback or a late subscription start is ignored after mode/clinic change. Denial clears rows; transient errors preserve the last confirmed prefix and retry at the same size. Pending writes never count as confirmations.
- [ ] Extend rules/browser fixtures beyond 50 consultations: verify the tie-break across the boundary, unknown dates at the end, the widened prefix after Load more, and another session’s backdated visit and legacy status edit with no refresh. Verify clinic isolation and deletion-induced prefix shifts using an emulator-only fixture write.
- [ ] Run `node --test tests/clinic-pages-hook.test.mjs`, then `npm run test:rules` and `npm run test:offline:browser` sequentially, recording failures attributable to the missing feature.
- [ ] Add a consultation listener using `historySortAt DESC, document ID DESC` once readiness is confirmed, and document-ID order otherwise. Listen for metadata changes, take `size + 1`, replace the visible prefix from the first confirmed `size`, and set `hasMore` from lookahead. Keep the currently authorized prefix during retry or widening and move to the next size only on Load more. Validate identity around both cached and live paths; release listeners and clear state on scope change or access denial.
- [ ] Render **Unknown date** after dated rows in chronological mode, and surface a notice when the clinic is still in document-ID mode. Apply the same dated/unknown grouping to the demo and loaded dossier history, preserving the dossier’s existing record matching and partial-data disclosure.
- [ ] Run the hook tests, `npm run test:consultations`, `npm run lint`, `npm run build`, and the two emulator suites sequentially. Review the feature diff for unintended changes to Owner / Member and Inventory.
