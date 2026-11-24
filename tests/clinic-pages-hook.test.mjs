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
        CLINIC_PAGE_SIZE: 50,
        appendUnique: (old, incoming, identity) => [...old, ...incoming.filter(record => !old.some(item => identity(item) === identity(record)))],
        subscribeClinicInventory: async () => () => {},
        loadClinicPage(clinicId, kind, cursor) {
          const pending = deferred();
          requests.push({ clinicId, kind, cursor, ...pending });
          return pending.promise;
        },
      },
    });
    function Screen({ clinicId, uid, authenticated }) {
      const [patients, setPatients] = React.useState([]);
      const [inventory, setInventory] = React.useState([]);
      const [consultations, setConsultations] = React.useState([]);
      const pages = useClinicPages({ clinicId, uid, authenticated, setPatients, setInventory, setConsultations });
      result = { pages, patients, inventory, consultations };
      return null;
    }
    const render = (clinicId, authenticated = true, uid = 'user-a') =>
      act(async () => { dom.root.render(React.createElement(Screen, { clinicId, uid, authenticated })); });
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

const inventoryItem = (itemCode, itemName, revision = 1, stock = 1) => ({
  itemCode, itemName, category: 'Medicine', stock,
  buyingPrice: 1, sellingPrice: 2, threshold: 0, revision,
});
const snapshotPage = (records, cursor = null, hasMore = false) => ({ records, cursor, hasMore });

function createHookHarness() {
  const dom = domHarness();
  const loads = [], subscriptions = [], unsubscribes = [];
  let result;
  const { useClinicPages } = loadSource('../../lib/useClinicPages.ts', {
    react: React,
    '@/lib/clinic-pages': {
      CLINIC_PAGE_SIZE: 50,
      isClinicInventoryAccessDenied: error => ['permission-denied', 'unauthenticated'].includes(error?.code),
      appendUnique: (old, incoming, identity) => [...old, ...incoming.filter(record => !old.some(item => identity(item) === identity(record)))],
      loadClinicPage(clinicId, kind, cursor) {
        const pending = deferred();
        loads.push({ clinicId, kind, cursor, ...pending });
        return pending.promise;
      },
      subscribeClinicInventory(clinicId, size, onServer, onError, uid, onDenied) {
        const pending = deferred();
        subscriptions.push({ clinicId, size, onServer, onError, uid, onDenied, ...pending });
        return pending.promise;
      },
    },
  });
  function Screen({ clinicId, uid, authenticated }) {
    const [patients, setPatients] = React.useState([]);
    const [inventory, setInventory] = React.useState([]);
    const [consultations, setConsultations] = React.useState([]);
    const pages = useClinicPages({ clinicId, uid, authenticated, setPatients, setInventory, setConsultations });
    result = { pages, patients, inventory, consultations };
    return null;
  }
  return {
    dom, loads, subscriptions, unsubscribes,
    current: () => result,
    render: (clinicId, authenticated = true, uid = 'user-a') =>
      act(async () => { dom.root.render(React.createElement(Screen, { clinicId, uid, authenticated })); }),
  };
}

test('inventory shows the first batch then replaces it with each confirmed server snapshot', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    assert.deepEqual(hook.loads.map(request => request.kind).sort(),
      ['activePatients', 'consultations', 'inventory']);
    await act(async () => {
      for (const request of hook.loads) request.resolve(request.kind === 'inventory'
        ? snapshotPage([inventoryItem('ITM-1', 'First')], 'cursor-1', true)
        : snapshotPage([], null, false));
    });
    assert.equal(hook.current().inventory[0].itemName, 'First',
      'the first batch stays readable before the listener confirms it');
    assert.equal(hook.subscriptions.length, 1);
    assert.equal(hook.subscriptions[0].clinicId, 'clinic-a');
    assert.equal(hook.subscriptions[0].size, 50);
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));

    await act(async () => hook.subscriptions[0].onServer(
      snapshotPage([inventoryItem('ITM-1', 'Server update', 2)], 'cursor-1', false)));
    assert.deepEqual(hook.current().inventory.map(item => [item.itemCode, item.itemName]),
      [['ITM-1', 'Server update']]);
    assert.equal(hook.current().pages.state.inventory.hasMore, false);

    await act(async () => hook.subscriptions[0].onServer(snapshotPage([
      inventoryItem('ITM-1', 'Server stock', 3, 9), inventoryItem('ITM-2', 'Second', 1),
    ], 'cursor-1', true)));
    assert.deepEqual(hook.current().inventory.map(item => [item.itemCode, item.stock]),
      [['ITM-1', 9], ['ITM-2', 1]]);
    assert.equal(hook.current().pages.state.inventory.hasMore, true);

    await act(async () => hook.subscriptions[0].onServer(snapshotPage([], null, false)));
    assert.equal(hook.current().inventory.length, 0, 'deletions come from the confirmed snapshot');
  } finally { await hook.dom.close(); }
});

