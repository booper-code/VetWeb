# VetCloudPro assistant orchestration — Phase 2A

## Goal and fit

Measure whether a small model improves interpretation and evidence-based completion enough to justify its cost. Phase 2A is a command-line prototype, not a new app route. `lib/assistant-tools.ts` already defines the deterministic router, strict tool contracts, and visibility. `workers/assistant-tools` remains the Phase 1 production authorization boundary. The new prototype imports the contracts but uses a fictional in-memory executor, not the Worker, Firebase, a clinic token, or browser state. No appointment, UI, shared data, or rule changes.

## Approaches to compare

1. **Current deterministic baseline:** unchanged router and local private name path. Where it cannot interpret a request, record clarification/unsupported rather than pretending it can. Also report a small deterministic composition reference on multi-step tasks, separately, to avoid crediting the model for arithmetic the app can do.
2. **DeepSeek planning:** deterministic fast path first; on eligible inventory requests, at most one accepted schema-validated plan. Run its approved independent reads together where possible, then let code verify and format the result. The plan may describe an allowlisted conditional read; the app evaluates the condition from evidence.
3. **DeepSeek bounded orchestration:** same deterministic fast path and provider, but it may request a next read based on minimal verified evidence. A successful programmatic verification ends the loop immediately. Compare this to the single-plan path, not just to the less capable original router.

Use existing import history for realistic comparisons between Manila date windows and conditional follow-ups such as “If this week had fewer than ten catalog items imported, check last week as well.” No extra tools for Phase 2A. Private name lookup stays deterministic and is exercised in safety cases; no meaningful model-assisted identity investigation is in scope. A future task requiring per-batch diagnostics would need a separate receipt-derived read tool with a privacy review.

## Execution and privacy

- The deterministic router gets the first choice. Only curated, known fictional inventory fixtures may reach the provider. The live adapter has no arbitrary-input CLI mode and no app import or hookup. No contacts, addresses, protected lab details, owner or patient names, record IDs, batch IDs, clinic IDs, Firebase tokens, or conversation history cross the model boundary. Tests capture outbound bodies and assert that private canaries and fixture metadata never cross. Private or mixed requests stay local or are declined.
- The provider proposes strict JSON actions, not SQL or final answers. The registry validates normalized date ranges and known tool IDs; the executor enforces role and fixture scope again. Validated evidence contains only date ranges, coverage and counts. Duplicate requests reuse request-local evidence; invalid actions stop; only classified transient failures can be retried, and attempts consume budget.
- Configurable per-request caps on model/tool attempts, deadlines, and prompt/output token reservations. Default experiment: `deepseek-flash` in non-thinking mode on official `api.deepseek.com`; at most three model attempts, four tool attempts, one transient retry per operation and 15 seconds per case. Reserve request tokens and maximum completion tokens before sending; reconcile with provider usage. A global estimated USD cap controls the live benchmark, reserving peak-price cost for every attempt and reporting unknown usage separately. No model choice is required in the UI.
- Render facts and arithmetic in code. A complete result must have all required authorized evidence, with source ranges and tracked-only or incomplete coverage labels. Permission denial, ambiguity, timeout, unavailable and incomplete evidence are distinct. No model-written answer or unsupported count is treated as success.
- Logs and reports contain fixture ID, experimental arm, status, elapsed time, counts, token usage, conservative estimated cost and coarse error codes only. Never log keys, raw prompts, responses, or tool data. No production telemetry or retention changes.

## Evaluation and decision

Use at least 100 known-answer fictional cases covering English, Tagalog, Taglish, relative dates, ambiguity, multi-step/conditional requests, permission and scope denials, transient and permanent failures, and injection. Score expected operations/ranges, authorization, coverage, and facts independently from model output; abstention is correct only when expected. Report accuracy and verified completion by category, failures and regressions by fixture ID, unnecessary tool attempts, model calls, latency, usage, estimated cost, and leaks. Keep offline fault-injection results distinct from actual DeepSeek measurements. Keep all arms on the same fixture set, and label the denominator for model-invoked cases.

Stay off in VetCloudPro unless live fictional results show useful quality gains over single-plan and deterministic composition with acceptable budget, latency, and zero observed privacy regressions. Hosted runtime verification, operating limits, credential handling, provider privacy review, and explicit rollout approval are production blockers.
