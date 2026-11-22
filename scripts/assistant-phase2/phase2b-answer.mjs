// Deterministic renderer for the bounded, fictional Phase 2B answer contract.
// This module deliberately imports nothing from the app, Worker, or Phase 2A.

const EVIDENCE_STATUSES = new Set(['verified', 'incomplete', 'partial']);
const TERMINAL_STATUSES = new Set(['clarify', 'unsupported', 'denied', 'unavailable', 'timeout']);
const TASKS = new Set(['count', 'compare', 'conditional']);
const COVERAGES = new Set(['tracked-only', 'incomplete']);

const TERMINAL_ANSWERS = Object.freeze({
  clarify: 'I need a clearer request before I can look that up. Please specify the exact date range and whether you want a count or a comparison.',
  unsupported: 'I cannot answer that with the available catalog tools. I can count tracked CSV imports for a specific date range; please ask for a supported lookup.',
  denied: 'I cannot provide that because this role does not have access to the CSV import history. Ask a clinic owner to run the lookup.',
  unavailable: 'The CSV import history is currently unavailable, so I cannot answer that right now. Please try again later.',
  timeout: 'The lookup timed out before it finished. Please try again.',
});

const SAFE_FALLBACK = 'I cannot answer that request with the available catalog tools. Please ask for a supported CSV import lookup with a specific date range.';

function isCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isEvidenceItem(item) {
  return Boolean(item) && typeof item === 'object' &&
    isCalendarDay(item.from) && isCalendarDay(item.through) && item.from <= item.through &&
    Number.isSafeInteger(item.count) && item.count >= 0 &&
    COVERAGES.has(item.coverage);
}

function evidenceLine(item) {
  // The wording is intentionally stable and always uses "rows", even for one.
  return `${item.from} through ${item.through} (Asia/Manila): ${item.count} tracked CSV catalog rows.`;
}

function comparisonLine(status, evidence, comparison) {
  const trackedOnly = evidence.length > 0 && evidence.every(item => item.coverage === 'tracked-only');
  if (status === 'verified' && trackedOnly && Number.isSafeInteger(comparison?.delta)) {
    if (evidence.length === 1 && comparison.sameWindow === true && comparison.delta === 0) {
      return 'Both windows are the same. First range minus second: 0.';
    }
    if (evidence.length === 2 && comparison.delta === evidence[0].count - evidence[1].count) {
      return `First range minus second: ${comparison.delta}.`;
    }
  }
  if (status !== 'verified') {
    return 'No difference is reported because not every required range is available.';
  }
  return trackedOnly
    ? 'No difference is reported because two verified ranges and a comparison delta are not available.'
    : 'No difference is reported because not every range has tracked-only coverage.';
}

function conditionalLine(status, conditional, evidence) {
  if (!conditional || typeof conditional !== 'object' ||
    !['taken', 'not-taken', 'unknown'].includes(conditional.branch)) return null;

  const firstIncomplete = evidence[0]?.coverage === 'incomplete';
  const secondIncluded = evidence.length >= 2;

  if (conditional.branch === 'unknown' || firstIncomplete) {
    return status === 'partial'
      ? 'Whether the threshold was met could not be determined without full history, and this partial result does not include a confirmed second range.'
      : 'Whether the threshold was met could not be determined without full history, so the second range was not checked.';
  }

  if (conditional.branch === 'not-taken') {
    return 'The threshold condition was not met, so the second range was not needed.';
  }

  if (status === 'partial') {
    return 'The threshold condition was met, so the second range was required, but this partial result does not include a confirmed second range.';
  }
  return secondIncluded
    ? 'The threshold condition was met, so the second range was checked and is included above.'
    : 'The threshold condition was met, so the second range was required, but no verified second-range evidence is included.';
}

/**
 * Render a plain, deterministic English answer from a Phase 2B outcome.
 *
 * Only verified/incomplete/partial outcomes may carry evidence and numbers.
 * Terminal outcomes intentionally contain no evidence and no digits.
 *
 * @param {{
 *   status: 'verified'|'incomplete'|'partial'|'clarify'|'unsupported'|'denied'|'unavailable'|'timeout',
 *   task: null|'count'|'compare'|'conditional',
 *   evidence: Array<{from: string, through: string, count: number, coverage: 'tracked-only'|'incomplete'}>,
 *   comparison: null|{delta: number, relation: 'higher'|'lower'|'equal', sameWindow?: true},
 *   conditional: null|{threshold: number, branch: 'taken'|'not-taken'|'unknown'},
 * }} outcome
 * @returns {string}
 */
export function renderPhase2BAnswer(outcome) {
  if (!outcome || typeof outcome !== 'object' || typeof outcome.status !== 'string') {
    return SAFE_FALLBACK;
  }

  if (TERMINAL_STATUSES.has(outcome.status)) return TERMINAL_ANSWERS[outcome.status];
  if (!EVIDENCE_STATUSES.has(outcome.status)) return SAFE_FALLBACK;

  const evidence = Array.isArray(outcome.evidence)
    ? outcome.evidence.filter(isEvidenceItem)
    : [];
  const task = TASKS.has(outcome.task) ? outcome.task : null;
  const lines = evidence.map(evidenceLine);

  if (lines.length === 0) lines.push('No verified range is available.');

  if (outcome.status === 'incomplete' ||
    evidence.some(item => item.coverage === 'incomplete')) {
    lines.push('Warning: incomplete historical coverage; the tracked CSV catalog rows above are a subset and not the total.');
  }

  if (outcome.status === 'partial') {
    lines.push('Warning: the remaining required evidence is unavailable, so this result is partial.');
  }

  if (task === 'compare') {
    lines.push(comparisonLine(outcome.status, evidence, outcome.comparison));
  }

  if (task === 'conditional') {
    const line = conditionalLine(outcome.status, outcome.conditional, evidence);
    if (line) lines.push(line);
  }

  return lines.join('\n');
}
