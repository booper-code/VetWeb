# Assistant Phase 2B — offline result

**Decision: keep scope extraction and execution deterministic. Do not enable
the model fallback in the app.** The offline prototype is complete. No Phase 3
was defined at the time of these results; a separate
[fictional confirmation rehearsal](ASSISTANT-PHASE-3.md) has since started.

## What ran

57 independently authored and labeled fictional cases (22 English, 19 Tagalog,
16 Taglish). All arms used the same gold labels and a selected fictional **CSV
catalog import history** context. This context is why “receipts” can be
understood as imports in this trial; an unscoped request for “receipts” gets
clarification, not an inventory or payment lookup. Dates use Manila calendar
days and include December, January, and UTC-midnight boundaries. Answers are
rendered in English; this measures multilingual input, not multilingual output.

| Measure | Narrow deterministic | Scripted single plan | Local scope, no planner |
| --- | ---: | ---: | ---: |
| Correct evidence **and** rendered reply / 57 | 37 | 56 | 56 |
| Complete verified answers / 28 possible | 16 | 27 | 27 |
| Offline planner calls | 0 | 19 | 0 |
| Observed unsafe evidence, inappropriate planner dispatches, or unnecessary unique reads | 0 | 0 | 0 |

The scripted arm gained 19 cases and lost none against the narrower grammar.
It gained **zero** over directly using the scope the gate already resolved and
made the same tool reads. The one shared miss was a comparison that gave
December without a year and January with an explicit year. The gold label
expected the prior December, but the implementation asks for clarification
rather than guessing across that year boundary. The original label remains.

The planner receives closed wording tokens, ordered date windows, and a
conditional threshold when applicable. It cannot rewrite those constraints.
Role and scope changes, unverifiable history, malformed reads, retry, and
timeout are exercised locally. The scorer checks attempted windows and rendered
counts, coverage, comparison delta, and conditional/abstention wording.
Expectations are not available to the caller's execution or the simulated planner.

These are **offline protocol results, not DeepSeek accuracy or latency**. No
tokens were billed, no live provider contacted, and no model cost or cache
measurements exist for Phase 2B. The grammar was refined during offline
integration without changing the holdout prompts or labels. Treat this as
conformance evidence, not an unbiased language-accuracy estimate. The lab
does not establish real-clinic privacy or production readiness. The app, its
appointment flows, Workers and Firebase rules were not changed.

## Reproduce

```sh
npm run test:assistant:phase2b
npm run --silent eval:assistant:phase2b
```

The report emits counts, case IDs, categorical outcomes and local timings,
not prompts, staff answers or receipt data. `--live` is not available. A
future paid fictional comparison would need a revised design with a
demonstrable benefit over deterministic scope extraction and explicit approval.

See [the design](superpowers/specs/2026-11-21-assistant-phase-2b-design.md)
and [Phase 2A's historical results](ASSISTANT-PHASE-2A-BENCHMARK.md).
