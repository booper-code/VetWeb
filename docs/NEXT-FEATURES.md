# VetCloudPro — feature handoff

This document is for the next chat/agent picking up **new features**. The
multi-clinic essentials are implemented in the working tree; see
`.opencode/HANDOFF.md` for the exact session state and verification commands.

## 1. Baseline

Done and verified in the emulator/build:

- Multi-clinic auth, clinic creation, editor/viewer invitations, member list.
- Owner member management: change role, remove member, transfer ownership.
- Owner clinic rename.
- Staff roster + owner-only pay rates + payroll periods + append-only,
  hash-chained payroll ledger with head anchoring.
- PDF exports for inventory and patient/medical records (client-side jsPDF).
- Owner-only JSON clinic backup download.
- Tenant-scoped `firestore.rules`, committed emulator suite (`npm run test:rules`).

Not verified yet:

- Live browser click-through of invitation acceptance, member role change,
  member removal, ownership transfer, and backup download.
- The latest `firestore.rules` has **not** been republished to the live
  `vetcloudpro` project. Until it is, the new member-management and
  staff/payroll collections are denied in production.

All current work is **uncommitted** on `main`; last commit is `622acf6`.

## 2. Ground rules

- **Stack constraint:** Firebase Spark + Cloudflare free tiers only. No paid
  server, no Cloud Functions/Blaze, no paid email/SMS.
- **Demo login must keep working.** `demo-clinic` bypasses Firebase entirely;
  never make demo mode depend on a network call.
- **Rules are the only access control.** Every new collection needs rules,
  emulator scenarios in `tests/firestore.rules.test.mjs`, and a manual
  republish in the Firebase Console.
- **Owner-only data lives in a separate collection.** Firestore rules cannot
  hide individual fields; that is why pay rates are in `payProfiles`.
- **Firebase stays lazily imported** through `lib/firebase.ts` and `lib/*`
  modules; components should not import `firebase/*` directly.
- **PDF currency is `PHP`, not `₱`** — the built-in PDF font cannot render it.
- **Next.js 16:** read `node_modules/next/dist/docs/` before changing routing,
  caching, or server/client boundaries. Do not assume older Next conventions.
- Keep diffs focused; the repo has pre-existing lint errors in older files.

## 3. Recommended order

| # | Feature | Effort | Why now |
|---|---|---|---|
| 0 | Migrate `clinics/binan-clinic` | S | If it is real data, it is inaccessible until membership exists |
| 1 | Move patient images to Cloudflare R2 | M | Biggest data-model risk; base64 photos nearly fill 1 MiB docs |
| 2 | Pagination + query limits | M | Every login currently downloads every patient, photo included |
| 3 | Offline persistence + PWA | M | Clinic wifi drops should not lose a consultation |
| 4 | Appointments + vaccine reminders | M | Highest-value vet-specific feature; no server needed |
| 5 | Billing tied to inventory | L | Makes `balance` real and dispensing safe |
| 6 | Clinical audit log | M | Extends the payroll hash-chain pattern to patient records |
| 7 | Email invites via Cloudflare Worker | M | Removes manual link copying without Firebase Blaze |
| 8 | Polish: errors, account deletion, reports, CI | S–M | Do after the data model settles |

If `binan-clinic` contains only demo data, skip item 0 and start at item 1.

## 4. Feature specs

### 0. Migrate `clinics/binan-clinic`

The clinic predates the membership model. Rules require
`clinics/{clinicId}/members/{uid}`, so nobody can read it until an owner
membership exists.

Steps:

1. The owner signs in (or signs up) so Firebase Auth has a UID. Copy the UID
   from Firebase Console → Authentication → Users.
2. In the Firestore Console (console writes bypass rules), create:
   - `clinics/binan-clinic/members/{uid}` with `uid`, `email`, `displayName`,
     `role: "owner"`, `createdAt` (timestamp).
   - `users/{uid}/clinics/binan-clinic` with `clinicId`, `clinicName`,
     `role: "owner"`, `joinedAt` (timestamp).
3. Set `ownerId` on `clinics/binan-clinic` to that UID if it is missing.
4. Sign in and confirm the clinic appears in the clinic picker, data loads,
   rename and backup work.

Acceptance: owner sees the clinic and its existing patients/inventory; a
non-member still gets permission denied.

### 1. Move patient images to Cloudflare R2

Current state:

- `PatientRecord.pictures`, `profilePicture`, and `LabResult.imageUrl` hold
  **base64 data URLs inside the patient document**.
- `lib/images.ts` compresses to 800 px/q0.72 (profile) or 1600 px/q0.8 (labs).
- `MAX_PATIENT_DOC_BYTES` (900 KB) is checked in `app/page.tsx` before writes.
- Every patient list load downloads every embedded image.