test('a second inventory page stays visible while the watched prefix widens', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(request.kind === 'inventory'
        ? snapshotPage([inventoryItem('ITM-1', 'First'), inventoryItem('ITM-2', 'Second')], 'cursor-1', true)
        : snapshotPage([], null, false));
    });
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));

    let loading;
    await act(async () => { loading = hook.current().pages.load('inventory'); });
    assert.equal(hook.loads.length, 4);
    assert.equal(hook.loads[3].cursor, 'cursor-1');
    await act(async () => {
      hook.loads[3].resolve(snapshotPage([inventoryItem('ITM-3', 'Third')], 'cursor-2', false));
      await loading;
    });
    assert.equal(hook.current().inventory.length, 3);
    assert.equal(hook.subscriptions.length, 2);
    assert.equal(hook.subscriptions[1].size, 100);
    assert.deepEqual(hook.unsubscribes, ['first']);

    await act(async () => hook.subscriptions[0].onServer(
      snapshotPage([inventoryItem('STALE', 'Stale')], null, false)));
    assert.equal(hook.current().inventory.length, 3, 'the replaced listener must ignore old callbacks');
    await act(async () => hook.subscriptions[1].resolve(() => hook.unsubscribes.push('second')));
    assert.equal(hook.current().inventory.length, 3, 'widening the prefix keeps confirmed rows visible');

    await act(async () => hook.subscriptions[1].onServer(snapshotPage([
      inventoryItem('ITM-1', 'Remote stock', 4, 9), inventoryItem('ITM-2', 'Second', 1),
      inventoryItem('ITM-3', 'Third', 1),
    ], 'cursor-2', false)));
    assert.equal(hook.current().inventory.length, 3);
    assert.equal(hook.current().inventory[0].stock, 9);
    assert.equal(hook.current().pages.state.inventory.hasMore, false);
  } finally { await hook.dom.close(); }
});

test('a failed listener restart keeps confirmed rows and a later retry recovers', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(request.kind === 'inventory'
        ? snapshotPage([inventoryItem('ITM-1', 'First')], 'cursor-1', true)
        : snapshotPage([], null, false));
    });
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));
    await act(async () => hook.subscriptions[0].onError(new Error('Listener stopped')));
    assert.equal(hook.current().pages.state.inventory.error, 'Listener stopped');
    assert.equal(hook.current().pages.state.inventory.busy, false);

    let loading;
    await act(async () => { loading = hook.current().pages.load('inventory'); });
    assert.equal(hook.loads.length, 4);
    await act(async () => {
      hook.loads[3].resolve(snapshotPage([], 'cursor-1', true));
      await loading;
    });
    assert.equal(hook.subscriptions.length, 2);
    await act(async () => hook.subscriptions[1].reject(new Error('Restart failed')));
    assert.equal(hook.current().pages.state.inventory.error, 'Restart failed');
    assert.equal(hook.current().inventory[0].itemName, 'First');

    await act(async () => hook.subscriptions[0].onServer(
      snapshotPage([inventoryItem('STALE', 'Stale')], null, false)));
    assert.equal(hook.current().inventory.length, 1, 'a failed listener must not accept old callbacks');

    await act(async () => { loading = hook.current().pages.load('inventory'); });
    assert.equal(hook.loads.length, 5);
    await act(async () => {
      hook.loads[4].resolve(snapshotPage([], 'cursor-1', true));
      await loading;
    });
    assert.equal(hook.subscriptions.length, 3);
    await act(async () => hook.subscriptions[2].resolve(() => hook.unsubscribes.push('third')));
    await act(async () => hook.subscriptions[2].onServer(
      snapshotPage([inventoryItem('ITM-1', 'Recovered', 2)], null, false)));
    assert.equal(hook.current().pages.state.inventory.error, '');
    assert.equal(hook.current().inventory[0].itemName, 'Recovered');
  } finally { await hook.dom.close(); }
});

