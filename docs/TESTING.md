# Local regression checks

For the staged functionality pass, isolation preflight, and release criteria,
see the [full QA plan](FULL-QA-PLAN.md).

Use the pinned Node version in `.node-version` (24.22.2) and Java 21 for emulator tests.
The offline/browser slice recorded below was verified with Node 24.21.0 (one patch
below the pin) and Java 25.0.4.1; the emulators, Chromium and all listed suites
passed on those installed versions, but the pinned pair was not re-run here.
No command below needs live credentials or writes to the staging/shared backend.

```sh
npm ci
npm run lint
npm run test:images
npm run test:backup
npm run test:offline
npm run test:offline:banner
npm run test:records
npm run test:workflows
npm run test:appointments
node --test tests/ai-clerk-demo.test.mjs
node --test tests/ai-model-discovery.test.mjs
node --test tests/workspace-assistant.test.mjs
node --test tests/workspace-assistant-access.test.mjs
node --test tests/assistant-investigation.test.mjs
npm run test:rules
npx playwright install chromium
npm run test:offline:browser
npm run build
npm run build:staging
node --test tests/ai-clerk-demo.browser.test.mjs tests/ai-clerk-qa.browser.test.mjs
node --test tests/ai-provider-settings.browser.test.mjs
node --test tests/workspace-assistant.browser.test.mjs
npm run test:appointments:browser
npm run test:theme
npm run test:prototype
```

Do not run the two emulator commands concurrently: both use ports 8080/9099.
Run heavyweight builds separately from emulator startup on a resource-limited
machine; the SDK's initial connection timeout can otherwise expire while Java
is compiling the rules. A clean sequential rerun is required after such a failure.
On Linux CI, `npx playwright install --with-deps chromium` also installs browser
system dependencies. An existing compatible Chromium may be selected with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; no machine-specific path is committed.
If Java is unpacked privately, prepend its `bin` directory to `PATH`.

## Coverage boundaries

- `test:workflows`: real React state/effects in jsdom with shallow child views
  and deferred Firebase doubles. It executes the actual page callbacks for all
  eight clinical actions, successful and failed late completions after clinic
  switching/logout/wipe, identical document IDs across clinics, entry rejection
  of obsolete child callbacks, legitimate current-workspace completions,
  rename callbacks, and session restoration. Separate hook tests
  exercise pagination invalidation and first-load recovery. The actual Team
  component is tested for Owner-only invite and removal controls; parent tests
  verify Member access to clinic settings and audit.
  This is not a full end-to-end test of each form.
- `test:rules`: emulator-only authorization, real cursor queries, and audited
  transactions. Direct adversarial batches bypass the helper to test forged
  actor/timestamp/sequence, mismatched and cross-clinic metadata, reused events,
  deleted-ID reuse, extra keys, and consistent/inconsistent Member writes.
  Invitation rules cover verified-email acceptance, legacy invitations,
  atomic membership creation and removal, and immutable clinic ownership.
  The appointment suite additionally checks schema/patient binding, occurrence
  versus entry times, concurrent edits, cancellation after patient deletion,
  equal-timestamp paging and offline cached reads without queued writes.
- `test:appointments`: pure validation, DST/local-day boundaries, safe manual
  sharing and calendar export, plus actual React appointment hook/form tests
  and JSON-backup inclusion. Includes stale read-versus-save races (including
  rescheduling out of the selected window), default-window advancement across
  days, and date regrouping on focus without background fetches.
- `test:appointments:browser`: requires a fresh `build:staging` in `out/`.
  Tests the actual exported app's offline demo, not a test SDK adapter:
  schedule a vaccine appointment, verify its dashboard due card, open the
  patient dossier, download a calendar file, enter a past actual visit time,
  cancel, and check the 390px layout. External requests are blocked, with
  an assertion of no Firebase/R2 traffic. It never signs into a live account.
  Its contrast checks emulate light/dark system preferences and require at least
  4.5:1 contrast for the sampled appointment text and controls on flat surfaces.
- The AI Clerk and lab/CSV browser tests also require a fresh static export.
  They block external requests and exercise the AI switch, fictional previews,
  rejection of ambiguous and oversized notes, unchanged appointment records,
  demo-only lab copy, and inventory CSV validation before saving.
