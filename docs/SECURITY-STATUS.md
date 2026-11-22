# Security status — 2026-11-15

See [Private use](PRIVATE-USE.md) for account recovery and access removal,
and [Clinic recovery](CLINIC-RECOVERY.md) for the planned isolated restore drill.

**Rollback warning:** older rules backups predate invitation email verification
and may reopen that admission flaw. They are recovery evidence, not a safe
automatic rollback target. Preserve the verified-email admission checks when
repairing a regression; do not restore permissive prior rules just to unblock UI.

The application is not yet production-ready for real clinic records. The staging
site is a test deployment with fictional records, not production evidence.

## Resolved critical issue: invitation admission

The previously open critical invitation-flow flaw (an unverified email address
could be admitted) is **fixed and deployed**. The active Firestore ruleset
`e49d3f3c-f232-477b-b7ff-471b89436b94` matched `firestore.rules` at that deployment.
The current local foundation batch adds audit enforcement and is not yet
deployed; do not confuse those local rules with the active invitation-fix baseline.
The fix is scoped to the verified email: the invitee can read, claim and accept
only the invitation matching their own verified email, and existing owners are
unchanged. The prior rules were backed up privately as
`firestore-rules-before-invite-verification-1794715019742.json`; the previous
active ruleset was `53e88f14-dfb0-45ad-a809-212485215afe`.

Live negative checks denied an unverified read and a direct claim. A controlled
test set `verified=true` through the admin path on a synthetic outsider only;
the "I’ve verified" refresh then worked and actual UI acceptance succeeded. The
temporary synthetic membership was removed. The staging verification prompt
preserves the invitation link.

**Residual gap:** real verification-email delivery has not been tested. Do not
describe the invitation flow as fully verified or production-ready on that
basis.

## Staging deployment

Staging is live at <https://vetcloudpro-staging.jmferrari16.workers.dev>, served
by Cloudflare Workers Static Assets (not Pages), version
`d8098314-5f66-41ed-9c3a-04d4997275aa`. It is a static-export build with no SSR
and no paid backend, and it displays a visible TEST STAGING banner with a
fictional-records notice. The staging origin was added to the Firebase
authorized domains while preserving all previous entries. Verified response
headers include `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `noindex`. A
live `GET` returned `200` with the TEST STAGING warning, and a CORS `OPTIONS`
preflight returned `204` reflecting the exact staging origin (not a wildcard).
See `docs/STAGING.md` for the build/deploy procedure and caveats.

Staging uses the **shared existing Firebase backend**. It is not an isolated
data environment; use fictional records only. The ordinary Next build remains
the default and `build:staging` is an opt-in static export.

## Dependency review

The current audit is unchanged: 11 affected-package entries, 4 high and 7
moderate, with 0 critical findings. These represent two underlying dependency
chains, not eleven independently demonstrated application exploits. Re-run the
audit (`npm audit`, `npm audit --omit=dev`) after dependency changes; the counts
stayed the same through the latest install and build.

- **Runtime dependency tree:** Firebase 12.19.0 → Firestore 4.17.2 →
  `@grpc/grpc-js` 1.9.16. The advisories concern gRPC server certificate
  authorization and server error disclosure:
  [GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j)
  and [GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4).
  The reviewed application uses browser Firebase imports and runs no gRPC
  server. The emulator test uses the Node Firestore build as a client.
  No exploitable application path was identified in this review; this is not
  proof of zero exposure. Reassess if server-side Firestore usage is added.
- **Development tree:** ESLint's TypeScript tooling → `minimatch` 10.2.6:
  [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
  The reported amplification path uses optimization level 2; the inspected
  tooling call uses the default level and trusted configuration. This reduces
  demonstrated exposure but does not remove the vulnerable dependency.

Do not run `npm audit fix --force`: its proposed Firebase downgrade to 9.14.0
is not an acceptable remediation. No blanket audit suppression or untested
transitive dependency override has been introduced. Track upstream fixes and
rerun both audit scopes after dependency changes:

```sh
npm audit
npm audit --omit=dev
```

## Deployed image Worker controls

Worker version `7493f7ae-87b2-4b8b-b255-dbbb8d526d39` is deployed with deletion
disabled, token-key refresh and caching, upload-body hardening, a 64 KiB bound on
signing-request JSON bodies, native rate-limit bindings and the exact staging
allowed origin. The approximate limits are 60 authenticated user requests/min,
10 user uploads/min, and 30 clinic uploads/min. A bounded live editor signing
test received 61 `200` responses and then one `429` with `Retry-After: 60`.

Rate limiting is approximate and enforced per location, not a global quota. Do
not present it as a hard usage cap or as protection against a distributed
client.

## Outstanding operational gaps

- Full-bucket recoverability: a complete R2 inventory backup, a documented
  restore procedure, retention policy, encryption, and a multi-object recovery
  rehearsal. Referenced-image backup tooling does not capture orphaned objects.
  The new `restore:images` tool passed a live single-fictional-image rehearsal
  with SHA-256 verification (journal
  `/home/jm/.local/share/vetcloudpro-backups/live-restore-1794714961161.jsonl`),
  but that is not full-bucket recovery.
- Strict quotas: storage ceilings and hard global quota protection. The deployed
  Worker has approximate per-location rate limits (60 user requests/min, 10 user
  uploads/min, and 30 clinic uploads/min), not a global quota. Current service
  access can still consume Firebase and Cloudflare quotas.
- Orphan retention and cleanup: reference-aware orphan reporting and a reviewed
  removal process. Deletion is disabled; removed references do not remove
  stored bytes.
- Historical key revocation: confirmation that historically exposed AI-provider
  credentials were revoked. Never reproduce historical keys in reports.
- Real verification-email delivery for invitations. The rules fix is deployed
  and live negative/positive checks passed, but no real email was delivered and
  used end to end.
- External image-host policy: the client-side filter blocks active/insecure
  schemes and credential-bearing image URLs, but it still permits external HTTPS
  legacy/demo images. `no-referrer` limits referrer leakage; it does not prevent
  a third-party host from observing the client IP or access pattern. Require an
  approved external-image/host policy before real clinic data, and do not claim
  arbitrary external tracking is fully solved. The filter remains
  defense-in-depth, not the access-control boundary.
- Physically separate browser verification and live 15-minute signed-URL expiry.
  Isolated owner/viewer Chromium contexts against live staging passed, including
  AI-toggle propagation, viewer R2 rendering and offline demo behavior; the
  15-minute expiry path has a unit test with a mocked clock, not a live wait.
- A live base64 image migration. Only mocked migration tests have run.

Existing deployed Firestore rules and the hardened image Worker passed the
recorded synthetic API checks and isolated browser checks. The app is ready for
the next development feature using synthetic/staging data; it is **not**
production-ready for real clinic records. Those checks do not establish clinical
correctness, regulatory compliance or production readiness. Avoid claims that
the system is "fully secure" or "production ready".