for (const transition of ['clinic', 'logout', 'account']) {
  test(`inventory listener cleanup releases callbacks on ${transition} changes`, async () => {
    const hook = createHookHarness();
    try {
      await hook.render('clinic-a');
      await act(async () => {
        for (const request of hook.loads) request.resolve(request.kind === 'inventory'
          ? snapshotPage([inventoryItem('ITM-1', 'First')], 'cursor-1', true)
          : snapshotPage([], null, false));
      });
      assert.equal(hook.subscriptions.length, 1);

      if (transition === 'account') await hook.render('clinic-a', true, 'user-b');
      else if (transition === 'logout') await hook.render(null, false, null);
      else await hook.render('clinic-b', true, 'user-a');

      await act(async () => {
        hook.subscriptions[0].onServer(snapshotPage([inventoryItem('STALE', 'Stale')], null, false));
        hook.subscriptions[0].onError(new Error('old failure'));
      });
      assert.equal(hook.current().inventory.length, transition === 'logout' ? 1 : 0);
      assert.equal(hook.current().pages.state.inventory.error, '');

      await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('late')));
      assert.deepEqual(hook.unsubscribes, ['late'], 'a late unsubscribe must still be released');

      if (transition !== 'logout') {
        assert.equal(hook.loads.length, 6);
        await act(async () => {
          for (const request of hook.loads.slice(3)) request.resolve(request.kind === 'inventory'
            ? snapshotPage([inventoryItem('ITM-NEW', 'New')], null, false)
            : snapshotPage([], null, false));
        });
        assert.equal(hook.subscriptions.length, 2);
        assert.equal(hook.subscriptions[1].clinicId, transition === 'account' ? 'clinic-a' : 'clinic-b');
        await act(async () => hook.subscriptions[1].resolve(() => hook.unsubscribes.push('new')));
        await act(async () => hook.subscriptions[1].onServer(
          snapshotPage([inventoryItem('ITM-NEW', 'Confirmed')], null, false)));
        assert.equal(hook.current().inventory[0].itemName, 'Confirmed');
      }
    } finally { await hook.dom.close(); }
  });
}

