import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, loadSource, domHarness } from './helpers/tsx-harness.mjs';

const patient = {
  id: 'patient-1', name: 'Bantay', species: 'Canine', breed: 'Aspin', gender: 'Male',
  ownerName: 'Synthetic Owner', ownerContact: '09170000000', weight: 10,
  admissionTypes: [], reason: 'Checkup', status: 'Waiting', balance: 0
};
const inventory = [
  { itemCode: 'MED-1', itemName: 'Amoxicillin', category: 'Medicine', stock: 5, buyingPrice: 10, sellingPrice: 25, threshold: 2 },
  { itemCode: 'SRV-1', itemName: 'Consultation', category: 'Service', stock: 999, buyingPrice: 0, sellingPrice: 500, threshold: 0 }
];
const existing = {
  id: 'CON-EXISTING', revision: 1, date: '11/17/2026', client: patient.ownerName, patient: patient.name,
  type: 'Vaccination', status: 'Completed', notes: 'Annual booster.',
  patientId: patient.id, occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
  recordedAt: new Date().toISOString(), staffUid: 'editor-1', staffName: 'Dr. Reyes',
  treatments: [{ id: 'TRT-1', itemCode: 'MED-1', itemName: 'Amoxicillin', category: 'Medicine', quantity: 1, unitPrice: 25, dose: '1 tablet', notes: '' }],
  stockMoves: [{ itemCode: 'MED-1', quantity: 1 }]
};

const setValue = (dom, element, value) => {
  const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

async function renderActivity({
  canEdit = true, onSave = async () => true, appointmentId = null, initialOccurredAt
} = {}) {
  const dom = domHarness();
  const calls = { saves: [], toasts: [] };
  const { ClinicalActivity } = loadSource('../../components/ClinicalActivity.tsx', {}, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator
  });
  await act(async () => dom.root.render(React.createElement(ClinicalActivity, {
    patient, consultations: [existing], inventory, canEdit,
    staffUid: 'editor-1', staffName: 'Synthetic Editor', appointmentId, initialOccurredAt,
    onSave: draft => { calls.saves.push(draft); return onSave(draft); },
    triggerToast: message => calls.toasts.push(message)
  })));
  return { dom, calls };
}

test('clinical activity lists existing treatments with visit and recorded times', async () => {
  const { dom } = await renderActivity();
  try {
    const text = dom.window.document.body.textContent;
    assert.match(text, /Clinical activity/);
    assert.match(text, /Vaccination/);
    assert.match(text, /Amoxicillin × 1/);
    assert.match(text, /Dr\. Reyes/);
    assert.match(text, /Recorded /);
  } finally { await dom.close(); }
});

test('editor records a treatment draft with an ISO visit time and stock line', async () => {
  const { dom, calls } = await renderActivity();
  try {
    const button = [...dom.window.document.querySelectorAll('button')]
      .find(element => element.textContent.trim() === 'Record treatment');
    assert.ok(button);
    await act(() => button.click());

    const item = dom.window.document.querySelector('select[aria-label="Treatment item"]');
    const quantity = dom.window.document.querySelector('input[aria-label="Quantity"]');
    assert.ok(item && quantity);
    await act(() => {
      setValue(dom, item, 'MED-1');
      setValue(dom, quantity, '2');
    });
    const add = [...dom.window.document.querySelectorAll('button')]
      .find(element => element.textContent.includes('Add line'));
    await act(() => add.click());
    assert.match(dom.window.document.body.textContent, /Amoxicillin × 2/);

    const save = [...dom.window.document.querySelectorAll('button')]
      .find(element => element.textContent.includes('Save treatment'));
    await act(async () => { await save.click(); });

    assert.equal(calls.saves.length, 1);
    const draft = calls.saves[0];
    assert.equal(draft.patientId, patient.id);
    assert.equal(draft.staffUid, 'editor-1');
    assert.equal(draft.staffName, 'Synthetic Editor');
    assert.equal(Number.isFinite(Date.parse(draft.occurredAt)), true);
    assert.equal(draft.treatments.length, 1);
    assert.equal(draft.treatments[0].itemCode, 'MED-1');
    assert.equal(draft.treatments[0].quantity, 2);
    assert.match(calls.toasts.at(-1), /Stock moves were applied once/);
    assert.equal(dom.window.document.querySelector('select[aria-label="Treatment item"]'), null);
  } finally { await dom.close(); }
});

test('a completed appointment opens a linked form with the visit time prefilled', async () => {
  const occurredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { dom, calls } = await renderActivity({ appointmentId: 'APPT-1', initialOccurredAt: occurredAt });
  try {
    assert.ok(dom.window.document.querySelector('select[aria-label="Treatment item"]'));
    assert.match(dom.window.document.body.textContent, /Linked to the completed appointment visit/);
    const save = [...dom.window.document.querySelectorAll('button')]
      .find(element => element.textContent.includes('Save treatment'));
    await act(async () => { await save.click(); });
    assert.equal(calls.saves.length, 1);
    assert.match(calls.toasts.at(-1), /No stock changed/);
    assert.equal(calls.saves[0].appointmentId, 'APPT-1');
    // datetime-local keeps minute precision, matching what the form shows.
    assert.equal(
      Math.floor(Date.parse(calls.saves[0].occurredAt) / 60_000),
      Math.floor(Date.parse(occurredAt) / 60_000)
    );
  } finally { await dom.close(); }
});

test('a viewer cannot open the treatment form', async () => {
  const { dom } = await renderActivity({ canEdit: false });
  try {
    assert.equal([...dom.window.document.querySelectorAll('button')]
      .some(element => element.textContent.includes('Record treatment')), false);
    assert.match(dom.window.document.body.textContent, /View-only/);
  } finally { await dom.close(); }
});

test('stock beyond the loaded amount is rejected before save', async () => {
  const { dom, calls } = await renderActivity();
  try {
    await act(() => [...dom.window.document.querySelectorAll('button')]
      .find(element => element.textContent.trim() === 'Record treatment').click());
    const item = dom.window.document.querySelector('select[aria-label="Treatment item"]');
    const quantity = dom.window.document.querySelector('input[aria-label="Quantity"]');
    await act(() => {
      setValue(dom, item, 'MED-1');
      setValue(dom, quantity, '9');
    });
    await act(() => [...dom.window.document.querySelectorAll('button')]
      .find(element => element.textContent.includes('Add line')).click());
    assert.match(dom.window.document.querySelector('[role="alert"]').textContent, /Only 5/);
    assert.equal(calls.saves.length, 0);
  } finally { await dom.close(); }
});
