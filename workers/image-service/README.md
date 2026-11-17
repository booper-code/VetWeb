# Patient image service (Cloudflare Worker + R2)

Private storage for patient photos and lab printouts. The Next.js app uploads a
compressed JPEG, stores the returned object key on the patient document, and
renders the image through a short-lived signed URL.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/upload` | Verify the Firebase ID token and clinic membership, store the image, return `{ key }`. Owners/editors only. |
| `POST` | `/file-urls` | Return `{ urls: { [key]: signedUrl } }` for up to 100 keys from one clinic. Any clinic member. |
| `GET` | `/file?key=&exp=&sig=` | Stream the R2 object when the HMAC signature is valid. |
| `DELETE` | `/file` | **Disabled in this version of the code.** Returns `405` with `{ error }` until a reference-aware cleanup process exists. |
| `GET` | `/health` | Returns `{ ok: true }`. |

All authenticated endpoints expect `Authorization: Bearer <Firebase ID token>`.

## Security model

- The R2 bucket is **private**. Nothing is served from a public bucket URL.
- The Worker verifies the Firebase ID token against Google's public JWKS
  (`securetoken@system.gserviceaccount.com`), including `iss`, `aud`, `exp`, and
  the RS256 signature.
- Membership is checked by reading `clinics/{clinicId}/members/{uid}` through
  the Firestore REST API **with the caller's own ID token**, so `firestore.rules`
  remains the source of truth. A client-supplied clinic ID is only accepted when
  that read succeeds.
- `/upload` requires `owner` or `editor`. `/file-urls` accepts any member,
  including viewers.
- **Deletion is disabled.** `DELETE /file` answers `405` before the caller is
  authenticated or any member document is read, so it cannot touch R2. The
  previous handler deleted any object in the caller's clinic without checking
  whether patient documents still referenced it, and a hard delete cannot be
  undone. Do not re-enable it until a reference-aware cleanup process exists,
  is reviewed, and has been rehearsed against a backed-up test clinic.
  Worker version `7493f7ae-87b2-4b8b-b255-dbbb8d526d39` is deployed;
  unauthenticated `DELETE` and an authenticated owner `DELETE` both returned
  `405` live. A viewer-specific authenticated `DELETE` was not separately
  recorded.
- Signed URLs expire after 15 minutes. Revoking a membership does not invalidate
  an already-issued URL until it expires.
- The deployed Worker (`7493f7ae-87b2-4b8b-b255-dbbb8d526d39`) uses native
  rate-limit bindings: 60 authenticated user requests/min, 10 user uploads/min,
  and 30 clinic uploads/min. These limits are approximate and enforced per
  location, not a global quota or a hard usage cap. A bounded live editor
  signing test received 61 `200` responses, then one `429` with
  `Retry-After: 60`.
- Signing-request JSON bodies for `/file-urls` are capped at 64 KiB.
- JSON responses (including signed URLs) are sent with `Cache-Control: no-store`.
  Google's signing keys are cached for an hour and refreshed at most once per
  minute, so a forged `kid` cannot force a JWKS fetch on every request.
- Uploads are sniffed (JPEG/PNG/WebP magic bytes), capped at 5 MB, and served
  with `X-Content-Type-Options: nosniff`. The multipart body is read with a hard
  5 MB + 64 KiB ceiling and cancelled as soon as it is crossed, so an oversized
  upload is rejected before it is buffered in full. `Content-Length` is only a
  fast-path hint; absent or understated lengths are still cut off mid-stream.
- CORS is restricted to `ALLOWED_ORIGINS`. The deployed version includes the
  exact staging origin `https://vetcloudpro-staging.jmferrari16.workers.dev`
  alongside localhost development origins. A live `OPTIONS` preflight returned
  `204` reflecting that exact origin, not a wildcard. Add any production origin
  explicitly; do not use a wildcard or reflective origin.

## Setup

