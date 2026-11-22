import { parseAssistantToolResult } from '../../lib/assistant-tools.ts';
import { withinDeadline } from './deadline.mjs';
import {
  acceptScopedPlan, inventoryTool, plannerContext, rangeKey, scopeFictionalInventory, scriptedPhase2BPlanner,
} from './phase2b-policy.mjs';

export const phase2BArms = Object.freeze(['deterministic', 'single-plan', 'local-envelope']);
const totals = Object.freeze({
  '2026-12-01': 2, '2026-12-07': 1, '2026-12-11': 4, '2026-12-12': 3, '2026-12-13': 1,
  '2026-12-14': 5, '2026-12-15': 2, '2026-12-16': 4, '2027-01-01': 6, '2027-01-02': 3,
  '2027-01-03': 2, '2027-01-04': 1,
});
const receipts = Object.entries(totals).flatMap(([day, count]) => Array.from({ length: count }, (_, index) => {
  const occurred = Date.parse(`${day}T00:00:00+08:00`) + index * 1000;
  return { day, occurred, at: new Date(occurred).toISOString(), batchId: '00000000-0000-4000-8000-000000000000' };
}));

function readFictionalReceipts(window, now) {
  const found = receipts.filter(({ day, occurred }) => day >= window.from && day <= window.through && occurred <= now);
  return {
    ...window, count: found.length, recent: found.slice(-10).reverse().map(({ at, batchId }) => ({ at, batchId })),
  };
}

class Stop extends Error {
  constructor(status) { super(status); this.status = status; }
}
const stop = status => { throw new Stop(status); };
const budget = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const tokenCount = value => Number.isSafeInteger(value) && value >= 0;