Target:

- Add a Cloudflare Worker in front of an R2 bucket.
  - `POST /upload`: verify the caller's Firebase ID token, accept a compressed
    image, store it under a random key, return the key/URL.
  - `GET /file/{key}`: serve the object. Prefer authenticated/signed access;
    patient photos are sensitive. If using public unguessable keys, document
    the tradeoff.
  - Set CORS for the app origin and localhost.
- Store object keys (and optionally a URL) in the patient document instead of
  base64. Keep a render fallback for values that still start with `data:` so
  old records keep working during migration.
- Reuse the canvas compression in `lib/images.ts`, but return a `Blob`/`File`
  for upload instead of a data URL.
- Best-effort delete of orphaned objects when a photo is removed.
- Migration: download a clinic backup first, then a one-off script reads each
  patient, uploads every data URL, rewrites the fields, and verifies counts.
  Batch writes and keep the original JSON until the migration is confirmed.
- PDF export: `jsPDF.addImage` needs image data. Either fetch each image with
  CORS and convert to a data URL for the PDF, or omit images from PDF v1.

Acceptance:

- A patient with a profile photo and lab images has a Firestore document well
  under 100 KB.
- Images still render after refresh and in a second browser.
- Removing a photo does not break the record.
- Existing base64 records still display until migrated.

Risks: Worker auth must verify Firebase ID tokens (Google JWKS) and check
clinic membership; do not trust a client-supplied clinic ID. Keep R2 and
Resend credentials as Worker secrets, never in the repo.

### 2. Pagination + query limits

Current state: `syncCloudData` in `app/page.tsx` calls `getDocs` on all
patients, inventory, and consultations with no `orderBy`/`limit`.

Target:

- Patients: load active records first, then discharged history in pages
  (e.g. 50 at a time) using `limit` + `startAfter`. Add a `dischargedAt`
  timestamp when status becomes `Discharged` so history has a stable sort.
- Consultations: newest-first pages.
- Inventory: likely small enough to keep loading in full.
- Add "Load more" controls; reset cursors on clinic switch.
- Document any composite indexes (e.g. `status == "Discharged"` +
  `orderBy("dischargedAt", "desc")`) and create them in the Firebase Console.
- Dashboard counts: either compute from loaded pages and label them
  approximate, or use `getCountFromServer` (billed as reads, but far cheaper
  than documents).

Acceptance: first load is bounded; "Load more" appends without duplicates;
search still works on loaded data; no full collection scan on login.

### 3. Offline persistence + PWA

Current state: `getFirestore(app)` uses memory cache. The demo is offline only
because it skips Firestore; real clinics lose unsynced work on refresh.

Target:

- Switch `lib/firebase.ts` to `initializeFirestore(app, { localCache:
  persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })`.
  It must be called once, before any other Firestore use, and must fall back to
  memory cache if persistence is unavailable (private mode/Safari).
- Surface pending writes (`hasPendingWrites`) and a simple online/offline
  indicator.
- Add a PWA manifest, icons, and a service worker that caches the app shell.
  Do not try to cache Firestore traffic; the SDK handles its own queue.
- Read the Next.js 16 docs before adding a service worker or manifest route.

Acceptance: load a clinic online, go offline, reload — data is still there;
create a patient offline, reconnect — it syncs exactly once; two tabs do not
duplicate writes.

### 4. Appointments + vaccine reminders

New collection `clinics/{clinicId}/appointments/{appointmentId}`:

```ts
{
  id: string;
  patientId: string;
  patientName: string;
  ownerName: string;
  ownerContact: string;
  ownerEmail?: string;
  type: 'Checkup' | 'Vaccination' | 'Deworming' | 'Grooming' | 'Surgery' | 'Follow-up';
  dueAt: Timestamp;
  durationMinutes?: number;
  status: 'scheduled' | 'completed' | 'cancelled' | 'no-show';
  notes?: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

UI: a new sidebar tab with upcoming appointments grouped by day, filters by
type/status, create/edit, mark complete/cancel, and a link to the patient.

Reminders without paid services:

- In-app "due today / this week" card on the dashboard.
- `mailto:` and `https://wa.me/...` share buttons with a prefilled message;
  the staff member sends manually.
- Downloadable `.ics` file for the clinic's calendar.
- Later, a Cloudflare Worker + Resend free tier can send email automatically
  (same infrastructure as item 7).

Rules: all members read; owners/editors create/update; deletes owner-only or
replace deletes with `cancelled` status. Add emulator scenarios.

Acceptance: appointment persists, appears in the due list, can be completed,
and a viewer cannot edit it.

Optional follow-ups: vaccine schedule templates by species, auto-create a
follow-up from a completed consultation.

