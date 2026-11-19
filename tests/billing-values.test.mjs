import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = new URL('../lib/billing-values.ts', import.meta.url);
const load = async () => {
  const input = readFileSync(source, 'utf8');
  const { outputText } = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
};
const now = Date.parse('2026-11-19T12:00:00Z');
const cutoff = Date.parse('2026-11-18T10:00:00Z');
const dayStart = Date.parse('2026-11-18T16:00:00Z');
const checked = { lastEntryId: 'opening', seq: 1, openingMinor: 120000, balanceMinor: 120000, cutoffMs: cutoff, cutoffKind: 'reviewed' };
const payment = { kind: 'payment', amountMinor: 50000, method: 'cash', occurredAtMs: dayStart };
const line = (overrides = {}) => ({
  itemCode: 'M-1', itemName: 'Fixture', category: 'Medicine', stock: 8,
  quantity: 2, expectedRevision: 3, unitPriceMinor: 12500, ...overrides,
});

test('legacy amounts are not rounded or invented', async () => {
  const { parsePhpMinor, readLegacyBalance } = await load();
  assert.equal(parsePhpMinor('1200.05'), 120005);
  assert.equal(parsePhpMinor('0'), 0);
  assert.deepEqual(readLegacyBalance(0), { kind: 'valid', minor: 0 });
  assert.deepEqual(readLegacyBalance(1.15), { kind: 'valid', minor: 115 });
  for (const value of ['', '-1', '2.001', '1e2', '90071992547409.92']) {
    assert.throws(() => parsePhpMinor(value), undefined, value);
  }
  for (const value of [undefined, null, '0', NaN, Infinity, -1, 2.001]) {
    assert.deepEqual(readLegacyBalance(value), { kind: 'invalid' });
  }
});

test('Manila time is independent of the host', async () => {
  const { parseBillingLocalTime, billingDayStartMs } = await load();
  assert.equal(parseBillingLocalTime('2026-11-19T00:00'), dayStart);
  assert.equal(billingDayStartMs(dayStart - 1), Date.parse('2026-11-17T16:00:00Z'));
  assert.equal(billingDayStartMs(now), dayStart);
  for (const value of ['2026-02-30T12:00', '2026-11-19T24:00', '2026-11-19T08:00Z', '2026-11-19']) {
    assert.throws(() => parseBillingLocalTime(value), undefined, value);
  }
});

test('opening verification preserves the cutoff and requires evidence for a mismatch', async () => {
  const { calculateBillingTransition } = await load();
  const verify = { kind: 'opening', verifiedMinor: 120000, source: 'Paper ledger', cutoffMs: cutoff };
  assert.throws(() => calculateBillingTransition(null, 1500, verify, now));
  assert.throws(() => calculateBillingTransition(null, undefined, verify, now));
  assert.throws(() => calculateBillingTransition(null, 1200, { ...verify, cutoffMs: now + 1 }, now));
  const actual = calculateBillingTransition(null, 1500, { ...verify, reason: 'Duplicate legacy entry' }, now);
  assert.deepEqual(actual.next, {
    seq: 1, openingMinor: 120000, balanceMinor: 120000, cutoffMs: cutoff, cutoffKind: 'reviewed',
  });
  assert.deepEqual(actual.stockMoves, []);
  assert.throws(() => calculateBillingTransition(checked, 1200, verify, now));
});

test('opening cutoff and balances are enforced for payments', async () => {
  const { calculateBillingTransition } = await load();
  const apply = (draft, current = checked) => calculateBillingTransition(current, 1200, draft, now);
  assert.equal(apply(payment).next.balanceMinor, 70000);
  assert.deepEqual(apply(payment).stockMoves, []);
  for (const patch of [{ amountMinor: 120001 }, { amountMinor: 0 }, { occurredAtMs: cutoff },
    { occurredAtMs: cutoff - 1 }, { occurredAtMs: now + 1 }, { method: 'unknown' }]) {
    assert.throws(() => apply({ ...payment, ...patch }));
  }
  assert.equal(apply({ ...payment, amountMinor: 120000 }).next.balanceMinor, 0);
  assert.throws(() => apply(payment, null));
});

test('an explicit legacy zero starts on the first charge day, not the recording minute', async () => {
  const { calculateBillingTransition } = await load();
  const charge = { kind: 'charge', lines: [line()] };
  for (const raw of [undefined, 2.001, 1200]) assert.throws(() => calculateBillingTransition(null, raw, charge, now));
  const initial = calculateBillingTransition(null, 0, charge, now);
  assert.equal(initial.next.cutoffKind, 'implicit-zero');
  assert.equal(initial.next.cutoffMs, dayStart);
  assert.deepEqual(initial.stockMoves, [{ itemCode: 'M-1', quantityDelta: -2 }]);
  const state = { ...initial.next, lastEntryId: 'first-charge' };
  const atStart = { ...payment, amountMinor: 10000 };
  assert.equal(calculateBillingTransition(state, 0, atStart, now).next.balanceMinor, 15000);
  assert.throws(() => calculateBillingTransition(state, 0, { ...atStart, occurredAtMs: dayStart - 1 }, now));
});

