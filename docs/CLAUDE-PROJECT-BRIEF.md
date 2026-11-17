# VetCloudPro — product plan and Claude handoff

Prepared 2026-11-15. This is a planning brief, not authorization to implement
every proposed feature or redesign the entire application at once.

## 1. What the user wants

VetCloudPro is a practical veterinary clinic management web app. It should help
staff find patients, record what happened, manage appointments and stock, collect
payments, and review the clinic's work without requiring constant monitoring.

**Important user context: staff will often open the app only occasionally during
the day and enter several completed activities at day's end.** Do not design
only for a receptionist continuously watching a live queue.

The user expects a substantial UI revamp later. First agree on the features,
screen contents, information hierarchy and workflows. Preserve the existing
working behavior and security safeguards while redesigning.

The immediate readability request was narrow: black text on the light
appointment/reminder surfaces. Those components now set their foreground
explicitly rather than inheriting the body's light text under system dark mode.
White text on dark primary buttons remains intentional. This is not a completed
app-wide theme/accessibility redesign.

For visual design work, open `docs/prototypes/vetcloudpro-ui-demo.html`.
It is a self-contained representative mockup, not an export of production code:
fictional records, local-only navigation/form previews, no Firebase/API/AI or
persistent storage. Send it with this brief; return revised HTML for later
integration rather than replacing real application logic with the mock scripts.
See `docs/prototypes/README.md`.

### Confirmed direction versus proposals

- **Confirmed:** occasional/end-of-day use; controlled AI actions rather than
  unrestricted data access; manual workflows first, AI later; local development
  only for now; improve readability before a larger UI redesign.
- **Existing constraints:** Firebase Spark and Cloudflare free tiers; keep the
  offline demo; preserve multi-clinic permissions and existing ownership.
- **Proposed below:** final navigation, detailed completion scope, sequencing,
  encounter/treatment models, payment policies and optional extensions.
  Ask for approval before turning those proposals into broad implementation.

## 2. The experience to design around

### A. Returning to the app

1. Sign in and select the correct clinic.
2. Immediately see the clinic, role, timezone, connection/cache state and
   whether the information is current or only partially loaded.
3. See a short actionable list: appointments due/overdue, relevant follow-ups,
   unpaid balances and low stock—not just a wall of KPI cards.
4. Find a patient or start entering today's/past work with minimal navigation.

### B. Ordinary manual visit

Find/create the patient → open a visit/encounter → record clinician-entered
observations and treatments → explicitly record dispensed items/charges →
record payment → optionally schedule a follow-up → review what saved.

Each arrow is a distinct action unless a tested business transaction explicitly
combines it. Never infer treatment, inventory or money changes just because
someone marks an appointment complete.

### C. End-of-day entry

Select actual work date/time and timezone → find each patient → enter completed
activities → review patient identity, quantities, amounts and dates → save →
show successful, failed and not-attempted items separately.

The app must distinguish:

- **Scheduled time:** when a visit was planned.
- **Occurred time:** when staff say the work actually happened.
- **Recorded/audit time:** when the server accepted the entry.

Backdated entry is normal. Inventing dates, silently rewriting history, or
presenting a backdated event as if it was entered earlier is not acceptable.

### D. Future AI-assisted entry

Staff may write, for example:

> “Dobby had a vaccination this morning, one vial was used, the owner paid
> PHP 800, and a follow-up should be scheduled.”

The assistant should propose separate allowlisted actions, ask about ambiguous
patient/item/date details, show an explicit preview, and execute only confirmed
actions through normal permission-checked handlers. It must not guess the
vaccine, dose, inventory item, payment method or follow-up interval.

See `docs/AI-ACTION-PLAN.md`. This assistant is **not implemented**.

## 3. Current state: do not start from an assumed blank slate

