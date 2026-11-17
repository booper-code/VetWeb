# VetCloudPro — current handoff

**Remaining work for the next chat:** `docs/NEXT-TASKS.md` (actionable list only).

## Product planning / Claude handoff

The user requested a complete feature-and-screen plan before a later major UI
revamp. Start with `docs/CLAUDE-PROJECT-BRIEF.md`: it distinguishes confirmed
needs, current implementation, proposed v1 screens/features, optional extensions,
AI constraints, release blockers and decisions needing approval.

The current UI change is limited to explicit black text on light appointment/
reminder surfaces (including labels and controls) across system color schemes.
Dark primary buttons retain contrasting white text. No app-wide redesign,
backend change or deployment was authorized.

**Claude handoff package: complete.** The user asked to finish only the Claude
planning handoff and its accompanying HTML, not deployment. Send:
`docs/CLAUDE-PROJECT-BRIEF.md` + `docs/prototypes/vetcloudpro-ui-demo.html`.
The optional cover/instructions are in `docs/prototypes/README.md`.
The HTML is a standalone representative mockup with fictional, disposable local
interactions—not production functions. It needs no server, credentials or
network. Prototype role controls were corrected so owner-only rename, backup,
AI policy and upload-pause previews are enabled only for the owner preview.
The package is verified by `test:prototype`; any returned redesign must be
integrated into the existing React/domain/security architecture, not substituted
wholesale for the real app. Live services remain untouched.

## Latest local feature — appointments and reminders

Appointments are now implemented locally on top of the foundation batch:
calendar/date-window paging, patient links, dashboard due cards, manual reminder
tools, calendar exports, and audited role-protected create/edit/cancel/complete
workflows. Completed appointments record the staff-entered actual visit time
separately from server entry time, supporting end-of-day data entry.

**Keep everything local, per the user's instruction. No feature deployment,
live account changes or live seeding is authorized.** Cloud appointments require
the matching new Firestore rules; do not mistake local builds/emulator results
for live availability. Use the offline demo or emulators for this feature.

Details: `docs/APPOINTMENTS.md`. The controlled end-of-day AI direction is
documented in `docs/AI-ACTION-PLAN.md`; it is **design only**, not an implemented
assistant. Appointment completion never records treatments, stock or payments
automatically. A completed visit does offer **Record treatment & stock**, which
opens a separate, pre-linked treatment form; saving it stays an explicit action.

Final verification: appointment unit/React tests 21 passed; existing workflow
suite expanded to 72 passed; full rules suite passes including 23 appointment
tests and 23 clinical-audit tests (parents included). Image 22, backup/restore 18,
offline-policy 6 and record-validation 2 passed. Lint has 0 errors and 1
pre-existing warning. Actual static-export demo browser/mobile checks and the
4-test Chromium/emulator cleanup suite passed. Both ordinary and staging builds
pass, and the actual export's browser/mobile flow passed again after the final
scope/read-race guards.
No new dependency, paid backend or automatic messaging service was added.
The earlier Astra review below covers the foundation, not this new feature.

Final low-risk cleanup pass (still local): removed the five unused handlers in
`PatientRecordsView.tsx` and the unused `setInventory` prop in
`SystemSettingsView.tsx`, added a "Dismiss status" control so successful
device-clear feedback can be cleared deliberately, and changed the image Worker
to a named default export. The Chromium/emulator suite now also asserts that
dismissal. `npm run lint -- --max-warnings=1` passes with 0 errors and the single
pre-existing `<img>` warning; the CI workflow and staging checklist use that
tightened limit.

Next development: complete payments/receipts before attempting AI-assisted
execution. Production blockers remain unchanged.

## Structured clinical activity / treatment entry (local)

Feature 2 from `docs/NEXT-TASKS.md` is implemented locally. The patient dossier
now has a **Clinical activity** section that records a completed treatment visit
with:

