# Patient dossier handoff — Clinical activity and billing

## Goal
- Clarify the relationship between **Visit type** and **Treatment & service lines**, automatically reflect billable lines in **Patient billing**, and allow authorized corrections with a visible **Modified** mark in the dossier.
- User requested documentation only for this session. Resume the feature work in a new chat; no implementation or deployment was requested.

## State
- `components/ClinicalActivity.tsx` currently records a visit type and independently selected catalog lines. The same line picker is visible for every type. A notes-only visit is allowed. The picker requires **Add line**. Selecting a visit type does not itself select or charge a service.
- `app/page.tsx` (`saveConsultationRecord`) and `lib/consultations.ts` (`saveConsultation`) save completed activity. Medicine and supply lines can deduct stock when the visit saves; service and grooming lines do not. Clinical activity currently creates no ledger charge.
- `components/PatientBilling.tsx`, `lib/billing.ts` (`commitBilling`), and `firestore.rules` implement the separate audited ledger. Billing can also move stock; existing rules distinguish stock movements for charges from treatment dispensing. Structured treatment records currently have no correction editor.
- The follow-up fixes are included in the repo: dossier display and validation, duplicate-submit protection, a read-only balance in the dossier editor, inline image preview, and demo-only lab extraction. See `components/ClinicalActivity.tsx`, `components/PatientRecordsView.tsx`, `lib/imageStore.ts`, `tests/patient-dossier.browser.test.mjs`, and `tests/offline-browser.test.mjs`. The appointment-to-inventory search fix and the AI Clerk's provider-independent local planning fix are included too.
- Previous local verification: `npm run build:staging`, 17 Chromium checks including `tests/patient-dossier.browser.test.mjs`, `npm run test:rules`, `npm run test:offline:browser` (9 passed), and targeted ESLint passed. No hosted verification or live image-worker test for those fixes. The three proposed features above have not been implemented or tested.

## Requirements and decisions to confirm
- **Visit type:** Make it clear what should be selected after choosing a type. Agree whether to collapse an optional add-lines section, suggest items by type, or filter the list. Preserve valid cross-type items (for example supplies used for grooming) unless the user says otherwise.
- **Billing:** User example: save a Grooming visit with catalog lines, then see the billable items in Patient billing automatically. Confirm what is billable, how no-charge or already-paid lines work, whether the save confirmation should show the charge amount, and what happens when an opening balance has not been verified.
- **Correction:** Support correcting a misclick on a saved activity. Show **Modified** when viewing it in the dossier. Confirm editable fields and authorized roles, and what should happen to stock and billing when an item or quantity changes, especially if an invoice has already been paid.
- **Integrity:** Reuse the existing audited ledger and revisions. Treat a visit, its charges, and any stock change as one consistent operation. Link charges to the source visit, snapshot prices, prevent duplicate charges or dispensing on retries, and preserve the original history via audited corrections. Do not silently backfill or rebill historical visits.

## Next action
- After pulling, run `git status --short` and review the three decisions above with the user before designing or changing code. Verify with fictional fixtures: Grooming plus a catalog item, a notes-only visit, retries, concurrent edits, a correction after payment, cross-session refresh, and read-only access. Run `npm run test:rules` before `npm run test:offline:browser`.

## Localhost on another computer
- `localhost` is the web server address, not the database. With `NEXT_PUBLIC_FIREBASE_STAGING_CONFIG` **unset** in the shell and all applicable `.env*` files, `lib/firebase.ts` defaults to the shared main project `vetcloudpro`.
- For isolated staging (`vetcloudpro-staging-6f819b`), follow [the Firebase setup in STAGING.md](STAGING.md#isolated-firebase-preview). Use the isolated web SDK JSON as `NEXT_PUBLIC_FIREBASE_STAGING_CONFIG` in the ignored `.env.development.local` or set it in the launch shell. Restart Next.js after changes and run `npm run dev -- --port 3000`. Use an account created in staging; main accounts do not carry over.
- Verify **before making changes**: reload, open browser DevTools → Network, filter for `firestore.googleapis.com`, and inspect a Firestore request's `database` parameter or resource path for `projects/vetcloudpro/` (main) or `projects/vetcloudpro-staging-6f819b/` (staging). Use fictional records in staging; use the emulator for destructive tests.
- AI Clerk's provider-backed clinic queries additionally require the signed-in isolated staging project at exactly `http://localhost:3000`. `git pull` does not copy `.env.development.local`, credentials, or browser-local AI provider settings.
