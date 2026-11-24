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
  page plus the real `OfflineStatus` shell (service-worker registration off)
  and signs in with fictional Viewer and Owner accounts in independent browser
  contexts: the same `docs/sample-inventory.csv` leaves the Viewer’s clinic
  unchanged, saves exactly 24 rows with 24 audit heads, events and receipts as
  Owner, and creates no duplicates after a fresh sign-in and retry. A Viewer
  that opened Inventory before the import sees the owner’s row, a later
  owner rename and an owner deletion without refreshing; a member of a second
  fictional clinic with its own context never sees those rows and its
  inventory stays empty on the server. With a write-capable Owner session held
  in memory but the canonical emulator membership downgraded to viewer, an
  import that the UI still offers fails with a real Firestore rules denial:
  `navigator.onLine` is true, the production status reports the rules error
  (not a success and not the offline banner), and no `CSV-DENIED` document is
  committed. A separate Owner context put offline shows the real banner and a
  front-end read-only refusal, commits no `CSV-OFFLINE` document either before
  or after reconnect, and the banner clears on reconnect. Both bundles connect
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

## Cross-device freshness audit: remaining clinical views (Task 4)

This is a read/write-path audit only; it adds no listener, permission, config,
dependency or app change and does not claim app-wide live sync. It extends the
Task 3 evidence above: **inventory is the only clinical collection whose
confirmed remote changes reach an already-open view** (the independent-context
emulator scenario in `tests/offline-browser.test.mjs:362-477` watches an import,
a rename and a delete appear for a Viewer without refreshing, while a second
clinic's open view stays untouched). The other `onSnapshot` users
(`subscribeClinicAI` and `subscribeClinicImageUploads` in `lib/clinics.ts`,
`watchAssistantRole` in `lib/workspace-assistant-access.ts`) deliver only
configuration/access state, not clinical records. "Fetch-on-open" below means
a one-shot read on mount, workspace/account change or an explicit button.

### Patient lists
- UI: `components/PatientRecordsView.tsx` (active/discharged directory and
  dossier), `components/DashboardHome.tsx`, `components/ClinicPatientSearch.tsx`.
- Read: `patients` state in `app/page.tsx:201` is filled by `useClinicPages`
  `load('activePatients', true)` and `load('dischargedPatients')`
  (`lib/useClinicPages.ts:89-156,158-179`) → `loadClinicPage`
  (`lib/clinic-pages.ts:45-84`), which uses `fs.getDocs` (server-preferring,
  cache fallback when offline). Discharged rows load only when that filter is
  first opened (`components/PatientRecordsView.tsx:612`). Directory search is
  a separate server-only lite `getDocs` scan (`loadClinicScanPage`,
  `lib/clinic-pages.ts:128-146`), keyed by `clinicScanKey` and gated by
  `clinicScanIsCurrent` (`app/page.tsx:110-111,295,1134-1143`).
- Write: `createQuickPatient`, `updatePatientRecord`, `deletePatientRecord`
  via `mutateClinicalRecord` (`app/page.tsx:315-655`); billing also patches
  patient rows through `applyBillingRecords` (`app/page.tsx:662-670`).
- Freshness: no listener. Fetch on open plus "Load more"/"Retry"
  (`components/PageControls.tsx`); when `hasMore` is false there is **no
  Refresh control**, so another device's admission/edit/discharge is invisible
  in an open directory until workspace reload or a new login. Cached rows can
  be visible: `getDocs` may fall back to cache, and opening an appointment's
  patient can use `getDocFromCache` while offline (`app/page.tsx:820-837`).
- Tests: `tests/clinic-pages-hook.test.mjs` pagination/generation (listener
  assertions are inventory-only), `tests/clinic-pages.rules.test.mjs` cursor
  bounds/legacy rows/clinic isolation, `tests/patient-search-workflow.test.mjs`
  and `tests/patient-search.browser.test.mjs` paged search/dossier,
  `tests/mutation-scope.test.mjs`. No test asserts a remote patient change
  reaching an already-open directory.

### Consultations
- UI: `components/PatientRecordsView.tsx` (dossier SOAP list/form) and
  `components/DashboardHome.tsx` (recent activity).
- Read: `consultations` state (`app/page.tsx:263`) via `useClinicPages`
  `load('consultations')` → `loadClinicPage` `fs.getDocs` (cache fallback),
  with dashboard "Load more"/"Retry" at `app/page.tsx:1098-1101`.
- Write: `toggleConsultationStatus` and `saveConsultationRecord`
  (`app/page.tsx:747-818`) → `mutateClinicalRecord` / `saveConsultation`
  (`lib/consultations.ts:55`), with stock changes patched into local state.
- Freshness: no listener, no Refresh control once fully loaded. An open
  dashboard or dossier misses another device's new SOAP or Draft→Completed
  change until reload; cached rows can be visible via `getDocs`.
- Tests: `tests/consultation-values.test.mjs`,
  `tests/clinical-activity.test.mjs`, `tests/clinic-pages.rules.test.mjs`.
  No cross-device assertion.

### Appointments and follow-ups
- UI: `components/AppointmentsView.tsx`, `components/FollowUpQueue.tsx`,
  `components/DashboardHome.tsx` due cards, `components/AppointmentReminders.tsx`.
- Read: `useAppointments` (`lib/useAppointments.ts`) → `loadAppointmentsPage`
  (`lib/appointments.ts:20-34`) uses `getDocs` online and `getDocsFromCache`
  offline, exposing `fromCache`/`refreshedAt` ("Cached results may be
  incomplete or outdated", `components/AppointmentsView.tsx:199`). It loads on
  mount, clinic/uid change, window change, "Load more" and "Refresh schedule"
  (dashboard: `appointments.load(true)`, `app/page.tsx:1091`). Follow-ups are a
  second, independently loaded path: `loadFollowUpPage` uses `getDocsFromServer`
  (`lib/follow-up.ts:24-36`), loaded on mount plus "Refresh queue"/"Load more"
  (`components/FollowUpQueue.tsx:59-68,113-115,147-148`).
- Write: `saveAppointment` (`lib/appointments.ts:37-75`) and
  `recordFollowUpContact` (`lib/follow-up.ts:46-71`) are revision-checked
  audited commits; results are patched into local state
  (`useAppointments.save`, `applyFollowUpContact`).
- Freshness: no listener. Cached/partial appointment rows **are** visible
  (offline cache path and bounded date window); follow-ups are server-only and
  cannot show cached rows. A remote reschedule/cancel/contact is missed by an
  open schedule, dashboard due card and follow-up queue until refresh.
  `AppointmentReminders` only recomputes labels on focus/visibilitychange
  (`components/AppointmentReminders.tsx:14-15`), not a refetch, as asserted in
  `tests/appointments-workflow.test.mjs:271`.
- Tests: `tests/appointment-values.test.mjs`,
  `tests/appointments-workflow.test.mjs` (stale read-vs-save, window changes,
  focus recalculation), `tests/appointments.rules.test.mjs`,
  `tests/appointments.browser.test.mjs`, `tests/follow-up-values.test.mjs`,
  `tests/follow-up-workflow.test.mjs`, `tests/follow-up.browser.test.mjs`.
  Single-view races and rules are covered; cross-device propagation is not.

### Billing
- UI: `components/PatientBilling.tsx` in the dossier tab, state in
  `lib/useBilling.ts`, gateway in `app/page.tsx:671-745`.
- Read: `loadBillingHistory` (`lib/billing.ts:190-198`), `loadBillingRecords`
  (`:177-188`), `checkBillingReconciliation` (`:200-224`) all use
  `getDoc(s)FromServer`; `loadPaymentReceipt` (`:226-236`) uses a transactional
  `tx.get`, and the commit receipt read is at `:172`. No cached ledger is
  displayed. `useBilling` loads once per patient/session
  (`lib/useBilling.ts:45-49`) and refetches on submit, explicit "Refresh
  billing", "Load more billing entries" and conflict-driven `refreshRecords`
  (`components/PatientBilling.tsx:182-192,255,300,323`).
- Write: `commitBilling` through `mutateClinicalRecord` with audit/receipt;
  responses patch patient/inventory state (`app/page.tsx:687-712`).
- Freshness: no listener. An open billing panel can show a stale balance or
  miss another device's posted entry/reversal until refresh or the next
  save's conflict path; it never shows a cached ledger.
- Tests: `tests/billing-values.test.mjs`, `tests/billing-workflow.test.mjs`
  (stale balance/conflict review), `tests/billing-reconciliation.test.mjs`,
  `tests/billing.rules.test.mjs`, `tests/billing.browser.test.mjs` (demo).
  No cross-device assertion.

### Next slice recommendation
Tackle **consultations** next as the smallest safe extension of the proven
inventory pattern: one read path (`useClinicPages.load('consultations')`),
bounded ID-ordered pages with no date sort or status-driven list moves
(`lib/clinic-pages.ts:56-60,69-78`), consumed by both the dashboard activity
list and the dossier. A confirmed-prefix listener would close the same
stale-view gap as inventory without widening to the whole collection, changing
permissions, or touching appointment/billing conflict machinery; it still
needs its own reviewed design and tests before implementation. Appointments
are the higher-value follow-on but require a separate plan: the schedule is
windowed and paginated with `committed`/generation race guards
(`lib/useAppointments.ts:19-79`) while the follow-up queue reads the same
collection through a different server-only path (`lib/follow-up.ts:28`), so a
single collection-wide listener would be wrong in both places. Independent
browser contexts are not physically separate devices; the shared cloud
deployment and real outages remain unverified.
