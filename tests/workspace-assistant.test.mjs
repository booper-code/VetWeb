import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../lib/workspace-assistant.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', logLevel: 'silent',
});
const { askWorkspaceAssistant, createAssistantReschedule, matchAssistantReschedule, assistantEditorTime } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

const milo = { id: 'appointment-milo', revision: 3, patientName: 'Milo', type: 'Checkup', dueAt: '2026-11-24T02:30:00.000Z' };
const otherMilo = { ...milo, id: 'other-milo', dueAt: '2026-11-24T04:00:00.000Z' };
const schedule = { window: { from: '2026-11-20', through: '2026-11-30' }, availability: 'ready', partial: false, rows: [milo] };
const timeQuestion = 'When is Milo’s checkup?';
const move = 'Move Milo’s checkup to November 24, 2026 at 2:30 PM Manila time.';

test('local app help does not depend on schedule access', () => {
  const result = askWorkspaceAssistant('Where are appointments?', { ...schedule, availability: 'error' });
  assert.equal(result.kind, 'help');
  assert.equal(result.destination, 'appointments');
  assert.match(result.message, /Everyday work/);
});

test('appointment questions match exact names and visit types in the loaded date window', () => {
  const result = askWorkspaceAssistant(timeQuestion, schedule);
  assert.equal(result.kind, 'appointments');
  assert.deepEqual(result.candidates, [milo]);
  assert.equal(result.requiresSelection, false);
  assert.equal(askWorkspaceAssistant('When is Mil’s checkup?', schedule).kind, 'not-found');
  assert.equal(askWorkspaceAssistant('When is Milo’s vaccination?', schedule).kind, 'not-found');
});

test('partial results and duplicate names require an explicit appointment selection', () => {
  const duplicate = askWorkspaceAssistant(move, { ...schedule, rows: [milo, otherMilo] });
  assert.equal(duplicate.kind, 'reschedule');
  assert.equal(duplicate.requiresSelection, true);
  assert.deepEqual(duplicate.candidates, [milo, otherMilo]);
  assert.equal(askWorkspaceAssistant(move, { ...schedule, partial: true }).requiresSelection, true);
});

test('unavailable data is not treated as an empty schedule', () => {
  for (const state of ['loading', 'error', 'offline']) {
    const result = askWorkspaceAssistant(timeQuestion, { ...schedule, availability: state });
    assert.equal(result.kind, 'unavailable');
    assert.equal('candidates' in result, false);
  }
  assert.equal(askWorkspaceAssistant(timeQuestion, { ...schedule, rows: [] }).kind, 'not-found');
  assert.match(askWorkspaceAssistant(timeQuestion, { ...schedule, rows: [], partial: true }).message, /more pages|partial/i);
});

test('explicit Manila times produce a typed proposal without changing any appointment', () => {
  for (const note of [move, 'Move Milo’s checkup to 2026-11-24 at 14:30']) {
    const result = askWorkspaceAssistant(note, schedule);
    assert.equal(result.kind, 'reschedule');
    assert.equal(result.proposedDueAt, '2026-11-24T06:30:00.000Z');
    assert.deepEqual(createAssistantReschedule(result.candidates[0], result.proposedDueAt), {
      appointmentId: 'appointment-milo',
      expectedRevision: 3,
      originalDueAt: '2026-11-24T02:30:00.000Z',
      proposedDueAt: '2026-11-24T06:30:00.000Z',
    });
  }
  assert.equal(milo.dueAt, '2026-11-24T02:30:00.000Z');
});

test('missing, relative, impossible, and out-of-scope requests do not produce a change', () => {
  for (const note of [
    'Move Milo’s checkup to tomorrow at 14:30',
    'Move Milo’s checkup to November 24 at 14:30',
    'Move Milo’s checkup to 2026-02-30 at 14:30',
    'Move Milo’s checkup to 2026-11-24 at 24:00',
    'Move Milo’s checkup to 2026-11-24 at 14:30 EST',
    'Move Milo’s checkup to 2026-11-24 at 14:30; cancel another visit',
    `${move}\nCancel Milo’s checkup`,
    'Set inventory quantity to 0',
    'x'.repeat(401),
  ]) assert.equal(askWorkspaceAssistant(note, schedule).kind, 'clarification', note);
  assert.equal(createAssistantReschedule(milo, milo.dueAt), null);
});

test('review refuses a changed revision, original time, or missing target', () => {
  const proposal = createAssistantReschedule(milo, '2026-11-24T06:30:00.000Z');
  assert.equal(matchAssistantReschedule(proposal, [milo]), milo);
  assert.equal(matchAssistantReschedule(proposal, [{ ...milo, revision: 4 }]), null);
  assert.equal(matchAssistantReschedule(proposal, [{ ...milo, dueAt: otherMilo.dueAt }]), null);
  assert.equal(matchAssistantReschedule(proposal, [otherMilo]), null);
});

test('editor prefill preserves the instant and refuses an unrepresentable repeated local time', () => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(assistantEditorTime('2026-11-24T06:30:00.000Z'), '2026-11-23T22:30');
    assert.equal(assistantEditorTime('2026-11-01T09:30:00.000Z'), null);
    assert.equal(assistantEditorTime('not-an-iso-date'), null);
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});
