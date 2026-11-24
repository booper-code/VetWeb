# Local regression checks

For the staged functionality pass, isolation preflight, and release criteria,
see the [full QA plan](FULL-QA-PLAN.md).

Use the pinned Node version in `.node-version` and Java 21 for emulator tests.
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
  rename/ownership callbacks, and session restoration. Separate hook tests
  exercise pagination invalidation and first-load recovery. The actual Team
  component is tested for transfer completion before/after unmount; parent
  tests separately verify clinic scope and preserving same-clinic navigation.
  This is not a full end-to-end test of each form.
- `test:rules`: emulator-only authorization, real cursor queries, and audited
  transactions. Direct adversarial batches bypass the helper to test forged
  actor/timestamp/sequence, mismatched and cross-clinic metadata, reused events,
  deleted-ID reuse, extra keys, and consistent/inconsistent editor writes.
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
  page and signs in with fictional Viewer and Owner accounts: the same
  `docs/sample-inventory.csv` leaves the Viewer’s clinic unchanged, saves 24
  rows and their audit records as Owner, and creates no duplicates after a
  fresh sign-in and retry. Both bundles connect only to loopback; neither is
  the hosted staging app.
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