- `occurredAt` (the real visit time, backdateable for day-end entry) stored
  separately from server-recorded `recordedAt`/audit time;
- linked `patientId` and optional `appointmentId` (only a completed appointment
  with the same patient can be linked);
- structured treatment/service lines (`itemCode`, rebuilt name/category/price,
  quantity, dose, note) and the signed-in staff UID/name;
- medicine/supply lines dispensed exactly once in the same audited transaction
  as the consultation, using the existing bounded three-record clinical commit.

Implementation: `components/ClinicalActivity.tsx`, `lib/consultation-values.ts`,
`lib/consultations.ts`, `types.ts`, `firestore.rules`, and the wiring in
`app/page.tsx` / `components/PatientRecordsView.tsx` / `components/AppointmentsView.tsx`.
Legacy free-text consultation rows remain readable and match by patient name;
new rows use `patientId` and appear for every clinic member. Viewers get a
read-only section and are denied by rules as well.

Firestore rules cannot iterate arbitrary lists, so the stock invariant uses a
bounded `stockMoves` list (maximum two entries). Each declared move must match
the inventory document's stock decrement and revision bump in the same audited
transaction; `stockMoves` and treatment lines are immutable after creation and
consultation hard deletes are denied. Consequence to keep explicit: rules cannot
prove that every hand-written medicine line has a matching entry in
`stockMoves`, so the trusted client/server action is what constructs both lists.
Do not let untrusted code write consultations directly.

Verification: `test:consultations` (9 passed), appointments 21, workflows 72,
full rules suite 95 passed including viewer denial, structured service/stock
transactions, future-time rejection, hard-delete denial, immutable treatment
lines and completed/not-completed appointment links. A real Chromium demo pass
confirmed a 2-unit dispense changed stock 25 → 23 exactly once, showed visit vs
recorded time, and saved an appointment-linked service-only record with the
"Appointment linked" badge. Type-check, lint (0 errors, 1 known warning) and
both builds pass. Nothing was deployed; demo verification stayed in memory.

## Active foundation batch

See `docs/FEATURE-BATCH.md` for the in-progress pagination, workflow, audit/storage
and offline/PWA work. Source files contain the new implementation and stricter
audit rules; this batch is not yet recorded as deployed. Do not infer live state
from these local rules or from the older completed staging baseline below.

Resume point: `docs/HANDOFF-FOUNDATION-BATCH.md`. The previously missing scope
and audit regressions now pass, with real Chromium/emulator cleanup tests also
passing. Sol's three interrupted patches (late-mutation scope guards, cross-tab
wipe signalling and persistent clear feedback) are applied and verified; no code
patch from that interruption remains unapplied. Logout and initialization races
were closed; blocked IndexedDB deletion
now reports failure after a bounded wait instead of hanging. The staging build
passed, including the final export refresh after the ownership callback fix.
Astra's scoped review is complete with no blocker; its same-clinic ownership
finding was fixed and rechecked. Final counts: workflows 72 (the foundation suite
was 69 before the appointments tests were added), audit suite 23,
browser cleanup 4 (including suite parents); ordinary build, type-check and lint
also pass (1 existing lint warning).
**The user chose to keep this batch local for now. Do not deploy without renewed
authorization.** No foundation changes have been deployed or live-tested.
See `docs/TESTING.md` for repeatable credential-free checks and their limits.

**Updated:** 2026-11-15
**Repository:** <https://github.com/booper-code/VetWeb>

## Latest update (2026-11-15)

