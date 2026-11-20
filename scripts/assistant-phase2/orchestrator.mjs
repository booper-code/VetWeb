import {
  assistantToolRegistry, exactAssistantObject, parseAssistantToolInput, parseAssistantToolResult, routeAssistantTool,
} from '../../lib/assistant-tools.ts';
import { coverageFor, fictionalHistory, fixture, NOW, rangeKey } from './fixtures.mjs';
import { withinDeadline } from './deadline.mjs';

const tool = 'inventory_import_history';
const normalStages = new Set(['deterministic', 'composition', 'planning', 'orchestrated']);
export const defaults = Object.freeze({ maxModelCalls: 3, maxToolCalls: 4, maxMs: 15_000, maxTokens: 4600, maxOutput: 210 });

class Halt extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new Halt(code); };
const signalProblem = signal => { if (signal.aborted) fail('timeout'); };

export function readPlan(value, phase, deferredConditional) {
  if (!value || typeof value !== 'object') return null;
  if (['clarify', 'unsupported'].includes(value.kind) && exactAssistantObject(value, ['kind'])) return value;
  if (value.tool !== tool || assistantToolRegistry[tool].modelVisibility !== 'summary-only' || assistantToolRegistry[tool].mutates) return null;
  if (phase === 'followup') {
    return deferredConditional && value.kind === 'followup' && exactAssistantObject(value, ['kind', 'tool', 'range']) &&
      parseAssistantToolInput(tool, value.range, NOW) ? value : null;
  }
  if (value.kind !== 'plan' || !['count', 'compare', 'conditional'].includes(value.task)) return null;
  const keys = ['kind', 'tool', 'task', 'first'];
  if (!parseAssistantToolInput(tool, value.first, NOW)) return null;
  if (value.task === 'conditional') {
    keys.push('threshold');
    if (!Number.isSafeInteger(value.threshold) || value.threshold < 1 || value.threshold > 10_000) return null;
  }
  if (value.task === 'compare' || (value.task === 'conditional' && !deferredConditional)) {
    keys.push('second');
    if (!parseAssistantToolInput(tool, value.second, NOW)) return null;
  }
  return exactAssistantObject(value, keys) ? value : null;
}

// Optional deterministic composition reference, deliberately separate from
// the existing baseline. It uses wording, never gold plans or expected values.
function compositionPlan(prompt) {
  const text = prompt.toLowerCase();
  if (!text.includes('csv')) return null;
  const ranges = [];
  const span = (from, through = from) => ({ from: `2026-11-${String(from).padStart(2, '0')}`, through: `2026-11-${String(through).padStart(2, '0')}` });
  const markers = [
    ...[...text.matchAll(/\b(?:nov(?:ember)?|nob(?:yembre)?)[. ]+(\d{1,2})(?:[–-](\d{1,2}))?/g)]
      .map(match => [match.index, span(+match[1], +(match[2] ?? match[1]))]),
    ...[...text.matchAll(/\b(?:this (?:calendar )?week(?: to date|-to-date)?|nitong linggo|ngayong linggo)\b/g)].map(x => [x.index, span(16, 20)]),
    ...[...text.matchAll(/\b(?:last (?:full |calendar )?week|(?:buong )?nakaraang (?:buong )?linggo)\b/g)].map(x => [x.index, span(9, 15)]),
    ...[...text.matchAll(/\b(?:today|ngayon(?:g araw)?|yesterday|kahapon|kamakalawa|two days ago|monday|lunes|tuesday|martes|wednesday|miyerkules)\b/g)]
      .filter(x => !text.slice(x.index).startsWith('ngayong linggo'))
      .map(x => [x.index, span(({ today: 20, ngayon: 20, 'ngayong araw': 20, yesterday: 19, kahapon: 19,
        kamakalawa: 18, 'two days ago': 18, monday: 16, lunes: 16, tuesday: 17, martes: 17, wednesday: 18, miyerkules: 18 })[x[0]] ?? 20)]),
  ];
  for (const [, range] of markers.sort(([a], [b]) => a - b)) ranges.push(range);
  const threshold = /\b(?:fewer than|under|below|less than|mas mababa sa) (\d+)\b/.exec(text);
  const wantsCompare = /\b(?:compare|paghambingin|ihambing|comparison|vs|versus|higher|more than|mas marami|same total|pareho)\b/.test(text);
  if (threshold && ranges.length === 2) return { kind: 'plan', tool, task: 'conditional', first: ranges[0], second: ranges[1], threshold: +threshold[1] };
  if (wantsCompare && ranges.length === 2) return { kind: 'plan', tool, task: 'compare', first: ranges[0], second: ranges[1] };
  return null;
}

