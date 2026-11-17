# Four-part foundation batch — in progress

Scope: pagination/query limits; core search/validation/error/mobile workflows;
recovery/storage/audit safeguards; privacy-conscious offline/PWA support.

## Implementation

- Initial patient, inventory and consultation reads are limited to 50 documents.
  Active patients load first; discharged history loads separately on demand.
  Cursors reset on clinic changes, stale in-flight requests are discarded, and
  appended pages deduplicate by canonical document ID.
- Search, dashboard values and PDF exports explicitly describe **loaded records**,
  not whole-clinic totals. Consultation and history paging use stable document-ID
  order: legacy locale dates are not a reliable global chronological sort.
  New discharges receive an ISO `dischargedAt`, without rewriting legacy data.
- New admissions and inventory/CSV rows without explicit codes use random IDs.
  This prevents partial lists from accidentally allocating an existing ID.
- Validations reject negative/non-finite quantities and prices. Failed edits and
  deletions retain the UI record rather than reporting success before commit.
  CSV imports are bounded to 2 MB/500 rows and report partial completion honestly.
- Clinical mutation transactions check record revisions and create an immutable
  audit event plus a permanent head atomically. Rules enforce this for patients,
  inventory and consultations. Legacy records begin at revision zero.
  Only owners can enumerate audit events. Events store identity/action/revision
  metadata, never a clinical-content snapshot. Administrative credentials can
  bypass rules; this is not a compliance-certified audit system.
- Billing/stock changes commit together, with at most two stock items plus the
  patient per transaction to stay within Firestore rule-access limits.
- An owner-only switch pauses new image uploads without deleting existing images.
  The Worker enforces it. The existing per-file/rate limits remain; these are not
  strict global byte/billing quotas.
- Image backup/restore regression coverage includes multiple objects, partial
  failures, 429 responses, oversized downloads and malicious manifests.
- The PWA caches only a public static app shell and same-origin build assets.
  It never caches API/RSC responses, signed images, provider responses or
  cross-origin traffic. Updates wait for tabs to close rather than forcing a
  reload over a draft.
- Default devices use memory-only authentication and records. A trusted device
  requires explicit consent before persistent sign-in/Firestore caching.
  Clearing disables access, signs out and clears IndexedDB; other tabs are
  notified to stop displaying data. Users must close other tabs if cleanup
  cannot be confirmed.
- Trusted devices can restore cached read-only records offline. Clinical
  transactions are not queued offline. The demo continues to work without cloud
  access. Offline editing/draft synchronization is **not** implemented.

## Rollout safety

The new audit rules reject older unaudited clinical clients. Publish the matching
UI and reviewed rules together, preserve the invitation email-verification fix,
and tell existing users to finish work and reload. Never revert security rules
merely to unblock an outdated client.

The image migration script was updated to use a conditional atomic REST commit
with an audit event/head; it still backs up before uploading and checks the
patient update-time precondition.

All live checks must use the separately authorized fictional clinic/accounts.
No real patient migration, ownership transfer, deletion or payroll entry is
authorized as a smoke test.

## Verification status

Local rules, pagination and expanded clinical-audit emulator scenarios pass
(23 audit tests including the parent and 22 direct-write/editor subtests).
Image tests: 22 passed; backup/restore: 18; offline-policy: 6; validation: 2.
Workflow regressions: 72 passed using real React state/effects and shallow child
views, including late completions and stale callback entry across clinics,
logout and wipe. Sol's three interrupted patches (late-mutation scope guards,
cross-tab wipe signalling, persistent clear feedback) are applied and verified;
no patch from that interruption remains unapplied. Real Chromium/emulator device
cleanup: 4 passed (parent plus
three scenarios), covering memory-only tabs, initialization races and genuinely
blocked IndexedDB deletion with persistent failure feedback/retry.
The actual Team component also has mounted/unmounted transfer regressions:
role changes propagate within the same clinic without interrupting another view.
Type-check and ordinary build pass. Lint: no errors, 1 pre-existing warning.
The final staging export also passes after the ownership fix.
Astra completed the requested review and confirmed the ownership finding closed,
with no blocker in the reviewed scope. It independently ran the earlier 66-test
workflow suite; the main session ran the final 72-test suite.
Live staged feature checks and coordinated deployment remain pending.
**The user explicitly chose to keep this batch local for now.** No foundation
changes are deployed. See `docs/TESTING.md` for coverage boundaries and commands.

Resume point and remaining work: `docs/HANDOFF-FOUNDATION-BATCH.md`.

Production gaps in `SECURITY-STATUS.md` remain separate: complete bucket recovery,
strict quotas, orphan-retention policy, historical-key revocation confirmation,
external image-host policy and real verification-email delivery.
