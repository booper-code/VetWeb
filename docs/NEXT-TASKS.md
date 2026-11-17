# Remaining work — handoff for the next chat

**Date:** 2026-11-16
**Scope:** local-only development. Nothing in this list authorizes deployment,
live data changes, seeding, or touching shared backends.

Current tree state: type-check, lint (0 errors, 1 known warning), workflows 72,
appointments 21, consultations 9, rules/emulator 95 scenarios, offline browser 4,
offline-policy 6, images 22, backup 18, records 2, prototype 1, and both builds
pass. A real Chromium demo pass also verified the clinical-activity flow. The
workspace has **no `.git`**, so nothing is committed, pushed, or CI-verified.

---

## 1. Waiting on Sol's review

- [ ] Read Sol's findings from the 2026-11-16 cleanup pass and fix only what is
      flagged, then rerun the affected checks.
- [ ] Review targets: `components/OfflineDeviceSettings.tsx` (dismiss control),
      `components/PatientRecordsView.tsx` (removed dead handlers),
      `components/SystemSettingsView.tsx` + `app/page.tsx` (removed
      `setInventory`), `workers/image-service/src/index.ts` (named default
      export), `tests/offline-browser.test.mjs` (dismissal assertion).
- Note: dismissal clears in-memory status only; a full reload resets it. That is
      expected until item 5.1 is done.

---

## 2. Next feature — structured clinical activity / treatment entry

Goal: replace free-text consultations with auditable, structured treatment
records that support day-end entry.

- [x] Add an **actual event timestamp** (`occurredAt`) to `Consultation` in
      `types.ts`, separate from server `createdAt`/`updatedAt`, mirroring
      `Appointment.occurredAt`. Legacy rows still fall back to `date`.
- [x] Add structured treatment lines: service or item, quantity, dose/notes,
      linked patient, linked appointment (optional), and the staff member.
- [x] Route medicine/supply usage through the existing stock path so dispensing
      decrements inventory exactly once; no direct stock edits.
- [x] On appointment completion, allow creating a linked consultation/activity
      record (do not auto-create clinical content). Completed rows offer
      **Record treatment & stock**, which opens the dossier with the visit time
      and appointment already linked.
- [x] Keep entry time and event time visibly distinct in the UI; allow
      backdated event times for day-end data entry.
- [x] Rules: members read; owner/editor create/update; no deletes; audit entry
      per write. `stockMoves` and treatment lines are immutable after creation.
- [x] Emulator tests for role denial, cross-clinic access, timestamp integrity,
      stock linkage and appointment-link status.

Acceptance: a treatment entered at day's end stores the real visit time, moves
stock once, links to the patient/appointment, is visible to all clinic members,
and cannot be edited by a viewer.

Implementation files: `types.ts`, `lib/consultation-values.ts`,
`lib/consultations.ts`, `components/ClinicalActivity.tsx`,
`components/PatientRecordsView.tsx`, `components/AppointmentsView.tsx`,
`app/page.tsx`, `firestore.rules`, `tests/consultation-values.test.mjs`,
`tests/clinical-activity.test.mjs`, `tests/firestore.rules.test.mjs`.

Remaining limits to keep explicit:
- Firestore rules cannot loop over arbitrary lists, so `stockMoves` is capped at
  two and must stay in sync with medicine/supply treatment lines. The trusted
  server action builds both; do not expose direct consultation writes to
  untrusted clients.
- Treatment records intentionally do not add patient charges; billing and
  receipts remain feature 3.
- Clinical writes are not queued offline; entry requires an online owner/editor.
- Legacy consultations have no `occurredAt`/`treatments`/`stockMoves` and keep
  working through the legacy shape.

---

## 3. Next feature — payments and receipts

Goal: make `balance` real and auditable instead of a hand-edited number.

- [ ] Add a payments model (subcollection or array): amount, method, reference,
      received-by, recorded-at, note.
- [ ] `recordPayment` runs transactionally: append payment, reduce balance.
- [ ] Charge/billable writes stay transactional with stock changes; voiding a
      charge restores stock and reverses the balance without hard-deleting the
      original line.