export async function runCase(id, arm, provider, config = {}) {
  const row = fixture(id);
  if (!normalStages.has(arm)) throw new Error('Unknown benchmark arm');
  const limit = { ...defaults, ...config };
  for (const [key, max] of Object.entries({ maxModelCalls: 6, maxToolCalls: 8, maxMs: 30_000, maxTokens: 12_000, maxOutput: 512 })) {
    if (!Number.isSafeInteger(limit[key]) || limit[key] <= 0 || limit[key] > max) throw new Error(`Invalid ${key} budget`);
  }
  const start = performance.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), limit.maxMs);
  const signal = deadline.signal;
  const metrics = {
    modelCalls: 0, toolCalls: 0, modelRetries: 0, toolRetries: 0, providerErrors: 0, toolErrors: 0,
    deduplicated: 0, blockedTools: 0, unknownUsage: 0, inputTokens: 0, outputTokens: 0,
    cachedTokens: 0, nanodollars: 0, reservedUnknownNanodollars: 0, latencyMs: 0,
  };
  const windowEvidence = [];
  const allReads = new Set();
  const cached = new Map();
  let remainingTokens = limit.maxTokens;
  let interpretedTask = null;
  let conditionalThreshold = null;
  let personCount = null;
  let comparison = null;
  let detail = null;
  const limitError = value => ['auth', 'quota', 'io', 'provider', 'provider-rate', 'format', 'budget', 'privacy', 'timeout'].includes(value)
    ? value : 'provider';

  const callerMayRead = id => row.inClinic && ['owner', 'editor', 'viewer'].includes(row.role) &&
    (assistantToolRegistry[id].access !== 'owner' || row.role === 'owner');

  async function getPlan(phase, evidence) {
    let retried = false;
    for (;;) {
      signalProblem(signal);
      if (metrics.modelCalls >= limit.maxModelCalls || remainingTokens <= 0) fail('budget');
      if (!provider) fail('provider');
      // Provider takes a fixture ID, not user-supplied text or arbitrary state.
      let dispatch = null, response;
      try {
        response = await withinDeadline(provider.call({ id, phase, arm, evidence, remainingTokens,
          maxOutput: limit.maxOutput, signal, onDispatch: receipt => { dispatch = receipt; } }), signal);
      } catch {
        // The shared provider ledger protects the reservation. Include this
        // attempt pessimistically even if abort won the race with its reply.
        response = { ...dispatch, sent: !!dispatch, unknown: !!dispatch, error: signal.aborted ? 'timeout' : 'io' };
      }
      if (response.sent) {
        metrics.modelCalls += 1;
        if (retried) metrics.modelRetries += 1;
        remainingTokens -= response.chargedTokens ?? 0;
        metrics.inputTokens += response.usage?.input ?? 0;
        metrics.outputTokens += response.usage?.output ?? 0;
        metrics.cachedTokens += response.usage?.cached ?? 0;
        metrics.nanodollars += response.nanodollars ?? 0;
        metrics.unknownUsage += response.unknown ? 1 : 0;
        if (response.unknown) metrics.reservedUnknownNanodollars += response.nanodollars ?? 0;
      }
      signalProblem(signal);
      if (remainingTokens < 0) fail('budget');
      if (response.error) {
        const code = limitError(response.error);
        metrics.providerErrors += 1;
        if (response.retryable && response.sent && !retried && !signal.aborted && metrics.modelCalls < limit.maxModelCalls) {
          retried = true; continue;
        }
        detail = code;
        fail(code === 'budget' || code === 'timeout' ? code : code === 'format' ? 'invalid-model' : 'provider');
      }
      const validated = readPlan(response.command, phase, arm === 'orchestrated');
      if (!validated) {
        metrics.blockedTools += 1;
        fail('invalid-model');
      }
      return validated;
    }
  }

  const invalidScope = () => { metrics.blockedTools += 1; fail('invalid-scope'); };
  const permittedRanges = row.task ? new Set([row.task.first, row.task.second].filter(Boolean).map(rangeKey)) : new Set();
  function read(range) {
    signalProblem(signal);
    if (!callerMayRead(tool)) fail('denied');
    if (!parseAssistantToolInput(tool, range, NOW) || !permittedRanges.has(rangeKey(range))) {
      invalidScope();
    }
    const key = rangeKey(range);
    if (cached.has(key)) { metrics.deduplicated += 1; return cached.get(key); }
    allReads.add(key);
    const pending = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signalProblem(signal);
        if (metrics.toolCalls >= limit.maxToolCalls) fail('budget');
        metrics.toolCalls += 1;
        if (attempt) metrics.toolRetries += 1;
        if (row.fault === 'transient' && attempt === 0) { metrics.toolErrors += 1; continue; }
        if (row.fault === 'partial' && rangeKey(row.task.second) === key) { metrics.toolErrors += 1; fail('unavailable'); }
        const upstream = fictionalHistory(range);
        if (row.fault === 'malformed') upstream.ownerAddress = 'PRIVATE-ADDRESS-CANARY';
        const verified = parseAssistantToolResult(tool, upstream);
        if (!verified || verified.from !== range.from || verified.through !== range.through) { metrics.toolErrors += 1; fail('unavailable'); }
        // Select only literal allowlisted fields, not a serialized tool reply.
        return { from: verified.from, through: verified.through, count: verified.count, coverage: coverageFor(range) };
      }
      fail('unavailable');
    })();
    cached.set(key, pending);
    return pending;
  }

  async function apply(plan) {
    if (plan.kind === 'clarify' || plan.kind === 'unsupported') fail(plan.kind);
    // Do not use the expected task to repair a proposal. The fictional
    // consent envelope bounds the operation and order before any read.
    if (!row.task || plan.task !== row.task.type || rangeKey(plan.first) !== rangeKey(row.task.first) ||
      (plan.second && (!row.task.second || rangeKey(plan.second) !== rangeKey(row.task.second))) ||
      (plan.task === 'conditional' && plan.threshold !== row.task.threshold)) invalidScope();
    interpretedTask = plan.task;
    if (plan.task === 'conditional') conditionalThreshold = plan.threshold;
    if (plan.task === 'compare' && plan.second) {
      // Evidence reads are independent; preserve order in the verified reply.
      const results = await Promise.allSettled([plan.first, plan.second].map(range => Promise.resolve().then(() => read(range))));
      for (const result of results) if (result.status === 'fulfilled') windowEvidence.push(result.value);
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      if (windowEvidence.every(item => item.coverage === 'tracked-only')) {
        const delta = windowEvidence[0].count - windowEvidence[1].count;
        comparison = { delta, relation: delta === 0 ? 'equal' : delta > 0 ? 'higher' : 'lower' };
      }
      return;
    }
    const first = await read(plan.first);
    windowEvidence.push(first);
    if (plan.task === 'count' || (plan.task === 'conditional' &&
      (first.coverage === 'incomplete' || first.count >= plan.threshold))) return;
    const second = plan.second ?? (await getPlan('followup', first)).range;
    if (!second) fail('clarify');
    if (!row.task.second || rangeKey(second) !== rangeKey(row.task.second)) invalidScope();
    windowEvidence.push(await read(second));
  }

  let status = 'verified';
  try {
    const routed = routeAssistantTool(row.prompt, NOW);
    if (routed.kind === 'tool') {
      if (!callerMayRead(routed.tool)) fail('denied');
      if (routed.tool === 'find_person_by_name') {
        interpretedTask = 'person';
        metrics.toolCalls += 1;
        allReads.add('local-person');
        const result = parseAssistantToolResult(routed.tool, { more: false, matches: [
          { name: routed.input.name, patientName: 'Fictional Milo', reference: 'fictional-one' },
          { name: routed.input.name, patientName: 'Fictional Luna', reference: 'fictional-two' },
        ] });
        if (!result) fail('unavailable');
        personCount = result.matches.length;
      } else await apply({ kind: 'plan', tool, task: 'count', first: routed.input });
    } else if (!row.modelPrompt || arm === 'deterministic' || arm === 'composition') {
      const plan = arm === 'composition' && row.modelPrompt ? compositionPlan(row.prompt) : null;
      if (plan && readPlan(plan, 'plan', false)) await apply(plan);
      else fail(routed.kind === 'clarify' ? 'clarify' : 'unsupported');
    } else {
      await apply(await getPlan('plan'));
    }
    if (windowEvidence.some(item => item.coverage === 'incomplete')) status = 'incomplete';
  } catch (error) {
    if (!(error instanceof Halt)) throw error;
    status = error.code === 'unavailable' && windowEvidence.length ? 'partial' : error.code;
  } finally { clearTimeout(timer); }
  metrics.latencyMs = performance.now() - start;
  return { status, detail, task: interpretedTask, conditionalThreshold, comparison, personCount,
    evidence: windowEvidence, attemptedRanges: [...allReads], uniqueReads: allReads.size, metrics };
}
