import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers/tsx-harness.mjs';

const { basePayForPeriod } = loadSource('../../lib/payroll.ts', {
  '@/lib/firebase': {}, '@/lib/clinical-mutations': {},
});
const monthly = { payBasis: 'monthly', rate: 21000 };
const period = (startDate, endDate) => ({ startDate, endDate });

test('monthly and daily payroll use calendar days regardless of device timezone', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['Asia/Manila', 'UTC', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      assert.equal(basePayForPeriod(monthly, period('2026-11-01', '2026-11-30')), 21000, zone);
      assert.equal(basePayForPeriod(monthly, period('2026-11-01', '2026-11-15')), 10000, zone);
      assert.equal(basePayForPeriod({ payBasis: 'daily', rate: 1000 }, period('2026-10-30', '2026-11-02')), 2000, zone);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('payroll rejects impossible or reversed dates and counts leap day', () => {
  assert.equal(basePayForPeriod(monthly, period('2026-02-29', '2026-03-01')), 0);
  assert.equal(basePayForPeriod(monthly, period('2026-11-30', '2026-11-01')), 0);
  assert.equal(basePayForPeriod({ payBasis: 'monthly', rate: 21000 }, period('2024-02-29', '2024-02-29')), 1000);
});
