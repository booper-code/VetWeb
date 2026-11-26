import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth';
import * as fs from 'firebase/firestore';
import * as fsLite from 'firebase/firestore/lite';
import { stockAlertFor } from '../lib/stock-alert-values.ts';

const projectId = 'demo-vetcloud-rules';
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
  throw new Error('Pagination integration tests require a local Firestore emulator.');
}
const app = initializeApp({ apiKey: 'fake-key', projectId }, `paging-${Date.now()}`);
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = fs.getFirestore(app);
const [hostname, port] = host.split(':');
fs.connectFirestoreEmulator(db, hostname, Number(port));
const liteDb = fsLite.getFirestore(app);
fsLite.connectFirestoreEmulator(liteDb, hostname, Number(port));
globalThis.__pagingHandles = { app, db, firestore: fs };
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
let source = await readFile(new URL('../lib/clinic-pages.ts', import.meta.url), 'utf8');
source = source.replace('@/lib/firebase', url('export const initializeFirebase = async () => globalThis.__pagingHandles;'));
source = source.replace('firebase/firestore/lite', import.meta.resolve('firebase/firestore/lite'));
source = source.replace('@/lib/stock-alert-values', new URL('../lib/stock-alert-values.ts', import.meta.url).href);
const { loadClinicPage, loadClinicScanPage, loadInventoryCatalogCount, appendUnique, CLINIC_PAGE_SIZE } = await import(url(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText));