### 5. Billing tied to inventory

Current state: `PatientRecord.balance` is a hand-edited number;
`billableItems` live on the patient document and do not move stock; there is
no payment history.

Target:

- Keep `billableItems`, add a `payments` array (or a `payments` subcollection)
  with date, amount, method, reference, received-by, note.
- `addBillableItem` runs in a transaction: read the inventory item, verify
  stock, decrement stock for `Medicine`/`Supplies`, append the billable item,
  and increment the balance/charges.
- `recordPayment` runs in a transaction: append payment, decrement balance.
- Voiding a charge restores stock and reverses the balance; never hard-delete
  the original entry (mark it voided) so the history stays auditable.
- Add a receipt PDF using the existing `lib/pdf.ts` helpers.
- Decide and document whether `balance` is stored or derived. If stored,
  add a reconciliation check (`charges - payments == balance`).

Rules: owners/editors write charges and payments; no deletes; owner-only
refunds/voids if that matches clinic policy. Test concurrent dispensing so
stock cannot go negative.

Acceptance: dispensing decrements stock exactly once; voiding restores it;
receipt totals match; balance equals charges minus payments.

### 6. Clinical audit log

Mirror the payroll pattern:

- `clinics/{clinicId}/auditLog/{entryId}`:
  `seq`, `action`, `entityType`, `entityId`, `summary`, `actorUid`,
  `actorEmail`, `createdAt`, `prevHash`, `hash`.
- Head document `auditMeta/ledger` with the last `seq` and `hash`.
- Extract the canonicalize/hash/verify helpers from `lib/payroll.ts` into a
  shared `lib/hashChain.ts` instead of duplicating them.
- Rules: create by owners/editors, no update/delete; read owner-only (decide
  whether editors should see the audit trail).
- Instrument patient create/update/delete, inventory changes, consultations,
  billing/payments, staff changes, member role changes/removal/transfer, and
  clinic rename.
- Add a "Verify integrity" view in Account Settings.

Honest limit: client-side logging is best-effort — a malicious client can skip
writing an entry. True enforcement needs a trusted server (Cloud Functions on
Blaze, or a Worker with Admin credentials). Say this in the UI.

Acceptance: each instrumented action appends one entry; verification detects
edits, reordering, and tail deletion via the head anchor.

### 7. Email invites via Cloudflare Worker

Current state: owners copy a one-time invite link and send it manually.

Target:

- Worker endpoint `POST /api/invite-email`:
  - Verify the caller's Firebase ID token against Google's public JWKS.
  - Read `clinics/{clinicId}/members/{uid}` via Firestore REST and require
    `role == "owner"`.
  - Validate the recipient email and rate-limit per user/clinic.
  - Send through Resend's free tier (or another free transactional email API).
  - Store the API key as a Worker secret, never in the repo.
- Email contains clinic name, inviter, role, expiry, and the invite link.
- Keep the existing copy-link flow as a fallback.

Acceptance: the email arrives; the link opens the app and acceptance works;
a revoked/expired invite fails; a non-owner cannot send.

### 8. Polish

- Error boundary and readable `permission-denied` messages ("rules may not be
  published" instead of a generic load failure).
- Account deletion after ownership transfer: requires a recent login, cleanup
  of memberships/indexes, and a decision about clinics with no other owner.
  Rules for deleting user documents need to be designed and tested.
- Staff deletion vs deactivation; payslip PDFs; attendance/deductions if the
  clinic asks for them.
- Revenue and inventory-turnover reports.
- Accessibility pass (aria-labels, `next/image`).
- CI: GitHub Actions running `npm ci`, `npm run test:rules`, `npx tsc
  --noEmit`, `npm run build`. The emulator needs Java, which GitHub runners
  provide.

## 5. Verification checklist for any change

```text
npm run test:rules      # Firestore emulator, all authorization scenarios
npx tsc --noEmit        # type check
npm run build           # production build
npx eslint <touched files>
```

Then publish the full `firestore.rules` manually in Firebase Console → Rules.
Add emulator scenarios for every new collection before publishing. Manually
smoke-test the demo login, clinic creation, invite acceptance, role change,
removal, ownership transfer, backup download, both PDF exports, and payroll
chain verification.

## 6. Open questions for the user

1. Does `clinics/binan-clinic` contain real records that must be migrated
   before anything else?
2. Should the audit log be readable by editors or owner-only?
3. For R2: authenticated/signed image URLs, or unguessable public URLs?
4. Billing: keep a stored `balance` with transactional updates, or derive it
   from charges and payments?
5. Appointments: can editors delete, or only cancel?
6. Is email the only reminder channel needed, or is SMS/WhatsApp important?
