import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, domHarness, loadSource } from './helpers/tsx-harness.mjs';

async function billingHarness() {
  const dom = domHarness();
  const { useBilling } = loadSource('../../lib/useBilling.ts', { react: React });
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
  return { dom, entries, render, ids, get session() { return session; }, suspendNext: pending => { holdNext = pending; } };
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
