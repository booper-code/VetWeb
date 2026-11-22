# Scoped read-only clinic query engine (localhost staging preview)

The assistant previously answered questions such as “which patient has the longest
name?” from a fixed fictional inventory and a *follow-up summary* — a subset of
appointments — so it could miss records in the current clinic. This engine
replaces that one-off behaviour with a reusable pattern: the configured model
**plans** a small query over an allowlisted schema, the app **executes** it
locally against fresh bounded reads of the signed-in clinic, and the verified
result is **rendered locally**. The model never receives clinic rows.

## Flow (one provider call, with at most one repair)

1. Native/verified workflows still resolve locally in
   `lib/workspace-assistant.ts` and `lib/assistant-tools.ts` (navigation,
   greetings, inventory count, appointment lookup, reschedule drafts, CSV import
   count, find-person). They send nothing to a provider.
2. Every non-native question goes to `planWorkspaceClinicQuery()` in
   `lib/workspace-ai.ts`. There is no keyword gate or sample-chat fallback.
   It sends **only**:
   the user prompt, the generated schema (`buildClinicQuerySchema()`), and the
   previous *plans* (nonsensitive identifiers/literals, never previous answers).
   Same provider registry, exact built-in endpoint, saved key, provider-neutral
    wire formats, no tools, no redirect, one shared 15 s timeout. Custom or edited
   endpoints fail closed. Preview is limited to development on
   `http://localhost:3000` and the isolated staging project.
3. Gemini requests JSON with an action schema. The response is parsed as a
   query (`plan` or `plans` with 1–3 independent plans), a non-clinic
   conversation reply, or a decline. The app renders a safe clarification
   for a decline; it is not a finding about the directory. Common top-level
   plan aliases are normalized before strict validation (`parseClinicQueryPlan`);
   all plans must validate. Invalid output gets one repair request to the
   same provider/model with a generic validation hint, never the rejected
   output. Network, HTTP and quota errors are not retried.
4. `readClinicQuerySource()` (`lib/clinic-query-client.ts`) performs server-only
   (`firebase/firestore/lite`) reads of allowlisted collections under
   `clinics/{currentClinicId}`, ordered by document id, 50 rows/page, at most 4
   pages (200 rows), 8 s timeout, rechecking account/scope/cancellation each
   page. No arbitrary path is constructible from a plan. No writes, indexes or
   rules changes.
5. Each distinct table is read once per turn. `executeClinicQuery()`
   filters/sorts/aggregates the projected rows, and the app renders each
   outcome in the question's order. `projectQueryRow()` keeps only
   allowlisted fields, so notes, owner contact details, lab results, pictures,
   billing internals and payroll/hash metadata never enter a result or request.

## Domains (allowlisted tables and required role)

| Table | Role | Fields available to a query |
| --- | --- | --- |
| `patients` | member | name, species, breed, gender, status, ownerName, balance, weight, dischargedAt, id — **all statuses**, not just the UI's active/discharged pages |
| `inventory` | member | itemCode, itemName, category, stock, buyingPrice, sellingPrice, threshold, expiryDate |
| `appointments` | member | patientId, patientName, type, status, dueAt, occurredAt, createdAt, durationMinutes, id (the whole schedule, not just the current date window) |
| `consultations` | member | patient, client, type, status, occurredAt, recordedAt, staffUid, staffName, `treatmentCount` (derived count only), id |
| `staff` | member | name, kind, position, active, hiredAt, id |
| `billingEntries` | editor+ | kind, patientId, amountMinor, balanceBeforeMinor, balanceAfterMinor, recordedAt, reversed, id (balances are also exposed as `patients.balance`) |
| `auditEvents` | owner | action, entityType, entityId, actorUid, seq, time, eventId — metadata only |
| `payrollLedger` | owner | seq, type, direction, staffId, staffName, amount, periodId, createdAt, id |
| `payrollPeriods` | owner | startDate, endDate, status, createdAt, closedAt, id |
| `payProfiles` | owner | payBasis, rate, staffId |

Role levels mirror `firestore.rules` (`member` = owner/editor/viewer,
`editor` = owner/editor, `owner` = owner only). Insufficient role → explicit
`denied` with zero rows and no read; a rule/role change during a read is also
denied; other failures are explicit `unavailable`. Neither is ever phrased as
“no results”.

## Operations

`count`, `list`, `rank` (min/max with `name` length via
`sort: [{field:'name', transform:'length', direction:'desc'|'asc'}]`, `limit`,
`includeTies`), `sum`, `group`. Generic `filter` supports eq/neq/gt/gte/lt/lte/
in/notNull/contains with AND semantics. Sorting, filtering, grouping and
aggregation are performed in JS **after** the bounded read; no composite index
or server-side arbitrary query is used.

## Limits and explicit non-claims

- **Not exhaustive past 200 rows.** If a fourth full page is returned, the
  source is marked incomplete: the result is `partial`, rows carry a warning,
  and extrema are worded as “among the records checked … not necessarily the
  clinic-wide extreme”. No truncated scan is presented as exhaustive.
- **No clinical text or detail projections.** Consultation `notes`, treatment
  line details, lab findings, reasons, owner contact/email/address and picture
  references are deliberately not allowlisted. Only `treatmentCount` is
  available. “Treatment/visits” therefore means visit metadata and counts, not
  chart contents.
- **No inventory import receipts table** in the schema (a separate existing
  owner-only tool covers CSV import history with an aggregation query).
- **No writes of any kind.** Rescheduling stays a manual, separately audited
  editor save; no payments, refunds, admin actions, messages or record edits.
- **Preview only.** No production/nonstaging rollout; no auth, rules, indexes or
  hosted-build changes. Provider planning remains disabled outside the isolated
  localhost/staging setup.
- **Planner failure is fail-closed.** If repair still fails validation, no
  clinic query runs. Model misplanning cannot widen access because the
  validator and the read layer are independent of the provider.
- Clear front-desk briefings such as “what should I check today?” or “who needs
  checking?” no longer go to the provider: they are a local, deterministic read
  of the signed-in clinic’s staging appointments, due follow-ups and stock
   alerts. See [DAILY-BRIEFING.md](DAILY-BRIEFING.md). Patient questions use the
   Patient Directory, not the sample follow-up list. “Currently here” means
   active status in the directory, not verified physical presence.

## Tests

`npm run test:assistant:clinic-query` covers generic operations, the four-patient
longest/shortest result including ties and follow-up plan context, partial/
denied/unavailable isolation, strict alias normalization, one-shot repair,
ordered multi-query reads and rendering, projection redaction and the absence
of protected evidence in provider requests.