test('subscribeClinicInventory ignores cached and pending snapshots and maps the bounded prefix', async () => {
  const snapshots = [];
  const releases = [];
  let options;
  const firestore = {
    // Mirror the Firestore SDK: the first argument is the database handle.
    collection: (db, ...parts) => ({ type: 'collection', db, parts }),
    documentId: () => 'documentId',
    orderBy: field => ({ type: 'orderBy', field }),
    limit: count => ({ type: 'limit', count }),
    query: (collection, ...constraints) => ({ collection, constraints }),
    onSnapshot(query, snapshotOptions, onNext, onError) {
      options = snapshotOptions;
      snapshots.push({ query, onNext, onError });
      return () => releases.push('unsubscribed');
    },
  };
  const auth = {
    currentUser: { uid: 'user-a' },
    onAuthStateChanged(listener) {
      listener(this.currentUser);
      return () => { releases.push('auth'); };
    },
  };
  const { subscribeClinicInventory } = loadSource('../../lib/clinic-pages.ts', {
    '@/lib/firebase': { initializeFirebase: async () => ({ db: {}, auth, firestore }) },
    '@/lib/stock-alert-values': loadSource('../../lib/stock-alert-values.ts'),
  });
  const pages = [], errors = [], denied = [];
  const unsubscribe = await subscribeClinicInventory('clinic-a', 2,
    snapshot => pages.push(snapshot), error => errors.push(error), 'user-a', error => denied.push(error));
  // The harness runs production code in a VM realm, so copy the options into
  // this realm before comparing their shape and exact value.
  assert.deepEqual({ ...options }, { includeMetadataChanges: true });
  assert.equal(snapshots[0].query.collection.parts.join('/'), 'clinics/clinic-a/inventory');
  assert.deepEqual(snapshots[0].query.constraints.map(constraint => constraint.type), ['orderBy', 'limit']);
  assert.equal(snapshots[0].query.constraints[1].count, 3);

  const doc = (id, data) => ({ id, data: () => data });
  snapshots[0].onNext({
    metadata: { fromCache: true, hasPendingWrites: false },
    docs: [doc('A', { itemName: 'Cached' })], size: 1,
  });
  snapshots[0].onNext({
    metadata: { fromCache: false, hasPendingWrites: true },
    docs: [doc('A', { itemName: 'Pending' })], size: 1,
  });
  assert.equal(pages.length, 0);

  snapshots[0].onNext({
    metadata: { fromCache: false, hasPendingWrites: false },
    docs: [
      doc('A', { itemName: 'A', stock: 1 }), doc('B', { itemName: 'B', stock: 2 }),
      doc('C', { itemName: 'C', stock: 3 }),
    ],
    size: 3,
  });
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].records.map(item => item.itemCode), ['A', 'B']);
  assert.equal(pages[0].hasMore, true);

  snapshots[0].onError('denied');
  assert.equal(errors[0].message, 'denied');
  assert.equal(denied.length, 0);
  unsubscribe();
  assert.deepEqual(releases, ['auth', 'unsubscribed']);
});

test('subscribeClinicInventory rejects stale-identity snapshots and explicit access denial', async () => {
  let authObserver;
  const releases = [];
  const auth = {
    currentUser: { uid: 'user-a' },
    onAuthStateChanged(listener) {
      authObserver = listener;
      listener(this.currentUser);
      return () => { releases.push('auth'); };
    },
  };
  const firestore = {
    collection: () => ({}), documentId: () => 'documentId',
    orderBy: () => ({}), limit: () => ({}), query: () => ({}),
    onSnapshot(_query, _options, onNext, onError) {
      firestore.onNext = onNext;
      firestore.onError = onError;
      return () => { releases.push('listener'); };
    },
  };
  const { subscribeClinicInventory } = loadSource('../../lib/clinic-pages.ts', {
    '@/lib/firebase': { initializeFirebase: async () => ({ db: {}, auth, firestore }) },
    '@/lib/stock-alert-values': loadSource('../../lib/stock-alert-values.ts'),
  });
  const pages = [], errors = [], denied = [];
  const unsubscribe = await subscribeClinicInventory('clinic-a', 1,
    page => pages.push(page), error => errors.push(error), 'user-a', error => denied.push(error));
  assert.equal(typeof authObserver, 'function', 'inventory sync must observe real Firebase auth');
  const doc = id => ({ id, data: () => ({ itemName: 'Confirmed' }) });
  firestore.onNext({ metadata: { fromCache: false, hasPendingWrites: false }, docs: [doc('A')], size: 1 });
  assert.equal(pages.length, 1);

  firestore.onError(Object.assign(new Error('denied'), { code: 'permission-denied' }));
  assert.equal(denied.length, 1, 'a rules denial is an access mismatch, not a connection loss');
  assert.equal(errors.length, 0);

  auth.currentUser = { uid: 'user-b' };
  authObserver(auth.currentUser);
  firestore.onNext({ metadata: { fromCache: false, hasPendingWrites: false }, docs: [doc('B')], size: 1 });
  assert.equal(pages.length, 1, 'snapshots under a different Firebase UID must be ignored');
  unsubscribe();
  assert.deepEqual(releases, ['auth', 'listener']);
});

