import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers/tsx-harness.mjs';

const values = () => loadSource('../../lib/follow-up-values.ts');
const now = Date.parse('2026-11-18T16:00:00Z');
const base = { id: 'due', type: 'Follow-up', status: 'scheduled', dueAt: '2026-11-19T15:59:59.999Z' };

test('the queue includes only scheduled follow-ups through the end of the Manila day', () => {
  const { followUpDayEndMs, isDueFollowUp } = values();
  assert.equal(followUpDayEndMs(now), Date.parse('2026-11-19T16:00:00Z'));
  assert.equal(isDueFollowUp(base, now), true);
  assert.equal(isDueFollowUp({ ...base, dueAt: '2025-01-01T10:00:00.000Z' }, now), true);
  assert.equal(isDueFollowUp({ ...base, dueAt: '2026-11-19T16:00:00.000Z' }, now), false);
  for (const patch of [{ type: 'Vaccination' }, { status: 'completed' }, { status: 'cancelled' }, { status: 'no-show' }, { dueAt: 'invalid' }]) {
    assert.equal(isDueFollowUp({ ...base, ...patch }, now), false);
  }
});

test('contact belongs to one due time and is not inherited on reschedule', () => {
  const { currentFollowUpContact } = values();
  const contact = { dueAt: base.dueAt, contactedAt: '2026-11-18T16:01:00.000Z', contactedBy: 'fixture' };
  assert.equal(currentFollowUpContact({ ...base, followUpContact: contact }), contact);
  assert.equal(currentFollowUpContact({ ...base, dueAt: '2026-11-19T15:00:00.000Z', followUpContact: contact }), null);
  assert.equal(currentFollowUpContact(base), null);
});