- **Invitation admission flaw: fixed and deployed.** The previous critical
  finding (an unverified email address could be admitted) is remediated in the
  active Firestore rules. The active ruleset is an exact match with ruleset ID
  `e49d3f3c-f232-477b-b7ff-471b89436b94`; the prior active ruleset was
  `53e88f14-dfb0-45ad-a809-212485215afe`. The earlier rules were backed up
  privately as `firestore-rules-before-invite-verification-1794715019742.json`.
  The fix is scoped to the verified email: the invitee can read, claim and
  accept only the invitation matching their own verified email, and existing
  owners are unchanged. Live negative checks denied an unverified read and a
  direct claim. The staging verification prompt preserves the invitation link.
  A controlled test set `verified=true` through the admin path on a synthetic
  outsider only; the "I’ve verified" refresh then worked and actual UI
  acceptance succeeded. The temporary synthetic membership was removed
  afterwards. **Real verification-email delivery has not been tested.**
- **Staging is live:** <https://vetcloudpro-staging.jmferrari16.workers.dev>,
  served by Cloudflare Workers Static Assets (not Pages), version
  `d8098314-5f66-41ed-9c3a-04d4997275aa`. It is a static-export build, not SSR,
  and adds no paid backend. It shows a visible TEST STAGING banner with a
  fictional-records notice and uses the shared existing Firebase backend, so
  only fictional records are acceptable there. This is a test deployment, not a
  production-ready environment.
