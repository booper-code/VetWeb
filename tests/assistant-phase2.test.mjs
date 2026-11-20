import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases, fixture } from '../scripts/assistant-phase2/fixtures.mjs';
import { runCase } from '../scripts/assistant-phase2/orchestrator.mjs';
import { evaluateCase, runEvaluation, scriptedProvider } from '../scripts/assistant-phase2/evaluate.mjs';
import { createDeepSeekProvider, createSpendLedger } from '../scripts/assistant-phase2/deepseek.mjs';

test('a closed fictional catalog has 100+ distinct requests and independent expected comparisons', () => {
  assert.ok(cases.length >= 100);
  assert.equal(new Set(cases.map(row => row.id)).size, cases.length);
  assert.equal(new Set(cases.map(row => row.prompt)).size, cases.length);
  for (const language of ['en', 'tl', 'mix']) assert.ok(cases.filter(row => row.language === language).length >= 25);
  assert.deepEqual(fixture('compare-01-en').expected.counts, [8, 16]);
  assert.throws(() => fixture('not in the corpus'));
});

test('the fast path never calls the model, and conditional reads stop when evidence suffices', async () => {
  const mustNotCall = { call() { assert.fail('unexpected model call'); } };
  const fast = await runCase('fast-01-en', 'orchestrated', mustNotCall);
  assert.equal(fast.metrics.modelCalls, 0);
  assert.equal(fast.metrics.toolCalls, 1);
  assert.equal(evaluateCase('fast-01-en', fast).complete, true);
  const falseBranch = await runCase('conditional-02-en', 'orchestrated', scriptedProvider());
  assert.equal(falseBranch.metrics.modelCalls, 1);
  assert.equal(falseBranch.metrics.toolCalls, 1);
  assert.equal(evaluateCase('conditional-02-en', falseBranch).complete, true);
  const trueBranch = await runCase('conditional-01-en', 'orchestrated', scriptedProvider());
  assert.equal(trueBranch.metrics.modelCalls, 2);
  assert.equal(trueBranch.metrics.toolCalls, 2);
  assert.equal(evaluateCase('conditional-01-en', trueBranch).complete, true);
});

test('one-shot non-independent conditional read is gated and duplicate ranges reuse evidence', async () => {
  const result = await runCase('conditional-02-en', 'planning', scriptedProvider());
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.metrics.modelCalls, 1);
  const duplicate = await runCase('compare-06-en', 'planning', scriptedProvider());
  assert.equal(duplicate.metrics.toolCalls, 1);
  assert.equal(duplicate.metrics.deduplicated, 1);
  assert.equal(evaluateCase('compare-06-en', duplicate).complete, true);
});

test('private and denied cases never enter model context; retry does not make partial evidence a success', async () => {
  const mustNotCall = { call() { assert.fail('outbound private request'); } };
  for (const id of ['private-01-en', 'security-01-en', 'security-02-en']) {
    assert.equal(evaluateCase(id, await runCase(id, 'orchestrated', mustNotCall)).correct, true, id);
  }
  const transient = await runCase('recovery-01-en', 'planning', scriptedProvider());
  assert.equal(transient.metrics.toolRetries, 1);
  assert.equal(evaluateCase('recovery-01-en', transient).complete, true);
  const partial = await runCase('recovery-03-en', 'orchestrated', scriptedProvider());
  assert.equal(partial.status, 'partial');
  assert.equal(evaluateCase('recovery-03-en', partial).complete, false);
  assert.equal(evaluateCase('recovery-03-en', partial).correct, true);
});

test('registry and verifier reject unsupported operations, wrong windows, and wrong evidence', async () => {
  const model = command => ({ call: async () => ({ command, sent: true }) });
  const rejected = await runCase('flex-01-en', 'planning', model({ kind: 'tool', tool: 'find_person_by_name', name: 'Secret' }));
  assert.equal(rejected.status, 'invalid-model');
  assert.equal(rejected.metrics.toolCalls, 0);
  const wrong = await runCase('flex-01-en', 'planning', model({
    kind: 'plan', task: 'count', tool: 'inventory_import_history', first: { from: '2026-11-15', through: '2026-11-15' },
  }));
  assert.equal(evaluateCase('flex-01-en', wrong).complete, false);
  assert.equal(evaluateCase('flex-01-en', wrong).correct, false);
  const budget = await runCase('conditional-01-en', 'orchestrated', scriptedProvider(), { maxModelCalls: 1 });
  assert.equal(budget.status, 'budget');
  assert.equal(budget.metrics.toolCalls, 1);
});

