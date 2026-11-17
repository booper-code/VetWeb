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