test('real Firestore cursors bound pages, preserve legacy history and isolate clinics', async t => {
  try {
    const user = (await createUserWithEmailAndPassword(auth, `paging-${Date.now()}@example.com`, 'PagingFixture123!')).user;
    const clinicId = `paging-${Date.now()}`;
    const batch = fs.writeBatch(db);
    batch.set(fs.doc(db, 'clinics', clinicId), { name: 'Synthetic paging clinic', ownerId: user.uid, createdAt: fs.serverTimestamp() });
    batch.set(fs.doc(db, 'clinics', clinicId, 'members', user.uid), {
      uid: user.uid, email: user.email, displayName: 'Test', role: 'owner', createdAt: fs.serverTimestamp()
    });
    batch.set(fs.doc(db, 'users', user.uid, 'clinics', clinicId), {
      clinicId, clinicName: 'Synthetic paging clinic', role: 'owner', joinedAt: fs.serverTimestamp()
    });
    await batch.commit();
    const writes = [];
    const add = (collection, id, values) => writes.push({
      update: {
        name: `projects/${projectId}/databases/(default)/documents/clinics/${clinicId}/${collection}/${id}`,
        fields: Object.fromEntries(Object.entries(values).map(([key, value]) =>
          [key, typeof value === 'number' ? { integerValue: String(value) } : { stringValue: value }]))
      }
    });
    for (let index = 0; index < 65; index++) add('patients', `active-${String(index).padStart(3, '0')}`, {
      id: 'incorrect-stored-id', name: `Synthetic ${index}`, status: index % 2 ? 'Waiting' : 'Confined', balance: 0
    });
    for (let index = 0; index < 7; index++) add('patients', `history-${index}`, { name: 'Legacy history', status: 'Discharged' });
    for (let index = 0; index < 57; index++) add('inventory', `item-${String(index).padStart(3, '0')}`, {
      itemName: 'Synthetic item', category: 'Supplies', stock: index ? 1 : 20,
      ...(index === 55 ? { expiryDate: '2026-11-20', threshold: 1 } : {}),
      ...(index === 56 ? { expiryDate: '2026-11-31' } : {}),
    });
    for (let index = 0; index < 60; index++) add('consultations', `SOAP-${String(index).padStart(4, '0')}`, { status: 'Draft', notes: 'Synthetic' });
    // Admin fixture writes are restricted to this demo emulator and never used in app code.
    const seeded = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes })
    });
    assert.equal(seeded.status, 200);
    const first = await loadClinicPage(clinicId, 'activePatients');
    assert.equal(first.records.length, CLINIC_PAGE_SIZE);
    assert.equal(first.hasMore, true);
    assert.equal(first.records[0].id, 'active-000');
    const second = await loadClinicPage(clinicId, 'activePatients', first.cursor);
    assert.equal(second.records.length, 15);
    assert.equal(second.hasMore, false);
    const merged = appendUnique(first.records, [...first.records, ...second.records], record => record.id);
    assert.equal(merged.length, 65);
    assert.ok(merged.every(record => record.status !== 'Discharged'));
    const history = await loadClinicPage(clinicId, 'dischargedPatients');
    assert.equal(history.records.length, 7, 'legacy history must not require a new timestamp');
    const inventory = await loadClinicPage(clinicId, 'inventory');
    assert.equal(inventory.records.length, 50);
    assert.equal((await loadClinicPage(clinicId, 'inventory', inventory.cursor)).records.length, 7);
    const consultations = await loadClinicPage(clinicId, 'consultations');
    assert.equal(consultations.records.length, 50);
    assert.equal(consultations.records[0].id, 'SOAP-0000');
    await assert.rejects(loadClinicPage(`${clinicId}-not-a-member`, 'activePatients'),
      error => error.code === 'permission-denied');
    await assert.rejects(loadClinicPage('demo-clinic', 'inventory'));

    await t.test('legacy consultation backfill is a guarded dry run, is resumable, and is idempotent', async () => {
      const { backfillConsultationHistory } = await import('../scripts/backfill-consultation-history.mjs');
      const root = `projects/${projectId}/databases/(default)/documents`;
      const endpoint = `http://${host}/v1/${root}`;
      const consultations = `clinics/${clinicId}/consultations`;
      const marker = `clinics/${clinicId}/workspaceConfig/consultationHistory`;
      const get = path => fetch(`${endpoint}/${path}`, { headers: { Authorization: 'Bearer owner' } });
      const fixture = [
        ['precise', { occurredAt: { timestampValue: '2024-03-01T12:34:56.123456Z' }, date: { stringValue: '3/1/2024' } }],
        ['dated', { date: { stringValue: '29/2/2024' } }],
        ['unknown', { date: { stringValue: '2/3/2024' } }],
      ];
      const commit = writes => fetch(`${endpoint}:commit`, {
        method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
        body: JSON.stringify({ writes })
      });
      assert.equal((await commit(fixture.map(([id, fields]) => ({
        update: { name: `${root}/${consultations}/${id}`, fields }
      })))).status, 200);
      await assert.rejects(backfillConsultationHistory({ host: 'example.invalid:8080', projectId, clinicId }), /loopback/i);
      await assert.rejects(backfillConsultationHistory({ host, projectId: 'non-demo-project', clinicId }), /demo/i);
      const options = { host, projectId, clinicId };
      const preview = await backfillConsultationHistory(options);
      assert.equal(preview.needsWrite, 63);
      assert.equal((await get(marker)).status, 404);
      assert.equal((await (await get(`${consultations}/dated`)).json()).fields.historySortAt, undefined);
      let raced = false;
      const raceFetch = async (url, init) => {
        const changes = init?.body && JSON.parse(init.body).writes;
        if (!raced && changes?.some(write => write.update?.name.endsWith('/SOAP-0000'))) {
          raced = true;
          assert.equal((await commit([{
            update: { name: `${root}/${consultations}/SOAP-0000`, fields: { notes: { stringValue: 'Concurrent edit' } } },
            updateMask: { fieldPaths: ['notes'] }
          }])).status, 200);
        }
        return fetch(url, init);
      };
      await assert.rejects(backfillConsultationHistory({ ...options, apply: true, request: raceFetch }), /commit/i);
      assert.equal((await (await get(marker)).json()).fields.state.stringValue, 'preparing');
      const result = await backfillConsultationHistory({ ...options, apply: true });
      assert.equal(result.needsWrite, 63);
      assert.equal((await (await get(marker)).json()).fields.state.stringValue, 'ready');
      const readFields = async id => (await (await get(`${consultations}/${id}`)).json()).fields;
      assert.deepEqual(await readFields('dated'), {
        date: { stringValue: '29/2/2024' }, historySortAt: { timestampValue: '2024-02-29T00:00:00Z' }
      });
      assert.deepEqual((await readFields('unknown')).historySortAt, { nullValue: null });
      assert.deepEqual((await readFields('precise')).historySortAt, { timestampValue: '2024-03-01T12:34:56.123456Z' });
      assert.equal((await readFields('SOAP-0000')).notes.stringValue, 'Concurrent edit');
      assert.equal((await backfillConsultationHistory({ ...options, apply: true })).needsWrite, 0);
    });

    await t.test('clinic-wide patient scans read past active pages and stop at the real end', async () => {
      assert.equal(typeof loadClinicScanPage, 'function', 'the clinic-wide scan loader is available');
      const first = await loadClinicScanPage(clinicId, 'patients', null);
      assert.equal(first.rows.length, 50);
      assert.equal(first.rows[0].id, 'active-000', 'uses the canonical document ID');
      assert.equal(first.next, 'active-049');
      const later = await loadClinicScanPage(clinicId, 'patients', first.next);
      assert.equal(later.rows.find(row => row.id === 'history-0')?.status, 'Discharged');
      assert.equal(later.next, null);
      const exact = await loadClinicScanPage(clinicId, 'patients', 'active-021');
      assert.equal(exact.rows.length, 50);
      assert.deepEqual(await loadClinicScanPage(clinicId, 'patients', exact.next), { rows: [], next: null });
      await assert.rejects(loadClinicScanPage(`${clinicId}-not-a-member`, 'patients', null),
        error => error.code === 'permission-denied');
      await assert.rejects(loadClinicScanPage('demo-clinic', 'patients', null));
    });
    await t.test('stock alert scans find dated, low-stock items beyond the inventory page', async () => {
      const first = await loadClinicScanPage(clinicId, 'inventory', null);
      assert.equal(first.rows.length, 50);
      assert.ok(first.rows.every(row => !stockAlertFor(row, '2026-11-20')));
      const later = await loadClinicScanPage(clinicId, 'inventory', first.next);
      assert.equal(later.next, null);
      const alert = stockAlertFor(later.rows.find(row => row.itemCode === 'item-055'), '2026-11-20');
      assert.deepEqual(alert?.reasons, ['reorder', 'expires-today']);
      assert.equal(later.rows.find(row => row.itemCode === 'item-056').expiryDate, undefined);
      await assert.rejects(loadClinicScanPage(`${clinicId}-not-a-member`, 'inventory', null),
        error => error.code === 'permission-denied');
    });
    await t.test('catalog aggregate counts past page one under Firestore membership rules', async () => {
      assert.equal(await loadInventoryCatalogCount(clinicId), 57, 'counts documents, not stock units or loaded rows');
      await assert.rejects(loadInventoryCatalogCount('demo-clinic'));
      await createUserWithEmailAndPassword(auth, `nonmember-${Date.now()}@example.com`, 'PagingFixture123!');
      await assert.rejects(loadInventoryCatalogCount(clinicId), { code: 'permission-denied' });
    });
  } finally {
    delete globalThis.__pagingHandles;
    await fsLite.terminate(liteDb);
    await deleteApp(app);
  }
});