**“Implemented locally” does not mean deployed, complete, or production-ready.**
The foundation and appointments batches have not been deployed by user choice.
The existing staging site is an older static-export baseline and shares the
existing Firebase backend; it is not an isolated test database.

| Area | What exists locally | Important remaining gap |
| --- | --- | --- |
| Authentication/clinics | Sign-in/sign-up, clinic creation/picker/switching, invitations, owner/editor/viewer memberships | Real verification-email delivery still untested; finish role/account UX and relevant live checks |
| Team management | Owner invitations, role changes, member removal and complete ownership-transfer protocol | Preserve existing owner; no real ownership-transfer smoke test |
| Patient/admission records | Profiles, owner/contact fields, active/discharged status, notes, photos, dossier and PDF output | A proper encounter/treatment timeline and structured administration records are not complete |
| Consultations | Draft/completed records and a queue | Legacy dates are locale strings; paging is stable ID order, not reliable chronological history |
| Appointments | Patient-linked scheduling, six visit types, edit/cancel/no-show/complete, actual visit time, due cards, date paging, manual reminders and ICS files | Not deployed; no background messages, availability checks or medical vaccine scheduling |
| Inventory | Catalog, stock/prices/thresholds, loaded-record search, bounded paging, CSV import and PDF output | Complete movement/reconciliation workflow, robust dispensing/void history and any optional batch/expiry tracking |
| Billing | Patient billables/balance and atomic patient/stock changes | Not a complete payment ledger: current charge removal and balance-clear controls must not be treated as auditable voids/payments |
| Laboratory | Saved lab records/images and existing lab/provider UI | Clinical AI/extraction results are predefined demo output; no real clinical analysis |
| Staff/payroll | Staff roster, owner-only pay profiles, periods and append-only hash-chained ledger | Not a complete attendance/tax/payroll compliance system; expand only if requested |
| Clinical audit | Rules-enforced metadata head/event protocol for patients, inventory, consultations and appointments | No clinical-content snapshots; cannot reconstruct every prior record; admins bypass rules |
| Images | Private R2/Worker access, signed URLs, upload controls, legacy image fallback and referenced-image backup/restore tools | Full-bucket recovery, orphan policy and remaining operational checks are unresolved; deletion stays disabled |
| Offline/PWA | Public shell, explicit trusted-device caching, default memory-only sessions, read-only cached records and cross-tab clear | No offline clinical write queue or draft synchronization |
| Backup/exports | Owner clinic JSON export; patient/inventory PDFs; appointments included in JSON | JSON is not image bytes or a one-click clinic restore; full recovery remains incomplete |
| Settings/AI controls | Clinic-wide owner AI switch, browser-local provider settings/connection tests, imports, device privacy controls and upload pause | A provider connection test is not implemented clinical AI; audit provider-key handling before relying on it |
| Reports | Loaded-record dashboard summaries | No complete financial/reporting suite or guaranteed whole-clinic totals |
| CI/testing | Local unit/React/emulator/browser/build checks and a GitHub workflow | Workspace has no `.git`; nothing pushed from here and GitHub CI has not run |

### Existing information architecture

Current tabs are Dashboard; Appointments & Reminders; Admission & Medical;
Inventory Control; conditional Laboratory & AI; Clinic Setup; Account Settings;
Staff & Payroll; owner-only Team & Invitations; owner-only Clinical Audit.

Do not assume a menu label proves its entire intended business workflow exists.

## 4. Roles and permissions

Current application roles are **owner, editor and viewer**, not separate
receptionist/veterinarian/cashier roles.

- All members can read the clinic's permitted patient/schedule/inventory data.
- Owners/editors can perform permitted clinical, scheduling and inventory writes
  online. A future daily-entry or AI workflow must obey the same restrictions.
- Viewers must not gain writes through alternate screens, imports, hotkeys or AI.
- Owners manage memberships/invitations/ownership, clinic-wide AI settings and
  upload pause. Pay profiles/payroll and audit-event enumeration are owner-only.
