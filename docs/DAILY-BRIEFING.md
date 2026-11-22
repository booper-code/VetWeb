# Local daily front-desk briefing — preview only

**Snapshot: 2026-11-22.** The Workspace Assistant’s “What should I check today?”
/ front-desk briefing is now a **native, deterministic local read** of the
signed-in clinic’s real staging records. It makes **no provider call**, forwards
**no clinic data**, and writes nothing. Ordinary general conversation still uses
the provider saved in Clinic setup. Nothing was deployed; no account, record,
rule, index or AI setting was changed.

## What changed

Previously a briefing question was routed to the configured model with a fixed
nine-row fictional sample catalog plus fictional follow-up summaries. Now:

- `isDailyBriefingQuestion` in `lib/workspace-assistant.ts` recognizes clear
  variants and returns `{ kind: 'daily-briefing' }`. `shouldDeferToModel` is
  false for that result, so the provider transport is never invoked.
- Recognized phrasings include “What should I check today?”, “Give me a daily
  briefing”, “What should I be mindful of today?”, the exact earlier prompt
  “are there any things in the clinic that i should be mindful of”, “who needs
  checking”, and “How about the patients? Is there someone that needs
  checking?”. A qualifier, a write verb, a different clinic, or unusual wording
  is **not** a briefing: it falls back to the existing routes (general questions
  still go to the provider).
- The single Ask field and all provider-neutral wording/gates are unchanged.
  Local turns and local results — including the briefing text — never enter
  the provider’s bounded chat history or the query planner’s plan context.
- `onDailyBriefing` is wired only for a signed-in, non-demo workspace on
  `http://localhost:3000` in development, with the staging Firebase project.
  The hosted static build does not wire it; neither does the offline demo.
  In those places a briefing question returns a local “unavailable here”
  message, never a provider request.

## Aggregator and reads

- `lib/daily-briefing.ts` is a pure aggregator: Manila day boundaries from the
  existing `billing-values`/`follow-up-values` helpers, stock status from
  `stock-alert-values`, bounded per-section lists, explicit states and a
  deterministic plain-text renderer. No Firebase import, no provider, no writes.
- `lib/daily-briefing-client.ts` performs fresh, bounded, clinic-scoped server
  reads and rechecks access after them:
  - scheduled today: `dueAt` in the Manila day window, `orderBy dueAt`, capped;
  - due/overdue follow-ups: `dueAt < end of Manila day`, `orderBy dueAt desc`,
    capped, then filtered with `isDueFollowUp` (scheduled + `Follow-up` type);
  - stock: the existing bounded `loadClinicScanPage('inventory')` scanner, up
    to two pages, evaluated with `stockAlertFor`.
  - Both appointment reads are **single-field `dueAt` ranges**; they do not
    depend on the Follow-up Queue’s composite `status`/`type`/`orderBy` index.
- Scope, account, live role and abort are checked before reads, after the
  collections and after a final fresh role read. A change during the read
  denies the briefing instead of showing records read under the old access.

## Result rules

- **Unavailable vs no results:** a failed read says “could not be verified”
  and explicitly refuses to mean there were no results. Only a complete,
  successful read may say “none found in the checked records”.
- **Partial vs complete:** each section reports its own read completeness. A
  capped read says “partial read, more may exist”; it is never a clinic-wide
  all-clear. Matching rows beyond the five-per-section display cap are flagged
  (“N more not shown”).
- **Actionable detail:** scheduled patient/type/Manila time; follow-up patient,
  date, overdue vs due today, and whether outreach is logged for that due time;
  stock item with low/out/expired/expires-today/expiring-soon reasons when the
  catalog records them. Each section points back to the normal screen.
- **No inference:** no medical urgency, diagnosis or “patient is fine” claim;
  no message, contact log, booking, save or other write.
- **Bounded output:** the reply is limited to 1,600 characters and ends with a
  “briefing shortened” flag when truncated.

## Files

- `lib/daily-briefing.ts`, `lib/daily-briefing-client.ts` (new).
- `lib/workspace-assistant.ts` (routing), `components/WorkspaceAssistant.tsx`
  (local briefing turn), `app/page.tsx` (gated callback).
- `scripts/assistant-followups/prototype.ts` (rehearsal keeps briefings local).
- `tests/daily-briefing.test.mjs`, `tests/workspace-question-eval.test.mjs`,
  `tests/workspace-assistant.browser.test.mjs`, `package.json`.
- `docs/UNIFIED-FRONT-DESK.md`, `docs/CLINIC-QUERY-ENGINE.md`,
  `docs/AI-CLERK-INTEGRATION-HANDOFF.md`, `docs/CURRENT-HANDOFF.md`.

## Verification (local only)

- `npm run test:assistant:workspace` — 48 passed, including six new aggregate
  tests (Manila day edge, status/contact/stock rules, partial/unavailable/
  denial, hidden cap and size bound, no fabricated empty data) and the routing
  test showing briefings never defer to the model.
- `npm run test:assistant:briefing` — aggregate tests plus the two pinned
  Chromium browser tests. The browser proof asserts two briefing questions
  produce zero provider calls and two local briefing reads, while the real
  read-only clinic query and the reschedule draft/Review in Appointments flow
  continue to pass.
- `npm run test:assistant:clinic-query` 12, `npm run test:appointments` 23,
  `npm run test:assistant:phase3` 8, `npm run test:assistant:phase2b` 23 and
  `npm run test:workflows` 75 passed.
- `npx tsc --noEmit`, `npm run build` and `npm run build:staging` passed.
  Lint still reports one **pre-existing** React-memoization error at
  `app/page.tsx:298` (unrelated follow-up code); no new lint error was added.

## Limitations

- The local aggregator has no live Firestore emulator/browser read test in this
  change; the read helpers themselves are the existing verified server reads.
  The browser proof uses a local deterministic briefing callback, not a live
  clinic. A real signed-in staging smoke check was not performed.
- The bounded `dueAt` reads may miss a matching row that falls outside the
  first 50 documents; this is reported as partial, not as an all-clear.
- Stock expiry is shown only when the catalog records a valid Manila expiry
  date and the item is a stocked category (medicine/supplies).
- No hosted or production rollout, no rules/index changes, no live provider
  call and no account or record change were made.
