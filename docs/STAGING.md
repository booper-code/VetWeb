# Test staging

URL: <https://vetcloudpro-staging.jmferrari16.workers.dev>

This is a static Next.js export served through Cloudflare Workers Static Assets,
not a Next.js SSR server or a Pages Functions backend. Static asset serving does
not require a Workers Paid plan. No subscription upgrade was performed.

**The site uses the existing `vetcloudpro` Firebase project and private image
Worker. It is not a separate database environment. Use fictional test accounts
and records only.** The public login page has a test-staging warning and
no-index headers. These are not access controls or a compliance guarantee.

The existing application owner is retained. Test credentials are held privately
outside this repository; never copy them into this document or a CI secret
unless an explicit, reviewed automation setup requires it.

## Isolated Firebase preview

For hosted tests, use the separate `vetcloudpro-staging-6f819b` project. It has a registered **VetCloudPro Staging Web** app, email/password Auth, and Firestore in Singapore. Set `NEXT_PUBLIC_FIREBASE_STAGING_CONFIG` to the app's JSON web SDK configuration before building with `npm run build:staging`. Get it by app ID with the Firebase CLI and explicitly select the staging project. Do not use a service account key as web configuration.

An explicit staging build rejects incomplete or mixed production settings at sign-in and disables the shared image Worker. The default build is unchanged. Use fictional data only, and use a separate hosting target if publishing the isolated preview.

For a persistent local setup, put the validated SDK configuration in the
ignored `.env.development.local` as `NEXT_PUBLIC_FIREBASE_STAGING_CONFIG`
and use `npm run dev -- --port 3000`. This does not select the test project
for production builds. Keep `NEXT_PUBLIC_CSV_IMPORT_RECEIPTS=0` unless the
isolated rules support that optional collection; normal inventory audit
records are independent of those receipts.

To use the isolated **cloud database from localhost** without publishing a
website, run this in a new PowerShell session from the repository:

```powershell
$project = 'vetcloudpro-staging-6f819b'
$appId = '1:989304337142:web:c6fd25c912cbbb1ee532d7'
$output = npx --yes firebase-tools@15.36.0 apps:sdkconfig WEB $appId --project $project --json --non-interactive
if ($LASTEXITCODE -ne 0) { throw 'Could not load isolated Firebase config.' }
$config = ($output | Out-String | ConvertFrom-Json).result.sdkConfig
if ($config.projectId -ne $project -or $config.authDomain -ne "$project.firebaseapp.com" -or $config.appId -ne $appId) {
  throw 'Refusing to start: unexpected Firebase target.'
}
$env:NEXT_PUBLIC_FIREBASE_STAGING_CONFIG = $config | ConvertTo-Json -Compress
npm run dev
```

Use the URL printed by Next.js, then sign in with an account created **in the
isolated project**. An account from the shared project does not carry over.
Use a fictional clinic and records only. The override lives in that terminal
session, not in `.env.local`; close the terminal when done.

After verifying that the export shows **Isolated Firebase project**, publish it to a temporary channel in the staging project:

```sh
npx firebase-tools@15.36.0 hosting:channel:deploy checkout --expires 30d --project vetcloudpro-staging-6f819b --config firebase.staging.json
```

This does not update the shared site above. The preview URL is shareable, not access-controlled; do not enter real clinic records.

### Inventory CSV release check

On localhost, an ordinary clinic sign-in still uses the configured cloud
project; only the built-in demo skips Firestore. The shared rules inspected on
2026-11-20 predate the inventory audit transaction. If the current app reports
`Missing or insufficient permissions` before saving any rows, do not change
the CSV or relax the rules to work around a version mismatch.

1. Run `npm run test:rules` and `npm run test:offline:browser` sequentially.
   The latter signs in as fictional users, uploads `docs/sample-inventory.csv`,
   and validates both inventory and audit records in the emulator.
2. For a hosted rehearsal, use the isolated Firebase project above. Before
   uploading, verify the preview shows **Isolated Firebase project**, the
   isolated project has the rules from the same revision as the app, and
   the selected clinic is fictional and empty. Do not test the release on a
   real clinic.
3. As Owner, use **Clinic setup → Import Inventory CSV** and expect 24 rows
   and a create audit for each. Sign out and back in, confirm Inventory has
   loaded, then import again: expect no new items or audit records. Keep
   permission-denial checks in the emulator. Members also have inventory access.
