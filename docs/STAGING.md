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

For Checkout and End-of-Day Close testing, use the separate `vetcloudpro-staging-6f819b` project, not the shared site above. It has a registered **VetCloudPro Staging Web** app, email/password Auth, and Firestore in Singapore. Set `NEXT_PUBLIC_FIREBASE_STAGING_CONFIG` to the app's JSON web SDK configuration before building with `npm run build:staging`. Get it by app ID with the Firebase CLI and explicitly select the staging project. Do not use a service account key as web configuration.

An explicit staging build rejects incomplete or mixed production settings at sign-in and disables the shared image Worker. The default build is unchanged. Use fictional data only, and use a separate hosting target if publishing the isolated preview.

After verifying that the export shows **Isolated Firebase project**, publish it to a temporary channel in the staging project:

```sh
npx firebase-tools@15.36.0 hosting:channel:deploy checkout --expires 30d --project vetcloudpro-staging-6f819b --config firebase.staging.json
```

This does not update the shared site above. The preview URL is shareable, not access-controlled; do not enter real clinic records.

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

## Verification recorded

- Owner/viewer login through real forms in isolated Chromium contexts.
- Owner AI toggle propagates to the viewer; the viewer control is disabled.
- Viewer R2 images render after reload and re-login.
- Demo login and AI toggle work with external HTTPS blocked and no Firebase/R2
  requests.
- Unverified invitee reads and atomic acceptance are denied by deployed rules.
- The verification UI preserves the invitation URL and refreshes token claims.
  With a controlled **synthetic-only administrator verification update**, the
  real staging acceptance flow succeeds. This does **not** test mailbox delivery.
- Headers checked: `nosniff`, `no-referrer`, frame denial and no-index.
- At 390px, the login layout, labelled navigation toggle and demo settings
  switch passed a mobile Chromium smoke check.

Live test scripts and account state were kept private outside the repository.
`.github/workflows/verify.yml` adds credential-free unit/emulator/build checks,
not live tests or deployments. It has not been run on GitHub; the current
workspace has no Git metadata, so these changes have not been pushed from here.

## Feature development versus production

This is a verified synthetic-data baseline for further development. Before real
clinic use, close the production gaps in `docs/SECURITY-STATUS.md`, including
complete recovery, storage controls, historical-key revocation confirmation and
real verification-email delivery. Do not claim full security or regulatory
readiness from a passing staging smoke test.
