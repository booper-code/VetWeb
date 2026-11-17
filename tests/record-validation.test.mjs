import test from 'node:test';
import assert from 'node:assert/strict';
import { patientValidationError, inventoryValidationError } from '../lib/record-validation.ts';
const patient = {
  name: 'Synthetic patient', gender: 'Unknown', status: 'Waiting', weight: 0, balance: 0,
  ownerContact: '0917-123-4567'
};
const item = { itemName: 'Synthetic', category: 'Supplies', stock: 1, buyingPrice: 0, sellingPrice: 1, threshold: 0 };
test('valid legacy formatted contacts and non-negative records are accepted', () => {
  assert.equal(patientValidationError(patient), null);
  assert.equal(inventoryValidationError(item), null);
});
test('non-finite, negative and invalid clinical fields are rejected', () => {
  for (const change of [{ weight: -1 }, { weight: NaN }, { balance: Infinity }, { name: '' }, { gender: 'Other' }, { ownerContact: 'bad' }, { ownerEmail: 'bad' }]) {
    assert.ok(patientValidationError({ ...patient, ...change }));
  }
  for (const change of [{ stock: -1 }, { sellingPrice: Infinity }, { threshold: NaN }, { category: 'Other' }, { itemName: '' }]) {
    assert.ok(inventoryValidationError({ ...item, ...change }));
  }
});
