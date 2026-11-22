import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { holdout } from './phase2b-holdout.mjs';
import { renderPhase2BAnswer } from './phase2b-answer.mjs';
import { csvHistorySelection } from './phase2b-policy.mjs';
import { phase2BArms, runPhase2BCase } from './phase2b-run.mjs';
import { scorePhase2BCase } from './phase2b-score.mjs';

const sum = (rows, pick) => rows.reduce((total, row) => total + Number(pick(row)), 0);
const roundMs = ms => Number(ms.toFixed(3));
const latency = (rows, field) => {
  const values = rows.map(row => row[field]).filter(value => value !== null).sort((a, b) => a - b);
  const percentile = value => values.length ? values[Math.ceil(values.length * value) - 1] : null;
  return { median: percentile(.5), p95: percentile(.95) };
};

function summarize(rows) {
  return {
    cases: rows.length,
    correct: sum(rows, row => row.correct),
    evidenceCorrect: sum(rows, row => row.evidenceCorrect),
    answerCorrect: sum(rows, row => row.answerCorrect),
    verifiedComplete: sum(rows, row => row.complete),
    completableCases: sum(rows, row => row.completable),
    observationsWithUnsafeEvidence: sum(rows, row => row.unsafeEvidence),
    inappropriatePlannerContacts: sum(rows, row => row.inappropriatePlannerContact),
    unnecessaryReads: sum(rows, row => row.unnecessaryReads),
    plannerCalls: sum(rows, row => row.plannerCalls),
    unknownUsageCalls: sum(rows, row => row.unknownUsage),
    blockedPlans: sum(rows, row => row.blockedPlans),
    toolCalls: sum(rows, row => row.toolCalls),
    toolRetries: sum(rows, row => row.toolRetries),
    deduplicated: sum(rows, row => row.deduplicated),
    wallClockMs: latency(rows, 'latencyMs'),
    plannerWallClockMs: latency(rows, 'plannerMs'),
  };
}

function paired(left, right) {
  const byId = new Map(right.map(row => [row.id, row]));
  return {
    gains: left.filter(row => row.correct && !byId.get(row.id).correct).map(row => row.id),
    losses: left.filter(row => !row.correct && byId.get(row.id).correct).map(row => row.id),
    additionalPlannerCalls: sum(left, row => row.plannerCalls) - sum(right, row => row.plannerCalls),
    additionalToolCalls: sum(left, row => row.toolCalls) - sum(right, row => row.toolCalls),
  };
}

export async function evaluatePhase2B() {
  if (new Set(holdout.map(row => row.id)).size !== holdout.length) throw new Error('Duplicate holdout ID.');
  const records = Object.fromEntries(phase2BArms.map(arm => [arm, []]));
  for (const { expected, id, language, category, prompt, now, role, inClinic, faults } of holdout) {
    for (const arm of phase2BArms) {
      const outcome = await runPhase2BCase({ prompt, now, role, inClinic, faults, selection: csvHistorySelection }, arm);
      const rendered = renderPhase2BAnswer(outcome);
      const grade = scorePhase2BCase(expected, outcome, rendered);
      records[arm].push({
        id, language, category, arm, status: outcome.status, expectedStatus: expected.status, completable: expected.status === 'verified',
        ...grade, ...outcome.metrics, latencyMs: roundMs(outcome.metrics.latencyMs),
        plannerMs: outcome.metrics.plannerMs === null ? null : roundMs(outcome.metrics.plannerMs),
      });
    }
  }
  return {
    mode: 'offline scripted planner (no model or provider contact)', scenario: 'explicit fictional CSV history selection', cases: holdout.length,
    observedProviderUsage: null, observedProviderCache: null, estimatedProviderUsd: null,
    arms: Object.fromEntries(phase2BArms.map(arm => [arm, {
      ...summarize(records[arm]),
      byLanguage: Object.fromEntries(['en', 'tl', 'mix'].map(language => [language, summarize(records[arm].filter(row => row.language === language))])),
      byCategory: Object.fromEntries([...new Set(holdout.map(row => row.category))].sort()
        .map(category => [category, summarize(records[arm].filter(row => row.category === category))])),
    }])),
    paired: {
      singlePlanVsDeterministic: paired(records['single-plan'], records.deterministic),
      singlePlanVsLocalEnvelope: paired(records['single-plan'], records['local-envelope']),
    },
    results: phase2BArms.flatMap(arm => records[arm]),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) {
    console.error('Usage: node scripts/assistant-phase2/evaluate-phase2b.mjs (offline only)');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await evaluatePhase2B(), null, 2)); }
    catch {
      console.error('Offline holdout evaluation failed.');
      process.exitCode = 1;
    }
  }
}
