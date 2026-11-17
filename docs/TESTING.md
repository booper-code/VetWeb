# Local regression checks

Use the pinned Node version in `.node-version` and Java 21 for emulator tests.
No command below needs live credentials or writes to the staging/shared backend.

```sh
npm ci
npm run lint
npm run test:images
npm run test:backup
npm run test:offline
npm run test:records
npm run test:workflows
npm run test:appointments
npm run test:rules
npx playwright install chromium
npm run test:offline:browser
npm run build
npm run build:staging
npm run test:appointments:browser
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
  Its contrast checks emulate light/dark system preferences and require black
  appointment labels, inputs, ordinary buttons and secondary text on light panels.
- `test:prototype`: opens the standalone HTML directly from `file://`, with
  external network requests blocked. Checks navigation, mock appointment forms,
  search/role previews, dossier tabs, mobile layout and reset-on-reload behavior.
  It tests a disposable design artifact, not production business logic.
- `test:offline:browser`: real Chromium, Firebase Auth/Firestore emulators,
  actual IndexedDB, and the actual device-settings component. Test-only bundle
  adapters replace project configuration and wire both SDKs to loopback.
  Browser requests to other hosts are blocked. Cases cover two memory-only
  tabs without a consent key, a trusted initialization/wipe race, blocked
  IndexedDB deletion, status surviving sign-out/remount, and successful retry.
  The small browser fixture is not the full staging app; page-level wipe
  wiring is covered separately by `test:workflows`.
- `test:offline`: public service-worker cache policy and consent defaults.
  Browser/emulator passes do not establish physically separate-device behavior,
  staging deployment, or production readiness.

The IndexedDB cleanup deadline is ten seconds. A blocked deletion must report
failure and require closing other tabs/retrying, not claim that data is erased.
The SDK's underlying deletion may complete later after the blocker closes.

GitHub CI includes these checks but has not run from this workspace (no `.git`).