test('repeated listener retries restart the same bounded prefix without consuming pages', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(request.kind === 'inventory'
        ? snapshotPage([inventoryItem('ITM-1', 'First')], 'cursor-1', true)
        : snapshotPage([], null, false));
    });
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));
    await act(async () => hook.subscriptions[0].onError(new Error('Listener stopped')));

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let loading;
      await act(async () => { loading = hook.current().pages.load('inventory'); });
      const retry = hook.loads[2 + attempt];
      assert.equal(retry.cursor, 'cursor-1');
      await act(async () => {
        retry.resolve(snapshotPage([], 'cursor-1', true));
        await loading;
      });
      assert.equal(hook.subscriptions.length, 1 + attempt);
      assert.equal(hook.subscriptions[attempt].size, 50, `retry ${attempt} must not widen the prefix`);
      await act(async () => hook.subscriptions[attempt].reject(new Error(`Restart ${attempt} failed`)));
      assert.equal(hook.current().pages.state.inventory.error, `Restart ${attempt} failed`);
    }
    assert.equal(hook.current().inventory[0].itemName, 'First', 'confirmed rows survive repeated retries');
  } finally { await hook.dom.close(); }
});

test('a remote insertion at the head re-cursors the next page from the confirmed prefix', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(request.kind === 'inventory'
        ? snapshotPage([inventoryItem('ITM-1', 'One'), inventoryItem('ITM-2', 'Two')], 'cursor-2', true)
        : snapshotPage([], null, false));
    });
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));
    await act(async () => hook.subscriptions[0].onServer(snapshotPage([
      inventoryItem('ITM-1', 'One'), inventoryItem('ITM-2', 'Two'),
    ], 'cursor-2', true)));
    await act(async () => hook.subscriptions[0].onServer(snapshotPage([
      inventoryItem('ITM-0', 'Zero'), inventoryItem('ITM-1', 'One'),
    ], 'cursor-1', true)));
    assert.deepEqual(hook.current().inventory.map(item => item.itemCode), ['ITM-0', 'ITM-1'],
      'the displaced tail leaves the confirmed prefix');

    let loading;
    await act(async () => { loading = hook.current().pages.load('inventory'); });
    assert.equal(hook.loads[3].cursor, 'cursor-1', 'the next page starts after the last confirmed row');
    await act(async () => {
      hook.loads[3].resolve(snapshotPage([inventoryItem('ITM-2', 'Two')], 'cursor-2', false));
      await loading;
    });
    assert.deepEqual(hook.current().inventory.map(item => item.itemCode), ['ITM-0', 'ITM-1', 'ITM-2'],
      'the displaced tail is recovered by the next page');
  } finally { await hook.dom.close(); }
});

test('an empty terminal read keeps the prefix while an explicit stale-boundary load may widen it', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(snapshotPage([], null, false));
    });
    assert.equal(hook.subscriptions[0].size, 50);
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));

    let loading;
    await act(async () => { loading = hook.current().pages.load('inventory'); });
    assert.equal(hook.loads[3].cursor, null);
    await act(async () => { hook.loads[3].resolve(snapshotPage([], null, false)); await loading; });
    assert.equal(hook.subscriptions.length, 1, 'an empty terminal read must not open a wider listener');

    await act(async () => { loading = hook.current().pages.load('inventory'); });
    await act(async () => { hook.loads[4].resolve(snapshotPage([], null, true)); await loading; });
    assert.equal(hook.subscriptions.length, 2, 'an explicit stale-boundary load may widen the prefix');
    assert.equal(hook.subscriptions[1].size, 100);
  } finally { await hook.dom.close(); }
});

