import test from 'node:test';
import assert from 'node:assert/strict';
import { isExpiryDate, manilaStockDay, stockAlertFor } from '../lib/stock-alert-values.ts';

const item = {
  itemCode: 'ITEMA', itemName: 'Fictional test medicine', category: 'Medicine',
  stock: 4, threshold: 2, buyingPrice: 0, sellingPrice: 1,
};
const today = '2026-11-20';

test('expiry dates must be real calendar dates, including century leap-year boundaries', () => {
  for (const date of ['2028-02-29', '2000-02-29', '0001-01-01', '9999-12-31']) assert.equal(isExpiryDate(date), true, date);
  for (const date of ['2026-02-29', '2100-02-29', '2026-04-31', '0000-01-01', '2026-11-00',
    '2026-2-01', '2026-13-01', '2026-11-20T00:00:00Z', null, 20261120]) assert.equal(isExpiryDate(date), false, String(date));
});

test('stock dates use Manila midnight, not the device date or UTC midnight', () => {
  assert.equal(manilaStockDay(new Date('2026-11-19T15:59:59Z')), '2026-11-19');
  assert.equal(manilaStockDay(new Date('2026-11-19T16:00:00Z')), '2026-11-20');
});

test('stock expiry distinguishes expired, today, and the inclusive 30-day warning', () => {
  for (const [expiryDate, reason] of [
    ['2026-11-19', 'expired'], ['2026-11-20', 'expires-today'], ['2026-11-21', 'expiring-soon'], ['2026-12-20', 'expiring-soon'],
  ]) assert.deepEqual(stockAlertFor({ ...item, expiryDate }, today)?.reasons, [reason]);
  assert.equal(stockAlertFor({ ...item, expiryDate: '2026-12-21' }, today), null);
  assert.equal(stockAlertFor({ ...item, expiryDate: '2026-02-29' }, today), null);
  assert.equal(stockAlertFor(item, today), null, 'undated legacy stock has no expiry alert');
});

test('reorder at a positive threshold combines with expiry without duplicating the item', () => {
  assert.deepEqual(stockAlertFor({ ...item, category: 'Supplies', stock: 2, expiryDate: today }, today), {
    itemCode: 'ITEMA', itemName: 'Fictional test medicine', stock: 2, threshold: 2,
    expiryDate: today, reasons: ['reorder', 'expires-today'],
  });
  assert.deepEqual(stockAlertFor({ ...item, stock: 0, expiryDate: today }, today)?.reasons, ['reorder']);
  assert.equal(stockAlertFor({ ...item, stock: 0, threshold: 0, expiryDate: today }, today), null);
  for (const category of ['Service', 'Grooming']) {
    assert.equal(stockAlertFor({ ...item, category, stock: 1, expiryDate: today }, today), null);
  }
});
