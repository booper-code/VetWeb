# Booper Stress Regressions Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution and track progress below.

**Goal:** Make the Booper Assistant meet the existing question bank’s pass conditions without changing its clinic data or saved provider.

**Architecture:** Keep bounded, role-checked local execution. Normalize known domain terms, use the app’s existing stock rules for stock-specific calculations, and preserve supported clauses when another clause is unavailable. Prefer enforceable read semantics over prompt-only fixes.

**Tech stack:** TypeScript, existing Node test runner, Booper staging browser.

**Spec:** [Question bank and acceptance rules](../../WORKSPACE-ASSISTANT-STRESS-QUESTIONS.md).

## Global constraints

No clinic writes, permission changes, provider changes, or raw result exports. Use one live tester, observe the submission spacing and stop on quota warnings.

## Review focus

Unknown species must not disappear; stock units must exclude non-stock services; threshold checks must use each row’s configured threshold; contact details must remain unavailable; follow-up filters must not affect unrelated results.

## Execution

- [x] Add a failing dog/canine fixture test in `tests/clinic-query.test.mjs`; normalize species predicates in `lib/clinic-query.ts`; rerun the suite.
- [x] Add failing fixture coverage for stock sums and reorder eligibility. Reuse normal Inventory rules in the query engine and teach the planner the exact fields for those requests.
- [x] Add failing tests for mixed supported/unsupported requests and multi-clause follow-up scope. Preserve safe results and explicit limitations without increasing read permissions.
- [x] Run the assistant suites and TypeScript. Run the remaining live bank with the established Hy4 Flash (High) tester; document each turn and loop on failures.

Automated verification after the final boundary wording fix: 52 clinic-query checks and 49 workspace checks passed; `npx tsc --noEmit` passed.

All 48 live cases met their acceptance criteria across measured passes, including the final live recheck of B03 and S05. See the [results log](../../WORKSPACE-ASSISTANT-STRESS-RESULTS.md#boundary-recheck--2026-11-22-s05-b03).