Prerequisites: a Cloudflare account and `npx wrangler` (no global install
needed). The Firebase project is `vetcloudpro`.

```powershell
cd workers/image-service

# 1. Log in and create the private bucket once.
npx wrangler login
npx wrangler r2 bucket create vetcloudpro-images

# 2. Generate a signing secret (32+ random characters) and store it.
#    PowerShell:
$bytes = [byte[]]::new(48)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$secret = [Convert]::ToBase64String($bytes)
$secret | npx wrangler secret put IMAGE_TOKEN_SECRET

# 3. Add the app origin(s) to ALLOWED_ORIGINS in wrangler.toml.
#    The deployed Worker currently allows localhost and the exact staging origin
#    https://vetcloudpro-staging.jmferrari16.workers.dev.

# 4. Deploy.
npx wrangler deploy
```

Wrangler prints the Worker URL, for example
`https://vetcloudpro-images.<your-subdomain>.workers.dev`. Point the app at it:

```text
# .env.local (or the production environment)
NEXT_PUBLIC_IMAGE_WORKER_URL=https://vetcloudpro-images.<your-subdomain>.workers.dev
```

`NEXT_PUBLIC_*` values are inlined at build time, so rebuild/redeploy the app
after changing it. If the variable is empty, the app keeps the old behaviour and
stores photos as base64 data URLs inside the patient document (demo mode always
does this so it never needs the network).

Local development:

```powershell
npx wrangler dev
# then set NEXT_PUBLIC_IMAGE_WORKER_URL=http://localhost:8787
```

## Free tier notes

- Workers free: 100,000 requests/day.
- R2 free: 10 GB-month storage, 1M Class A operations/month, 10M Class B
  operations/month. A compressed patient photo is typically 40–200 KB.
- The Worker only proxies reads; no egress charge from R2 to the Worker.

## Migration from base64 documents

Existing records still render: `components/StoredImage.tsx` passes `data:` URLs
straight to the browser. To move them into R2, use the one-off script at the
repository root:

```powershell
# Always dry-run first.
$env:FIREBASE_API_KEY = "<web API key from lib/firebase.ts>"
$env:FIREBASE_EMAIL = "owner@example.com"
$env:FIREBASE_PASSWORD = "<owner password>"
$env:CLINIC_ID = "<clinic id>"
$env:IMAGE_WORKER_URL = "https://vetcloudpro-images.<subdomain>.workers.dev"
node scripts/migrate-patient-images.mjs

# Apply. The script writes a JSON backup before changing anything.
node scripts/migrate-patient-images.mjs --apply
```

The script signs in through Firebase Auth, reads patients through the Firestore
REST API, uploads each `data:image/...` value, patches only the affected fields
(`profilePicture`, `pictures`, `labResults`), and verifies that no data URLs
remain. It uses `currentDocument.updateTime` preconditions so a concurrent edit
causes that patient to be skipped rather than overwritten.

Keep the backup file safe: it contains the original base64 images. Run the
migration while the clinic is idle, and verify the image count in the app before
deleting the backup.

The app's JSON clinic backup contains R2 keys, not the R2 image bytes. Keep a
separate, access-controlled backup of the R2 bucket; the JSON export alone is
not sufficient to restore migrated images. One fictional object was privately
backed up and restored under `restore-test` with SHA-256 verification, but that
is not a full-bucket backup or a documented restore procedure.

## Operational notes

- `npm run backup:images` can plan/download images referenced by a clinic JSON
  export and verify their hashes offline. See `docs/IMAGE-BACKUP.md` at the
  repository root for secure setup and restore limitations. It does not
  enumerate or back up the whole R2 bucket.

- `npm run restore:images` can upload a verified referenced-image backup as new
  `restore-test` objects and record a private append-only mapping journal. It
  requires explicit `--apply` and `RESTORE_CLINIC_ID`, verifies the whole backup
  offline before uploading, checks each restored object, and does not change
  original objects or patient references. See `docs/IMAGE-BACKUP.md`. A live
  synthetic rehearsal passed for one fictional image with SHA-256 verification
  (journal
  `/home/jm/.local/share/vetcloudpro-backups/live-restore-1794714961161.jsonl`);
  multi-object and full-bucket recovery remain unverified.

