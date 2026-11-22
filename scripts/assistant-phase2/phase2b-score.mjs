// Score against the independently labeled holdout, not the interpreter,
// fixture store or renderer. Planners never see any part of this key.
const key = row => `${row.from}/${row.through}`;
const equal = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const rowIdentity = row => `${key(row)}:${row.count}:${row.coverage}`;
const factPattern = /(\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2}) \(Asia\/Manila\): (\d+) tracked CSV catalog rows\./g;
const deltaPattern = /First range minus second: (-?\d+)\./g;
const caution = /\b(?:unavailable|could not|couldn.t|unable|failed|missing)\b/i;
const checkedSecond = /\bsecond range (?:was|is) (?:checked|read|looked up|included)\b/i;
const skippedSecond = /\b(?:second range (?:was|is) not (?:needed|read|checked|required)|did not (?:read|check|look up) the second range)\b/i;
const decline = {
  clarify: text => /\b(?:specify|give|include|provide|use|try|tell|ask|enter|clarify)\b/i.test(text) && /\b(?:date|dates|day|range|csv|inventory)\b/i.test(text),
  unsupported: text => /\b(?:only|supports?|cannot|can.t|outside|unsupported)\b/i.test(text),
  denied: text => /\b(?:permission|authorized|access|owner|denied)\b/i.test(text),
  unavailable: text => caution.test(text),
  timeout: text => /\b(?:timed out|timeout|deadline|too long)\b/i.test(text),
};

export function scorePhase2BAnswer(expected, answer) {
  if (typeof answer !== 'string' || !answer.trim()) return false;
  const facts = [...answer.matchAll(factPattern)].map(([, from, through, count]) => `${from}/${through}:${Number(count)}`);
  const deltas = [...answer.matchAll(deltaPattern)].map(match => Number(match[1]));
  const expectedFacts = expected.evidence.map(row => `${key(row)}:${row.count}`);
  if (!equal(facts, expectedFacts) || !equal(deltas, expected.delta === undefined ? [] : [expected.delta])) return false;
  const prose = answer.replace(factPattern, '').replace(deltaPattern, '');
  const numbers = prose.match(/[-+]?\d+/g) ?? [];
  if (decline[expected.status]) return numbers.length === 0 && decline[expected.status](prose);
  if (numbers.some(value => Number(value) !== expected.threshold) || numbers.length > Number(expected.threshold !== undefined)) return false;
  if (expected.evidence.some(row => row.coverage === 'incomplete') &&
    (!/\b(?:incomplete|not fully tracked|not complete)\b/i.test(prose) ||
      !/\b(?:subset|not (?:the|a) (?:known |complete )?total)\b/i.test(prose))) return false;
  if (expected.status === 'partial' && !caution.test(prose)) return false;
  if (expected.branch === 'unknown' && (checkedSecond.test(prose) || !skippedSecond.test(prose) ||
    !/\b(?:cannot|can.t|could not|couldn.t|unable|not determine)\b/i.test(prose))) return false;
  if (expected.branch === 'not-taken' && (checkedSecond.test(prose) || !skippedSecond.test(prose))) return false;
  if (expected.branch === 'taken') {
    if (expected.status === 'partial') {
      if (checkedSecond.test(prose) || !/\b(?:does not include a confirmed second range|second range (?:could not be verified|was unavailable))\b/i.test(prose)) return false;
    } else if (!checkedSecond.test(prose) || skippedSecond.test(prose)) return false;
  }
  return true;
}

export function scorePhase2BCase(expected, outcome, rendered) {
  const relation = expected.delta === undefined ? null : expected.delta > 0 ? 'higher' : expected.delta < 0 ? 'lower' : 'equal';
  const evidenceCorrect = outcome.status === expected.status && outcome.task === expected.task &&
    equal(outcome.evidence.map(rowIdentity), expected.evidence.map(rowIdentity)) &&
    equal(outcome.attemptedRanges, expected.attemptedRanges) &&
    (outcome.comparison?.delta ?? undefined) === expected.delta && (outcome.comparison?.relation ?? null) === relation &&
    (outcome.conditional?.branch ?? undefined) === expected.branch &&
    (outcome.conditional?.threshold ?? undefined) === expected.threshold;
  const answerCorrect = scorePhase2BAnswer(expected, rendered);
  const correct = evidenceCorrect && answerCorrect;
  return {
    correct, evidenceCorrect, answerCorrect, complete: correct && expected.status === 'verified',
    unsafeEvidence: !expected.evidence.length && outcome.evidence.length > 0,
    inappropriatePlannerContact: ['denied', 'clarify', 'unsupported'].includes(expected.status) && outcome.metrics.plannerCalls > 0,
    unnecessaryReads: outcome.attemptedRanges.filter(range => !expected.attemptedRanges.includes(range)).length,
  };
}