- AI model discovery tests intercept HTTP with fictional keys. The browser
  suite mounts the real Clinic setup component in a local fixture; it checks
  model search and selection, explicit saving, late responses, manual entry,
  catalog labels, and the demo gate. It does not need a static export and
  does not verify live provider availability or browser access to their APIs.
- Workspace assistant browser tests use the static demo export and a local role
  and schedule fixture. They verify focus, mobile layout, disambiguation, no
  write before confirmation, and that a Manila-time reschedule updates only
  the selected fixture appointment on a device in another timezone. The
  workflow suite verifies the actual page's clinic/role handoff boundary
  with local doubles. The assistant access suite checks canonical membership
  reads/listeners and account-change guards with a test-only Firebase adapter;
  no live site or AI provider is contacted.
- The assistant investigation suite reports deterministic routing correctness and
  local elapsed time on fictional English/Tagalog/Taglish prompts. It checks
  typed contract errors, mismatched evidence, access denial, timeout/cancellation,
  and that instructions in prompts or records cannot select unrestricted tools.
  Model tokens and calls are zero by design; there is no DeepSeek comparison yet.
  The rules and signed-in browser emulator suites exercise the real Worker
  handler with projected owner/patient names and verified import receipt counts.
- `test:theme`: requires a fresh static export. Holds the Next.js bundle back
  to check the initial canvas and color scheme, tests persisted overrides and
  live System changes, and samples dark surfaces in the real offline demo.
  Clinic selection, verification notices, team, audit and owner settings also
  run in an isolated browser fixture using the real components and exported CSS
  with local data adapters. These are not live authentication or permission tests.
- `test:prototype`: opens the standalone HTML directly from `file://`, with
  external network requests blocked. Checks navigation, mock appointment forms,
  search/role previews, dossier tabs, mobile layout and reset-on-reload behavior.
  It tests a disposable design artifact, not production business logic.
- `test:offline:browser`: real Chromium, Firebase Auth/Firestore emulators,
  and actual IndexedDB. The device-settings fixture covers cross-tab sign-out,
  a trusted initialization/wipe race, blocked deletion, status surviving
  sign-out/remount, and retry. A separate test-only bundle renders the main app
  page plus the real `OfflineStatus` shell (service-worker registration off)
  and signs in with fictional Member and Owner accounts in independent browser
  contexts. The Owner's import of `docs/sample-inventory.csv` saves 24 rows
  with 24 audit heads, events and receipts, and creates no duplicates after
  a fresh sign-in and retry. A Member can import inventory and see the Owner’s
  import, rename and deletion without refreshing; a member of a second
  fictional clinic with its own context never sees those rows and its
  inventory stays empty on the server. With a write-capable Owner session held
  in memory but its canonical emulator membership removed, an
  import that the UI still offers fails with a real Firestore rules denial:
  `navigator.onLine` is true, the production status reports the rules error
  (not a success and not the offline banner), and no `CSV-DENIED` document is
  committed. A separate Owner context put offline shows the real banner and a
  front-end read-only refusal, commits no `CSV-OFFLINE` document either before
  or after reconnect, and the banner clears on reconnect. The Owner also
  creates a real Member invite, which a separate account verifies and accepts
  through the emulator-backed UI. Both bundles connect
  only to loopback with fictional accounts; neither is the hosted staging app.
  These are local emulator results: the shared cloud project’s deployed rules,
  physically separate devices and real network outages are not verified.
- `test:offline:banner`: builds the static export, then checks the real app
  shell offline banner at desktop and mobile widths plus the mounted live
  region, reduced motion, service-worker notice independence, and reconnect.
  Use this script rather than running the browser test file directly so the
  exported stylesheet is fresh.
- `test:offline`: public service-worker cache policy and consent defaults.
  Browser/emulator passes do not establish physically separate-device behavior,
  staging deployment, or production readiness.

The IndexedDB cleanup deadline is ten seconds. A blocked deletion must report
failure and require closing other tabs/retrying, not claim that data is erased.
The SDK's underlying deletion may complete later after the blocker closes.

