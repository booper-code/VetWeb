import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, domHarness, loadSource } from './helpers/tsx-harness.mjs';

async function billingHarness() {
  const dom = domHarness();
  const { useBilling } = loadSource('../../lib/useBilling.ts', { react: React }, { window: dom.window });
  const entries = ['entry-4', 'entry-3', 'entry-2', 'entry-1'];
  let holdNext;
  const gateway = {
    pending: () => null,
    history: async (_id, after) => {
      if (after && holdNext) {
        const suspended = holdNext;
        holdNext = null;
        return suspended.promise;
      }
      const offset = after ? entries.indexOf(after) + 1 : 0;
      const page = entries.slice(offset, offset + 2);
      return { entries: page.map(id => ({ id })), next: offset + 2 < entries.length ? page.at(-1) : null };
    }
  };
  let session;
  function Screen({ sequence }) {
    session = useBilling('patient-1', gateway, true, sequence);
    return null;
  }
  const render = sequence => act(async () => dom.root.render(React.createElement(Screen, { sequence })));
  const ids = () => Array.from(session.entries, entry => entry.id);
  await render(4);
  return { dom, gateway, entries, render, ids, get session() { return session; }, suspendNext: pending => { holdNext = pending; } };
}

test('a confirmed remote billing append refreshes the loaded history without reducing its depth', async () => {
  const app = await billingHarness();
  try {
    await act(async () => app.session.loadMore());
    assert.deepEqual(app.ids(), ['entry-4', 'entry-3', 'entry-2', 'entry-1']);
    app.entries.unshift('entry-5');
    await app.render(5);
    assert.deepEqual(app.ids(), ['entry-5', 'entry-4', 'entry-3', 'entry-2']);
    assert.equal(app.session.hasMore, true);
  } finally { await app.dom.close(); }
});

test('a remote billing refresh retains a Load more request that is still in flight', async () => {
  const app = await billingHarness();
  try {
    const pending = deferred();
    app.suspendNext(pending);
    await act(async () => { void app.session.loadMore(); });
    app.entries.unshift('entry-5');
    await app.render(5);
    await act(async () => { pending.resolve({ entries: [{ id: 'stale' }], next: null }); });
    assert.deepEqual(app.ids(), ['entry-5', 'entry-4', 'entry-3', 'entry-2']);
  } finally { await app.dom.close(); }
});

test('a confirmed checkout clears its retry prompt before the history refresh returns', async () => {
  const app = await billingHarness();
  const operation = {
    clinicId: 'fictional-clinic', patientId: 'patient-1', operationId: 'payment-5', expectedPatientRevision: 4,
    draft: { kind: 'payment', amountMinor: 500, method: 'cash', occurredAtMs: 1000 },
  };
  const finished = deferred();
  const nextRead = deferred();
  try {
    app.gateway.submit = () => finished.promise;
    const submit = app.session.submit(operation);
    app.gateway.pending = async () => operation;
    await app.render(5); // Ledger advances before acknowledgement returns.
    assert.equal(app.session.pending?.operationId, 'payment-5');

    app.gateway.pending = () => nextRead.promise;
    await act(async () => { finished.resolve({ entry: { id: 'payment-5', clinicId: operation.clinicId } }); await submit; });
    assert.equal(app.session.pending, null);
  } finally {
    nextRead.resolve(null);
    await app.dom.close();
  }
});

test('a posted checkout whose acknowledgement is interrupted is distinguishable from an uncertain save', async () => {
  const app = await billingHarness();
  const operation = {
    operationId: 'payment-5', expectedPatientRevision: 4,
    draft: { kind: 'payment', amountMinor: 500, method: 'cash', occurredAtMs: 1000 },
  };
  try {
    app.gateway.submit = async () => ({
      entry: { id: 'payment-5', clinicId: 'fictional-clinic' }, needsPaymentAcknowledgement: true,
    });
    app.gateway.pending = async () => { throw new Error('Disconnected before marker could be read'); };
    await act(async () => { await app.session.submit(operation); });
    assert.equal(app.session.pending?.operationId, 'payment-5');
    assert.equal(app.session.pendingPaymentPosted, true);

    app.gateway.pending = async () => null;
    await act(async () => app.dom.window.dispatchEvent(new app.dom.window.Event('online')));
    assert.equal(app.session.pending, null);
    assert.equal(app.session.pendingPaymentPosted, false);
  } finally { await app.dom.close(); }
});

test('a recovery-marker read failure does not hide posted history', async () => {
  const app = await billingHarness();
  try {
    app.entries.unshift('entry-5');
    app.gateway.pending = async () => { throw new Error('Recovery marker read interrupted'); };
    await app.render(5);
    assert.deepEqual(app.ids(), ['entry-5', 'entry-4']);
  } finally { await app.dom.close(); }
});