test('a model cannot turn a conditional into an unconditional read or change the predicate', async () => {
  const { task } = fixture('conditional-02-en');
  const plan = { kind: 'plan', tool: 'inventory_import_history', first: task.first, second: task.second };
  for (const command of [{ ...plan, task: 'compare' }, { ...plan, task: 'conditional', threshold: 10 }]) {
    const outcome = await runCase('conditional-02-en', 'planning', { call: async () => ({ command, sent: true }) });
    assert.equal(outcome.status, 'invalid-scope');
    assert.equal(outcome.metrics.toolCalls, 0);
  }
});

test('arm protocols are enforced and the comparison uses code-computed arithmetic', async () => {
  const { task } = fixture('compare-01-en');
  const planned = { kind: 'plan', tool: 'inventory_import_history', task: 'compare', first: task.first };
  const cannotDefer = await runCase('compare-01-en', 'orchestrated', { call: async () => ({ command: planned, sent: true }) });
  assert.equal(cannotDefer.status, 'invalid-model');
  assert.equal(cannotDefer.metrics.toolCalls, 0);
  const conditional = fixture('conditional-01-en').task;
  const cannotProvideSecond = await runCase('conditional-01-en', 'orchestrated', { call: async () => ({
    command: { ...planned, task: 'conditional', first: conditional.first, second: conditional.second, threshold: conditional.threshold }, sent: true,
  }) });
  assert.equal(cannotProvideSecond.status, 'invalid-model');
  assert.equal(cannotProvideSecond.metrics.toolCalls, 0);
  const comparison = await runCase('compare-01-en', 'planning', scriptedProvider());
  assert.deepEqual(comparison.comparison, { delta: -8, relation: 'lower' });
  assert.equal(evaluateCase('compare-01-en', { ...comparison, comparison: null }).complete, false);
  const partial = await runCase('recovery-03-en', 'planning', scriptedProvider());
  assert.equal(partial.comparison, null);
  assert.equal(evaluateCase('recovery-03-en', { ...partial, attemptedRanges: [...partial.attemptedRanges].reverse() }).correct, false);
});

test('conservative reservations are shared, retain unknown charges, and stop on overrun', () => {
  const ledger = createSpendLedger(0.001);
  const a = ledger.reserve(1000, 200);
  assert.ok(a);
  assert.equal(ledger.reserve(1000, 200), null);
  assert.equal(a.settle(null), 540000);
  assert.equal(ledger.snapshot().unknownNanodollars, 540000);
  const b = ledger.reserve(100, 10);
  assert.ok(b);
  b.settle({ input: 200, output: 10, cached: 0 });
  assert.equal(ledger.snapshot().overrun, true);
  assert.equal(ledger.reserve(1, 1), null);
});

test('DeepSeek sends only approved fixture input and projected evidence to the fixed endpoint', async () => {
  const captured = [];
  const provider = createDeepSeekProvider({
    key: 'not-a-real-token', ledger: createSpendLedger(), fetcher: async (url, init) => {
      captured.push({ url, init });
      return Response.json({ model: 'deepseek-flash',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ kind: 'clarify' }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 9, prompt_cache_hit_tokens: 25 },
      });
    },
  });
  const limit = { arm: 'orchestrated', remainingTokens: 5000, maxOutput: 200, signal: new AbortController().signal };
  assert.equal((await provider.call({ ...limit, id: 'private-01-en', phase: 'plan' })).sent, false);
  assert.equal((await provider.call({ ...limit, id: 'compare-01-en', phase: 'followup',
    evidence: { from: '2026-11-16', through: '2026-11-20', count: 8, coverage: 'tracked-only', ownerName: 'Do not send' },
  })).sent, false);
  const response = await provider.call({ ...limit, id: 'compare-01-en', phase: 'followup',
    evidence: { from: '2026-11-16', through: '2026-11-20', count: 8, coverage: 'tracked-only' },
  });
  assert.equal(response.sent, true);
  assert.equal(response.nanodollars, 33450);
  assert.equal(captured.length, 1);
  const [{ url, init }] = captured;
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(init.redirect, 'error');
  assert.doesNotMatch(init.body, /not-a-real-token|Do not send|Alex Example|fictional-clinic|batchId|fixtureId/i);
  assert.deepEqual(JSON.parse(init.body).thinking, { type: 'disabled' });
});

