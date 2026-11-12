# VetCloudPro — project brief

Paste this whole file into Claude, then add your question at the bottom.

## 1. What it is

A veterinary clinic practice-management web app ("VetCloudPro"), built as an
academic/demo project for Biñan Animal Clinic. Single-page dashboard covering
patient admission & medical records, inventory/POS, laboratory + AI summaries,
and clinic settings. Demo credentials: `admin@binanvet.com` / `admin123`.

## 2. Stack (actually installed)

- Next.js 16.2.9 (App Router, Turbopack), React 19.2.4, TypeScript 5.9.3
- Tailwind CSS v4 (`@tailwindcss/postcss`), lucide-react 1.21.0
- Firebase 10.14.1 (client SDK: Auth + Firestore)
- Node 24 / npm 11. Scripts: `dev`, `build`, `start`, `lint`.
- No test framework, no CI, no API routes, no server actions, no middleware.

## 3. Repo layout

```
app/
  layout.tsx     root layout, Geist fonts, metadata still "Create Next App"
  page.tsx       ~4,100 lines — the ENTIRE app lives here
  globals.css    Tailwind import + theme vars
next.config.ts   empty default
eslint.config.mjs
package.json
```

There is exactly one route (`/`) and one client component file. No `components/`,
`lib/`, or `hooks/` directories yet.

## 4. Current status

- `npm install` done; `npm run build` passes (TypeScript included).
- `npm run lint` FAILS: 36 errors / 28 warnings, all pre-existing. Mostly
  `@typescript-eslint/no-explicit-any`, `react/no-unescaped-entities`, plus
  `no-img-element` and unused-variable warnings. Lint is not part of `build`.
- Verified in a browser: login, dashboard, and all five nav tabs render with
  zero console errors.

