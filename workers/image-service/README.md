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
| `DELETE` | `/file` | Best-effort delete of `{ key }`. Owners/editors only. |
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
- `/upload` and `DELETE /file` require `owner` or `editor`. `/file-urls` accepts
  any member, including viewers.
- Signed URLs expire after 15 minutes. Revoking a membership does not invalidate
  an already-issued URL until it expires.
- Uploads are sniffed (JPEG/PNG/WebP magic bytes), capped at 5 MB, and served
  with `X-Content-Type-Options: nosniff`.
- CORS is restricted to `ALLOWED_ORIGINS`.

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

# 3. Add the production app origin to ALLOWED_ORIGINS in wrangler.toml.

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
not sufficient to restore migrated images.

## Operational notes

- Automatic deletion is disabled: concurrent edits or shared references could
  otherwise delete images still in use. Removed images can remain as orphaned
  objects until a safe, reference-aware cleanup process is implemented.
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

Run `npm run test:images` for mocked Worker authorization and migration tests.
They do not exercise Cloudflare, Firebase, or the browser UI; the checks below
are still required before using real patient data.

1. `curl https://<worker>/health` returns `{ "ok": true }`.
2. Sign in as an owner, admit a patient with a photo, and confirm the Firestore
   document contains a `clinics/...` key instead of a `data:` string.
3. Refresh and open the patient dossier; the photo still renders.
4. Open the same clinic in a second browser/profile; the photo renders there.
5. Upload a lab printout, refresh, and click the thumbnail to enlarge it.
6. Remove a photo, save, and confirm the patient document no longer references
   the old key. The object remains in R2 until safe cleanup is available.
7. Sign in as a viewer and confirm the image renders but upload/delete fail.
8. Sign in as a non-member and confirm `/file-urls` returns 403.
9. Wait 15 minutes and reload an image URL; the old signed URL is rejected.
10. Run the migration dry-run, then `--apply` on a test clinic; confirm the
    verification pass reports zero remaining data URLs.
