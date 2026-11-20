import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { routeAssistantTool } from '../../lib/assistant-tools.ts';
import { cases, fixture, NOW, rangeKey } from './fixtures.mjs';
import { runCase } from './orchestrator.mjs';
import { createDeepSeekProvider, createSpendLedger, liveModel } from './deepseek.mjs';

const tool = 'inventory_import_history';
const equal = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

export function evaluateCase(id, outcome) {
  const row = fixture(id);
  const target = row.expected;
  const grounded = equal(outcome.evidence.map(rangeKey), target.ranges) &&
    equal(outcome.evidence.map(value => value.count), target.counts) &&
    equal(outcome.evidence.map(value => value.coverage), target.coverage) &&
    outcome.personCount === target.personCount;
  const hasTask = ['verified', 'partial', 'incomplete', 'unavailable'].includes(target.status);
  const delta = target.comparisonDelta;
  const comparisonMatches = delta === null ? outcome.comparison === null : outcome.comparison?.delta === delta &&
    outcome.comparison?.relation === (delta === 0 ? 'equal' : delta > 0 ? 'higher' : 'lower');
  const correct = outcome.status === target.status && grounded &&
    comparisonMatches && equal(outcome.attemptedRanges, target.attemptedRanges) &&
    (!hasTask || outcome.task === target.task) &&
    (target.task !== 'conditional' || !hasTask || row.task.threshold === outcome.conditionalThreshold);
  return {
    correct, complete: correct && target.status === 'verified',
    expectedStatus: target.status,
    unsafeEvidence: row.denyLeak && (outcome.evidence.length > 0 || outcome.personCount !== null),
    privateModelContact: !row.modelPrompt && outcome.metrics.modelCalls > 0,
    unnecessaryToolCalls: Math.max(0, outcome.uniqueReads - target.minUniqueReads),
    recovered: outcome.metrics.toolRetries > 0 && correct && target.status === 'verified',
  };
}

/** Scripted replay exercises the control plane, never measures model ability. */
export function scriptedProvider() {
  return {
    mode: 'scripted',
    async call({ id, phase, arm }) {
      const row = fixture(id);
      if (!row.modelPrompt) return { sent: false, error: 'privacy' };
      if (!row.task) return { sent: true, command: { kind: 'clarify' } };
      if (phase === 'followup') return { sent: true, command: { kind: 'followup', tool, range: row.task.second } };
      const { type: task, first, second, threshold } = row.task;
      return { sent: true, command: { kind: 'plan', tool, task, first,
        ...(task === 'conditional' && { threshold }),
        ...(second && (arm === 'planning' || task === 'compare') && { second }),
      } };
    },
  };
}

const sum = (rows, property) => rows.reduce((total, row) => total + (row[property] ?? 0), 0);
const tally = (rows, property) => rows.filter(row => row[property]).length;
const round = value => Number(value.toFixed(3));
function quantile(rows, fraction) {
  if (!rows.length) return null;
  const sorted = rows.map(row => row.latencyMs).sort((a, b) => a - b);
  return round(sorted[Math.ceil(sorted.length * fraction) - 1]);
}
const counts = (rows, key) => Object.fromEntries([...new Set(rows.map(row => row[key]))].map(value => [
  value, rows.filter(row => row[key] === value).length,
]));

function summarize(rows, arm, mode) {
  const attempted = rows.filter(row => row.modelCalls > 0);
  const eligible = rows.filter(row => row.modelEligible);
  const report = {
    cases: rows.length, correct: tally(rows, 'correct'), verifiedComplete: tally(rows, 'complete'),
    completableCases: rows.filter(row => row.expectedStatus === 'verified').length,
    unsafeEvidence: tally(rows, 'unsafeEvidence'), privateModelContact: tally(rows, 'privateModelContact'),
    toolCalls: sum(rows, 'toolCalls'), unnecessaryToolCalls: sum(rows, 'unnecessaryToolCalls'),
    modelCalls: sum(rows, 'modelCalls'), modelEligibleCases: eligible.length, modelAttemptedCases: attempted.length,
    modelMeteredCases: mode === 'live' ? attempted.filter(row => row.modelCalls > row.unknownUsage).length : null,
    modelCasesCorrect: tally(attempted, 'correct'), modelCasesVerifiedComplete: tally(attempted, 'complete'),
    modelRetries: sum(rows, 'modelRetries'), toolRetries: sum(rows, 'toolRetries'), recovered: tally(rows, 'recovered'),
    blockedTools: sum(rows, 'blockedTools'), providerErrors: sum(rows, 'providerErrors'), toolErrors: sum(rows, 'toolErrors'),
    knownInputTokens: sum(rows, 'inputTokens'), knownOutputTokens: sum(rows, 'outputTokens'),
    cachedTokens: sum(rows, 'cachedTokens'), unknownUsageCalls: sum(rows, 'unknownUsage'),
    estimatedPeakUsd: sum(rows, 'nanodollars') / 1e9,
    unknownUsageReserveUsd: sum(rows, 'reservedUnknownNanodollars') / 1e9,
    medianMs: quantile(rows, .5), p95Ms: quantile(rows, .95), modelMedianMs: quantile(attempted, .5), modelP95Ms: quantile(attempted, .95),
    statusCounts: counts(rows, 'status'), details: counts(rows.filter(row => row.detail), 'detail'),
    categories: Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => {
      const group = rows.filter(row => row.category === category);
      return [category, { cases: group.length, correct: tally(group, 'correct'), complete: tally(group, 'complete') }];
    })),
  };
  if (arm === 'deterministic' || arm === 'composition') report.modelEligibleCases = 0;
  return report;
}

