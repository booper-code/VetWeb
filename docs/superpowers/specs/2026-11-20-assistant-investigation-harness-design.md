# VetWeb Assistant: read-only investigation harness

## Goal

Let the assistant look up evidence with small, permission-checked tools and link staff to what it found. Start with recent CSV inventory imports and name-only person lookup. Keep the existing appointment flows unchanged.

## Fit with VetCloudPro

- `app/page.tsx` currently manages the active clinic, Firebase session, AI switch, and appointment handoff. `WorkspaceAssistant.tsx` presents the existing synchronous appointment and navigation path. Keep that path intact; only the two new intents call the read harness.
- Next.js can export a static site (`next.config.ts` and `scripts/build-static.mjs`), so runtime authorization cannot live in a Next route that disappears in the export. Add a small standalone Worker, consistent with `workers/image-service`, configured independently and **off by default**. The Worker uses the caller's Firebase ID token, not a service account. Firestore validates that token and enforces read rules; the Worker additionally checks canonical membership, role and the AI switch, and constructs all database paths and queries itself.
- Use Firestore REST field projection as the dedicated **name-only read path**. No index backfill or change to patient writes: the fixed query accepts an exact recorded owner name and projects only `ownerName` and `name`. Full patient search already exists but is not an assistant dependency. Revalidate access before opening a result through the existing normal record view.
- CSV rows already use `lib/clinical-mutations.ts`. Extend only opt-in inventory creates with a minimal receipt in the existing audited transaction. Keep old clients/ordinary manual creates valid and do not relabel older audit events. Firebase rules make receipts immutable and require a matching audited create. Receipts attest to app-tracked imports; an authorized editor who deliberately builds their own write client can misclassify their own inventory create. No assistant action can write a receipt.

## Approaches

- **Recommended: typed tools with local routing.** VetWeb selects from a short list of known operations, checks access, and returns structured results. This supports exact questions without a model call and gives a baseline for evaluating one later.
- **Model-led routing:** Use the same tools but let a model interpret more flexible requests. Defer until accuracy, latency, cost, and privacy can be compared with the baseline on fictional cases.
- **Unrestricted search over clinic records:** Not in scope. Hiding fields in the popup would not stop the assistant from reading them.

## First slice

1. **Recent CSV imports.** Count distinct catalog rows successfully created by the CSV importer, not quantities or manually created items. Record a minimal, server-timestamped receipt in the same transaction as each successful create, grouped by an import ID, so partial imports count only committed rows. No raw CSV, item descriptions, or contact details in receipts. Use explicit dates or a labeled seven-day Manila default. Say when the requested period predates reliable tracking; don't guess from old audit events. Link to permission-checked import history. Start with Owner access for history; do not grant callers access to the clinical audit log.
2. **Name-only lookup.** Use the fixed projected query with clinic-scoped record references. Don't reuse a search path that fetches full patient documents and strips fields afterward. The assistant never reads phone, email, address, clinical notes, billing, or payroll. Return at most five matches, without guessing or automatically opening a record. A click opens the normal patient view, where VetWeb rechecks clinic and record access; the assistant does not receive the contact view's contents. Names and references are sensitive and remain UI-only, not model context.

## Guardrails and verification

- Recheck the current user, active clinic, role, and AI switch before lookups and link handoff. Discard results on scope change. Fail closed on missing or stale authorization and distinguish unavailable from zero results.
- Small typed requests and bounded responses; one lookup per supported question. Use source timestamps and app/database counts, not generated numbers. No assistant writes, provider calls, general document reads, or live deployment.
- Test with fictional records: partial imports, retry/duplicates, historical coverage and Manila boundaries, duplicate names, cross-clinic and role denial, stale replies, and contact-field exclusion at the data boundary. Record answer accuracy, tool-call count, and latency before claiming a model improves anything.

The import tool uses a bounded Manila calendar range (maximum 31 days) and server-derived count plus a ten-row recent receipt preview. Results label the coverage as tracked only, even when zero, because older or other app versions may not have tracked the same period. The app's importer writes receipts through normal staff-authorized saves; the assistant only reads them. Receipt writes are guarded by a separate explicit build setting to permit a coordinated rollout, independently of existing imports and the AI switch.

## Later: hybrid orchestration and proposals

Deterministic interpreter → typed tool executor → result validation/evidence → UI formatter is the fast path. In the later path a modular DeepSeek adapter will receive only approved schemas and sanitized task context, return structured tool names/arguments, and share the same executor. The provider will not receive Firebase credentials, raw user text that may contain private fields, names, record references, contacts, addresses, protected lab details, or history containing those fields. Keep people lookups in the private fast path; any later name-containing language request must be reduced to safe local arguments before model routing or stay local.

The coordinator will enforce a request deadline, total/per-tool budgets, deduplicate normalized calls within the same actor/clinic/request, retry only classified transient reads within budget, and terminate on success, ambiguity, disallowed requests, or exhausted resources. Tool results are untrusted until their shape, source, scope, and freshness are checked. Never append database rows or raw prompts to logs; retain tool name, status, duration and counts only as needed.

Future write path: interpretation → authorized reads → structured proposal with locked target, actor, clinic and expected revision → business-rule validation → staff preview and explicit approval → allowlisted audited transaction → verification. Bind a one-use idempotency key to the approved payload, do not blindly retry a write if the commit outcome is unknown, and reconcile partial operations before any retry. No write capability is registered in Phase 1.

Fictional evaluations cover expected answers and completion, correct/minimal tool selection, latency, tokens and cost when a model exists, denials/leaks, false claims, failure/timeout recovery, ambiguous English/Tagalog/Taglish, and attempts to smuggle instructions in text or tool results. Phase 1 measures the deterministic baseline only; later compare against DeepSeek on the same fixtures and gate rollout on regressions.
