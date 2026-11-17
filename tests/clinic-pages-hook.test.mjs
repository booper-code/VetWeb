import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, loadSource, domHarness } from './helpers/tsx-harness.mjs';

for (const transition of ['switch', 'wipe', 'logout']) {
  test(`pagination discards old completions after ${transition} and first loads remain usable`, async () => {
    const dom = domHarness();
    const requests = [];
    let result;
    const { useClinicPages } = loadSource('../../lib/useClinicPages.ts', {
      react: React,
      '@/lib/clinic-pages': {
        appendUnique: (old, incoming, identity) => [...old, ...incoming.filter(record => !old.some(item => identity(item) === identity(record)))],
        loadClinicPage(clinicId, kind, cursor) {
          const pending = deferred();
          requests.push({ clinicId, kind, cursor, ...pending });
          return pending.promise;
        },
      },
    });
    function Screen({ clinicId, authenticated }) {
      const [patients, setPatients] = React.useState([]);
      const [inventory, setInventory] = React.useState([]);
      const [consultations, setConsultations] = React.useState([]);
      const pages = useClinicPages({ clinicId, authenticated, setPatients, setInventory, setConsultations });
      result = { pages, patients, inventory, consultations };
      return null;
    }
    const render = (clinicId, authenticated = true) =>
      act(async () => { dom.root.render(React.createElement(Screen, { clinicId, authenticated })); });
    const page = label => ({ records: [{ id: 'shared', itemCode: 'shared', name: label }], cursor: label, hasMore: true });
    try {
      await render('clinic-a');
      assert.equal(requests.length, 3);
      if (transition !== 'switch') await render(null, false);
      await render('clinic-b');
      assert.equal(requests.length, 6, 'all new-clinic first pages must start');
      await act(async () => {
        requests[0].resolve(page('stale A'));
        requests[1].reject(new Error('stale failure'));
        requests[2].resolve(page('stale A'));
      });
      assert.equal(result.patients.length, 0);
      assert.equal(result.inventory.length, 0);
      assert.equal(result.consultations.length, 0);
      assert.equal(result.pages.state.inventory.error, '');
      assert.equal(result.pages.state.inventory.busy, true);
      await act(async () => { await result.pages.load('inventory'); });
      assert.equal(requests.length, 6, 'old finally must not unlock a new-clinic in-flight page');
      await act(async () => { for (const request of requests.slice(3)) request.resolve(page('current B')); });
      assert.equal(result.patients[0].name, 'current B');
      assert.equal(result.inventory[0].name, 'current B');
      assert.equal(result.consultations[0].name, 'current B');
      let loading;
      await act(async () => { loading = result.pages.load('inventory'); });
      assert.equal(requests.length, 7);
      assert.equal(requests[6].cursor, 'current B');
      await act(async () => { requests[6].resolve(page('duplicate B')); await loading; });
      assert.equal(result.inventory.length, 1);
    } finally { await dom.close(); }
  });
}
