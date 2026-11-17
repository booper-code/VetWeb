# Claude UI design handoff

This is the finished design-handoff package. Attach exactly these two files:

1. `vetcloudpro-ui-demo.html` — standalone visual starting point to redesign.
2. `../CLAUDE-PROJECT-BRIEF.md` — context, complete feature/screen plan and
   implementation boundaries.

`README.md` is optional context for the human relaying the files. Open the HTML
directly in a browser. It needs no server, package installation, internet
connection, credentials or real clinic records.

Do **not** attach the repository, `.env` files, private fixture state, real
records, provider keys or administrative credentials. The two files above are
sufficient for Claude to plan the product and redesign the mockup.

## Handoff completeness

- [x] Feature/screen plan with current, unfinished and optional work separated.
- [x] Occasional/end-of-day workflow context and controlled-AI boundary.
- [x] Standalone representative HTML with fictional, disposable data.
- [x] Owner/editor/viewer preview controls and owner-only safeguards.
- [x] Readable black text on light surfaces; mobile navigation; no external assets.
- [x] Local-only interactions, explicit placeholder messages and no persistence.
- [x] `test:prototype` browser verification with no external requests.
- [x] Deployment and live data explicitly out of scope for this handoff.
- [x] Claude's revised design returned and reviewed by the user.
- [x] Approved redesign integrated into the real React application.

## What is interactive

- Navigation, mobile drawer and owner/editor/viewer previews.
- Patient/owner/item search on the sample screens.
- Appointment status/type filters, local mock appointment editing and reminder
  previews.
- Patient dossier overview/billing/lab tabs.
- Local mock inventory editing.
- AI visibility toggle and login-screen preview.

All edits are disposable in-memory mock data and reset on reload. Date-range
query controls, quick admission and most administrative buttons are visual
placeholders with explicit messages. Nothing authenticates, uploads, exports
records, sends messages, performs clinical analysis, processes money or changes
the real application. No persistent browser storage or backend/API code is used.

This is a **representative mockup of current app areas**, not a pixel-perfect
snapshot of every React form and not proof that the live app contains all planned
features. The embedded handoff notes distinguish planned AI/financial/clinical
work from the illustrated current areas.

## Suggested message to Claude

> Read the attached project brief and HTML. First propose the complete but
> bounded feature/screen plan and navigation for occasional/end-of-day clinic
> use. After we agree on the design, revise the standalone HTML's layout,
> typography, colors and responsive behavior. Keep all data fictional and
> interactions local-only; do not add Firebase, API calls, credentials, external
> CDNs, real AI or production business logic. Maintain readable contrast and
> accessible labels/focus. Preserve the prototype's warnings and make planned
> versus implemented functionality clear. Return one self-contained HTML file
> and a short list of design decisions.

Send the revised HTML back for review and integration into the actual React
components. Its mock JavaScript must not replace the real permission,
validation, revision, audit, transaction, offline or privacy implementations.
Use `data-view` / `data-action` markers as prototype hooks if convenient, not as
a required production architecture.

Do not send `.env` files, private fixture state, real patient/owner records,
provider keys or administrative credentials with the design reference.

## Integration status (VetCloudPro final UI)

The final design in `VetCloudPro_Final_Quick_Advanced.html` is now the visual
source of truth for the live app shell:

- `app/globals.css` carries the light design tokens and shared `.vc-*`
  primitives (cards, buttons, badges, mode strip, tables, inputs).
- `components/Sidebar.tsx` and `components/Header.tsx` implement the navy
  navigation, grouped Quick/Advanced menus, search, Record visit and the
  Quick/Advanced workspace switch.
- `components/DashboardHome.tsx` provides the Quick overview and Advanced
  overview using the app's real patients, appointments, inventory and
  consultations.
- `components/AppointmentsView.tsx`, `components/PatientRecordsView.tsx` and
  `components/InventoryControlView.tsx` adopt the new headers, cards, buttons
  and the shared mode strip.

Workspace mode only changes presentation. Permissions, Firestore rules,
validation, offline handling, paging and audit behavior are unchanged, and the
prototype's mock handlers are not used in production. The `Quick` / `Advanced`
choice is kept in React state for the current session rather than persisted.

Admin screens (Clinic setup, My account, Staff & Payroll, Team & invitations,
Clinical audit, Laboratory & AI) were kept on their existing forms and logic;
they already use white cards with slate/teal accents inside the new shell.
