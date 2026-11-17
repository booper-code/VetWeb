# Foundation batch — handoff

The subsequent local appointments feature is recorded in `docs/APPOINTMENTS.md`
and the top of `docs/CURRENT-HANDOFF.md`. The foundation results below are the
historical completed baseline, not evidence that subsequent features were
deployed or independently reviewed. Deployment remains deferred.

## Resumed verification — 2026-11-15

This section supersedes the old mid-verification snapshot below. No rules,
Worker, UI deployment, live seeding or live test was performed in this resume.
**The user explicitly chose “Keep local for now.” Deployment requires renewed
authorization; the shared live baseline remains unchanged.**

### Completed locally

- Closed the logout/sign-out window synchronously and reject new clinical
  callbacks while leaving. Obsolete child callbacks also fail their render's
  scope check before starting an old-clinic mutation.
- Suppressed stale initialization/restoration errors and child-view toasts.
  Rename and ownership results cannot change the next clinic. Account settings
  are keyed by clinic/user to discard the old clinic's form state.
- Astra found a non-blocking ownership-feedback issue during the final review:
  navigating within the same clinic used to suppress the successful transfer's
  role callback. The callback now always reaches the workspace-scoped parent,
  which preserves the user's current non-Team screen. Actual Team component
  tests cover mounted and unmounted completions, and Astra confirmed the fix.
- Installed the Firebase device watcher before asynchronous initialization, so
  a wipe cannot be missed while SDK imports/auth/persistence are pending.
- Real browser testing exposed that the SDK can leave IndexedDB deletion
  pending indefinitely when another tab ignores `versionchange`. Cleanup now
  times out after ten seconds, preserves the failure status after remount, and
  permits retry once the blocking connection is closed. A timeout is not proof
  of erased data; the restart requirement remains.
- Added pinned dev-only jsdom/esbuild/Playwright tooling and credential-free CI
  checks. Emulator browser adapters exist only in the test bundle; the shipping
  app has no emulator flag or test SDK adapter.

### Results recorded

| Check | Result |
| --- | --- |
| `npm run test:workflows` | 69/69; actual page callbacks under React/jsdom with shallow child views, real pagination hook invalidation, and actual Team transfer mounted/unmounted |
| `npm run test:rules` | All authorization/cursor scenarios pass; audit suite 23/23 (parent plus 22 direct-write/editor subtests) |
| `npm run test:offline:browser` | 4/4 (parent plus 3 real Chromium/emulator scenarios); final run uses actual settings button and sign-out remount |
| `test:images` / `test:backup` / `test:offline` / `test:records` | 22 / 18 / 6 / 2 passed |
| Type-check | Passed |
| Lint | 0 errors, 1 pre-existing warning |
| `npm run build:staging` | Passed; final export refreshed after ownership fix |
| `npm run build` | Passed after ownership fix |
| Dependency audit | Unchanged: full tree 4 high / 7 moderate / 0 critical; runtime 4 high / 0 moderate / 0 critical |
| Final Astra review | Completed scoped read-only review/recheck; no blocker, ownership P2 fixed. Independently ran earlier 66 workflow tests; final 69 run by main session |
| Deployment/live checks | Not performed |

Commands and coverage boundaries: `docs/TESTING.md`.

### Remaining resume steps

1. Local checks, both builds and the final scoped review are complete.
   No new deployment version exists; keep the batch local as requested.
2. Obtain renewed deployment authorization and confirm a coordinated rollout
   window for the **shared** backend. New rules
   deny saves from old clients; notify users to finish work and reload.
3. Back up current live rules privately, then publish the matching rules,
   owner-upload-pause Worker and staging UI together using the procedure below.
   Never restore permissive old rules to accommodate an outdated client.
4. Seed only the authorized synthetic clinic after the rules are live, then run
   the pagination/search/audit/upload-pause/offline live checks. Emulator passes
   are not a substitute for those staged checks.
5. Record exact deployed versions only after deployment. The prior deployed
   baseline and all production blockers remain unchanged meanwhile.

The historical `/tmp/opencode/feature-rules-backup.cjs` and
`/tmp/opencode/seed-feature-fixtures.cjs` helpers are no longer present.
Recreate/review those private helpers or replace them with reviewed tooling
before attempting the historical rollout commands. Never print fixture secrets,
and preserve the synthetic-clinic ownership/name/email guards.

---

## Prior mid-verification snapshot (historical, superseded above)

Written 2026-11-15. This is the handoff for the four-part foundation batch
(pagination/query limits, search/validation/error/mobile workflows,
recovery/storage/audit safeguards, privacy-conscious offline/PWA).