- **Staging headers and CORS verified:** `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `noindex`.
  A live `GET` returned `200` with the TEST STAGING warning, and a CORS
  `OPTIONS` preflight returned `204` reflecting the exact staging origin (not a
  wildcard). The staging origin was added to the Firebase authorized domains
  while preserving all previous entries. See `docs/STAGING.md`.
- **Image Worker redeployed** as version
  `7493f7ae-87b2-4b8b-b255-dbbb8d526d39`, which includes the exact staging
  allowed origin. Controls are otherwise unchanged: deletion disabled, token-key
  refresh and caching, upload-body hardening, a 64 KiB signing-body bound, and
  approximate per-location rate limits.
- **New restore tool passed live:** `restore:images` restored one fictional
  image with SHA-256 verification and wrote the private append-only journal
  `/home/jm/.local/share/vetcloudpro-backups/live-restore-1794714961161.jsonl`.
  This is a single-object rehearsal, not full-bucket recovery.
- **Tests:** `test:images` 21/21, `test:backup` 9/9, the final rules
  emulator run passes with pinned `firebase-tools` 15.36.0, `tsc --noEmit`
  passes, ordinary `npm run build` passes, the staging static-export build
  passes, and `npm run lint -- --max-warnings=10` passes with 0 errors and 10
  warnings. A fresh audit is unchanged at 4 high, 7 moderate and 0 critical.
- **CI workflow added locally:** `.github/workflows/verify.yml` uses pinned
  action SHAs, Node 24.22.2 and Java 21, and performs no deployment, uses no
  secrets, and runs no live tests. It has **not** run on GitHub yet and is not
  pushed, because this workspace has no `.git`. See `docs/STAGING.md` for the
  build/deploy procedure and staging caveats.
- **Build behavior:** the ordinary Next build (`npm run build`) remains the
  default. `build:staging` is an opt-in static export used for the staging
  deployment.
- **Mobile check passed:** staging login layout, labelled navigation toggle and
  demo settings switch were exercised at a 390px viewport.
- **Remaining production blockers:** full-bucket recoverability, strict quotas
  versus approximate rate limits, orphan retention/cleanup, historical key
  revocation, and real verification-email delivery. None of these is resolved.
- **Readiness:** ready to proceed to the next development feature using
  synthetic/staging data; **not** production-ready for real clinic records.
- **Next development feature:** pagination and query limits. Final regression
  results are recorded, so this can start using synthetic/staging data.

## Follow-up context

- A fresh dependency review still reports 4 high and 7 moderate audit entries,
  representing the Firebase/gRPC and development-only minimatch chains. No
  exploitable application path was identified in the reviewed usage, but the
  dependencies remain affected. See `docs/SECURITY-STATUS.md`; do not force an
  old Firebase downgrade or treat this as a clean audit.

- Added `scripts/backup-referenced-images.mjs` and `docs/IMAGE-BACKUP.md`.
  The tool defaults to an offline plan, supports private referenced-image
  downloads and offline SHA-256 verification, and refuses overwrite,
  cross-clinic keys and off-origin signed URLs. Its five backup unit tests
  passed. It is not full-bucket backup or automated clinic restoration. Live
  synthetic verification passed for one referenced image (68 bytes), including
  offline integrity verification, saved privately under
  `/home/jm/.local/share/vetcloudpro-backups/referenced-images-1794713840727`.

- Added `scripts/restore-referenced-images.mjs` and `npm run restore:images`.
  The rehearsal uploader requires explicit `--apply` and `RESTORE_CLINIC_ID`,
  verifies the complete backup offline before any upload, writes a new
  append-only private mapping journal so partial uploads are traceable, uploads
  only under the `restore-test` prefix, verifies each restored object's checksum,
  and does not change original objects or patient references. It remains
  referenced-image only, not full-bucket or clinic restoration. `npm run
  test:backup` passes 9/9. The synthetic live rehearsal now passes for one
  fictional image with SHA-256 verification; see the journal path above. It does
  not establish multi-object or full-clinic restore behavior.

- The user authorized separate synthetic owner/editor/viewer/non-member accounts,
  a fictional test clinic, and private local test-image backup/restore into a
  separate test prefix. The isolated live SDK/Worker smoke test passed:
  invitation acceptance; owner AI enable/disable observed by a separate viewer
  client; editor/viewer/non-member AI-write denial; owner/editor image uploads;
  viewer image read and upload/patient-write denial; non-member signing denial;
  authenticated owner DELETE returning 405. A single fictional image was
  privately backed up and restored under `restore-test`, with SHA-256 verified.
  This is not a complete bucket backup.
  Private account/run state:
  `/home/jm/.local/share/vetcloudpro-backups/live-smoke-1794712809289.json`.
  Never copy credentials from that file into logs or Git.

- The staging Playwright checks used isolated owner and viewer Chromium
  contexts (separate contexts, not a physically separate device) against the
  live staging app. All passed: real form login; the owner's AI switch
  propagated to the viewer navigation and toggle, with the viewer control
  disabled; a viewer's R2 image rendered after reload and re-login; and the demo
  login plus AI toggle worked with external HTTPS requests blocked and no Firebase or
  R2 requests observed.

- The image Worker uses native rate-limit bindings: authenticated user requests
  60/min, user uploads 10/min, and clinic uploads 30/min. These limits are
  approximate and enforced per location, not as a global quota. A live bounded
  editor signing test received 61 `200` responses and then one `429` with
  `Retry-After: 60`. Signing-request JSON bodies are capped at 64 KiB.

- Client-side image URL handling filters unsafe values locally: it accepts
  raster base64 `data:` images or credential-free HTTPS URLs, adds `no-referrer`,
  and checks signed-URL origin and key parameters. This is defense-in-depth, not
  the access-control boundary.

- Ownership basis is confirmed: the Firebase administrative login is not itself
  an application account. Keep the existing application owner account (the
  current clinic owner) in place; do not transfer ownership to the
  administrative login and do not create a personal primary login. Any future
  ownership transfer needs a separate, explicit user instruction.

- Firebase and Cloudflare MCP connections were configured in `opencode.jsonc`.
  Firebase project `vetcloudpro` was selected for the MCP environment.
- Local rules now require complete, synchronized ownership transfers and
  membership/index changes. Expanded emulator tests passed, including all 30
  nonempty incomplete transfer combinations. A read-only, role-only check of
  the one existing clinic document found its single owner and index consistent.
- Next.js and its ESLint configuration were updated locally to 16.4.6. The
  Firebase SDK was updated locally to 12.19.0. The production build, rules
  emulator, and image tests passed; lint reports 10 warnings. The critical npm
  audit finding was removed. After a non-forced `npm audit fix`, 4 high and 7
  moderate findings remain; build, emulator and image tests were rerun and pass.
- Cloudflare confirmed that `vetcloudpro-images` has its managed public domain
  disabled and no custom domains. The current deployed Worker version is
  `7493f7ae-87b2-4b8b-b255-dbbb8d526d39`. Health and unauthenticated DELETE
  (405) checks passed; bindings and signing-secret presence were confirmed.
  Authenticated live upload and role checks passed as described above.
  `npm run test:images` passes 21 tests.
- Java was downloaded to `/tmp/opencode/java21` for emulator testing. It is
  temporary, not a system installation. Use
  `PATH="/tmp/opencode/java21/bin:$PATH" npm run test:rules` while it exists.

This document supersedes the session-state claims in `.opencode/HANDOFF.md`
and the baseline descriptions in `docs/NEXT-FEATURES.md`; those documents were
written before the R2, AI-toggle and staging work. The latter remains useful as a
feature roadmap. This workspace currently has no Git metadata. Source changes
from this follow-up have not been pushed to GitHub; do not assume GitHub `main`
matches the deployed staging app or local rules. The CI workflow exists locally
but has not been run on GitHub.

## Constraints

- Stay within Firebase Spark and Cloudflare free tiers; check current usage and
  pricing before enabling billable services. Do not introduce a paid backend.
  The staging site is static assets, not SSR or a paid runtime.
- Keep the demo login offline: `demo-clinic` must not require Firebase or R2.
- Firestore rules are the access-control boundary. Test authorization changes
  in the emulator and publish the reviewed rules separately.
- Firebase imports remain lazy in `lib/` modules. Do not put credentials,
  tokens, signing secrets, patient records, or local `.env` files in Git.
- Staging shares the existing Firebase backend. Use fictional records only and
  do not treat staging data as isolated from production data.
- Read the relevant local Next.js 16 docs in `node_modules/next/dist/docs/`
  before changing routing or client/server boundaries.

## Current state

- Multi-clinic login, membership, invitations, owner team management, staff and
  payroll screens, PDF exports, and JSON clinic backup are implemented.
- The user confirmed the legacy `clinics/binan-clinic` data is demo-only, so
  roadmap item 0 (migrating that clinic) was skipped.
- Patient-image work is **partially verified**, not production-ready:
  - The private R2 bucket `vetcloudpro-images` and image Worker were created and
    the Worker's health endpoint responded successfully.
  - The local app is configured with `NEXT_PUBLIC_IMAGE_WORKER_URL` in its
    ignored `.env.local`. The deployed Worker allows the exact staging origin and
    localhost origins.
  - Earlier browser checks in the user-confirmed test clinic uploaded and
    re-displayed a fictional patient's profile image after refresh and re-login.
    A sample lab image was uploaded, displayed and removed without removing the
    profile image.
  - Live Worker checks covered owner/editor uploads, viewer read and
    upload/patient-write denial, outsider URL denial, and authenticated owner
    `DELETE` returning `405`. Isolated Chromium owner/viewer contexts on live
    staging confirmed a viewer image after reload and re-login, and the owner AI
    toggle propagating to the viewer. A live base64 migration remains
    outstanding. The single-object backup/restore below is not a full-bucket
    exercise.
  - R2 object deletion is disabled in the deployed Worker: an unauthenticated
    `DELETE /file` returned `405`, and mocked tests cover owner and viewer
    requests. An authenticated owner `DELETE` also returned `405` live; a
    viewer-specific authenticated `DELETE` was not recorded. Removed images and
    failed/cancelled uploads leave orphaned objects. Design and rehearse
    reference-aware cleanup before re-enabling it.
  - Clinic JSON backups contain R2 object keys, **not image bytes**. One
    fictional object was privately backed up and restored under `restore-test`
    with SHA-256 verification, and the new `restore:images` tool passed the same
    single-object live rehearsal. A full access-controlled bucket backup, a
    documented restore procedure, and a rehearsed multi-object restore are still
    required.
  - Existing base64 images remain renderable. The migration script has mocked
    tests, but must be tested with a backed-up test clinic before any live use.
  - Client-side filters accept only raster base64 images or credential-free
    HTTPS image URLs, add `no-referrer`, and validate signed-URL origin and key.
    This is defense-in-depth and does not replace server-side authorization.
  - See `workers/image-service/README.md` for setup and limitations.
- The clinic owner can control the clinic-wide **Enable AI features** toggle in
  Clinic Setup. It defaults to off when the clinic field is absent. Turning it
  off hides AI screens and patient-summary UI without deleting saved summaries
  or browser-local provider settings; turning it on shows them again. The demo
  setting is session-only and stays offline.
- **AI clinical analysis is not implemented.** The existing laboratory and
  extraction flows display predefined example output, now labeled as demo
  only. They must not be used for clinical decisions. Provider connection
  testing is separate from actual clinical analysis.
- The active `firestore.rules` include the owner-only AI toggle and the
  invitation-verification fix (ruleset
  `e49d3f3c-f232-477b-b7ff-471b89436b94`). Live owner enable/disable observed by
  a separate viewer client, and non-owner toggle denial, passed through the SDK.
  The owner/viewer browser UI path also passed in isolated Chromium contexts on
  live staging; this is not a physically separate browser.
- The app is **deployed to staging only**, as a static-export build behind
  Cloudflare Workers Static Assets at
  <https://vetcloudpro-staging.jmferrari16.workers.dev> (version
  `d8098314-5f66-41ed-9c3a-04d4997275aa`). There is no SSR and no paid backend.
  The site shows a TEST STAGING fictional-records banner and has no
  production-ready claim. Publishing code to GitHub does not deploy the app,
  Firebase rules, or the Worker.
- The login page no longer pre-fills or displays demo credentials. The manual
  offline demo login remains available.

## Recommended next steps

1. Keep production sign-off blocked on the remaining production blockers:
   full-bucket recoverability, strict quotas instead of approximate per-location
   rate limits, orphan retention/cleanup, historical key revocation, and real
   verification-email delivery. The regression/test results are now recorded;
   these gaps are what keep the app off real clinic records.
2. If sign-off requires it, repeat the owner/viewer UI path in a physically
   separate browser or device. The current pass uses isolated Chromium contexts
   against live staging.
3. Finish image security and operational checks using fictional records:
   physically separate browser UI, live 15-minute URL expiry, safe cleanup
   design, multi-object restore, full-bucket backup/restore, and a live base64
   migration test. Keep the bucket private. Do not migrate or remove real
   records until a backup and a test migration have been verified.
4. Invitation work: the unverified-email flaw is fixed and deployed. Still test
   real verification-email delivery, plus role changes, member removal, and
   backup download with dedicated accounts. Do not perform an ownership transfer
   on the existing clinic; if an ownership-transfer test is required, use a
   disposable synthetic clinic. Avoid changes to actual members, ownership, or
   irreversible payroll entries during smoke tests.
5. Start roadmap item 2 now: pagination and query limits, then offline
   persistence/PWA and the remaining items, using synthetic/staging data. The
   final regression results are recorded; further production hardening can
   proceed in parallel with the named blockers above.

The Bopp test clinic contains the fictional patient `Automation Test` and an
empty test lab panel. A test inventory item was created and deleted during a
previous browser check. Do not delete any other data without confirmation.

## Final verification recorded

The results below are the final recorded results. Live checks used synthetic
accounts, fictional records and the deployed Worker/staging endpoints.

| Check | Result |
| --- | --- |
| `npm run test:rules` | Passed; final emulator run uses pinned `firebase-tools` 15.36.0, covering invitation-verification and owner/non-owner AI-setting scenarios |
| `npm run test:images` | Passed, 21/21 tests; Worker and migration tests use mocks, plus a genuine unchanged signed-URL expiry test using a mocked clock |
| `npm run test:backup` | Passed, 9/9 tests for the referenced-image backup and restore tools |
| `npx tsc --noEmit` | Passed |
| `npm run build` | Passed (ordinary Next build remains the default) |
| `npm run build:staging` | Passed (opt-in static export) |
| `npm run lint -- --max-warnings=10` | Passed with 0 errors and 10 warnings |
| `npm audit` | Unchanged: 4 high, 7 moderate, 0 critical. See `docs/SECURITY-STATUS.md` |
| Demo login and AI toggle | Passed with external HTTPS blocked and no Firebase/R2 requests |
| Staging Playwright owner/viewer contexts | Passed on live staging: real login; owner AI switch propagated to viewer navigation and toggle, viewer control disabled; viewer R2 image rendered after reload and re-login; demo mode made no external Firebase/R2 requests |
| Staging GET and response headers | `GET` returned `200` containing the TEST STAGING warning; headers verified `no-referrer`, `nosniff`, `DENY`, `noindex` |
| Staging CORS preflight | `OPTIONS` returned `204` echoing the exact staging origin; not a wildcard |
| Firestore active rules | Exact match to `firestore.rules`, ruleset `e49d3f3c-f232-477b-b7ff-471b89436b94`; previous rules privately backed up as `firestore-rules-before-invite-verification-1794715019742.json` |
| Invitation verification (live) | Passed: unverified read and direct claim denied; verified-email invitee read/claim/accept allowed; existing owners unchanged; controlled verified-flag test admitted only the synthetic outsider via the real UI, then the temporary membership was removed. Real email delivery not tested |
| Live synthetic SDK/Worker authorization | Passed: invitation acceptance, owner toggle observed by a viewer client, non-owner (editor/viewer/non-member) toggle denial, owner/editor image uploads, viewer read and upload/patient-write denial, outsider URL denial, owner `DELETE` 405 |
| Live Worker rate limits | Passed bounded editor signing test: 61 `200` responses, then one `429` with `Retry-After: 60`; limits are approximate and per location, not a global quota |
| Live `restore:images` rehearsal | Passed for one fictional image with SHA-256 verification under `restore-test`; journal `/home/jm/.local/share/vetcloudpro-backups/live-restore-1794714961161.jsonl`; not a full-bucket backup |
| CI workflow | Added locally with pinned action SHAs, Node 24.22.2, Java 21; no deployment, secrets or live tests; not run on GitHub and not pushed |
| Physically separate browser, live 15-minute URL expiry, live base64 migration, real verification-email delivery | Not verified |
| Full-bucket recovery, strict global quotas, orphan cleanup, historical key revocation | Not implemented; production blockers |

The Playwright Chromium checks establish behavior in isolated browser contexts
against live staging, not a physically separate device. Earlier browser checks
generated PDF and JSON blobs for inspection; they did not prove download-dialog
behavior or backup restoration. Real AI output and account deletion were not
tested.

## Security and deployment reminders

- The previous project brief flags a historical hardcoded Gemini key in old
  local Git history. Confirm that any affected key was revoked/rotated; do not
  reproduce or publish the key. The current code must not contain secrets.
- Invitation admission is fixed and deployed, but real verification-email
  delivery is untested. Do not describe the invitation flow as fully verified or
  production-ready on that basis.
- Signed image URLs are bearer links and can remain usable until their expiry;
  revoking membership does not immediately invalidate an already-issued link.
- Worker rate limits are approximate and enforced per location, not as a global
  quota. They reduce accidental overuse but do not guarantee a hard usage cap.
- Client-side image URL filtering is defense-in-depth only. Server-side
  authorization and the private bucket remain the access-control boundary.
- Review billing limits, privacy requirements, and the full access model before
  using real clinic records. The staging environment shares the existing
  Firebase backend and is not proof of production security or compliance. Avoid
  claims that the system is "fully secure" or "production ready".
