import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers/tsx-harness.mjs';

const values = loadSource('../../lib/consultation-values.ts');

const inventory = [
  { itemCode: 'MED-1', itemName: 'Amoxicillin', category: 'Medicine', stock: 5, buyingPrice: 10, sellingPrice: 25, threshold: 2 },
  { itemCode: 'SUP-1', itemName: 'Bandage', category: 'Supplies', stock: 3, buyingPrice: 5, sellingPrice: 12, threshold: 1 },
  { itemCode: 'SRV-1', itemName: 'Consultation', category: 'Service', stock: 999, buyingPrice: 0, sellingPrice: 500, threshold: 0 }
];

const patient = {
  id: 'patient-1', name: 'Bantay', species: 'Canine', breed: 'Aspin', gender: 'Male',
  ownerName: 'Synthetic Owner', ownerContact: '09170000000', weight: 10,
  admissionTypes: [], reason: 'Checkup', status: 'Waiting', balance: 0
};

const line = (overrides = {}) => ({
  id: 'TRT-1', itemCode: 'MED-1', itemName: 'Amoxicillin', category: 'Medicine',
  quantity: 1, unitPrice: 25, dose: '0.5 mL', notes: '', ...overrides
});

const draft = (overrides = {}) => ({
  patientId: patient.id,
  occurredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  type: 'Consultation',
  notes: 'Day-end entry',
  treatments: [line(), { ...line({ id: 'TRT-2', itemCode: 'SRV-1', itemName: 'Consultation', category: 'Service', quantity: 1, unitPrice: 500 }) }],
  staffUid: 'editor-1',
  staffName: 'Synthetic Editor',
  ...overrides
});

test('a backdated treatment record validates and keeps visit time separate from entry time', () => {
  assert.equal(values.consultationValidationError(draft(), inventory), '');
  const occurredAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const recordedAt = new Date().toISOString();
  const record = values.buildConsultationRecord('CON-1', draft({ occurredAt }), patient, recordedAt);
  assert.equal(record.occurredAt, occurredAt);
  assert.equal(record.recordedAt, recordedAt);
  assert.equal(record.status, 'Completed');
  assert.equal(record.patientId, patient.id);
  assert.equal(record.patient, patient.name);
  assert.equal(record.client, patient.ownerName);
  assert.equal(record.treatments.length, 2);
  assert.equal(record.staffName, 'Synthetic Editor');
});

test('future, fractional, duplicated, oversold and oversized stock sets are rejected', () => {
  assert.match(values.consultationValidationError(draft({
    occurredAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  }), inventory), /cannot be in the future/);
  assert.match(values.consultationValidationError(draft({
    treatments: [line({ quantity: 1.5 })]
  }), inventory), /whole positive quantities/);
  assert.match(values.consultationValidationError(draft({
    treatments: [line(), line({ id: 'TRT-2' })]
  }), inventory), /only once/);
  assert.match(values.consultationValidationError(draft({
    treatments: [line({ quantity: 6 })]
  }), inventory), /Only 5/);
  assert.match(values.consultationValidationError(draft({
    treatments: [
      line(),
      line({ id: 'TRT-2', itemCode: 'SUP-1', itemName: 'Bandage', category: 'Supplies' }),
      line({ id: 'TRT-3', itemCode: 'MED-2', itemName: 'Other', category: 'Medicine' })
    ]
  }), inventory), /at most 2 stock items/);
  assert.match(values.consultationValidationError(draft({
    treatments: [line({ itemCode: 'MISSING', itemName: 'Missing' })]
  }), inventory), /not loaded/);
  assert.match(values.consultationValidationError(draft({
    type: 'Not a visit type'
  }), inventory), /valid visit type/);
});

test('stock moves once for medicine/supply lines and services never change stock', () => {
  const changes = values.treatmentStockChanges(draft().treatments, inventory);
  assert.deepEqual(changes.map(item => [item.itemCode, item.stock]), [['MED-1', 4]]);
  assert.equal(changes.some(item => item.itemCode === 'SRV-1'), false);

  const supply = values.treatmentStockChanges([line({
    id: 'TRT-3', itemCode: 'SUP-1', itemName: 'Bandage', category: 'Supplies', quantity: 2
  })], inventory);
  assert.equal(supply[0].stock, 1);
});

test('legacy rows still match by patient name and fall back to the display date', () => {
  const legacy = {
    id: 'SOAP-1', date: '06/22/2026', client: patient.ownerName, patient: patient.name,
    type: 'Consultation', status: 'Draft', notes: ''
  };
  assert.equal(values.consultationMatchesPatient(legacy, patient), true);
  assert.ok(values.consultationTime(legacy) > 0);
  assert.equal(values.consultationOccurredAt(legacy), '');

  const structured = values.buildConsultationRecord('CON-2', draft(), patient);
  assert.equal(values.consultationMatchesPatient({
    ...structured, patient: 'Another name'
  }, patient), true);
  assert.equal(values.consultationOccurredAt(structured), structured.occurredAt);
});