function metricRow(id, arm, result) {
  const row = fixture(id);
  return { id, arm, category: row.category, language: row.language,
    modelEligible: !!row.modelPrompt && routeAssistantTool(row.prompt, NOW).kind !== 'tool',
    status: result.status, detail: result.detail, ...evaluateCase(id, result),
    ...result.metrics, latencyMs: round(result.metrics.latencyMs),
  };
}

export async function runEvaluation({ mode = 'scripted', provider = scriptedProvider(), concurrency = 1, limits } = {}) {
  if (!['live', 'scripted'].includes(mode) || provider.mode !== mode ||
    !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('Invalid benchmark mode or concurrency');
  }
  const arms = ['deterministic', 'planning', 'orchestrated', 'composition'];
  const result = {};
  for (const arm of ['deterministic', 'composition']) {
    result[arm] = [];
    for (const row of cases) result[arm].push(metricRow(row.id, arm, await runCase(row.id, arm, undefined, limits)));
  }
  const queue = cases.flatMap((row, index) => (index % 2 ? ['orchestrated', 'planning'] : ['planning', 'orchestrated'])
    .map(arm => ({ id: row.id, arm })));
  const paired = Array(queue.length);
  let index = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < queue.length) {
      const i = index++;
      const { id, arm } = queue[i];
      paired[i] = metricRow(id, arm, await runCase(id, arm, provider, limits));
    }
  }));
  for (const arm of ['planning', 'orchestrated']) result[arm] = paired.filter(row => row.arm === arm);
  const comparison = (left, right) => ({
    gains: result[left].filter((row, i) => row.correct && !result[right][i].correct).map(row => row.id),
    losses: result[left].filter((row, i) => !row.correct && result[right][i].correct).map(row => row.id),
  });
  return {
    mode, model: mode === 'live' ? liveModel : 'scripted replay (not DeepSeek)', cases: cases.length, concurrency,
    arms: Object.fromEntries(arms.map(arm => [arm, summarize(result[arm], arm, mode)])),
    comparisons: { planningVsDeterministic: comparison('planning', 'deterministic'),
      orchestrationVsDeterministic: comparison('orchestrated', 'deterministic'),
      orchestrationVsPlanning: comparison('orchestrated', 'planning'),
      planningVsComposition: comparison('planning', 'composition') },
    results: arms.flatMap(arm => result[arm]),
  };
}

const setting = (key, fallback) => process.env[key] === undefined ? fallback : Number(process.env[key]);
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--live')) throw new Error('Usage: node scripts/assistant-phase2/evaluate.mjs [--live]');
  const mode = args.length ? 'live' : 'scripted';
  const limits = Object.fromEntries([
    ['maxModelCalls', 'VETCLOUD_EVAL_MODEL_CALLS'], ['maxToolCalls', 'VETCLOUD_EVAL_TOOL_CALLS'],
    ['maxMs', 'VETCLOUD_EVAL_DEADLINE_MS'], ['maxTokens', 'VETCLOUD_EVAL_TOKENS'],
    ['maxOutput', 'VETCLOUD_EVAL_OUTPUT_TOKENS'],
  ].filter(([, key]) => process.env[key] !== undefined).map(([property, key]) => [property, Number(process.env[key])]));
  const ledger = mode === 'live' ? createSpendLedger(setting('VETCLOUD_EVAL_MAX_USD', .25)) : null;
  let provider;
  if (ledger) provider = createDeepSeekProvider({
    key: process.env.VETCLOUD_DEEPSEEK_EVAL_KEY ?? process.env.DEEPSEEK_API_KEY, ledger,
  });
  const report = await runEvaluation({ mode, provider, concurrency: setting('VETCLOUD_EVAL_CONCURRENCY', mode === 'live' ? 6 : 1), limits });
  console.log(JSON.stringify({ ...report, spend: ledger?.snapshot() ?? null }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Deliberately omit arbitrary exception text; a provider error may contain data.
    console.error('Evaluation stopped: invalid settings, missing credential, or an internal runner error.');
    process.exitCode = 1;
  });
}
