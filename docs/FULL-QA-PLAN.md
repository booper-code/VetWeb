# VetCloudPro full functionality test plan

**Status: planned, not executed.** This pass is for finding bugs and evaluating
readiness, not for deploying changes. Preserve the current worktree. Use fictional
records, images, and accounts; do not contact the shared clinic backend, send real
messages or reset emails, or restore anything to shared staging. The assistant
must remain proposal-only.

## 0. Verify isolation before starting

- Record the Git revision, whether there are local changes, and the versions of
  Node, Java, and the browser. Use the repo's Node version and Java 21 for
  Firestore; note missing tools as environment blockers, not app bugs.
- Run test servers on loopback with demo projects or explicit test doubles.
  Confirm **both** Auth and Firestore connect to local emulators and that image
  operations use mocks or a dedicated disposable target. `localhost` alone does
  not prove isolation: the default build can still use cloud services.
- Use fresh browser profiles for each role. Before any authenticated action,
  verify target project and network destinations. Stop if a destination is
  unexpected. Avoid running emulator suites concurrently when they reuse ports.
- Run the standard rules suite and the offline browser suite sequentially;
  both use the default emulator ports. Phase 3 has its own fixture config.
- Do not reuse an old `out/` or copy CI's live image Worker setting for this
  run. Build a fresh static artifact configured for the test target, block
  non-test requests in browser suites, and treat unexpected requests as
  failures. Prefer the Phase 2B offline evaluator over the older
  provider-capable assistant evaluator.

## 1. Automated baseline

Run the local equivalents of `.github/workflows/verify.yml`: lint, TypeScript,
production/static builds, rule tests in demo emulators, and workflow, privacy,
image, backup, and assistant suites. Check each browser suite's target before
running it. Include standalone checks not called by CI, such as consultation
and billing browser coverage, when they can run against isolated fixtures.
Capture failures before editing; do not publish builds.

### Priority checks from the Hy4 Flash review

This was a static review, not a test run or a list of confirmed app bugs.

1. **Restore:** The image tests use mocked requests, and the referenced-image
   tool does not restore records or reconnect images to patients. The
   records-and-images drill remains the biggest end-to-end coverage gap.
2. **Money:** Verify payroll calculation and ledger-chain validation with
   independent fixture totals. Include billing values, billing browser, and
   End-of-Day Close browser coverage that isn't in the current CI workflow.
3. **Recovery:** The existing mock test covers requesting a reset, not
   redeeming or expiring the link or re-entering the same clinic afterward.
   Exercise those locally; record real email delivery as a separate check.
4. **Clinical and assistant:** Run `npm run test:consultations` and
   `npm run test:assistant:workspace`. The workspace question harness uses the
   popup's actual routing function with a fixed clock and fictional prompts;
   it makes no provider or clinic calls. Add a fictional prompt with the
   expected reply kind or tool when fixing a question. To verify the real
   editor handoff, run `npm run build:staging` then
   `node --test tests/workspace-assistant.browser.test.mjs` with Playwright Chromium.
   Phase 3 runs separately and does not exercise the popup.

If CI changes are published later, include the currently untracked tests
referenced by the local workflow. A successful local run doesn't establish
which tests already run on hosted CI.

## 2. Browser and integration walkthrough

| Area | Verify |
| --- | --- |
| Direct-link privacy | Signed-out bookmark reaches the login page and exposes no records. Check `noindex` on the served routes being evaluated; mark checks that need later hosting approval as pending. |
| Accounts and team | A fictional account can request a reset and reuse its existing clinic access after completing it. UI confirmation does not disclose account status. Exercise expired links and network errors. Check verified invite acceptance, role changes, ownership transfer, and removal. Confirm normal access is denied for signed-out, removed, and unrelated accounts on fresh record and image requests. Document separately what can remain on a previously trusted offline device. |
| Clinical records | Create and update a fictional patient, link a consultation, schedule/reschedule/complete/cancel appointments as appropriate, attach and reopen an image, and confirm filters and paging. Reload and compare persisted values and audit history. Check each role's permitted actions. |
| Inventory, billing, and payroll | Import a fixture CSV twice; verify duplicates and audit behavior. Test treatment stock use, partial and full payment, reversal, and End-of-Day Close pagination. Reconcile clinic totals against fixture expectations; verify payroll calculations and role boundaries. |
| Offline and conflict handling | Exercise trusted and untrusted devices, lost connection, reconnect, account/clinic switching, and device cleanup. Check that stale edits don't silently overwrite newer data and that forbidden offline writes don't silently queue. |
| Workspace assistant | Compare old/new times; opening, discarding, or rejecting a draft must not save. Check unavailable/stale schedules, changed clinic or role, and a user's existing unsaved form. Then confirm once as an authorized editor or owner and verify the ordinary appointment audit plus no messaging or billing side effects. |

## 3. Restore drill

Follow [Clinic recovery](CLINIC-RECOVERY.md). Use empty disposable storage, seed
fictional records and images, and independently verify record counts and IDs,
Firestore types and links, ledger totals, permissions, and restored image
bytes. Record elapsed time and coverage. A mock or referenced-images-only pass
is useful, but does not establish provider-level or full-clinic recovery.
Record missing infrastructure as blocked; do not substitute shared staging.

## 4. Triage and retest

Record each case as **pass**, **fail**, **blocked**, or **not run**. For failures,
capture role, fixture identifiers, steps, expected versus actual behavior, and
redacted evidence. Prioritize access/privacy failures, data loss, wrong money
totals, and unsafe saves above usability defects. Retest fixes in isolation,
then repeat affected workflows. Don't declare readiness for real records
while high-severity bugs or mandatory recovery/access checks remain open.

Use a single run log with these columns:

| Case | Role and fixture | Environment / build | Expected | Observed / evidence | Status | Follow-up |
| --- | --- | --- | --- | --- | --- | --- |

Keep emulator, mock, browser, and hosted evidence separate. A simulated reset
request does not prove email delivery, and a successful build does not prove
the hosted routes send the intended headers. Track such checks explicitly
rather than inferring a pass from another layer.
