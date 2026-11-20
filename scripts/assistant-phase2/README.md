# VetCloudPro assistant Phase 2A lab

This CLI is not imported by the app or any Worker. It evaluates three paths
against the same **120 fictional fixtures**: the Phase 1 router, DeepSeek
single-plan routing, and bounded DeepSeek orchestration. A fourth,
deterministic composition reference tests whether common comparisons actually
need a model. It does not add any VetCloudPro features or access real data.

## Run locally

From the repository root, using the Node version in `.node-version`:

```sh
node --test tests/assistant-phase2.test.mjs tests/assistant-investigation.test.mjs
node scripts/assistant-phase2/evaluate.mjs
```

The default evaluator uses scripted interpretations to exercise the harness.
Its assisted-arm scores are **not** model-quality measurements.

An explicitly authorized live run uses `--live`. Supply a DeepSeek API key
through `VETCLOUD_DEEPSEEK_EVAL_KEY` (or an existing `DEEPSEEK_API_KEY`) in the
process environment; do not paste it into a command, fixture or report. The
runner only accepts the fixed fixture catalog and official DeepSeek endpoint.

```sh
node scripts/assistant-phase2/evaluate.mjs --live
```

The report is JSON with per-case status, call counts, latency, provider usage
and estimates. It contains no prompts, natural-language responses, receipt
identifiers, names or credentials. A live run may spend money; each invocation
has its own budget, so do not start an automatic rerun.

| Environment setting | Default |
| --- | ---: |
| `VETCLOUD_EVAL_MAX_USD` | `0.25` (cannot be raised) |
| `VETCLOUD_EVAL_CONCURRENCY` | `6` live, `1` scripted |
| `VETCLOUD_EVAL_MODEL_CALLS` | `3` per case, including retries |
| `VETCLOUD_EVAL_TOOL_CALLS` | `4` per case, including retries |
| `VETCLOUD_EVAL_DEADLINE_MS` | `15000` per case |
| `VETCLOUD_EVAL_TOKENS` | `4600` total per case |
| `VETCLOUD_EVAL_OUTPUT_TOKENS` | `210` per call |

## Lifecycle

1. Use `routeAssistantTool` from Phase 1; never spend tokens on a supported
   simple request. Private name lookups stay local.
2. If eligible, send a fixed fictional question and the one relevant JSON
   command schema to `deepseek-flash` (non-thinking). Never send history or
   ask it to generate the final answer.
3. Validate the returned command and all dates using the Phase 1 registry.
   Apply fictional clinic and role restrictions. The fixture's permitted
   date windows are an evaluation guard, not supplied to the model.
4. Read once per unique range; retry a classified transient error at most
   once. For an independent comparison, run both known reads together.
   For a conditional, stop if the first fact disproves the predicate or
   is incomplete. Request the next range only when the branch requires it.
5. Validate source shape, scope and coverage. The scorer checks the exact
   expected windows, counts and outcome, not the plausibility of a response.
   A correct denial or clarification is not a verified task completion.

The model-visible follow-up uses only a date range, verified count, and
coverage label rebuilt from trusted fictional evidence. Protected fields are
never masked after sending. The transport refuses unknown fixture IDs, private
cases, mismatched evidence and redirects. The lab does not import Firebase,
the production Worker, or existing clinic records.

Estimates reserve the peak rates from [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing.md)
before dispatch, including in-flight requests. The input reservation uses a
conservative UTF-8 byte estimate plus framing; output is limited at the API.
Metered usage reconciles the reservation, while unknown usage stays charged
at the reservation. Account spend and tokenizer behavior are not controlled
by this process; it reports any measured reservation overrun and stops sending.

See the [design and production blockers](../../docs/superpowers/specs/2026-11-20-assistant-orchestration-phase-2a-design.md).
The [live fictional benchmark](../../docs/ASSISTANT-PHASE-2A-BENCHMARK.md)
records the first comparison and recommendation.