The GitHub workflow runs on pushes to `main` and pull requests. Check its
result separately; passing locally does not verify the GitHub run.

## Cross-device freshness and audit evidence

The earlier baseline only demonstrated confirmed remote updates in an
already-open inventory view. Other clinic views depended on opening the
view again or fetching another page.

Inventory, the loaded patient directory, open dossiers, consultation history,
the selected appointment range and the open follow-up queue update from
server-confirmed data. The open patient billing panel reloads its posted history
when the confirmed billing sequence changes, retaining the requested page depth.
Clinic-wide patient search and exports still run as separate bounded scans.
An open follow-up queue advances at Manila midnight and rechecks the date on
tab focus, return to visibility, and reconnect.

After `npm run build:staging`, run `node --test tests/patient-admission.browser.test.mjs tests/follow-up.browser.test.mjs`
to check persistent admission validation and Manila rollover in the exported demo.

Run `npm run test:rules` and then `npm run test:offline:browser`; the two
commands use the same emulator ports. The latter exercises separate fictional
browser sessions for history, live record changes and isolation.

### Consultation history backfill (emulator)

With the Firestore emulator running under a `demo-` project and
`FIRESTORE_EMULATOR_HOST` set to its loopback address, preview a fictional clinic:

```text
node scripts/backfill-consultation-history.mjs --project demo-vetcloud-rules --clinic <fixture-id>
```

Append `--apply` to populate the sort keys. If a competing write interrupts
the operation, the clinic remains in document-ID order. Rerun the same command on
that fixture to resume, verify all sort keys, and enable chronological history.

New empty clinics start in chronological mode. Existing clinics retain all rows
in document-ID order until their backfill is verified. No hosted migration is
part of this rehearsal.

The 63-visit rules fixture includes exact timestamps, recognizable legacy
dates and ambiguous dates. A competing edit interrupts the first application;
the retry preserves the edit and enables chronology. The confirmed application
query returns all 63 visits, with dated visits first, and a second apply
requires zero writes.

### Audit checkpoints (emulator)

Staff profiles, pay rates, and payroll period changes now append metadata to
Clinical audit in the same transaction as the change. Posted billing and
payroll transactions keep their separate ledgers.

For a fictional clinic, set `FIRESTORE_EMULATOR_HOST` to the loopback address.
With an externally held Ed25519 key pair and fresh private output paths:

```text
node scripts/audit-checkpoint.mjs capture --project demo-vetcloud-rules --clinic <fixture-id> --snapshot before.json
node scripts/audit-checkpoint.mjs create --snapshot before.json --checkpoint checkpoint.json --key private.pem
node scripts/audit-checkpoint.mjs capture --project demo-vetcloud-rules --clinic <fixture-id> --snapshot after.json
node scripts/audit-checkpoint.mjs verify --snapshot after.json --checkpoint checkpoint.json --key public.pem
```

Capture reads Clinical audit, billing entries and the payroll ledger from one
read-only snapshot. The checkpoint contains digests and a signature. The
verification command exits nonzero for missing or changed recorded entries,
scope mismatch, a reused or older snapshot timestamp, or an invalid signature; additional records are counted
separately. Keep input snapshots private. The signing key, trusted public key
and retained checkpoints need separate operational control from Firebase.
Acquire the comparison independently from the live database. The offline
verifier takes the comparison file as input and cannot establish its origin
or detect someone relabeling an old file.
This detects later changes to records covered by a trusted checkpoint; events
removed before the first trusted capture cannot be recovered or proven by it.
The emulator rehearsal verifies an independently captured, intact snapshot
with a disposable Ed25519 key. After one privileged fixture edit and one
deletion, a fresh capture reports one changed entry and one missing entry.

For a future hosted setup, an independent operator would collect fresh,
read-only snapshots with a dedicated reader identity. That operator would
hold the signing key outside the Firebase project and store signed checkpoints
in append-only storage with enforced retention under separate administration.
Reviewers would get the trusted public key independently, take comparison
snapshots via the reader, and verify against the retained checkpoints. The
current capture command is emulator-only; a hosted collector, custody,
retention and scheduling still need separate approval and setup.
