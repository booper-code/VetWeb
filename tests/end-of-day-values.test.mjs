import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers/tsx-harness.mjs';

const values = () => loadSource('../../lib/end-of-day-values.ts');

test('collections sum unreversed posted payments only', () => {
  const { summarizeCollections } = values();
  const row = (entry, reversed = false) => ({ entry, reversed });
  assert.deepEqual({ ...summarizeCollections([
    row({ kind: 'payment', method: 'cash', amountMinor: 50000 }),
    row({ kind: 'payment', method: 'card', amountMinor: 25 }),
    row({ kind: 'payment', method: 'cash', amountMinor: 1900 }, true),
    row({ kind: 'unitemized-settlement', amountMinor: 70000 }),
  ]) }, { cash: 50000n, 'e-wallet': 0n, 'bank-transfer': 0n, card: 25n, other: 0n });
});

test('debt keeps legacy and unknown separate and displays large centavo totals exactly', () => {
  const { summarizeBalances, formatCloseMinor } = values();
  assert.deepEqual({ ...summarizeBalances([
    { ledgerMinor: 70000, legacyBalance: 1500 },
    { ledgerMinor: 0, legacyBalance: 1500 },
    { legacyBalance: 4.55 },
    { legacyBalance: 0 },
    {},
    { legacyBalance: 1.234 },
  ]) }, { ledgerMinor: 70000n, unverifiedMinor: 455n, unverifiedCount: 2, unknownCount: 2 });
  assert.equal(formatCloseMinor(9007199254740993n), 'PHP 90,071,992,547,409.93');
});

test('demo close uses the same business dates and explicit links without connecting to Firebase', async () => {
  const { createDemoEndOfDayLoader } = loadSource('../../lib/end-of-day.ts', {
    '@/lib/firebase': { initializeFirebase: () => { throw new Error('Unexpected network initialization'); } },
  });
  const start = Date.parse('2026-11-18T16:00:00Z');
  const next = Date.parse('2026-11-19T16:00:00Z');
  const common = { clinicId: 'demo-clinic', patientId: 'demo-patient', amountMinor: 5500 };
  const load = createDemoEndOfDayLoader({
    entries: [
      { ...common, id: 'payment', kind: 'payment', businessDayMs: start, recordedAtMs: start, method: 'cash' },
      { ...common, id: 'reverse_payment', kind: 'reversal', originalEntryId: 'payment', recordedAtMs: next },
    ],
    appointments: [{ id: 'visit', patientId: 'demo-patient', patientName: 'Toy patient', status: 'completed',
      dueAt: '2026-11-18T10:00:00Z', occurredAt: '2026-11-18T16:00:00Z' }],
    consultations: [{ appointmentId: 'visit', patientId: 'demo-patient', status: 'Draft' }],
    patients: [],
  });
  const scope = { clinicId: 'demo-clinic', uid: 'demo', dayStartMs: start, after: null };
  assert.equal((await load('entries', scope)).rows[0].reversed, true);
  assert.equal((await load('corrections', scope)).rows.length, 0);
  assert.equal((await load('corrections', { ...scope, dayStartMs: next })).rows[0].original.id, 'payment');
  assert.equal((await load('visits', scope)).rows[0].linkedTreatment, false);
});