- Deletion is disabled in the Worker code (`DELETE /file` returns `405`) and the
  app has no delete helper, so no client path calls it. Removing an image from a
  patient document only drops the key; the object stays in R2. Concurrent edits
  or shared references could otherwise delete images still in use, so re-enable
  deletion only alongside a reviewed, reference-aware cleanup process.
- Worker version `7493f7ae-87b2-4b8b-b255-dbbb8d526d39` has been deployed; live
  unauthenticated and authenticated owner `DELETE` requests returned `405`.
  Verify other authenticated roles as well (checklist item 7).
- PDF exports currently omit patient images (`lib/pdf.ts`). If images are added
  later, fetch the signed URL with CORS and convert the blob to a data URL before
  calling `jsPDF.addImage`.
- The bucket name and Firebase project ID are non-secret and live in
  `wrangler.toml`. `IMAGE_TOKEN_SECRET` is a Worker secret and must never be
  committed.
- The Worker's membership check depends on the published Firestore rules. If
  `clinics/{clinicId}/members/{uid}` reads are denied, uploads and image loads
  return 403 even for legitimate members. Republish `firestore.rules` first.

## Manual verification checklist

Run `npm run test:images` (21 tests) for mocked Worker authorization and
migration tests, plus a genuine unchanged signed-URL expiry test using a mocked
clock. The live synthetic SDK/Worker checks in `docs/CURRENT-HANDOFF.md` also
exercised several authorization paths against the deployed Worker. Staging
Playwright checks used isolated owner/viewer Chromium contexts against the live
staging site, with all paths passing. The items below must still be completed or
explicitly confirmed before using real patient data; use fictional records.

1. `curl https://<worker>/health` returns `{ "ok": true }`. **Passed** against
   the deployed Worker.
2. Sign in as an owner, admit a patient with a photo, and confirm the Firestore
   document contains a `clinics/...` key instead of a `data:` string.
   **Partially covered:** live owner/editor `/upload` requests passed, but the
   browser admittance and Firestore document check were not rerun.
3. Refresh and open the patient dossier; the photo still renders. **Partially
   passed:** an isolated Chromium viewer context against live staging rendered an
   R2 image after reload and re-login; an owner-side dossier refresh was not
   separately recorded.
4. Open the same clinic in a second browser/profile; the photo renders there.
   **Partially covered:** isolated owner/viewer Chromium contexts on live
   staging passed, but they are not a physically separate browser/profile.
5. Upload a lab printout, refresh, and click the thumbnail to enlarge it.
   **Partially covered:** live `/upload` requests passed; browser refresh and
   enlarge were not verified.
6. Remove a photo, save, and confirm the patient document no longer references
   the old key. The object remains in R2 until safe cleanup is available.
   **Not verified.**
7. Sign in as a viewer and confirm the image renders but upload fails. Confirm
   `DELETE /file` returns `405` for authenticated roles. **Partially passed:**
   an isolated Chromium viewer on live staging rendered the image after reload
   and re-login, and live viewer read and upload denial passed; an authenticated
   owner `DELETE` returned `405`, but a viewer-specific `DELETE` was not
   separately recorded.
8. Sign in as a non-member and confirm `/file-urls` returns 403. **Passed** live
   as outsider URL denial.
9. Wait 15 minutes and reload an image URL; the old signed URL is rejected.
   **Not verified live.** A unit test now covers genuine unchanged signed-URL
   expiry using a mocked clock, not a live 15-minute wait.
10. Run the migration dry-run, then `--apply` on a test clinic; confirm the
    verification pass reports zero remaining data URLs. **Not verified** live;
    only mocked migration tests have run.
