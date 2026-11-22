# Assistant Phase 2B — offline holdout and single-plan fallback

## Scope

This is a separate fictional inventory lab. It must not import Firebase, a hosted
adapter, clinic state, or any Assistant UI, and the app and Workers must not
import it. No live flag, credentials, patient lookup, write tools, or deployment.
Phase 2A remains a historical benchmark; the new holdout is independently
authored and its labels do not change to match the interpreter.

Every holdout case starts from an explicitly selected **fictional CSV catalog
import history** view. It can use “receipts” or an omitted subject in that
context; the general parser does not infer CSV intent from “receipts” alone.
Selection is lab-only metadata, not a new app control or a provider argument.

## Three arms

1. **Deterministic:** explicit count, compare, and conditional requests first,
   using Manila calendar math for the requested instant. Unrecognized language
   asks a useful question rather than guessing.
2. **Single plan:** same fast path; a recognized, unambiguous paraphrase can
   reach one injected offline planner. The planner sees only a closed semantic
   representation drawn from locally recognized wording, two maximum ordered
   windows, and (for a conditional) its exact threshold. There is no raw text,
   patient or account identifier, case ID, receipt or prior turn in the dispatch.
   No grammar match, private/mixed text, ambiguous input, or missing access
   means no planner dispatch. A response is a proposal, never the answer.
3. **Local envelope:** simply executes a verified local scope even for an
   eligible paraphrase. This deliberately measures whether the fallback adds
   anything once local scope extraction can already recover the plan.

This favors caution over language recall. The scope gate must independently
know the exact task, ordered ranges and threshold; it does not use answer keys
or infer consent from the planner. At this trust boundary a model may be
redundant. Report that result rather than presenting improvement over a narrower
router as an improvement over all local code.

## Acceptance

- Validate only count, compare and `first count < threshold` plans for the
  existing read-only inventory registry. Reject extra fields, reordered or
  widened scope and changed role before a read; recheck access before returning
  evidence. Do not return private or unverified facts on errors.
- Evaluate conditions and deltas from verified counts in code. Unknown history
  is not zero. No delta with partial/incomplete coverage; at a threshold tie,
  do not read the second range. Deduplicate same-window reads and permit one
  classified transient read retry within bounded attempts and a shared deadline.
- Grade exact ordered facts and attempted ranges, coverage, branches and
  abstention, plus the rendered staff answer. Keep verified completion
  separate from correct abstention. Report paired gains/losses, unexpected
  reads, planner attempts/latencies and unknown usage without emitting prompts,
  private values or raw answers. Scripted results have no observed provider
  tokens, cache behavior or costs.
- Test multilingual requests, Manila midnight and cross-year dates, mixed and
  injected prompts, scope/role changes, threshold boundaries, incomplete and
  malformed upstream evidence, transient faults, and a stalled planner. Keep
  the appointment fast path unchanged.

No Phase 3 is defined in the active handoff. A paid fictional model comparison
or a proposal/confirmation execution design is a separate approval decision,
not a deliverable of this offline lab.