Recently fixed (so don't re-report these):

1. Login cleared the seeded demo data, then the Firestore sync threw
   `Missing or insufficient permissions`, leaving an empty dashboard.
   Fix: skip the cloud sync and skip the state reset when
   `currentClinicId === 'demo-clinic'`.
2. Real accounts can sign in or create an account. After authentication, users
   choose/create a clinic or accept an invitation. The demo login still skips
   Firebase and uses the offline `demo-clinic` workspace.
3. `firestore.rules` contains the tenant-scoped membership/invitation model,
   member management, staff/payroll, and clinic rename/transfer rules. The
   committed emulator suite (`npm run test:rules`) passes. The member
   management, rename, and staff/payroll additions still need one more publish
   to the live project.

## 5. Architecture

`app/page.tsx` is a thin entry route (~486 lines) that owns all state; every other
piece lives in its own module. Module-level mutable singletons hold the Firebase
handles.

| File                                  | Role                                                    |
|---------------------------------------|---------------------------------------------------------|
| `types.ts`                            | all shared data types                                   |
| `constants.ts`                        | legacy Biñan workspace id/name for migration reference  |
| `lib/firebase.ts`                     | Firebase config + lazy init; `dbRef`/`firestore` live bindings |
| `lib/clinics.ts`                       | clinic creation, memberships, invite lifecycle              |
| `lib/ai.ts`                           | any-provider AI client; key lives in `localStorage`      |
| `lib/images.ts`                       | upload compression, Firestore doc size guard            |
| `app/page.tsx`                        | `App`: all state, seed data, CRUD, tab routing          |
| `components/LoginScreen.tsx`          | email/password auth + demo bypass                       |
| `components/ClinicWorkspaceScreen.tsx`| choose/create clinic, accept invite                     |
| `components/ClinicTeamView.tsx`       | member list, role changes, removal, ownership transfer, invitations |
| `components/Sidebar.tsx`              | nav + profile/logout footer                             |
| `components/AccountSettingsView.tsx`  | account settings tab: clinic rename, email, password reset |
| `components/StaffPayrollView.tsx`     | roster, pay rates, payroll periods, append-only ledger   |
| `lib/payroll.ts`                      | staff/payroll CRUD, hash-chain append + verification     |
| `lib/pdf.ts`                          | inventory and patient PDF exports                        |
| `lib/backup.ts`                       | owner-only JSON clinic backup download                   |
| `components/Header.tsx`               | title bar                                               |
| `components/DashboardHome.tsx`        | KPI cards, status counts, recent billables              |
| `components/PatientRecordsView.tsx`   | admission form, patient table, detail drawer, labs      |
| `components/InventoryControlView.tsx` | catalog table, add/edit drawer, delete confirm          |
| `components/AILaboratoryView.tsx`     | lab text/image input + "AI" summary output              |
| `components/SystemSettingsView.tsx`   | AI provider/key setup + connection test, CSV import      |

State lives in `App` and is passed down as props (`patients`, `inventory`,
`consultations`, `searchQuery`, CRUD callbacks, `triggerToast`). No context, no
state library, no routing library.

## 6. Data model (simplified)

```ts
type PatientRecord = {
  id: string; name: string; species: string; breed: string;
  gender: 'Male' | 'Female' | 'Unknown';
  ownerName: string; ownerContact: string;
  ownerEmail?: string; ownerAddress?: string;
  weight: number; admissionTypes: string[]; reason: string;
  status: 'Waiting' | 'In Treatment' | 'Confined' | 'Ready for Pickup' | 'Discharged';
  balance: number;
  pictures?: string[]; profilePicture?: string;
  labResults?: LabResult[]; tags?: string[]; notes?: string;
  aiLabSummary?: string; billableItems?: PatientBillableItem[];
};

type InventoryItem = {
  itemCode: string; itemName: string;
  category: 'Medicine' | 'Supplies' | 'Service' | 'Grooming';
  stock: number; buyingPrice: number; sellingPrice: number; threshold: number;
};

type Consultation = {
  id: string; date: string; client: string; patient: string;
  type: string; status: 'Draft' | 'Completed'; notes: string;
};
```

Seed data is inline in `App`: 3 patients, 7 inventory items, 3 consultations.
Data is only persisted to Firestore; there is no `localStorage`, so anything
saved while offline disappears on refresh.

## 7. Backend integrations

**Firebase (client SDK, lazily imported inside functions)**

- Config is hardcoded in `getFirebaseConfig()`; project `vetcloudpro`.
- `initializeFirebase()` memoizes `app/auth/db` in module-level `let`s and calls
  `getApps()` first to survive React double-render.
- Firestore shape: `clinics/{clinicId}/patients|inventory|consultations`.
- Staff & payroll: `clinics/{clinicId}/staff/{staffId}` is the roster readable by
  all members (owners/editors write it). Pay rates live separately in
  `payProfiles/{staffId}` and are owner-only. Payroll periods live in
  `payrollPeriods/{periodId}`; the append-only ledger is `payrollLedger/{entryId}`
  with a SHA-256 hash chain whose head is `payrollMeta/ledger`. Ledger entries
  deny update/delete in rules; the UI recomputes the chain to flag edits.
- PDF exports (`lib/pdf.ts`) use lazily imported `jspdf` + `jspdf-autotable`;
  inventory and patient exports are generated fully client-side.
- Multi-clinic membership shape: `clinics/{clinicId}/members/{uid}` is the
  clinic-side membership; `users/{uid}/clinics/{clinicId}` is a user-side index.
  Clinic creation and invite acceptance write both sides atomically. Invites live
  under `clinics/{clinicId}/invitations/{inviteId}` and expire after seven days.
- Auth: email/password sign-in and sign-up; demo login bypasses Firebase and
  uses the fake clinic id `demo-clinic`. Real users select a clinic after auth.
- Owners can create editor/viewer invite links and share them manually; no email
  delivery service is wired up. The multi-clinic rules are published; the
  staff/payroll collections added later need one more publish.
- Account deletion is disabled in the sidebar. Ownership transfer now exists,
  but deletion still needs membership/index cleanup and a rules design.
- Writes use `setDoc` / `updateDoc` / `deleteDoc`; on failure they fall back to
  local state and show a toast.
- The demo workspace (`demo-clinic`) never touches Firestore: reads, writes,
  edits and deletes are all skipped so the presentation runs fully offline.
- **Photos are stored as base64 data URLs inside the patient document**, so they
  are re-encoded client-side by `lib/images.ts` before they are kept: profile
  pictures to 800 px / JPEG q0.72 (~40–160 KB), lab printouts to 1600 px / q0.8.
  `MAX_PATIENT_DOC_BYTES` (900 KB) is checked before every patient write, because
  Firestore caps documents at 1 MiB and a raw phone photo is far larger.

**AI (provider-agnostic)**

- `lib/ai.ts` talks to any provider. The user picks one in Clinic Setup and
  supplies their own key; it lives in `localStorage` under `vetcloudpro.ai` and is
  **never bundled and never written to Firestore**. There is no server, so this is
  the whole credential story.
- Two wire formats cover everything: `gemini` (Google) and `openai`
  (`/chat/completions`, used by OpenAI, OpenRouter, Groq, DeepSeek, Mistral,
  Ollama and any custom OpenAI-compatible endpoint). Presets set the default
  base URL and model; model and base URL stay editable.
- `generateText(config, prompt, image?)` and `generateJSON<T>(...)`; retries only
  on 429/5xx, up to 3 attempts. Bad keys are mapped to a readable message even
  though Gemini reports them as `400 API key not valid` rather than 401.
- **The only real model call is the "Test Connection" button in
  `SystemSettingsView`.** `AILaboratoryView.handleAnalyze` is still a mock: it
  waits 1.8s, injects hardcoded "clinical synthesis" text, and never calls the API.

## 8. Known issues / risks

1. **Secrets in git history**: the old `lib/gemini.ts` hardcoded a Gemini API key
   (file now deleted, key still in history at `df95198` — rotate it). The Firebase
   web config in `lib/firebase.ts` is public by design.
2. **Large components**: the file was split into `lib/`, `components/` and
   `types.ts`, but `PatientRecordsView.tsx` is still ~1,600 lines and owns the
   admission form, table, detail drawer and lab editor.
3. **Mocked AI**: lab analysis is hardcoded, not model output, despite the UI
   claiming an AI synthesis.
4. **Lint fails** (34 errors, 28 warnings) even though the build passes; the new
   clinic workflow files lint clean, but existing app/components still have errors.
5. **No CI.** The Firestore rules emulator suite is committed and runs via
   `npm run test:rules`, but nothing runs on push.
6. **No offline persistence**: demo edits vanish on refresh.
7. **No server layer**: Firestore rules are the only access control. The
   published rules predate member management, rename, and staff/payroll; the
   whole file must be republished. Email/password account creation is enabled
   in Firebase Auth for self-service signup.
8. `any` is used for Firebase handles (`let app: any`) and several callbacks.
10. Accessibility: many icon-only buttons have no `aria-label`; several `<img>`
    usages bypass `next/image`.

## 9. My question

<!-- Replace this with what you actually want advice on, e.g.:
     "How should I split page.tsx into maintainable files without breaking it?"
     "Is this Firebase + hardcoded-key setup safe to demo/deploy?"
     "How do I make the AI lab analysis real instead of mocked?" -->