Read this with `docs/FEATURE-BATCH.md` (what was built) and
`docs/SECURITY-STATUS.md` (unresolved production gaps).

**State at the time this snapshot was written:** the reviewed fixes were
implemented in the working tree, the tree type-checked and linted cleanly, but the
last three fixes had **no regression tests**, the staging build was **stale**, and
**nothing was deployed**. See the patch-status note below and the resumed
verification above for the final result.

---

## 1. Exactly where Sol stopped

> **Patch status (2026-11-16): complete.** All three patches in this section are
> applied in the current tree and covered by the verification recorded above
> (72 workflow, 23 audit, 4 browser-cleanup, both builds, type-check). The
> "Not verified since that pass" list below is the historical snapshot from the
> moment Sol stopped; it no longer describes the current tree. No code patch
> from this section remains unapplied. Deployment is still intentionally local.

Sol was fixing the three findings from Astra's final read-only review. It finished
the code changes and stopped before running any verification or writing tests.

### Implemented in the final pass

| File | Change |
| --- | --- |
| `lib/mutation-scope.ts` | New. Generation counter: `capture()` / `isCurrent()` / `invalidate()`. |
| `app/page.tsx` | Captures scope at every mutation entry point; blocks stale state writes; invalidates on logout, clinic select, clinic switch, login, device wipe and unmount. |
| `components/ClinicTeamView.tsx` | `mounted` ref so a late ownership-transfer callback cannot fire into an unmounted view. |
| `app/page.tsx` | `ClinicTeamView` now keyed by `clinicId:uid`. |
| `lib/offline-device.ts` | `WIPE_KEY` nonce + `BroadcastChannel` + `CustomEvent` detail; `DeviceChange` union; module-level clear state with `DEVICE_CLEAR_EVENT`. |
| `lib/firebase.ts` | Every initialized tab reacts to `wipe` (not only trusted tabs); received wipes use `clearOfflineDeviceData({ broadcast: false })` to avoid loops; watcher stopped on clear; clear phases recorded. |
| `components/OfflineDeviceSettings.tsx` | Subscribes to module-level clear state so success/failure survives the sign-out remount. |

### Verified after that pass (re-checked while writing this handoff)

- `npx tsc --noEmit` — passes, no output.
- `npm run lint` — 0 errors, 1 warning (pre-existing `<img>` in `AILaboratoryView`).
- `npm run test:images` — 22/22 pass.
- `npm run test:offline` — 6/6 pass.
- `npm run test:records` — 2/2 pass.

### Not verified since that pass

- `npm run test:rules` — last good run was 09:04 UTC, **before** the
  scope/wipe/clear-state patches. `firestore.rules` itself has not changed since
  that run, but re-run before deploying.
- `npm run build:staging` — last build **predates** the final patches. It does not
  represent the current tree.
- No regression test exists for any of the three fixes.
- Nothing is deployed. Live rules are still the older baseline
  (`e49d3f3c-f232-477b-b7ff-471b89436b94`); deployed image Worker is still
  `7493f7ae-87b2-4b8b-b255-dbbb8d526d39`.

So the honest status is: **compiles and lints, runtime behaviour of the new
guards is unproven.**

---

## 2. Essential to finish (ordered)

### Step 1 — Re-run the local suite

```sh
cd /media/jm/E/VetWeb
npx tsc --noEmit
npm run lint
PATH="/tmp/opencode/java21/bin:$PATH" npm run test:rules
npm run test:images
npm run test:backup
npm run test:offline
npm run test:records
npm run build:staging
```

Java 21 is a JRE unpacked at `/tmp/opencode/java21`; `/tmp` is wiped when the
machine restarts. Re-download from
`https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jre/hotspot/normal/eclipse`
if `java -version` fails.

### Step 2 — Regression tests for the three fixes (currently missing)

**2a. Delayed mutation completions (scope guard).**
Test that a mutation which resolves after the scope is invalidated does not write
to React state. Minimum cases:

- clinic A → clinic B switch while a save is in flight, where **both clinics use
  the same document ID** (the dangerous case: an update is applied to A's record
  while B is displayed).
- logout while a save is in flight.
- device wipe while a save is in flight.
- `createQuickPatient`, `createInventoryItem`, `updateInventoryItem`,
  `deleteInventoryItem`, `updatePatientRecord`, `deletePatientRecord`,
  `savePatientAndInventory`, `toggleConsultationStatus` — one case each, since
  each has its own guard block.

`lib/mutation-scope.ts` is pure and can be unit-tested directly, but that only
proves the counter works, not the wiring. The wiring test needs either:

- a lightweight React test of the mutation functions (they are currently inline
  in the ~800-line `app/page.tsx` component, so extraction into a hook/module is
  the pragmatic prerequisite), or