test('the same cases and scoring apply to all arms; a scripted replay cannot be labelled live', async () => {
  await assert.rejects(runEvaluation({ mode: 'live' }), /Invalid benchmark/);
  const report = await runEvaluation();
  const ids = arm => report.results.filter(row => row.arm === arm).map(row => row.id);
  assert.deepEqual(ids('planning'), ids('deterministic'));
  assert.deepEqual(ids('orchestrated'), ids('deterministic'));
  assert.equal(report.arms.planning.modelAttemptedCases, report.arms.planning.modelEligibleCases);
  assert.equal(report.arms.orchestrated.unsafeEvidence, 0);
  assert.equal(report.arms.orchestrated.privateModelContact, 0);
  assert.doesNotMatch(JSON.stringify(report), /example\.com|Alex Example|CANARY|fixtureId|patientName/i);
});

test('transient provider errors retry once, but auth and corrupt output stop with reserved usage', async () => {
  const ledger = createSpendLedger();
  let attempts = 0;
  const provider = createDeepSeekProvider({ key: 'fixture-secret', ledger, fetcher: async () => {
    attempts += 1;
    if (attempts === 1) return Response.json({ credential: 'fixture-secret' }, { status: 503 });
    return Response.json({ choices: [{ message: { content: '{not JSON' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 9 } });
  } });
  const failure = await runCase('flex-01-en', 'planning', provider);
  assert.equal(failure.status, 'invalid-model');
  assert.equal(attempts, 2);
  assert.equal(failure.metrics.modelRetries, 1);
  assert.equal(failure.metrics.unknownUsage, 1);
  assert.equal(failure.metrics.toolCalls, 0);
  assert.ok(ledger.snapshot().unknownNanodollars > 0);
  const auth = createDeepSeekProvider({ key: 'fixture-secret', ledger, fetcher: async () => {
    attempts += 1;
    return new Response(null, { status: 401 });
  } });
  assert.equal((await runCase('flex-01-en', 'planning', auth)).detail, 'auth');
  assert.equal((await runCase('flex-02-en', 'planning', auth)).detail, 'auth');
  assert.equal(attempts, 3);
});

test('the deadline bounds a stalled adapter and a failed response stream can be retried', async () => {
  const stall = { call: () => new Promise(() => {}) };
  const timed = await runCase('flex-01-en', 'planning', stall, { maxMs: 15 });
  assert.equal(timed.status, 'timeout');
  const timedLedger = createSpendLedger();
  const stalledFetch = createDeepSeekProvider({ key: 'fictional', ledger: timedLedger, fetcher: () => new Promise(() => {}) });
  const timedRequest = await runCase('flex-01-en', 'planning', stalledFetch, { maxMs: 15 });
  assert.equal(timedRequest.status, 'timeout');
  assert.equal(timedRequest.metrics.modelCalls, 1);
  assert.equal(timedRequest.metrics.unknownUsage, 1);
  assert.equal(timedRequest.metrics.nanodollars, timedLedger.snapshot().unknownNanodollars);
  assert.equal(timedLedger.snapshot().inFlightNanodollars, 0);
  const ledger = createSpendLedger();
  let requests = 0;
  const provider = createDeepSeekProvider({ key: 'fictional', ledger, fetcher: async () => {
    if (++requests === 1) {
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('synthetic reset')); } }));
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"kind":"clarify"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 9 } });
  } });
  const recovered = await runCase('flex-01-en', 'planning', provider);
  assert.equal(recovered.status, 'clarify');
  assert.equal(recovered.metrics.modelRetries, 1);
  assert.equal(recovered.metrics.unknownUsage, 1);
  assert.ok(ledger.snapshot().unknownNanodollars > 0);
});