- Roster editing and payroll administration are not the same permission.
- Financial void/refund permissions and any new staff-specific role model are
  policy decisions, not permission changes to slip into a UI redesign.
- Hiding a button is not authorization. Firestore rules enforce access; secret
  owner-only fields require separate collections because rules cannot hide
  individual fields in a readable document.

## 5. Proposed screen plan: what the user should see

This is a proposed destination, not a requirement to add all these tabs now.
Prefer a small stable navigation with useful patient subviews over many
overlapping screens.

### 5.1 Login and clinic selection

Show sign-in/account mode, understandable errors, invitation verification/retry,
clinic name and role, and shared-device privacy controls.
Keep the manual offline demo separate from real authentication. Do not restore
visible/pre-filled demo credentials or imply verification email delivery works
until tested.

### 5.2 Dashboard / “Today”

Show a clear date/timezone, last refresh and coverage; appointments/follow-ups,
balances needing attention and low-stock actions; shortcuts to find a patient,
add a visit, record a payment and enter the day's work.

Only show shortcuts whose real workflows exist. Distinguish charges, collected
payments and receivables. Mark loaded-page/cached figures clearly. No invented
revenue metrics or constant polling merely to make the page feel “live.”

### 5.3 Patients and owners

Directory: name/ID, species/breed, owner, relevant status, last activity, next due
appointment and balance when reliably available. Search/filter/paging and an
obvious add-patient action.

Patient workspace proposal:

- **Overview:** identity, owner contact, relevant alerts and quick actions.
- **Clinical timeline:** dated encounters, clinician-entered findings,
  treatments, amendments and who recorded them.
- **Vaccines/deworming:** actual administrations versus planned due dates.
- **Appointments:** upcoming and past schedule.
- **Billing:** itemized charges, payment history, balance and receipts.
- **Labs/documents:** saved tests, results, images and attachments.

Patient identity is persistent; a new visit should not require duplicating the
patient. The current model embeds owner fields in each patient: a normalized
multi-pet owner directory is an optional schema decision requiring migration
planning, not just another frontend list.

### 5.4 Visits, treatment and daily entry — remaining core work

Show actual visit date/time and separate server entry time, patient and clinician,
reason/observations, structured treatment entries and explicit links to any
dispensing, charge, lab result and follow-up.

For vaccinations/deworming, identify the actual product and staff-entered
administration details; batch/expiry and dose fields need agreed clinical policy.
Do not let an AI generate medical recommendations.

Daily entry should offer a fast **manual** workflow first. If drafts are added,
define where they live, whether they contain sensitive data, when they expire
and what happens on logout, clinic switch, wipe or conflict. Shared-device
privacy and the no-offline-write-queue policy must not be silently reversed.

### 5.5 Appointments and reminders

Show daily/weekly agenda, date-range and status/type filters, patient/owner,
scheduled time/timezone, duration and status; clear create/edit/reschedule,
cancel/no-show/complete actions and links to patient details.

Keep scheduled time separate from actual attendance and entry timestamps.
Show manual reminder previews, recipient and delivery limitations. Optional
calendar presentation can replace the current card list only without losing
the bounded-query, accessible list and mobile workflows.

Current constraints: selector/search covers loaded records; snapshots are not
live; timezone is the device's named timezone. Clinic-configurable timezone and
better bounded patient lookup are proposed improvements.

### 5.6 Inventory and dispensing

Show item/code/category, available stock, unit/price and reorder threshold;
low-stock filters; safe add/edit/import; a dated movement history with actor and
reason; explicit dispensing, restock, adjustment and reversal workflows.

Snapshot prices on charge lines so catalog price changes do not rewrite past
bills. Do not silently convert units or allow negative stock. Batch/lot expiry,
suppliers, purchase orders and multi-location stock are optional extensions,
not assumed v1 scope.

### 5.7 Billing and payments — remaining core work