4. Treat a shared rollout as a separate approval. Use the coordinated
   app/rules rollout below and have staff reload. Publishing new rules
   alone can block older app clients from saving.

Hosted rehearsal on 2026-11-27 (`preview-4515345`): a fictional Owner imported
all 24 rows. A separate server read confirmed 24 inventory records and 24
matching create audit events. Re-importing after logout and sign-in left
inventory and audit records unchanged. The fictional clinic and account were
removed. This check covers a CSV with explicit item codes.

## Build and deploy

**Foundation-batch rollout warning:** local audit rules reject older unaudited
clinical clients. The generic UI command below is not a complete batch rollout.
Use the coordinated rules/Worker/UI procedure and reload notice in
`docs/HANDOFF-FOUNDATION-BATCH.md`; confirm a rollout window before changing the
shared backend. Current local checks are documented in `docs/TESTING.md`.

Use Node 24.22.2 for the repository's Node-native TypeScript tests and Java 21 for
Firestore emulator tests.

```sh
npm ci
npm run test:rules
npm run test:images
npm run test:backup
npm run lint -- --max-warnings=1
npm run build:staging
npx wrangler deploy --config wrangler.staging.jsonc
```

Configure `NEXT_PUBLIC_IMAGE_WORKER_URL` before building, via the ignored
`.env.local` or the build environment:

```text
NEXT_PUBLIC_IMAGE_WORKER_URL=https://vetcloudpro-images.jmferrari16.workers.dev
```

The public variable is embedded into the generated app. Rebuild after changes.
`npm run build` remains a normal Next.js build; only `build:staging` selects
`output: export` and generates `out/_headers`. New features requiring server
runtime APIs will need a different deployment plan.

The image Worker allows this exact staging origin. Firebase's authorized domains
also include its hostname for verification-email continue URLs. Existing domains
were preserved; do not use wildcards or replace the domain list on future edits.

## Release verification — 2026-11-27

The [GitHub verification run](https://github.com/booper-code/VetWeb/actions/runs/45821157736)
passed for `4515345`. GitHub runs credential-free tests and builds; hosted
checks use disposable records in the isolated Firebase project.

The [admission and follow-up preview](https://vetcloudpro-staging-6f819b--preview-admission-followup-cv77dept.web.app)
expires December 27, 2026. It contains the local validation and Manila
rollover patches on top of `4515345`. The deployed admission chunk matched
the isolated build byte for byte. Hosted checks confirmed the admission
errors clear when the inputs are corrected and an open queue picks up the
newly due visit on focus after a simulated Manila date change.

On `preview-4515345`, independent Chromium sessions verified Owner and Member
onboarding, live patient directory and dossier updates, and a Member
consultation arriving in the Owner's dossier and appearing in clinic history
and Clinical audit. A fictional charge and cash payment updated a second
session's balance without refresh and produced a PDF receipt. Staff, pay rate,
and payroll period changes appeared under the correct actor in Clinical audit.
Inventory creation, a new scheduled appointment, and follow-up contact
also reached the Owner's already-open views after Member saves. Recording
contact kept the visit scheduled.

On both preview channels, a Member recorded a fictional PHP 400 advance
against PHP 2,500 base pay and posted the calculated PHP 2,100 payout. The
Owner saw both ledger entries; the stored actor, amounts and chain matched.
On those deployed builds, the period still offered **Record payout** after
the full amount was recorded. Only one payout was posted in each test.

An initially unverified invitee received the Firebase email in a private
disposable [Mail.tm](https://mail.tm/) inbox, completed verification, returned
to the exact invitation, and joined as a Member on both preview channels.
The fictional Firebase clinics and accounts were removed after each run.

The original preview login rendered without horizontal overflow at 375 px and sent
the `noindex`, `nosniff`, frame denial, referrer and permissions headers.

See [Testing](TESTING.md) for the emulator backfill and audit-checkpoint
rehearsals. Separate browser sessions do not establish physical-device
or real-outage behavior. Shared staging and production were not part of
this release check.

## Feature development versus production

This is a verified synthetic-data baseline for further development. Before real
clinic use, close the production gaps in `docs/SECURITY-STATUS.md`, including
complete recovery, storage controls, historical-key revocation confirmation and
real verification-email delivery. Do not claim full security or regulatory
readiness from a passing staging smoke test.
