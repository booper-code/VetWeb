# Referenced patient-image backup and restore

Clinic JSON exports contain image keys, not image bytes. Two companion tools
support a rehearsal workflow:

- `npm run backup:images` downloads the R2 images referenced by the export's
  patient collection into a new private directory, with a manifest containing
  object keys, byte counts and SHA-256 checksums.
- `npm run restore:images` verifies that backup and uploads the bytes through the
  Worker as new objects under the `restore-test` prefix, recording an append-only
  private mapping journal. It does not update patient documents.

**This is not a full-bucket or full-clinic backup/restore.** Orphans, cancelled
uploads and objects absent from that clinic export are not included. It does not
provide point-in-time consistency with Firestore, and it does not automatically
restore patient documents or recreate original object keys.

## Plan the backup first (no network)

```sh
npm run backup:images -- /private/location/clinic-export.json
```

The export must be a version 1 `vetcloudpro-clinic-backup` JSON file. Cross-clinic
keys are rejected, and repeated references are downloaded once.

## Download

Supply `IMAGE_WORKER_URL` (the trusted HTTPS origin of your deployed Worker)
and `FIREBASE_ID_TOKEN` through your local environment. Use an authorized clinic
member's short-lived Firebase ID token, **not** a Firebase CLI access token.
Do not put tokens in shell arguments, repository files, or chat.

```sh
npm run backup:images -- /private/location/clinic-export.json /private/location/NEW-image-backup --apply
```

The output directory must not already exist. The tool creates it with mode 0700
and files with mode 0600. Run as your own user on a private filesystem. These
permissions are not encryption: use encrypted, access-controlled storage and a
reviewed retention policy for real records.

Downloads are sequential, bounded to 5 MB each, and restricted to signed URLs on
the configured Worker origin. Redirects are rejected. Tokens and signed URLs
are never written into the manifest. A failed run leaves an `INCOMPLETE` marker
and no usable final manifest; preserve the export and retry into a new directory.
Tokens may expire during long backups; keep the dataset bounded and rerun with
a fresh token rather than treating a partial run as complete.

## Offline integrity verification

```sh
npm run backup:images -- --verify /private/location/image-backup
npm run test:backup
```

Verification checks every manifest entry's clinic, filename, size and hash.
This detects missing or modified bytes but does not authenticate a manifest
against malicious alteration. Keep the whole backup in trusted private storage.
`npm run test:backup` runs the backup and restore suites; 9/9 tests currently
pass. Those are unit-test results; live evidence is limited to single-object
rehearsals (see below), not a multi-object restore.

## Restore rehearsal

The restore tool is explicit and non-destructive. There is no plan-only mode:
invoking it with `--apply` uploads as soon as local verification succeeds.

```sh
export RESTORE_CLINIC_ID="<disposable test clinic id>"
export IMAGE_WORKER_URL="https://vetcloudpro-images.<subdomain>.workers.dev"
export FIREBASE_ID_TOKEN="<short-lived authorized member token>"
npm run restore:images -- /private/location/image-backup /private/location/NEW-restore-journal.jsonl --apply
```

Requirements and behavior:

1. `--apply` is mandatory. The tool also requires the backup directory, a new
   journal path, and `RESTORE_CLINIC_ID`; do not run it against a real clinic.
   `RESTORE_CLINIC_ID` must be 1–64 characters of letters, digits, `_` or `-`.
   Use a disposable test clinic containing fictional records.
2. `FIREBASE_ID_TOKEN` must be an authorized clinic member's short-lived token,
   not a Firebase CLI token. `IMAGE_WORKER_URL` must be a credential-free HTTPS
   origin with no path, query or fragment. Do not put tokens in arguments,
   repository files, logs or chat.
3. The journal path must not already exist. The tool creates it exclusively with
   mode 0600, so an old or reused path stops the run before uploads.
4. The complete backup is verified offline, including every manifest entry and
   SHA-256 checksum, before any cloud write. Each object's bytes are hashed again
   immediately before upload.
5. Uploads use `patientId=restore-test`. The returned key must be under
   `clinics/<RESTORE_CLINIC_ID>/patients/restore-test/` and end in a UUID-style
   `.jpg` name; anything else stops the run.
6. The journal is append-only and private. It records the source clinic, target
   clinic, `restore-test` prefix, and each source key to new restored key mapping.
   It never contains tokens or signed URLs. A per-object `verified: false` entry is
   appended before the restored image is checked, then `verified: true` after the
   download matches the recorded size and SHA-256.
7. A failed run can leave uploaded objects and a partial journal. Preserve the
   journal, inspect the verified/partial entries, and retry with a **new** journal
   path. The tool does not roll back or delete restored objects.
8. The tool does not change original R2 objects or any patient reference. Patient
   documents still point at the original keys; the journal is the mapping needed
   for later, separately reviewed document restoration.
9. It restores only images referenced by the clinic export. It is not a
   full-bucket inventory, a full clinic backup, an automated clinic-document
   restore, or a point-in-time-consistent recovery.

**Live status:** the new `restore:images` tool passed a synthetic live rehearsal
for one fictional image: the upload went under the `restore-test` prefix and the
restored object matched the recorded size and SHA-256. The append-only journal
is `/home/jm/.local/share/vetcloudpro-backups/live-restore-1794714961161.jsonl`.
This is a single-object result; it does not demonstrate multi-object ordering,
interrupted-run recovery, or full-bucket recovery. An earlier
single-fictional-object rehearsal also passed using the previous manual
procedure, not this tool. Full-bucket recovery and automatic clinic restoration
remain unverified.