- [ ] Keep `balance == charges - payments` and add a reconciliation check.
- [ ] Add a receipt PDF using `lib/pdf.ts` (currency as `PHP`, not `₱`).
- [ ] Rules: owner/editor write; no deletes; owner-only void/refund if that is
      clinic policy. Test concurrent payments and stock contention.
- [ ] Document the Firestore transaction ceiling and how large dispenses are
      split or bounded.

Acceptance: a payment reduces the balance exactly once, receipts match, voids
reverse both stock and balance, and concurrent writes cannot double-apply.

Likely files: `types.ts`, `components/PatientRecordsView.tsx`, `lib/pdf.ts`,
`lib/firestore` helpers, `firestore.rules`, tests.

---

## 4. AI assistant (only after sections 2 and 3)

- [ ] Implement the design in `docs/AI-ACTION-PLAN.md`: propose → staff confirm →
      execute a predefined action.
- [ ] No autonomous clinical decisions, no unrestricted database access, no
      background writes. AI must never invent a charge, treatment, or diagnosis.

---

## 5. Known local fixes / technical debt

- [ ] **Durable device-clear status.** Success/failure and dismissal currently
      live in module memory; a full reload loses them. Decide whether the
      cleared/failed state should persist across reload and test it.
- [ ] **Upload-pause read cache.** Confirm what remains readable when an owner
      pauses uploads, and test that cached image URLs do not keep serving new
      content against policy.
- [ ] **Consultation date ordering/backfill.** New rows store `occurredAt` and
      the patient dossier sorts by it with a legacy `date` fallback. Legacy rows
      have not been backfilled, and clinic-wide consultation pagination still
      uses the existing document order, so do not promise chronological pages
      across mixed old/new records yet.
- [ ] **Strict image quotas.** Worker limits are approximate per-location rate
      limits, not global byte quotas. Add hard caps or monitoring before the
      free tier can be exhausted.
- [ ] **Audit tamper-evidence.** Rules block edits/deletes, but project
      credentials bypass rules. Either add export/independent retention or keep
      the limitation explicit in the UI and docs.
- [ ] **Offline write queue.** Deliberately absent. Any future drafting needs
      conflict resolution and a revision policy first; do not queue clinical
      writes blindly.
- [ ] **Git metadata / CI.** Initialize or attach the repository and push so
      `.github/workflows/verify.yml` actually runs.
- [ ] **Last lint warning.** Replace the `<img>` in
      `components/AILaboratoryView.tsx:103` with `next/image`, then the
      `--max-warnings=1` gate can become `--max-warnings=0`.

---

## 6. Before any deployment (requires explicit user authorization)

- [ ] Publish the current `firestore.rules` (the local batch is not live).
- [ ] Deploy the image Worker only if it changed, and rebuild/redeploy staging.
- [ ] Resolve the production blockers: full-bucket recovery, strict global
      quotas, orphan retention/cleanup, historical key revocation, real
      verification-email delivery, and the external image-host policy.
- [ ] Run the live smoke checks in `docs/STAGING.md`; do not describe
      emulator/build results as live verification.

---

## 7. Decisions still needed from the user

- [ ] Which payment methods and receipt fields are required?
- [ ] Can editors void/refund, or is that owner-only?
- [ ] Should editors see the clinical audit trail, or owner-only?
- [ ] Authenticated/signed image URLs vs. unguessable public keys?
- [ ] Is `clinics/binan-clinic` real data needing migration, or disposable demo
      data?

---

## 8. Local environment notes

- Workspace has **no `.git`**; there is no diff history to review.
- Firestore emulator needs Java 21:
  `PATH="/tmp/opencode/java21/bin:$PATH"`.
- Browser tests need the installed Chromium:
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/home/jm/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"`.
- Do not run emulator suites concurrently — they share ports 8080/9099.
- Lint gate is `npm run lint -- --max-warnings=1`.

Verification set:

```sh
npx tsc --noEmit
npm run lint -- --max-warnings=1
npm run test:workflows
npm run test:appointments
npm run test:consultations
PATH="/tmp/opencode/java21/bin:$PATH" npm run test:rules
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/home/jm/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome" npm run test:offline:browser
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/home/jm/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome" npm run test:prototype
npm run test:images && npm run test:backup && npm run test:offline && npm run test:records
npm run build && npm run build:staging
```

There is intentionally no deploy command in this list.