- a browser test on staging with the private synthetic accounts after deploy.

**2b. Two-tab device clear (offline initialisation/cleanup).**
`tests/offline-policy.test.mjs` is policy-only (service-worker filtering and
consent storage). It does not exercise Firebase initialisation. Required cases:

- two tabs in memory mode; clear in tab 1; tab 2 signs out and drops records even
  though `localStorage` never held a consent key.
- trusted tab initialising while a clear is broadcast (race).
- `clearIndexedDbPersistence` blocked because another tab holds the connection →
  user sees a persistent failure message, not silent success.
- clear feedback still visible after the settings view unmounts (post-sign-out).

This needs a real browser. Cached tooling:

- Playwright: `/home/jm/.npm/_npx/9833c18b2d85bc59/node_modules/playwright`
- Chromium: `/home/jm/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`

Two-tab tests require working Auth, so they must run against staging after deploy
(the app hardcodes its Firebase config and has no emulator switch), unless a
test-only emulator build flag is added first. Treat them as live staging checks.

**2c. Adversarial audit writes.** Extend `tests/clinical-audit.rules.test.mjs`.
Already covered: unaudited create, stale revision, event update/delete denial,
head delete denial, viewer write denial, viewer event read denial, concurrent
same-revision writes, deleted-ID recreation through the helper, multi-record
atomicity, REST commit protocol.

Not covered yet — direct writes bypassing `mutateClinicalRecord`:

