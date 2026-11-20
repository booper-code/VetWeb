import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, domHarness, loadSource } from './helpers/tsx-harness.mjs';

class ManilaDate extends Date {
  constructor(value = '2026-11-19T17:00:00Z') { super(value); }
}
const item = {
  itemCode: 'sample', itemName: 'Fictional batch', category: 'Medicine',
  stock: 2, threshold: 2, expiryDate: '2026-11-20', buyingPrice: 1, sellingPrice: 2,
};

async function setup(props = {}) {
  const { StockAlerts } = loadSource('../../components/StockAlerts.tsx', { react: React }, { Date: ManilaDate });
  const dom = domHarness();
  const doc = dom.window.document;
  const defaults = { online: true, isCurrent: () => true, ...props };
  const render = (extra = {}, key = 'clinic') => act(async () => dom.root.render(React.createElement(StockAlerts, { key, ...defaults, ...extra })));
  const click = async label => {
    const button = [...doc.querySelectorAll('button')].find(el => el.textContent.trim() === label);
    assert.ok(button, `Missing button: ${label}`);
    await act(async () => button.click());
  };
  await render();
  return { ...dom, doc, render, click };
}

test('stock scans are on demand and partial coverage never claims no alerts', async () => {
  let reads = 0;
  const app = await setup({ load: async () => {
    reads += 1;
    return reads === 6 ? { rows: [item], next: null }
      : { rows: [{ ...item, itemCode: `quiet-${reads}`, stock: 8, expiryDate: undefined }], next: String(reads) };
  } });
  try {
    assert.equal(reads, 0);
    await app.click('Check stock alerts');
    assert.equal(reads, 5);
    assert.match(app.doc.body.textContent, /5 items checked.*Partial/s);
    assert.doesNotMatch(app.doc.body.textContent, /No stock alerts/);
    await app.click('Continue scan');
    assert.equal(reads, 6);
    assert.match(app.doc.body.textContent, /2026-11-20 Manila/);
    const rows = app.doc.querySelectorAll('li');
    assert.equal(rows.length, 1);
    assert.match(rows[0].textContent, /Fictional batch.*Reorder.*Expires today/s);
  } finally { await app.close(); }
});

test('retry resumes a failed scan and refresh discards outdated alerts', async () => {
  const cursors = [];
  let clear = false;
  const app = await setup({ load: async after => {
    cursors.push(after);
    if (clear) return { rows: [{ ...item, stock: 10, expiryDate: undefined }], next: null };
    if (after === null) return { rows: [item], next: 'sample' };
    if (cursors.length === 2) throw new Error('private error details');
    return { rows: [], next: null };
  } });
  try {
    await app.click('Check stock alerts');
    assert.match(app.doc.body.textContent, /stopped before completion/);
    assert.match(app.doc.body.textContent, /Fictional batch/);
    assert.doesNotMatch(app.doc.body.textContent, /No stock alerts|private error details/);
    await app.click('Retry scan');
    assert.deepEqual(cursors, [null, 'sample', 'sample']);
    clear = true;
    await app.click('Refresh alerts');
    assert.equal(cursors.at(-1), null);
    assert.match(app.doc.body.textContent, /No stock alerts/);
    assert.doesNotMatch(app.doc.body.textContent, /Fictional batch/);
  } finally { await app.close(); }
});

test('late stock pages cannot appear offline or in another workspace', async () => {
  const pending = deferred();
  let active = true;
  let reads = 0;
  const app = await setup({ isCurrent: () => active, load: () => { reads += 1; return pending.promise; } });
  try {
    await app.click('Check stock alerts');
    active = false;
    await app.render({ online: false }, 'offline');
    await act(async () => pending.resolve({ rows: [item], next: 'must-not-load' }));
    assert.equal(reads, 1);
    assert.match(app.doc.body.textContent, /Offline/);
    assert.doesNotMatch(app.doc.body.textContent, /Fictional batch|No stock alerts/);
    await app.render({ isCurrent: () => true }, 'other-clinic');
    assert.doesNotMatch(app.doc.body.textContent, /Fictional batch/);
    assert.equal(reads, 1);
  } finally { await app.close(); }
});