test('charge money uses exact centavos and rejects duplicate lines or unavailable stock', async () => {
  const { calculateBillingTransition } = await load();
  const service = line({ itemCode: 'S-1', category: 'Service', stock: 0, quantity: 3, unitPriceMinor: 510 });
  const charge = lines => calculateBillingTransition(checked, 1200, { kind: 'charge', lines }, now);
  assert.equal(charge([line(), service]).next.balanceMinor, 146530);
  assert.deepEqual(charge([service]).stockMoves, []);
  for (const lines of [[line(), line()], [line({ stock: 1 })], [line({ quantity: 1.5 })],
    [line({ unitPriceMinor: Number.MAX_SAFE_INTEGER })], [line(), service, line({ itemCode: 'M-2' })]]) {
    assert.throws(() => charge(lines));
  }
});

test('correcting an opening amount preserves the cutoff and cannot create a credit', async () => {
  const { calculateBillingTransition } = await load();
  const afterPayment = { ...checked, balanceMinor: 70000, seq: 2 };
  const correction = { kind: 'opening-correction', verifiedMinor: 110000, source: 'Paper ledger', reason: 'Recounted' };
  const actual = calculateBillingTransition(afterPayment, 1200, correction, now);
  assert.equal(actual.next.balanceMinor, 60000);
  assert.equal(actual.next.cutoffMs, cutoff);
  assert.deepEqual(actual.stockMoves, []);
  assert.throws(() => calculateBillingTransition(afterPayment, 1200, { ...correction, verifiedMinor: 49999 }, now));
  assert.throws(() => calculateBillingTransition({ ...afterPayment, openingMinor: 0, cutoffKind: 'implicit-zero' }, 0, correction, now));
});

test('payment reversal restores the balance but never stock', async () => {
  const { calculateBillingTransition } = await load();
  const afterPayment = { ...checked, balanceMinor: 70000, seq: 2 };
  const draft = {
    kind: 'reversal', originalEntryId: 'payment', reason: 'Duplicate entry', returnStock: false,
    expectedStockRevisions: {}, original: { kind: 'payment', amountMinor: 50000, stockMoves: [] },
  };
  const result = calculateBillingTransition(afterPayment, 1200, draft, now);
  assert.equal(result.next.balanceMinor, 120000);
  assert.deepEqual(result.stockMoves, []);
  assert.throws(() => calculateBillingTransition(afterPayment, 1200, { ...draft, returnStock: true }, now));
});

test('unitemized settlement clears the reviewed balance and reverses without stock', async () => {
  const { calculateBillingTransition, parseBillingDay } = await load();
  assert.equal(parseBillingDay('2026-11-19'), dayStart);
  assert.throws(() => parseBillingDay('2026-02-30'));
  const current = { ...checked, balanceMinor: 70000, seq: 2 };
  const draft = { kind: 'unitemized-settlement', businessDayMs: dayStart, amountMinor: 70000 };
  const result = calculateBillingTransition(current, 1200, draft, now);
  assert.equal(result.next.balanceMinor, 0);
  assert.equal(result.next.openingMinor, 120000);
  assert.equal(result.next.cutoffMs, cutoff);
  assert.equal(result.deltaMinor, -70000);
  assert.deepEqual(result.stockMoves, []);
  const reversal = { kind: 'reversal', originalEntryId: 'settlement', reason: 'Wrong date', returnStock: false,
    expectedStockRevisions: {}, original: { ...draft, stockMoves: [] } };
  assert.equal(calculateBillingTransition(result.next, 1200, reversal, now).next.balanceMinor, 70000);
  assert.throws(() => calculateBillingTransition(result.next, 1200, { ...reversal, returnStock: true }, now));
});

test('settlement rejects unknown or stale balances and dates outside ledger coverage', async () => {
  const { calculateBillingTransition } = await load();
  const current = { ...checked, balanceMinor: 70000 };
  const draft = { kind: 'unitemized-settlement', businessDayMs: dayStart, amountMinor: 70000 };
  assert.throws(() => calculateBillingTransition(null, undefined, draft, now));
  assert.throws(() => calculateBillingTransition({ ...current, balanceMinor: 0 }, 1200, draft, now));
  for (const patch of [{ amountMinor: 69999 }, { businessDayMs: dayStart + 1 },
    { businessDayMs: dayStart - 2 * 86400000 }, { businessDayMs: dayStart + 86400000 }]) {
    assert.throws(() => calculateBillingTransition(current, 1200, { ...draft, ...patch }, now));
  }
  assert.equal(calculateBillingTransition(current, 1200, { ...draft, businessDayMs: dayStart - 86400000 }, now).next.balanceMinor, 0);
});

test('reversing a charge changes stock only when the physical return was confirmed', async () => {
  const { calculateBillingTransition } = await load();
  const afterCharge = { ...checked, balanceMinor: 145000, seq: 2 };
  const draft = {
    kind: 'reversal', originalEntryId: 'charge', reason: 'Dispense correction', returnStock: false,
    expectedStockRevisions: {}, original: { kind: 'charge', amountMinor: 25000, stockMoves: [{ itemCode: 'M-1', quantityDelta: -2 }] },
  };
  const reverse = (input, current = afterCharge) => calculateBillingTransition(current, 1200, input, now);
  assert.equal(reverse(draft).next.balanceMinor, 120000);
  assert.deepEqual(reverse(draft).stockMoves, []);
  assert.deepEqual(reverse({ ...draft, returnStock: true, expectedStockRevisions: { 'M-1': 4 } }).stockMoves, [
    { itemCode: 'M-1', quantityDelta: 2 },
  ]);
  assert.throws(() => reverse(draft, { ...afterCharge, balanceMinor: 24999 }));
});
