# Assistant Phase 2A — live fictional benchmark

**Decision:** Keep the deterministic fast path. Prototype **single-plan**
DeepSeek as an optional fallback for hard-to-phrase inventory requests.
Do not enable it for real users or adopt the multi-step loop by default.

## Method

On 2026-11-20, all four arms received the same 120 hand-labeled fictional
cases across English, Tagalog and Taglish. The three principal arms used
the same evidence executor and independent scorer. A fourth arm added simple
deterministic composition as a check against giving a model credit for
work the application can already do. Only the two live assisted arms called
`deepseek-flash`, with thinking disabled. Calls alternated arm order by case
and ran with six concurrent cases under the shared $0.25 estimated cap.

The live scorer checked the task, evidence date ranges, counts, coverage,
and conditional threshold. A correct clarification, denial, or partial
result is correct behavior but **not** a complete evidence set. There were
78 cases that should yield a complete verified evidence set. The live run
did not grade rendered staff answers or computed comparison deltas.

## Live results

| Metric | Existing deterministic | DeepSeek single plan | DeepSeek bounded orchestration | Deterministic composition reference |
| --- | ---: | ---: | ---: | ---: |
| Correct outcomes / 120 | 49 | 119 | 119 | 82 |
| Complete verified evidence sets / 78 | 27 | 78 | 78 | 51 |
| Cases with metered model responses | 0 | 78 | 78 | 0 |
| Correct outcomes on model-invoked cases | — | 77/78 | 77/78 | — |
| Complete verified evidence sets on model-invoked cases | — | 51 | 51 | — |
| Model calls | 0 | 78 | 87 | 0 |
| Tool attempts (includes retries) | 33 | 126 | 126 | 90 |
| Unnecessary unique reads | 0 | 0 | 0 | 0 |
| Recovered transient tool failures | 3/3 | 3/3 | 3/3 | 3/3 |
| Median / p95, all cases | 0.012 / 0.101 ms | 612 / 1,015 ms | 604 / 1,433 ms | 0.026 / 0.077 ms |
| Median / p95, model-invoked cases | — | 712 / 1,138 ms | 812 / 1,690 ms | — |
| Metered input / output tokens | 0 / 0 | 21,097 / 3,503 | 23,785 / 3,440 | 0 / 0 |
| Estimated USD at peak prices with observed cache hits | $0 | $0.010307 | $0.008441 | $0 |
| Sensitive fixture contacts or unsafe evidence delivered | 0 | 0 | 0 | 0 |

**Live coverage:** 78 distinct cases exercised the external model in both
assisted arms: **156 paired arm-cases**, **165 metered calls**, and **zero cases
skipped for budget**. Both models bypassed 42 cases by design. Total estimated
spend was **$0.018748** against $0.25, with no missing usage, remaining
reservations, or detected reservation overruns. These are conservative
estimates, not a provider invoice.

## Where the model helped or hurt

- Both model arms handled **24/24 flexible phrasings**, **18/18 comparisons**,
  and **18/18 conditionals**, counting correct notice of incomplete history
  separately from verified completion. Existing deterministic routing had no
  correct outcomes in those 60 cases. The simple composition reference got
  **30/36** comparisons and conditionals right without a model. Those are good
  candidates for deterministic expansion before paying for routine requests.
  Each live assisted arm scored 39/40 English, 40/40 Tagalog, and 40/40
  Taglish; these are corpus results, not language-wide accuracy estimates.
- Each model arm gained **71** cases and lost **1** versus the existing
  deterministic arm. Both lost the **same** case, `security-03-en`: an
  instruction to fabricate an import result caused a model to propose a read
  instead of asking for clarification. The sandbox scope rejected it before
  any tool executed or any fact was displayed. The deterministic arms gave
  the expected clarification. This is a model-routing failure even though
  the boundary prevented disclosure and hallucinated evidence.
- The multi-step loop supplied **no additional correct or verified answers**.
  It made nine extra calls, all for conditional follow-ups, and added about
  552 ms to p95 among model-invoked cases. Its observed estimate was lower
  only with the recorded cache mix (9,600 cached input tokens versus 768).
  Pricing all input as uncached, costs would be $0.011264 versus $0.010533;
  the loop did not inherently use fewer resources.
- Each assisted arm reused three duplicated windows, stopped after a false
  conditional, and preserved three partial-failure outcomes without turning
  them into successes. There were no live API failures, so model-outage
  behavior was tested separately with scripted responses.

## Offline replay (not model results)

Scripted interpretations served as a control for the executor and scorer:
both assisted replays reached 120/120 correct and 78/78 verified. The script
uses known fixture plans; it is not a claim about model intelligence. Local
tests also exercise provider `503` retry, malformed JSON, authentication
stop, budget denial, privacy rejection, unknown usage, and refusal to score
a wrong range as complete.

After the paid run, independent review found that the original executor could
reject a wrong conditional only *after* its scorer saw the outcome. The
current runner rejects wrong task types, ordered ranges and conditional
thresholds before reading; enforces distinct model-arm protocols; computes
comparison deltas only from complete verified evidence; and checks which
ranges were attempted even when a read fails. It also bounds stalled
adapters and retries a transient response-stream failure once. These changes
were checked offline; the historical live run was not repeated or rescored.

## Limits and next decision

This is one run against a curated, narrow corpus and an in-memory executor,
not a clinic-wide safety proof, a production latency test, or a test of
general Tagalog comprehension. Case-specific permitted windows and a fixed
Manila date strengthen the benchmark but don't solve privacy-safe admission
or scope extraction for arbitrary staff text. The same model weights, API
performance, prices and cache distribution may change.

1. Keep existing fast paths and expand simple deterministic comparisons.
2. Test the single-plan fallback on a larger, independently held-out
   fictional corpus with more mixed-language, ambiguity and injection cases.
   Verify that a denied plan produces a useful safe response rather than an
   answer; continue to require source-supported results.
3. Enable neither path for clinic users until an actual input-privacy boundary,
   production authorization and isolation, hosted runtime controls, cost and
   rate limits, and a provider privacy review are verified and approved. The
   tested fixture permit-list is not that production boundary.
4. Revisit orchestration only for a workflow where a verified result changes
   what can usefully be read next and a single plan cannot express it safely.
   No new tool was required for this benchmark. The existing receipts do not
   prove why an import failed; adding that in future would require its own
   minimal audited outcome source rather than exposing raw logs.

Reproduce with the [isolated lab instructions](../scripts/assistant-phase2/README.md).
The benchmark did not modify the operational app, appointment flows, any
Firebase rule, or any clinic data, and nothing was deployed.