test('a retried failed page read widens once and survives the wider confirmed snapshot', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(request.kind === 'inventory'
        ? snapshotPage([inventoryItem('ITM-1', 'One')], 'cursor-1', true)
        : snapshotPage([], null, false));
    });
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));
    await act(async () => hook.subscriptions[0].onServer(snapshotPage([
      inventoryItem('ITM-1', 'One'),
    ], 'cursor-1', true)));

    let loading;
    await act(async () => { loading = hook.current().pages.load('inventory'); });
    assert.equal(hook.loads[3].cursor, 'cursor-1');
    await act(async () => {
      hook.loads[3].reject(new Error('Page read failed'));
      await loading;
    });
    assert.equal(hook.current().pages.state.inventory.error,
      'Could not load this page. Check your connection and retry.');

    await act(async () => { loading = hook.current().pages.load('inventory'); });
    assert.equal(hook.loads[4].cursor, 'cursor-1');
    await act(async () => {
      hook.loads[4].resolve(snapshotPage([inventoryItem('ITM-2', 'Two')], 'cursor-2', true));
      await loading;
    });
    assert.deepEqual(hook.current().inventory.map(item => item.itemCode), ['ITM-1', 'ITM-2']);
    assert.equal(hook.subscriptions.length, 2);
    assert.equal(hook.subscriptions[1].size, 100, 'a retried page read keeps its intended wider prefix');

    await act(async () => hook.subscriptions[1].resolve(() => hook.unsubscribes.push('second')));
    await act(async () => hook.subscriptions[1].onServer(snapshotPage([
      inventoryItem('ITM-1', 'One'), inventoryItem('ITM-2', 'Two'),
    ], 'cursor-2', false)));
    assert.deepEqual(hook.current().inventory.map(item => item.itemCode), ['ITM-1', 'ITM-2'],
      'the wider confirmed snapshot must not drop the retried rows');
  } finally { await hook.dom.close(); }
});

test('a retried first-page read still starts a 50-row listener', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(snapshotPage([], null, false));
    });
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));

    let loading;
    await act(async () => { loading = hook.current().pages.load('inventory', true); });
    await act(async () => {
      hook.loads[3].reject(new Error('First page failed'));
      await loading;
    });
    await act(async () => { loading = hook.current().pages.load('inventory'); });
    assert.equal(hook.loads[4].cursor, null);
    await act(async () => {
      hook.loads[4].resolve(snapshotPage([inventoryItem('ITM-1', 'First')], 'cursor-1', false));
      await loading;
    });
    assert.equal(hook.subscriptions.length, 2);
    assert.equal(hook.subscriptions[1].size, 50);
  } finally { await hook.dom.close(); }
});

test('an auth identity mismatch clears inventory and rejects stale reads and callbacks', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a', true, 'user-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(request.kind === 'inventory'
        ? snapshotPage([inventoryItem('ITM-1', 'First')], 'cursor-1', true)
        : snapshotPage([], null, false));
    });
    assert.equal(hook.subscriptions[0].uid, 'user-a');
    assert.equal(typeof hook.subscriptions[0].onDenied, 'function');
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));
    assert.equal(hook.current().inventory[0].itemName, 'First');

    let stale;
    await act(async () => { stale = hook.current().pages.load('inventory'); });
    await act(async () => hook.subscriptions[0].onDenied(new Error('auth changed')));
    assert.deepEqual([...hook.current().inventory], []);
    assert.match(hook.current().pages.state.inventory.error, /access|reload/i);

    await act(async () => {
      hook.subscriptions[0].onServer(snapshotPage([inventoryItem('STALE', 'Stale')], null, false));
      hook.loads[3].resolve(snapshotPage([inventoryItem('STALE-READ', 'Stale read')], 'cursor-2', false));
      await stale;
    });
    assert.deepEqual([...hook.current().inventory], [], 'stale reads and callbacks cannot repopulate a cleared view');
    await act(async () => { void hook.current().pages.load('inventory'); });
    assert.equal(hook.loads.length, 4, 'access loss cannot be retried within the old workspace');
  } finally { await hook.dom.close(); }
});

