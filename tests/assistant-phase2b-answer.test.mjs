import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPhase2BAnswer } from '../scripts/assistant-phase2/phase2b-answer.mjs';

const row = (from, through, count, coverage = 'tracked-only') => ({ from, through, count, coverage });
const outcome = overrides => ({
  status: 'verified',
  task: 'count',
  evidence: [],
  comparison: null,
  conditional: null,
  ...overrides,
});
const evidenceLine = (from, through, count) =>
  `${from} through ${through} (Asia/Manila): ${count} tracked CSV catalog rows.`;

test('verified count lists every available range with the stable sentence', () => {
  const answer = renderPhase2BAnswer(outcome({
    evidence: [
      row('2026-11-16', '2026-11-20', 8),
      row('2026-11-09', '2026-11-15', 16),
    ],
  }));

  assert.equal(typeof answer, 'string');
  assert.equal(answer, [
    evidenceLine('2026-11-16', '2026-11-20', 8),
    evidenceLine('2026-11-09', '2026-11-15', 16),
  ].join('\n'));
  assert.doesNotMatch(answer, /incomplete|unavailable|First range minus second/i);
});

test('the evidence sentence uses "rows" even when the count is one', () => {
  const answer = renderPhase2BAnswer(outcome({
    evidence: [row('2026-11-12', '2026-11-12', 1)],
  }));

  assert.match(answer, /: 1 tracked CSV catalog rows\.$/m);
  assert.doesNotMatch(answer, /1 tracked CSV catalog row\./);
});

test('incomplete status warns that historical coverage is incomplete and the tracked count is not the total', () => {
  const answer = renderPhase2BAnswer(outcome({
    status: 'incomplete',
    evidence: [row('2026-11-03', '2026-11-10', 3, 'incomplete')],
  }));

  assert.ok(answer.includes(evidenceLine('2026-11-03', '2026-11-10', 3)));
  assert.match(answer, /incomplete historical coverage/i);
  assert.match(answer, /subset/i);
  assert.match(answer, /not the total/i);
  assert.doesNotMatch(answer, /First range minus second/);

  const verifiedButIncomplete = renderPhase2BAnswer(outcome({
    status: 'verified',
    evidence: [row('2026-11-03', '2026-11-10', 3, 'incomplete')],
  }));
  assert.match(verifiedButIncomplete, /incomplete historical coverage/i);
  assert.match(verifiedButIncomplete, /not the total/i);
});

test('partial status lists available evidence, warns remaining evidence is unavailable, and withholds comparisons', () => {
  const answer = renderPhase2BAnswer(outcome({
    status: 'partial',
    task: 'compare',
    evidence: [row('2026-11-18', '2026-11-18', 3)],
    comparison: { delta: -4, relation: 'lower' },
  }));

  assert.ok(answer.includes(evidenceLine('2026-11-18', '2026-11-18', 3)));
  assert.match(answer, /remaining required evidence is unavailable/i);
  assert.match(answer, /partial/i);
  assert.doesNotMatch(answer, /First range minus second/);
  assert.doesNotMatch(answer, /\b(higher|lower|equal)\b/i);
});

test('only a verified compare with two ranges emits the exact delta phrase', () => {
  const verified = renderPhase2BAnswer(outcome({
    task: 'compare',
    evidence: [
      row('2026-11-16', '2026-11-20', 8),
      row('2026-11-09', '2026-11-15', 16),
    ],
    comparison: { delta: -8, relation: 'lower' },
  }));
  assert.ok(verified.includes('First range minus second: -8.'));
  assert.equal(verified.match(/First range minus second:/g).length, 1);

  const equal = renderPhase2BAnswer(outcome({
    task: 'compare',
    evidence: [
      row('2026-11-19', '2026-11-19', 1),
      row('2026-11-19', '2026-11-19', 1),
    ],
    comparison: { delta: 0, relation: 'equal' },
  }));
  assert.ok(equal.includes('First range minus second: 0.'));

  const blocked = [
    outcome({
      task: 'count',
      evidence: [row('2026-11-19', '2026-11-19', 1), row('2026-11-18', '2026-11-18', 3)],
      comparison: { delta: -2, relation: 'lower' },
    }),
    outcome({
      status: 'incomplete',
      task: 'compare',
      evidence: [row('2026-11-03', '2026-11-10', 3, 'incomplete')],
      comparison: { delta: 3, relation: 'higher' },
    }),
    outcome({
      status: 'partial',
      task: 'compare',
      evidence: [row('2026-11-18', '2026-11-18', 3)],
      comparison: { delta: -4, relation: 'lower' },
    }),
    outcome({
      task: 'compare',
      evidence: [row('2026-11-16', '2026-11-20', 8), row('2026-11-09', '2026-11-15', 16)],
      comparison: null,
    }),
    outcome({
      task: 'compare',
      evidence: [row('2026-11-16', '2026-11-20', 8)],
      comparison: { delta: 8, relation: 'higher' },
    }),
    outcome({
      task: 'compare',
      evidence: [
        row('2026-11-03', '2026-11-10', 3, 'incomplete'),
        row('2026-11-11', '2026-11-13', 4),
      ],
      comparison: { delta: -1, relation: 'lower' },
    }),
  ];

  for (const item of blocked) {
    assert.doesNotMatch(renderPhase2BAnswer(item), /First range minus second/);
  }
});

