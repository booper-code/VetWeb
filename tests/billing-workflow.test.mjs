import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, loadSource, domHarness } from './helpers/tsx-harness.mjs';

const cutoffMs = Date.parse('2026-11-18T10:00:00Z');
const base = { id: 'dobby', name: 'Dobby', balance: 1500, revision: 3,
  billableItems: [{ id: 'old', itemName: 'Legacy visit', date: '2026-11-18', quantity: 1, total: 1500 }] };
const state = { lastEntryId: 'opening', seq: 1, openingMinor: 120000, balanceMinor: 120000, cutoffKind: 'reviewed', cutoffMs };
const paid = { id: 'paid', kind: 'payment', amountMinor: 50000, balanceAfterMinor: 70000, method: 'cash', occurredAtMs: cutoffMs + 3600000, recordedAtMs: cutoffMs + 3600000, stockMoves: [] };
const receipt = { ...paid, patientName: 'Dobby at the time', clinicName: 'Old clinic name', reversed: true };
class FixtureDate extends Date {
  static now() { return Date.parse('2026-11-19T12:00:00Z'); }
}

async function setup({ patient = base, entries = [], canEdit = true, onSubmit = async () => {}, onReceipt = async () => receipt } = {}) {
  const dom = domHarness();
  const submissions = [], pdfs = [], refreshes = [];
  const { PatientBilling } = loadSource('../../components/PatientBilling.tsx', {
    react: React,
    '@/lib/pdf': { exportPaymentReceiptPdf: async value => { pdfs.push(value); } },
  }, { window: dom.window, document: dom.window.document, Date: FixtureDate });
  const billing = {
    entries, busy: false, error: '', hasMore: false,
    submit: async operation => { submissions.push(operation); return onSubmit(operation); },
    receipt: onReceipt, refresh: async () => { refreshes.push(true); }, loadMore: async () => {},
  };
  const render = (next = patient) => act(() => dom.root.render(React.createElement(PatientBilling, { patient: next, inventory: [], canEdit, billing })));
  await render();
  const doc = dom.window.document;
  const click = async text => {
    const button = Array.from(doc.querySelectorAll('button')).find(b => b.textContent.trim() === text);
    assert.ok(button, `button not found: ${text}`);
    await act(() => button.click());
    return button;
  };
  const fill = async (label, value) => {
    const el = Array.from(doc.querySelectorAll('label')).find(l => l.firstChild?.textContent.trim() === label)?.querySelector('input, textarea, select');
    assert.ok(el, `field not found: ${label}`);
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    await act(() => {
      set.call(el, value);
      el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
  };
  return { ...dom, doc, click, fill, render, submissions, pdfs, refreshes };
}

test('mark paid in full confirms once without installment details', async () => {
  const app = await setup({ patient: { ...base, billing: { ...state, balanceMinor: 70000 } } });
  try {
    await app.click('Mark paid in full');
    const dialog = app.doc.querySelector('dialog[open]');
    assert.match(dialog.textContent, /Installment dates and methods won’t be recorded/);
    assert.doesNotMatch(dialog.textContent, /Payment method/);
    assert.match(dialog.textContent, /PHP 700\.00/);
    await app.fill('Fully paid on (Asia/Manila)', '2026-11-19');
    const confirm = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm paid in full');
    assert.ok(confirm);
    await act(() => { confirm.click(); confirm.click(); });
    assert.equal(app.submissions.length, 1);
    const { draft, expectedPatientRevision } = app.submissions[0];
    assert.equal(draft.kind, 'unitemized-settlement');
    assert.equal(draft.amountMinor, 70000);
    assert.equal(draft.businessDayMs, Date.parse('2026-11-18T16:00:00Z'));
    assert.equal(expectedPatientRevision, 3);
  } finally { await app.close(); }
});

test('a changed balance must be shown before confirming settlement again', async () => {
  const patient = { ...base, billing: { ...state, balanceMinor: 70000 } };
  const app = await setup({ patient });
  try {
    await app.click('Mark paid in full');
    await app.render({ ...patient, revision: 4, billing: { ...patient.billing, balanceMinor: 75000 } });
    await app.click('Confirm paid in full');
    assert.equal(app.submissions.length, 0);
    assert.equal(app.refreshes.length, 1);
    assert.match(app.doc.querySelector('dialog[open]').textContent, /PHP 750\.00/);
    await app.click('Confirm paid in full');
    assert.equal(app.submissions[0].draft.amountMinor, 75000);
    assert.equal(app.submissions[0].expectedPatientRevision, 4);
  } finally { await app.close(); }
});

test('only an editor with a positive ledger balance can open the shortcut; settlements have no receipt', async () => {
  for (const options of [{ patient: base }, { patient: { ...base, billing: { ...state, balanceMinor: 0 } } },
    { patient: { ...base, billing: state }, canEdit: false }]) {
    const app = await setup(options);
    try { assert.doesNotMatch(app.doc.body.textContent, /Mark paid in full/); }
    finally { await app.close(); }
  }
  const settled = { id: 'settled', kind: 'unitemized-settlement', businessDayMs: Date.parse('2026-11-18T16:00:00Z'), amountMinor: 70000, stockMoves: [] };
  const app = await setup({ entries: [settled] });
  try {
    assert.match(app.doc.body.textContent, /Paid in full — installments not itemized/);
    assert.doesNotMatch(app.doc.body.textContent, /Print receipt/);
    await app.click('Reverse entry');
    assert.match(app.doc.querySelector('dialog[open]').textContent, /restore the outstanding balance/);
  } finally { await app.close(); }
});

test('opening review can be postponed without writing and restores focus', async () => {
  const app = await setup();
  try {
    const opener = await app.click('Verify opening balance');
    assert.ok(app.doc.querySelector('dialog[open]'));
    await app.click('Not now');
    assert.equal(app.doc.querySelector('dialog[open]'), null);
    assert.equal(app.doc.activeElement, opener);
    assert.equal(app.submissions.length, 0);
    assert.doesNotMatch(app.doc.body.textContent, /Clear.*balance/i);
    assert.match(app.doc.body.textContent, /Legacy visit/);
  } finally { await app.close(); }
});

test('mismatch confirmation posts an opening, not a payment', async () => {
  const app = await setup();
  try {
    await app.click('Verify opening balance');
    await app.click('No, it differs');
    await app.fill('Verified amount', '1200');
    await app.fill('Checked against', 'Paper ledger');
    await app.fill('Balance as of (Asia/Manila)', '2026-11-18T18:00');
    await app.click('Review update');
    assert.match(app.doc.querySelector('[role=alert]').textContent, /reason/i);
    await app.fill('Reason for correction', 'Repeated item');
    await app.click('Review update');
    assert.match(app.doc.body.textContent, /PHP 1,500\.00 → PHP 1,200\.00/);
    assert.equal(app.submissions.length, 0);
    await app.click('Confirm PHP 1,200.00');
    assert.deepEqual(app.submissions.map(({ draft }) => [draft.kind, draft.verifiedMinor, draft.cutoffMs]), [['opening', 120000, cutoffMs]]);
    assert.doesNotMatch(app.doc.body.textContent, /Print receipt/);
  } finally { await app.close(); }
});

test('an uncertain payment save retains the exact reviewed intent for retry', async () => {
  let calls = 0;
  const app = await setup({ patient: { ...base, billing: state, balance: 1200 },
    onSubmit: async () => { if (++calls === 1) throw new Error('Lost response'); } });
  try {
    await app.click('Record payment');
    await app.fill('Amount received (PHP)', '500');
    await app.fill('Received at (Asia/Manila)', '2026-11-19T10:00');
    await app.click('Review update');
    assert.match(app.doc.body.textContent, /PHP 1,200\.00 → PHP 700\.00/);
    assert.equal(app.submissions.length, 0);
    await app.click('Confirm payment');
    assert.match(app.doc.body.textContent, /Lost response/);
    assert.doesNotMatch(app.doc.body.textContent, /Print receipt/);
    await app.click('Retry same review');
    assert.equal(app.submissions.length, 2);
    assert.equal(app.submissions[0].operationId, app.submissions[1].operationId);
    assert.equal(app.submissions[1].draft.amountMinor, 50000);
  } finally { await app.close(); }
});

test('printing uses the saved receipt even when patient and clinic names change', async () => {
  const app = await setup({ patient: { ...base, name: 'Renamed', billing: state }, entries: [paid, {
    id: 'reverse_paid', kind: 'reversal', originalEntryId: 'paid', amountMinor: 50000, stockMoves: [], reason: 'Mistake',
  }] });
  try {
    assert.match(app.doc.body.textContent, /Reversed/);
    await app.click('Print receipt');
    assert.deepEqual(app.pdfs, [receipt]);
  } finally { await app.close(); }
});

test('a stale payment confirmation retains the draft and demands a fresh review', async () => {
  const app = await setup({ patient: { ...base, billing: state, balance: 1200 },
    onSubmit: async () => { throw Object.assign(new Error('Stale version'), { name: 'ClinicalConflictError' }); } });
  try {
    await app.click('Record payment');
    await app.fill('Amount received (PHP)', '500');
    await app.fill('Received at (Asia/Manila)', '2026-11-19T10:00');
    await app.click('Review update');
    await app.click('Confirm payment');
    assert.match(app.doc.querySelector('[role=alert]').textContent, /changed/i);
    assert.equal(app.doc.querySelector('input[inputmode=decimal]').value, '500');
    assert.doesNotMatch(app.doc.querySelector('dialog').textContent, /Retry same review/);
    await app.click('Review update');
    assert.equal(app.submissions.length, 1);
  } finally { await app.close(); }
});