test('a newer confirmed snapshot wins over an in-flight page read for rows, cursor and hasMore', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(request.kind === 'inventory'
        ? snapshotPage([inventoryItem('ITM-1', 'First')], 'cursor-1', true)
        : snapshotPage([], null, false));
    });
    await act(async () => hook.subscriptions[0].resolve(() => hook.unsubscribes.push('first')));
    await act(async () => hook.subscriptions[0].onServer(snapshotPage([
      inventoryItem('ITM-1', 'First'),
    ], 'cursor-1', false)));
    assert.equal(hook.current().pages.state.inventory.hasMore, false);

    let loading;
    await act(async () => { loading = hook.current().pages.load('inventory'); });
    await act(async () => hook.subscriptions[0].onServer(snapshotPage([
      inventoryItem('ITM-1', 'First'),
    ], 'confirmed-cursor', false)));
    await act(async () => {
      hook.loads[3].resolve(snapshotPage([inventoryItem('REMOVED', 'Older row')], 'stale-cursor', true));
      await loading;
    });
    assert.equal(hook.current().pages.state.inventory.hasMore, false,
      'a stale page read must not override the newer confirmed hasMore');
    assert.deepEqual(hook.current().inventory.map(row => row.itemCode), ['ITM-1']);
    await act(async () => { void hook.current().pages.load('inventory'); });
    assert.equal(hook.loads[4].cursor, 'confirmed-cursor');
  } finally { await hook.dom.close(); }
});

test('a page read cannot erase a newer inventory listener error', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(snapshotPage([], null, false));
    });
    await act(async () => hook.subscriptions[0].resolve(() => {}));
    let loading;
    await act(async () => { loading = hook.current().pages.load('inventory'); });
    await act(async () => hook.subscriptions[0].onError(new Error('Inventory connection interrupted')));
    await act(async () => {
      hook.loads[3].resolve(snapshotPage([inventoryItem('STALE', 'Stale')], 'stale-cursor', true));
      await loading;
    });
    assert.equal(hook.current().pages.state.inventory.error, 'Inventory connection interrupted');
    assert.equal(hook.current().inventory.length, 0);
    assert.equal(hook.subscriptions.length, 1);
  } finally { await hook.dom.close(); }
});

test('a direct inventory permission denial clears the prefix and blocks retry', async () => {
  const hook = createHookHarness();
  try {
    await hook.render('clinic-a');
    await act(async () => {
      for (const request of hook.loads) request.resolve(request.kind === 'inventory'
        ? snapshotPage([inventoryItem('PRIVATE', 'Previously readable')], 'cursor-1', true)
        : snapshotPage([], null, false));
    });
    let loading;
    await act(async () => { loading = hook.current().pages.load('inventory'); });
    await act(async () => {
      hook.loads[3].reject(Object.assign(new Error('Firestore rejected this read'), { code: 'permission-denied' }));
      await loading;
    });
    assert.equal(hook.current().inventory.length, 0);
    assert.match(hook.current().pages.state.inventory.error, /access changed/i);
    await act(async () => { void hook.current().pages.load('inventory'); });
    assert.equal(hook.loads.length, 4);
  } finally { await hook.dom.close(); }
});

test('an inventory page checks Firebase identity before and after a cache-capable read', async () => {
  const auth = { currentUser: { uid: 'other-user' } };
  const pending = deferred(), started = deferred();
  let queries = 0;
  const firestore = {
    collection: () => ({}), limit: () => ({}), query: () => ({}),
    getDocs() { queries += 1; started.resolve(); return pending.promise; },
  };
  const { loadClinicPage } = loadSource('../../lib/clinic-pages.ts', {
    '@/lib/firebase': { initializeFirebase: async () => ({ db: {}, auth, firestore }) },
    '@/lib/stock-alert-values': loadSource('../../lib/stock-alert-values.ts'),
  });
  const wrongIdentity = loadClinicPage('clinic-a', 'inventory', null, 'user-a').catch(error => error);
  const denial = await Promise.race([wrongIdentity, started.promise]);
  assert.equal(queries, 0, 'do not start a cache-capable read under a different identity');
  assert.equal(denial?.code, 'unauthenticated');
  auth.currentUser = { uid: 'user-a' };
  const loading = loadClinicPage('clinic-a', 'inventory', null, 'user-a');
  await Promise.race([started.promise, loading]);
  assert.equal(queries, 1);
  auth.currentUser = null;
  pending.resolve({ docs: [], size: 0, metadata: { fromCache: true } });
  await assert.rejects(loading, { code: 'unauthenticated' });
});