Show charges, payments, outstanding balance and receipt history separately.
Provide itemized review, explicit payment amount/method/reference/date, who
received it, and visible correction/void history. Define partial payments,
overpayments, discounts, refunds and rounding before implementing them.

Replace “clear balance” as a collection shortcut and hard removal of billables
with an approved financial ledger/compensation workflow. A cleared balance is
not proof money was collected.

Keep stock/charge actions atomic and idempotent. Current transactions are
bounded to a patient plus at most two stock items; a larger cart/extra ledger
documents require a tested redesign, not partial commits disguised as one sale.
Use `PHP` in existing PDF output unless font support is deliberately changed.
Do not claim tax, receipt or accounting compliance without the relevant review.

### 5.8 Laboratory and documents

Show real saved results, collection/result dates, attachment previews and
clinician-entered interpretations. Manual lab management should not depend on
an AI switch once separated into a proper clinical screen.

Any example output must remain visibly demo-only. OCR/extraction could later
populate a reviewable draft with its source, never silently replace real results.
Real clinical analysis is a separate product/safety decision, not required for
the administrative assistant.

### 5.9 Staff and payroll

Preserve roster, active/deactivated status, owner-only pay details, periods and
ledger history. Make irreversible payouts/period closing explicit. Keep
financial data hidden from unauthorized users at the data layer.

Payslips, attendance, deductions, government reporting and a larger payroll
engine need separate user requirements. Do not expand this into HR software
while trying to finish clinic workflows.

### 5.10 Reports — remaining core work

Proposed initial reports: payments collected by period, charges, outstanding
balances, appointment/visit counts and stock movements/low stock.
Show date range, coverage, timezone and data freshness, with useful export.

Whole-clinic figures require appropriately scoped queries/aggregations, indexes
and read-cost planning. Never relabel currently loaded pages as complete totals.
Avoid a full collection download on every login or dashboard refresh.

### 5.11 Settings, team, audit and recovery

Group logically, without hiding safeguards:

- Clinic identity and proposed clinic timezone.
- Account/password and approved future deletion flow.
- Owner team/invitations and ownership management.
- Owner AI policy/provider configuration; visibly off/disabled states.
- Device trust, offline limitations, last-refresh state and device clear status.
- Owner image upload pause, storage limitations and backup/restore information.
- Owner audit: actor, time, entity/action and revision, with coverage limits.

Do not claim “backed up” merely because a JSON file was exported. Recovery needs
image bytes, integrity verification, a restore procedure and a successful
rehearsal. Audit metadata is not a complete medical or financial history.

### 5.12 End-of-day assistant — after core workflows

Show instruction input, explicit patient resolution, questions, a per-action
preview and confirmation, then an execution report with links to saved records.
Allow selected actions to be deselected. Make uncertain/unsupported instructions
visible instead of silently ignoring or guessing them.

Use minimum necessary data and approved providers only. Exclude deletion,
ownership, membership, payroll, refunds and autonomous clinical decisions from
the initial action set. No arbitrary database access, scripts or Admin SDK
credentials. Retrying must not duplicate stock use, charges or payments.

## 6. Shared UI requirements for the redesign

- Start with high-contrast readable text. On light surfaces use black/near-black
  body text and explicit label/input colors; do not inherit a dark-mode
  foreground onto white cards. Treat a real dark theme as a separate coherent
  palette. Aim for WCAG AA contrast and test both system color schemes.
- Use clear type sizes and spacing; avoid tiny faint text for important facts.
- Use plain language, predictable controls, keyboard focus and associated labels.
  Do not communicate status/errors only through color.
- Support a 390px mobile viewport and comfortable touch targets. Keep primary
  actions reachable and avoid page-wide horizontal scrolling.
- Design loading, empty, filtered-empty, offline, partial/cached, failed-save,
  stale-revision, permission-denied and successful-save states for every module.
