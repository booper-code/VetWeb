# VetCloudPro — current handoff

**Updated:** 2026-11-14
**Repository:** <https://github.com/booper-code/VetWeb>

This document supersedes the session-state claims in `.opencode/HANDOFF.md`
and the baseline descriptions in `docs/NEXT-FEATURES.md`; those documents were
written before the R2 and AI-toggle work. The latter remains useful as a
feature roadmap. At the time of writing, GitHub `main` contains the current
application, and the local `published-main` branch tracks `origin/main`.

## Constraints

- Stay within Firebase Spark and Cloudflare free tiers; check current usage and
  pricing before enabling billable services. Do not introduce a paid backend.
- Keep the demo login offline: `demo-clinic` must not require Firebase or R2.
- Firestore rules are the access-control boundary. Test authorization changes
  in the emulator and publish the reviewed rules separately.
- Firebase imports remain lazy in `lib/` modules. Do not put credentials,
  tokens, signing secrets, patient records, or local `.env` files in Git.
- Read the relevant local Next.js 16 docs in `node_modules/next/dist/docs/`
  before changing routing or client/server boundaries.

## Current state

- Multi-clinic login, membership, invitations, owner team management, staff and
  payroll screens, PDF exports, and JSON clinic backup are implemented.
- The user confirmed the legacy `clinics/binan-clinic` data is demo-only, so
  roadmap item 0 (migrating that clinic) was skipped.
- Patient-image work is **partially verified**, not production-ready:
  - The private R2 bucket `vetcloudpro-images` and image Worker were created and
    the Worker's health endpoint responded successfully.
  - The local app was configured with `NEXT_PUBLIC_IMAGE_WORKER_URL` in its
    ignored `.env.local`; a fresh checkout or deployment must configure its own
    environment. The Worker currently allows localhost origins; add the actual
    staging origin before using it from a hosted site.
  - In the user-confirmed test clinic, a fictional patient's profile image was
    uploaded and displayed again after refresh and re-login. A sample lab image
    was uploaded, displayed and removed without removing the profile image.
  - A second-browser check, live viewer/non-member authorization tests, live
    migration, and an R2 backup/restore exercise remain outstanding.
  - Automatic R2 object deletion is disabled to avoid deleting objects that
    could still be referenced. Removed images and failed/cancelled uploads may
    leave orphaned objects. Design reference-aware cleanup before enabling it.
  - Clinic JSON backups contain R2 object keys, **not image bytes**. A separate
    access-controlled R2 backup and tested restore procedure are required.
  - Existing base64 images remain renderable. The migration script has mocked
    tests, but must be tested with a backed-up test clinic before any live use.
  - See `workers/image-service/README.md` for setup and limitations.
- The clinic owner can control the clinic-wide **Enable AI features** toggle in
  Clinic Setup. It defaults to off when the clinic field is absent. Turning it
  off hides AI screens and patient-summary UI without deleting saved summaries
  or browser-local provider settings; turning it on shows them again. The demo
  setting is session-only and stays offline.
- **AI clinical analysis is not implemented.** The existing laboratory and
  extraction flows display predefined example output, now labeled as demo
  only. They must not be used for clinical decisions. Provider connection
  testing is separate from actual clinical analysis.
- The latest `firestore.rules`, including the owner-only AI toggle, were tested
  in the emulator but were **not confirmed published** to the live Firebase
  project. Until published, the live toggle may fail to save. Do not assume
  rules in Git are deployed.
- The app itself has **not** been deployed to Cloudflare staging. Publishing
  code to GitHub does not deploy the app or Firebase rules.
- The login page no longer pre-fills or displays demo credentials. The manual
  offline demo login remains available.

## Recommended next steps

1. Review the current `firestore.rules` and confirm the live Firebase project
   and active rules. With the owner's authorization, publish the full reviewed
   file in Firebase Console. Test the AI toggle with an owner and a second staff
   account: enable/disable, cross-client update, and non-owner denial.
2. Finish image security and operational checks using fictional records: second
   browser, viewer/non-member behavior, image backup/restore, and a safe cleanup
   design. Keep the bucket private. Do not migrate or remove real records until
   a backup and a test migration have been verified.
3. Test team invitation acceptance, role changes, removal, ownership transfer,
   and backup download using dedicated test accounts. Avoid changes to actual
   members, ownership, or irreversible payroll entries during smoke tests.
4. Configure a test-only Cloudflare staging deployment and the Worker's allowed
   staging origin. Use fictional records until privacy, rules, and backups have
   been reviewed. Obtain the user's approval before any billable setup.
5. Once the image work is stable, continue with roadmap item 2: pagination and
   query limits, followed by offline persistence/PWA and the remaining items.

The Bopp test clinic contains the fictional patient `Automation Test` and an
empty test lab panel. A test inventory item was created and deleted during the
previous browser check. Do not delete any other data without confirmation.

## Last verification reported

These results were recorded in the previous session, not rerun when this
handoff was written:

| Check | Result |
| --- | --- |
| `npm run test:rules` | Passed, including owner/non-owner AI-setting scenarios |
| `npm run test:images` | Passed; Worker and migration tests use mocks |
| `npx tsc --noEmit` | Passed |
| `npm run build` | Passed |
| `npm run lint` | Passed with 17 warnings |
| Demo AI toggle and summary hide/restore | Passed in a browser using demo data |
| Live AI toggle, cross-account R2 access, live migration | Not verified |

The earlier browser checks generated PDF and JSON blobs for inspection; they
did not prove download-dialog behavior or backup restoration. Real AI output,
account deletion, and production readiness were not tested.

## Security and deployment reminders

- The previous project brief flags a historical hardcoded Gemini key in old
  local Git history. Confirm that any affected key was revoked/rotated; do not
  reproduce or publish the key. The current code must not contain secrets.
- Signed image URLs are bearer links and can remain usable until their expiry;
  revoking membership does not immediately invalidate an already-issued link.
- Review billing limits, privacy requirements, and the full access model before
  using real clinic records. The current staging/test setup is not proof of
  production security or compliance.