/** Test inputs and optional collaborators in this module are fictional only. */
export async function runPhase2BCase(scenario, arm, {
  planner = scriptedPhase2BPlanner, maxMs = 1_000, maxToolCalls = 4,
  access = () => ({ role: scenario.role ?? 'owner', inClinic: scenario.inClinic !== false, generation: 0 }),
} = {}) {
  if (!phase2BArms.includes(arm) || !budget(maxMs, 15_000) || !budget(maxToolCalls, 4)) throw new Error('Invalid offline run limits.');
  const started = performance.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), maxMs);
  const { signal } = deadline;
  const metrics = {
    plannerCalls: 0, plannerMs: null, blockedPlans: 0, toolCalls: 0, toolRetries: 0, deduplicated: 0, toolErrors: 0,
    knownInputTokens: 0, knownOutputTokens: 0, cachedInputTokens: 0, unknownUsage: 0, latencyMs: 0,
  };
  const outcome = {
    status: 'verified', task: null, evidence: [], comparison: null, conditional: null, attemptedRanges: [], metrics,
  };
  const pending = new Map();
  const now = Date.parse(scenario.now);
  let activeGeneration;
  const admit = () => {
    if (signal.aborted || performance.now() - started >= maxMs) stop('timeout');
    const actor = access();
    if (actor?.inClinic !== true || actor.role !== 'owner') stop('denied');
    const generation = actor.generation ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0) stop('denied');
    activeGeneration ??= generation;
    if (generation !== activeGeneration) stop('denied');
  };

  const read = async requested => {
    admit();
    const key = rangeKey(requested);
    if (pending.has(key)) {
      metrics.deduplicated++;
      return pending.get(key);
    }
    const work = Promise.resolve().then(() => {
      const fault = scenario.faults?.[key];
      for (let attempt = 0; attempt < 2; attempt++) {
        admit();
        if (metrics.toolCalls >= maxToolCalls) stop('unavailable');
        if (!attempt) outcome.attemptedRanges.push(key);
        metrics.toolCalls++;
        if (attempt) metrics.toolRetries++;
        if (!attempt && fault === 'transient') { metrics.toolErrors++; continue; }
        if (fault === 'unavailable') { metrics.toolErrors++; stop('unavailable'); }
        const reply = readFictionalReceipts(requested, now);
        if (fault === 'malformed') reply.unexpected = true;
        const verified = parseAssistantToolResult(inventoryTool, reply);
        if (!verified || rangeKey(verified) !== key) { metrics.toolErrors++; stop('unavailable'); }
        admit();
        return { ...requested, count: verified.count, coverage: requested.from < '2026-12-01' ? 'incomplete' : 'tracked-only' };
      }
      stop('unavailable');
    });
    pending.set(key, work);
    return work;
  };

  const planOnce = async local => {
    admit();
    const start = performance.now();
    metrics.plannerCalls++;
    let response;
    try {
      const context = plannerContext(local);
      response = await withinDeadline(Promise.resolve().then(() => planner(context, signal)), signal);
    } catch { stop(signal.aborted ? 'timeout' : 'unavailable'); }
    finally {
      metrics.plannerMs = performance.now() - start;
      const usage = response?.usage;
      if (usage && [usage.input, usage.output, usage.cached].every(tokenCount) && usage.cached <= usage.input) {
        metrics.knownInputTokens = usage.input;
        metrics.knownOutputTokens = usage.output;
        metrics.cachedInputTokens = usage.cached;
      } else metrics.unknownUsage++;
    }
    admit();
    if (response?.command?.kind === 'clarify' && Object.keys(response.command).length === 1) stop('clarify');
    const verified = acceptScopedPlan(response?.command, local, now);
    if (!verified) { metrics.blockedPlans++; stop('clarify'); }
    return verified;
  };

  try {
    const scope = scopeFictionalInventory(scenario.prompt, now, scenario.selection);
    if (!scope.plan) stop(scope.kind);
    admit();
    if (scope.kind === 'fallback' && arm === 'deterministic') stop('clarify');
    const plan = scope.kind === 'fallback' && arm === 'single-plan' ? await planOnce(scope.plan) : scope.plan;
    outcome.task = plan.task;
    if (plan.task === 'compare') {
      const pair = await Promise.allSettled([read(plan.first), read(plan.second)]);
      for (const result of pair) {
        if (result.status === 'fulfilled' && !outcome.evidence.some(row => rangeKey(row) === rangeKey(result.value))) {
          outcome.evidence.push(result.value);
        }
      }
      const failed = pair.filter(result => result.status === 'rejected');
      if (failed.length) throw (failed.find(result => result.reason.status !== 'unavailable') ?? failed[0]).reason;
      if (outcome.evidence.every(row => row.coverage === 'tracked-only')) {
        const delta = pair[0].value.count - pair[1].value.count;
        outcome.comparison = {
          delta, relation: delta > 0 ? 'higher' : delta < 0 ? 'lower' : 'equal',
          ...(outcome.evidence.length === 1 && { sameWindow: true }),
        };
      }
    } else {
      if (plan.task === 'conditional') outcome.conditional = { threshold: plan.threshold, branch: 'unknown' };
      const first = await read(plan.first);
      outcome.evidence.push(first);
      if (plan.task === 'conditional') {
        const branch = first.coverage === 'incomplete' ? 'unknown' : first.count < plan.threshold ? 'taken' : 'not-taken';
        outcome.conditional = { threshold: plan.threshold, branch };
        if (branch === 'taken') outcome.evidence.push(await read(plan.second));
      }
    }
    admit();
    if (outcome.evidence.some(row => row.coverage === 'incomplete')) outcome.status = 'incomplete';
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    // A stale actor never receives any previously accumulated evidence.
    if (error.status === 'unavailable' && outcome.evidence.length) {
      try { admit(); outcome.status = 'partial'; }
      catch (accessError) {
        if (!(accessError instanceof Stop)) throw accessError;
        outcome.status = accessError.status;
      }
    } else outcome.status = error.status;
    if (!['partial', 'incomplete', 'verified'].includes(outcome.status)) {
      outcome.evidence = [];
      outcome.comparison = null;
      if (outcome.status !== 'unavailable') outcome.conditional = null;
    }
    if (['denied', 'timeout'].includes(outcome.status)) outcome.task = null;
  } finally {
    clearTimeout(timer);
    metrics.latencyMs = performance.now() - started;
  }
  return outcome;
}