- Keep drafts after failed saves; make unsaved-discard and destructive actions
  explicit. Do not navigate unexpectedly after a delayed lookup.
- Always make the current clinic and read-only/demo state clear. Old requests
  must never populate another clinic or user session.
- Simplify the information hierarchy first. A prettier dashboard must not
  replace working forms with non-functional mock controls.

## 7. Data/architecture guardrails

- Stack: Next.js **16.4.6**, React **19.2.4**, TypeScript, Tailwind CSS,
  Firebase **12.19.0**, Cloudflare Workers/R2 and client-side PDF generation.
- Read `AGENTS.md` and relevant local `node_modules/next/dist/docs/` guides before
  changing routing, server/client boundaries or build behavior.
- UI currently lives in `app/page.tsx` plus `components/`; domain helpers are in
  `lib/`, shared types in `types.ts`, authorization in `firestore.rules`.
- Preserve lazy Firebase initialization and the explicit memory/trusted-device
  lifecycle. A presentational task must not weaken these boundaries.
- Clinical audited collections: `patients`, `inventory`, `consultations`,
  `appointments`, plus permanent `auditHeads` and immutable `auditEvents`.
  Read the rules/helper protocol before adding collections or write paths.
- Keep domain actions independent of presentation so manual forms and a future
  assistant can share validation, permissions, revision checks and transactions.
- New entities such as encounters, treatment entries, payments and stock
  movements are design proposals. Define schemas, ownership, IDs, indexes,
  audit coverage, backfill and emulator tests before implementing.
- Keep stable identities and explicit revisions. Avoid allocating IDs by counting
  loaded rows; avoid duplicate creation on retry.
- Existing legacy consultation dates, base64 images, owner snapshots and billable
  arrays need compatibility/migration planning. Never rewrite/delete real data
  as an incidental UI refactor.
- No paid backend, Blaze upgrade, Cloud Functions, paid messaging or new provider
  subscription without separate approval and current pricing/usage review.

## 8. Recommended delivery plan and completion gates

1. **Product/UI agreement:** verify this brief against source, resolve blocking
   policy questions, propose navigation and low-fidelity screens, get approval.
2. **Shared UI foundation:** accessible typography, explicit color tokens,
   consistent form/table/card/status patterns; preserve existing behavior and
   test the appointment readability fix across themes.
3. **Patient/clinical workflow:** persistent patient identity, encounter/treatment
   timeline, explicit actual-event times, manual lab records and safe amendments.
4. **Financial/stock completion:** charges/payments/receipts, explicit void policy,
   stock movements and reconciliation with concurrency/idempotency tests.
5. **Operational completion:** appointment/search/timezone polish, usable period
   reports, backup/account/team UX and any agreed basic payroll polish.
6. **AI capstone:** proposal-only prototype first; approved provider/data policy;
   then confirmed allowlisted actions sharing the proven manual handlers.
7. **Release gate:** coordinated synthetic staging checks, operational recovery,
   production blockers and explicit deployment authorization. This is a separate
   gate, not something to leave until after real clinics start using the app.

Production hardening can proceed alongside phases 2–6. Manual v1 can be useful
with AI disabled; AI should not hold the core application hostage.

### “Functionally complete v1” proposal

Staff can find a patient, record a visit and actual work time, save real treatment
or lab data, account for stock/charges/payments, schedule follow-up, issue the
agreed receipt/export and review history. Owners can manage access and recover
the agreed data. Viewers cannot write, failures do not lose drafts, retries do
not duplicate effects, and reports are honest about coverage.

### Separate production blockers

Read `docs/SECURITY-STATUS.md` for authoritative detail:

- Full-bucket/image recoverability, integrity and rehearsed restoration.
- Strict global quota/storage protection versus approximate rate limits.
- Reference-aware orphan retention/cleanup; keep R2 deletion disabled meanwhile.
- Confirmation that historically exposed provider keys were revoked.
- Real verification-email delivery and remaining live authorization checks.
- Approved external image-host/privacy policy and remaining image migration/
  expiry checks.