- `actorUid` not equal to `request.auth.uid` (owner forging another member's ID).
- `time` other than `request.time` (client-supplied timestamp).
- `seq` gap or repeat (expected `old + 1`).
- head/event mismatch (head for patient X, event claiming patient Y).
- cross-clinic references (head or event in clinic B while the entity is in A).
- reused `eventId` pointing at an already-existing event document.
- recreation of a previously deleted ID with `expectedRevision: null` (partially
  covered; assert the specific rules branch, not just the client error).
- extra fields injected into the event or head (`hasOnly` key list).
- editor attempting to write a *consistent* head+event (must be allowed) versus
  an inconsistent one (must be denied).

### Step 3 — Review the remaining unguarded paths

These were not confirmed clean when Sol stopped:

- `app/page.tsx` (~lines 254-258): the `initializeFirebase()` failure toast in
  `createQuickPatient` is emitted **without** a scope check, so a stale error can
  pop up after a clinic switch. Same pattern should be audited in every
  `catch` block that calls `triggerToast`.
- `handleLogout` (~line 732): it invalidates first, then `await signOut(...)`.
  During that await a new user action captures the **current** generation and
  will pass `isCurrent`, writing to the clinic that is about to be cleared.
  Decide whether a `leavingRef` is needed; at minimum, document the behaviour.
- `handleRenameClinic`, ClinicTeamView rename/ownership callbacks — verify the
  new `mounted` ref and key cover rapid clinic switching.
- `useClinicPages` generation guard vs. the new mutation scope: confirm they
  cannot deadlock or drop legitimate first loads after a wipe.
- `restoreFirebaseSession` effect invalidates the scope on success — confirm this
  cannot cancel a mutation the user started in the same tick.

### Step 4 — Staging build and docs

Re-run `npm run build:staging` after the patches, then update
`docs/FEATURE-BATCH.md` "Verification status" and `docs/CURRENT-HANDOFF.md` with
real counts and the new versions. Do not carry forward the old counts; the
previous build predates the fixes.

### Step 5 — Coordinated deployment

The new `firestore.rules` reject older unaudited clinical clients. Deploy UI,
Worker and rules together in one window, and tell users to reload.

```sh
# 1. Back up the live ruleset (private output dir, prints sha256)
node /tmp/opencode/feature-rules-backup.cjs

# 2. Build the matching UI with the Worker URL configured
npm run build:staging

# 3. Deploy rules (this is the breaking change)
npx firebase deploy --only firestore:rules --project vetcloudpro

# 4. Deploy the image Worker (owner upload-pause enforcement)
cd workers/image-service && npx wrangler deploy && cd ../..

# 5. Deploy the staging UI
npx wrangler deploy --config wrangler.staging.jsonc
```

Order matters: if the Worker goes out first, existing clients are unaffected; if
rules go out first, old clients fail closed (denied saves) but cannot corrupt
data. Do **not** revert the rules to unblock a stale client.

Then, with the private synthetic fixture state only:

```sh
# Creates ~120 fictional records through the audited helper.
# Refuses to run unless owner email / clinic name / ownerId all match.
node /tmp/opencode/seed-feature-fixtures.cjs
```

Live checks to run after seeding: pagination (55 active / 7 discharged /
55 inventory), loaded-record search, audit log as owner and denial as editor,
upload pause enforced by the Worker, trusted-device offline read-only access,
and cross-tab clear in two tabs.

### Step 6 — Final review

Astra was reserved for final checking. Ask it to re-review only after Steps 1-3
are done, and only on the corrected findings plus the adversarial audit gaps. If
it is still rate-limited, say so — do not claim a review happened.

---

## 3. Future fixes related to this batch

Not required to ship, but caused or exposed by this work:

1. **Consultation ordering.** Legacy `date` values are locale strings
   (`11/15/2026`), so paging uses stable document-ID order. A real chronological
   sort needs a date migration (`dateIso`) plus a backfill; until then the
   consultation list is not time-ordered, only stable.
2. **Clear-status persistence.** `getDeviceClearState()` lives in module memory.
   A full page reload after a failed clear loses the failure message; only the
   restart-required behaviour remains. If a durable warning is wanted, persist a
   non-PII status flag to `sessionStorage` and clear it on successful cleanup.
   Note also that `WIPE_KEY` leaves a timestamp nonce in `localStorage`
   permanently (no PII, but it is residue on a supposedly memory-only device).
3. **Stale clear banner.** Once a clear reports success, the message stays
   visible on the login screen until reload. Add dismissal or reset-to-idle.
4. **Upload-pause cost.** `requireUploadsEnabled` adds a Firestore read per
   upload (latency + quota). A short-TTL cache in the Worker would cut that,
   at the cost of a slower pause propagation.
5. **Rate limits are not quotas.** `USER_*`/`CLINIC_UPLOAD_LIMITER` are
   approximate per-location limits. The owner pause switch is an operational
   brake, not a global storage/billing cap. Strict quota enforcement is a
   separate production task.
6. **Transaction size ceiling.** Billing is capped at patient + 2 stock items
   because of Firestore rules access-unit limits. Larger carts need a different
   design (server-side transaction / callable function), not a bigger client
   transaction.
7. **Audit is not tamper-evident against admins.** Rules prevent edits/deletes
   and require atomic head+event writes, but project-level credentials bypass
   rules entirely. Any claim of compliance-grade auditing would need export +
   independent retention.
8. **Dead code in the record views.** Resolved: the five unused handlers in
   `PatientRecordsView.tsx` (`startEditing`, `cancelEditing`, `saveEdits`,
   `toggleEditAdmission`, `handleConfirmDelete`) and the unused `setInventory`
   prop in `SystemSettingsView.tsx` were removed, leaving one pre-existing
   `<img>` lint warning in `AILaboratoryView.tsx`. No unaudited write path was
   revived.
9. **No offline write queue.** Deliberate: clinical writes fail rather than
   queue, to avoid conflicting overwrites. Any future offline drafting needs
   conflict resolution and an explicit revision policy first.
10. **Workspace has no Git metadata.** Nothing is committed or pushed, so CI
    (`.github/workflows/verify.yml`) has never run. Publishing to a remote is a
    prerequisite for CI being meaningful.

---

## 4. Constraints (carry forward)

- Keep the existing application owner `jmcapitan1204@gmail.com`. Do **not**
  transfer ownership to the Firebase administrator.
- Use only the separately authorized fictional owner/editor/viewer/non-member
  accounts and the synthetic clinic. No real records, no real ownership transfer,
  no payroll entries, no deletions as smoke tests.
- Never put credentials, tokens or private fixture contents in chat, logs, Git
  or docs. Fixture state:
  `/home/jm/.local/share/vetcloudpro-backups/live-smoke-1794712809289.json`
  (read programmatically only).
- Do not deploy the seed script before the matching audit rules are live; it
  writes through the audited helper and will be rejected.
- Do not run the image migration script against anything but the synthetic clinic;
  it now performs an atomic REST commit with head/event and a `revision` bump.
- No paid services, no plan upgrades.

---

## 5. Environment notes

- Java 21 (needed for `test:rules`): `/tmp/opencode/java21` — ephemeral.
- Playwright: `/home/jm/.npm/_npx/9833c18b2d85bc59/node_modules/playwright`.
- Chromium: `/home/jm/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`.
- Firebase CLI internals used by the rules backup script:
  `/home/jm/.npm/_npx/7750544ccf494d8b/node_modules/firebase-tools`.
- Staging: `https://vetcloudpro-staging.jmferrari16.workers.dev` (static export,
  shared `vetcloudpro` backend, fictional data only).
- Both Firebase and Wrangler are authenticated as `jmferrari16@gmail.com`
  (re-check with `npx wrangler whoami` before deploying).
