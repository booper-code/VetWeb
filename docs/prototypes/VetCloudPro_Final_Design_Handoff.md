# VetCloudPro — Unified Workspace UI Handoff

**Deliverable:** `VetCloudPro_Final_Quick_Advanced.html`

This is the final consolidated **UI-only prototype** combining the original VetCloudPro visual identity, a quieter, more professional dashboard aesthetic, and distinct Quick / Advanced workflows. It is not a production application, deployment, or approval to replace the existing Next.js components.

## Main experience

- **Quick:** Clearly labeled common tasks, larger patient and inventory records, simpler appointment views, and a guided three-stage **Record a Visit** form with an explicit review.
- **Advanced:** The same underlying fictional records but dense operational statistics, patient and inventory registers, additional filters and full visit-entry fields.
- **Navigation:** Main everyday pages remain visible; less-frequent tools stay discoverable under **More tools** in Quick or grouped sections in Advanced.
- **Record a Visit:** Available in the top bar. The staff member must explicitly enter the date and time the work occurred. Review is required. A successful preview can be followed by **Save & log another**.
- **Patient dossier:** Overview, clinical timeline, vaccines/prevention, appointments, billing and lab/files. Planned appointments are never presented as actual vaccine administration or medical treatment.
- **Dashboard:** Due and overdue appointments, inventory warnings, outstanding *sample* balances and shortcuts to appropriate patient pages.
- **Search, patient admission, scheduling and inventory:** Safe, in-memory mock interactions; both modes use the same data for the session.
- **Responsive:** Tested at 1440, 980 and 390 CSS-pixel widths, including a mobile navigation drawer and visit dialog.

## Important invariants

1. **Quick / Advanced is presentation only.** It is completely separate from the existing owner/editor/viewer authorization model.
2. This HTML has a restrictive CSP and uses no external network, backend, credentials, authentication, uploads, AI provider or persistent data storage.
3. Sample changes **reset on reload**; none are written to the real clinic database.
4. **Scheduled**, **occurred** (staff-entered), and **recorded** (mock entry time) are distinct concepts. The preview never assumes a completed visit timestamp. The recorded timestamp is not an authoritative server audit time.
5. Recording a visit note **does not** update appointment completion, inventory quantities, billables, balances, payments, vaccine administration, follow-up appointments or audit events.
6. Related stock/charge/payment/follow-up fields in visit-entry are *uncommitted draft descriptions only*, not transactions.
7. Owner-only controls and clinical writes remain governed by production authorization and Firestore rules, never by hiding UI elements alone.

## Guidance for integrating into the real app

- First reproduce the visual components and navigation patterns in the actual Next.js / React project while **preserving existing data loaders, routing, validation, security rules and functional behaviors**.
- Do not copy prototype array operations or mock form handlers into production. Replace them with reviewed domain actions, clinic scoping, authorization and conflict detection.
- Treat encounters, administration records, stock movements, charges, payments and receipts as separate, explicitly committed and auditable operations. Confirm schemas, indexes, roles, and transaction boundaries before shipping any of them.
- Persist a user's Quick/Advanced preference only after deciding where and how preferences are safely stored, particularly for shared-device and trusted-device sessions.
- The demo's artificial totals are not whole-clinic reports. Retain loaded-data coverage and freshness indicators, and add truthful failure/offline/retry states in production.
- Check mobile usability, accessible focus/labels, text contrast, read-only role behavior, unsaved form preservation, retries and duplicate-submission protection before release.
- Consult the existing `CLAUDE-PROJECT-BRIEF.md`, `AGENTS.md`, `firestore.rules`, tests and relevant local framework docs before merging.

## Tested prototype scenarios

- Quick and Advanced layouts at 390 / 980 / 1440 pixels with no page-level horizontal overflow.
- Role switch to Viewer disables mock write buttons and visit creation.
- Cross-module dashboard search, sidebar navigation and mobile drawer.
- Add fictional patient; add fictional appointment; reject appointment completion without actual time.
- Inventory changes visible across modes; Advanced shows additional buying-price columns.
- Guided visit: input required occurred time, move between steps, review, save in memory, open patient's clinical timeline.
- Advanced visit: review, confirm, save in memory.
- No uncaught browser JavaScript errors in tested flows.

**Release status:** Visual prototype for review and selective integration. Not a complete veterinary recordkeeping, payment, data-security, medical or backup solution.
