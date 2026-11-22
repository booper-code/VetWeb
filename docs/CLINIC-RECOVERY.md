# Clinic recovery: what to save and how to rehearse

**Readiness checklist, not a completed restore.** There is no in-app clinic
restore. Use only fictional records, accounts, and images for this drill.
Never point the drill at the shared staging site, live Firebase, or the live
image Worker/bucket.

## Know what each artifact covers

| Artifact | Included | Not included / limits |
| --- | --- | --- |
| Account Settings → Download records JSON (v1) | Clinic document, members and invitations; patients, inventory, consultations, appointments, billing entries, staff, pay profiles, payroll periods/ledger/metadata, audit heads/events | No user-side membership index, inventory import receipts, Auth users, uploaded bytes, rules or indexes. Server reads are paged and sequential, not one point-in-time snapshot; it is a plaintext application export, not a native Firestore import artifact. |
| [Referenced-image tools](IMAGE-BACKUP.md) | Patient images listed by key in the JSON, with a byte count and SHA-256 for each | No unreferenced objects. The restore tool writes new test keys and records a mapping; it does not restore records or rewrite references. |
| Full recovery set (to provision and test separately) | A typed provider-level Firestore backup/export including all required documents and indexes-as-configuration; R2 inventory and actual objects; a separately protected Auth recovery plan preserving UIDs; known-good app, rules, indexes, Worker and hosting configuration | Ensure the selected provider modes and permissions really support export/restore. Record coverage gaps explicitly, including MFA/session recovery if applicable. Never store live secrets in the repo. |

## Isolated drill: records and images together

1. **Choose a disposable target.** Use a loopback Firebase demo/emulator for
   local fixtures, or a separately authorized disposable Firebase project and
   private R2 bucket/Worker for a provider-level rehearsal. Verify project ID,
   Worker origin, and bucket against an explicit drill allowlist before any
   write. Test environment and source must not share production credentials,
   account identities, or storage. Disable external messaging and integrations.
2. **Seed and capture.** Create a fictional owner, editor, viewer, and outsider;
   patients with multiple image references; and linked inventory, consultations,
   appointments, billing, payroll, and audits. Include an import receipt and
   an orphan image for the full-recovery track. Pause writes, sync pending
   changes, and capture a typed database backup plus object inventory/bytes.
   Export the account/UID mapping and configuration separately for the full
   track. Capture the clinic JSON and referenced images as a supplemental set.
   Record the cutoff, per-collection counts and IDs, types and key relationships,
   expected image keys, sizes and SHA-256 hashes. Hash the files and store the
   manifest in a separately protected location. Verify the artifacts before
   proceeding.
3. **Restore to empty storage.** Use the provider's supported typed import
   (or emulator snapshot import for local fixtures), not a loose JSON copy
   that converts timestamps or other Firestore types into plain objects.
   Bring up the matching verified rules/indexes and map fictional accounts to
   the recovered ownership and membership UIDs before exposing access. Restore
   image bytes to isolated storage; preserve keys when testing full recovery.
   With the referenced-image tool, retain the source→new-key journal and
   update only the isolated patient fixtures via a reviewed mapping step.
   Missing, ambiguous, or cross-clinic keys fail the drill.
4. **Verify independently.** Compare source and restored counts, IDs,
   timestamps and types, patient/appointment relationships, ledger totals,
   audit sequences and revisions, and ownership/membership indexes. Read
   restored image bytes back and compare SHA-256 and lengths to the source;
   open the matching patient records in the isolated app. Confirm the orphan
   exists only on the full-object recovery track (not in the referenced-only
   set). Check owner/editor/viewer permissions and deny signed-out, removed,
   and outsider users on fresh record and image reads. Verify uploads and any
   permitted writes stay isolated.
5. **Record the result.** Keep a redacted checklist with versions, cutoff,
   manifests, discrepancies, and measured recovery time and data-loss window.
   Mark partial recovery explicitly; a passing referenced-image check is not
   a passing clinic restore. Shut down the drill and expire temporary artifacts
   and credentials according to the agreed policy.

## Protect and retain copies

Encrypt backups and staging directories at rest, restrict access to named
operators, and keep recovery keys separate. Treat even manifests, membership
exports, and restore journals as sensitive. Keep a second independent copy
with protected deletion and periodically verify it can be decrypted. Do not
leave plaintext JSON in Downloads, email it, or commit it. Before real use,
agree on a tolerable data-loss window and recovery time; set backup frequency,
retention, and expiration to meet them and the clinic's legal obligations.
For a starting discussion, consider daily copies retained 30 days and monthly
copies retained 12 months, subject to approval. Rehearse before real use and
repeat after changes to schema, storage, authentication, or backup tooling.