test('conditional metadata explains a checked second range, an unnecessary one, or an undeterminable threshold', () => {
  const taken = renderPhase2BAnswer(outcome({
    task: 'conditional',
    evidence: [
      row('2026-11-16', '2026-11-20', 8),
      row('2026-11-09', '2026-11-15', 16),
    ],
    conditional: { threshold: 10, branch: 'taken' },
  }));
  assert.match(taken, /second range was checked/i);
  assert.doesNotMatch(taken, /not verified/i);

  const notTaken = renderPhase2BAnswer(outcome({
    task: 'conditional',
    evidence: [row('2026-11-16', '2026-11-20', 8)],
    conditional: { threshold: 5, branch: 'not-taken' },
  }));
  assert.match(notTaken, /second range was not needed/i);
  assert.doesNotMatch(notTaken, /second range was checked/i);

  const unknown = renderPhase2BAnswer(outcome({
    status: 'incomplete',
    task: 'conditional',
    evidence: [row('2026-11-03', '2026-11-03', 2, 'incomplete')],
    conditional: { threshold: 4, branch: 'unknown' },
  }));
  assert.match(unknown, /could not be determined/i);
  assert.match(unknown, /full history/i);
  assert.match(unknown, /second range/i);

  const incompleteNotTaken = renderPhase2BAnswer(outcome({
    status: 'incomplete',
    task: 'conditional',
    evidence: [row('2026-11-03', '2026-11-03', 2, 'incomplete')],
    conditional: { threshold: 4, branch: 'not-taken' },
  }));
  assert.match(incompleteNotTaken, /could not be determined/i);
  assert.match(incompleteNotTaken, /full history/i);
  assert.match(incompleteNotTaken, /not checked/i);

  const incompleteTaken = renderPhase2BAnswer(outcome({
    status: 'incomplete',
    task: 'conditional',
    evidence: [row('2026-11-03', '2026-11-03', 2, 'incomplete')],
    conditional: { threshold: 4, branch: 'taken' },
  }));
  assert.match(incompleteTaken, /could not be determined/i);
  assert.match(incompleteTaken, /full history/i);
  assert.doesNotMatch(incompleteTaken, /threshold condition was met/i);
});

test('a partial conditional does not claim the second range was verified', () => {
  const answer = renderPhase2BAnswer(outcome({
    status: 'partial',
    task: 'conditional',
    evidence: [row('2026-11-16', '2026-11-20', 8)],
    conditional: { threshold: 10, branch: 'taken' },
  }));

  assert.match(answer, /second range/i);
  assert.match(answer, /does not include a confirmed second range/i);
  assert.match(answer, /partial/i);
  assert.doesNotMatch(answer, /second range was checked and is included/i);
  assert.doesNotMatch(answer, /second range.*\bverified\b/i);
});

test('terminal outcomes emit no evidence, counts, or comparison arithmetic', () => {
  const evidence = [row('2026-11-19', '2026-11-19', 1)];
  const comparison = { delta: -4, relation: 'lower' };
  const conditional = { threshold: 10, branch: 'taken' };

  for (const status of ['clarify', 'unsupported', 'denied', 'unavailable', 'timeout']) {
    const answer = renderPhase2BAnswer({ status, task: 'compare', evidence, comparison, conditional });
    assert.equal(typeof answer, 'string');
    assert.ok(answer.length > 0);
    assert.doesNotMatch(answer, /\d/);
    assert.doesNotMatch(answer, /Asia\/Manila/);
    assert.doesNotMatch(answer, /tracked CSV catalog rows/i);
    assert.doesNotMatch(answer, /First range minus second/);
    assert.doesNotMatch(answer, /\b(higher|lower|equal)\b/i);
    assert.doesNotMatch(answer, /2026-11-19/);
    assert.doesNotMatch(answer, /evidence|verified/i);
  }

  const clarify = renderPhase2BAnswer({
    status: 'clarify',
    task: null,
    evidence: [],
    comparison: null,
    conditional: null,
  });
  assert.match(clarify, /Please/);
  assert.match(clarify, /date range/i);
});

test('rendering is deterministic and does not mutate its input', () => {
  const input = outcome({
    status: 'partial',
    task: 'compare',
    evidence: [row('2026-11-18', '2026-11-18', 3)],
    comparison: { delta: -4, relation: 'lower' },
  });
  const snapshot = JSON.stringify(input);

  Object.freeze(input);
  Object.freeze(input.evidence);
  Object.freeze(input.evidence[0]);
  Object.freeze(input.comparison);

  const first = renderPhase2BAnswer(input);
  const second = renderPhase2BAnswer(input);

  assert.equal(first, second);
  assert.equal(JSON.stringify(input), snapshot);
});

test('an unknown status falls back to a safe, number-free answer', () => {
  const answer = renderPhase2BAnswer({
    status: 'mystery',
    task: 'count',
    evidence: [row('2026-11-19', '2026-11-19', 1)],
    comparison: null,
    conditional: null,
  });

  assert.equal(typeof answer, 'string');
  assert.doesNotMatch(answer, /\d/);
  assert.doesNotMatch(answer, /tracked CSV catalog rows/i);
});

test('the renderer never reflects malformed dates or reports an inconsistent delta', () => {
  const malformed = renderPhase2BAnswer(outcome({
    evidence: [row('Fictional private name', '2026-11-20', 7), row('2026-02-29', '2026-03-01', 2)],
  }));
  assert.doesNotMatch(malformed, /Fictional private name|2026-02-29/);
  const wrongDelta = renderPhase2BAnswer(outcome({
    task: 'compare',
    evidence: [row('2026-11-19', '2026-11-19', 3), row('2026-11-18', '2026-11-18', 4)],
    comparison: { delta: 4, relation: 'higher' },
  }));
  assert.doesNotMatch(wrongDelta, /First range minus second/);
});