- Appropriate privacy/security/operational review before real clinic data.

There is no current claim of production readiness, clinical correctness or
regulatory compliance.

## 9. Decisions to ask the user—not silently choose

Ask only when needed for the next phase, rather than blocking with a giant form:

1. Clinic timezone (the app currently shows device timezone).
2. Which staff should see/change financial data; who can void/refund/adjust.
3. Payment methods, partial/overpayment handling, discounts and receipt fields.
4. Required treatment/vaccine/deworming fields and clinician responsibilities.
5. Whether owner/client normalization, staff scheduling, lot/expiry tracking and
   attendance are actually needed for v1.
6. Preferred dashboard priorities and navigation after seeing wireframes.
7. AI provider, consent, retention, budget and first allowed actions—later.

No owner/client portal, automatic SMS, online payments, multi-branch stock,
advanced accounting, real AI diagnosis or autonomous clinical advice is an
approved default requirement.

## 10. Where Claude should start

**If Claude receives only the two attachment files** (this brief plus
`prototypes/vetcloudpro-ui-demo.html`), start from those. The HTML is a
representative mockup, not source of truth for every production form. Ask for the
repository or specific files only when a claim must be verified before an
implementation decision.

**If Claude also has repository access**, read in this order:

1. `AGENTS.md`
2. `docs/CLAUDE-PROJECT-BRIEF.md` (this file)
3. `docs/CURRENT-HANDOFF.md`
4. `docs/APPOINTMENTS.md`, `docs/FEATURE-BATCH.md`
5. `docs/AI-ACTION-PLAN.md`, `docs/SECURITY-STATUS.md`, `docs/TESTING.md`
6. Actual source/types/rules for the feature being worked on.

`docs/NEXT-FEATURES.md` and the older handoffs contain useful history but outdated
baseline/spec claims. Do not revive offline write queues or old audit designs
just because they appear there.

Local: `http://localhost:3000` with `npm run dev`. The ordinary build remains
`npm run build`; `npm run build:staging` creates the optional static export.
See `docs/TESTING.md` for all suites, Java/Chromium setup and coverage limits.
Current recorded baselines include 21 appointment unit/React tests, 72 existing
workflow tests, 23 appointment emulator tests, 23 audit tests, demo browser/mobile
coverage and 4 browser cleanup tests (some counts include suite parents).
Re-run affected checks; recorded counts are not a substitute for verification.

**Do not deploy, seed the shared live backend, change real ownership, use real
patient data in tests, expose secrets or delete/migrate real records.**
Keep the existing application owner; the Firebase administrative login is not
automatically a clinic owner. Never copy private fixture files or `.env` contents
into chat, docs or Git. This workspace has no Git metadata; do not assume remote
`main`, local source and staging are identical. CI exists locally but is not
proven by a GitHub run.

### Suggested opening prompt for Claude

> Read the attached VetCloudPro project brief and open the attached standalone
> HTML mockup. First propose a complete but bounded v1 feature plan, navigation
> and what each screen should show, optimized for occasional and end-of-day
> clinic use. Clearly distinguish existing behavior, unfinished core workflows
> and optional later features. Provide wireframe-level screen outlines and a
> phased implementation plan before a major UI rewrite. If you have repository
> access, verify claims against current source; otherwise treat the HTML as a
> representative starting point, not guaranteed production behavior. Preserve
> permissions, auditing, demo isolation, privacy and the local-only deployment
> boundary. Ask about blocking policy decisions; do not invent requirements or
> implement every proposal automatically. AI execution comes after reliable
> manual workflows, using confirmed allowlisted actions only. When asked to
> redesign, return one self-contained HTML file plus a short list of design
> decisions; keep mock data fictional and add no backend, APIs, credentials,
> external CDNs or production business logic.
