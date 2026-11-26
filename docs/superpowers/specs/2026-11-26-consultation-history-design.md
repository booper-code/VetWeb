# Live consultation history and chronological paging

## Outcome

Owners and Members see confirmed consultation changes from other devices in the open workspace. History is newest visit first across pages, including in the patient dossier for records already loaded. Equal sort values break ties by descending document ID. Unresolved legacy records remain visible after dated visits under **Unknown date**, with their original display text preserved where available.

## Approach

Use a bounded Firestore listener like Inventory’s: watch the first 50 results plus one lookahead; Load more widens the watched prefix by 50. Replace the prefix on confirmation so deletes, edits, and boundary shifts cannot leave duplicates or holes. Keep current authorized cached reads for startup and last confirmed results through transient failures. Clear on account or clinic change or access denial; stale callbacks cannot repopulate cleared state.

Reuse the exact `occurredAt` timestamp for structured visits. Add `historySortAt`, a timestamp for dated visits and explicit `null` for unknown dates. The separate field preserves the distinction between an exact visit time and a legacy calendar date. Accept strictly valid ISO calendar dates and numeric legacy dates with only one valid interpretation; use UTC midnight for date-only sorting, never invent a displayed visit time, and classify ambiguous or invalid dates as unknown. Original values stay untouched. Apply the same date classification in the demo without Firebase.

Sorting directly on `occurredAt` would omit documents missing the field. Downloading the full collection to sort would remove read bounds. A backfilled sort field with a per-clinic readiness gate avoids both problems.

## Rollout and scope

Use an app-readable configuration document with `preparing` and `ready` states. Newly created empty clinics start `ready` in their Owner bootstrap; only the migration operator can change readiness for existing clinics. Until `ready` is server-confirmed, use a live document-ID prefix, retaining legacy visibility and labeling its ordering honestly. From `preparing` onward, new consultations must be structured visits with their exact timestamp as the sort field, and once any row has a key, its date inputs cannot change. Backfill only that field with version preconditions and verify every row before marking the clinic `ready`. Keep dry-run reports aggregate-only; the apply path for this slice is restricted to fictional loopback emulator fixtures. Older clients that omit the field on write may need a refresh after the write requirement is enabled.

Preserve existing Owner / Member behavior, demo behavior, and audit rules for normal consultation edits. No changes to production or shared staging, and no deployment in this slice. Remaining freshness views, Staff & Payroll audit coverage, and external audit retention are subsequent slices. Run the Firestore rules and offline browser suites sequentially because they share ports.
