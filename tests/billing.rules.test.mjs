import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth';
import * as fs from 'firebase/firestore';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Local emulators are required.');
const projectId = 'demo-vetcloud-rules';
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const compile = async (file, replacements = {}) => {
  let source = await readFile(new URL(`../lib/${file}`, import.meta.url), 'utf8');
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
  return url(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
};
const handles = url('export const initializeFirebase = async () => globalThis.__billingHandles;');

test('the patient balance projection does not confuse missing legacy data with verified zero', async () => {
  const { patientFromDocument } = await import(await compile('clinic-pages.ts', {
    '@/lib/firebase': handles, '@/lib/stock-alert-values': await compile('stock-alert-values.ts'),
  }));
  assert.equal(patientFromDocument('legacy', {}).legacyBillingBalance, null);
  assert.equal(patientFromDocument('zero', { balance: 0 }).legacyBillingBalance, 0);
  assert.equal(patientFromDocument('malformed', { balance: -4.5 }).balance, 0);
  assert.equal(patientFromDocument('malformed', { balance: -4.5 }).legacyBillingBalance, -4.5);
  const patient = patientFromDocument('updated', { balance: 1500, billing: { balanceMinor: 70000 } });
  assert.equal(patient.balance, 700);
  assert.equal(patient.legacyBillingBalance, 1500);
});

test('billing commits and rules protect money, stock, receipt and clinic boundaries', async t => {
  const valuesUrl = await compile('billing-values.ts');
  const mutationUrl = await compile('clinical-mutations.ts', { '@/lib/firebase': handles });
  const serviceUrl = await compile('billing.ts', {
    '@/lib/firebase': handles, '@/lib/clinical-mutations': mutationUrl, '@/lib/billing-values': valuesUrl,
    '@/lib/billing-reconciliation': await compile('billing-reconciliation.ts'),
  });
  const { commitBilling, loadBillingHistory, loadPaymentReceipt } = await import(serviceUrl);
  const { mutateClinicalRecord } = await import(mutationUrl);
  const clinicId = `billing-${Date.now()}`;
  const localTime = Math.floor(Date.now() / 60000) * 60000;
  const cutoffMs = localTime - 120 * 60000;
  const clients = {};
  const select = role => {
    globalThis.__billingHandles = { ...clients[role], firestore: fs };
    return clients[role];
  };
  const ref = (collection, id, client = clients.owner, clinic = clinicId) => fs.doc(client.db, 'clinics', clinic, collection, id);
  const denied = operation => assert.rejects(operation, error => error.code === 'permission-denied');
  const get = async (collection, id) => (await fs.getDoc(ref(collection, id))).data();
  const payment = { kind: 'payment', amountMinor: 50000, method: 'cash', occurredAtMs: localTime - 60000 };
  const apply = (patientId, operationId, expectedPatientRevision, draft) => commitBilling({
    clinicId, patientId, operationId, expectedPatientRevision, draft,
  });
  const verify = { kind: 'opening', verifiedMinor: 120000, source: 'Paper ledger', reason: 'Duplicate balance entry', cutoffMs };

  try {
    for (const role of ['owner', 'editor', 'viewer', 'outsider']) {
      const app = initializeApp({ apiKey: 'fake-key', projectId }, `${clinicId}-${role}`);
      const auth = getAuth(app);
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      const db = fs.getFirestore(app);
      const [hostname, port] = host.split(':');
      fs.connectFirestoreEmulator(db, hostname, Number(port));
      await createUserWithEmailAndPassword(auth, `${clinicId}-${role}@example.com`, 'BillingFixture123!');
      clients[role] = { app, auth, db };
    }
    const owner = select('owner'), uid = owner.auth.currentUser.uid;
    const bootstrap = fs.writeBatch(owner.db);
    bootstrap.set(fs.doc(owner.db, 'clinics', clinicId), { name: 'Billing Fixture', ownerId: uid, createdAt: fs.serverTimestamp() });
    bootstrap.set(ref('members', uid), { uid, email: owner.auth.currentUser.email, displayName: 'Fixture', role: 'owner', createdAt: fs.serverTimestamp() });
    bootstrap.set(fs.doc(owner.db, 'users', uid, 'clinics', clinicId), { clinicId, clinicName: 'Billing Fixture', role: 'owner', joinedAt: fs.serverTimestamp() });
    await bootstrap.commit();
    const seed = (collection, id, fields) => ({
      update: { name: `projects/${projectId}/databases/(default)/documents/clinics/${clinicId}/${collection}/${id}`, fields },
    });
    const membership = ['editor', 'viewer'].map(role => {
      const member = clients[role].auth.currentUser;
      const data = { role, uid: member.uid, email: member.email, displayName: 'Fixture' };
      return seed('members', member.uid, Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { stringValue: value }])));
    });
    const inventory = ['MED-1', 'MED-2'].map(id => seed('inventory', id, {
      id: { stringValue: id }, itemCode: { stringValue: id }, itemName: { stringValue: id },
      category: { stringValue: 'Medicine' }, stock: { integerValue: '8' }, sellingPrice: { doubleValue: 125.25 },
    }));
    const seeded = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: [
        ...membership, ...inventory,
        seed('patients', 'legacy', { id: { stringValue: 'legacy' }, name: { stringValue: 'Dobby' }, balance: { doubleValue: 1500 } }),
        seed('patients', 'untouched', { id: { stringValue: 'untouched' }, name: { stringValue: 'Fixture' }, balance: { doubleValue: 4.5 } }),
        seed('patients', 'zero', { id: { stringValue: 'zero' }, name: { stringValue: 'Fixture' }, balance: { integerValue: '0' } }),
        seed('patients', 'missing', { id: { stringValue: 'missing' }, name: { stringValue: 'Fixture' } }),
      ] }),
    });
    assert.equal(seeded.status, 200);

    const opened = await apply('legacy', 'opening-legacy', 0, verify);
    assert.equal(opened.state.balanceMinor, 120000);
    assert.equal((await get('patients', 'legacy')).balance, 1500);
    assert.equal(opened.entry.actorUid, uid);
    assert.ok(opened.entry.recordedAtMs >= localTime);
    await assert.rejects(() => apply('legacy', 'exact-cutoff', opened.patientRevision, { ...payment, occurredAtMs: cutoffMs }));
    const first = await apply('legacy', 'first-payment', opened.patientRevision, payment);
    assert.equal(first.state.balanceMinor, 70000);
    const receipt = await loadPaymentReceipt({ clinicId, patientId: 'legacy', entryId: first.entry.id });
    assert.equal(receipt.patientName, 'Dobby');
    assert.equal(receipt.clinicName, 'Billing Fixture');
    assert.equal(receipt.balanceAfterMinor, 70000);
    assert.equal(receipt.amountMinor, 50000);
    assert.equal(receipt.reversed, false);

    await t.test('same reviewed payment replays after the next ledger commit', async () => {
      const other = await apply('legacy', 'second-payment', first.patientRevision, { ...payment, amountMinor: 10000 });
      const patient = await get('patients', 'legacy');
      const profile = await mutateClinicalRecord({
        clinicId, collection: 'patients', id: 'legacy', expectedRevision: other.patientRevision,
        action: 'save', data: { ...patient, notes: 'Committed after the payment' },
      });
      const replay = await apply('legacy', 'first-payment', opened.patientRevision, payment);
      assert.equal(replay.entry.id, first.entry.id);
      assert.equal(replay.state.balanceMinor, 60000);
      assert.equal(replay.patientRevision, profile.revision);
      assert.equal(replay.records.patient.notes, 'Committed after the payment');
      const history = await loadBillingHistory({ clinicId, patientId: 'legacy' });
      assert.deepEqual(history.entries.map(entry => entry.id), ['second-payment', 'first-payment', 'opening-legacy']);
      await assert.rejects(() => apply('legacy', 'first-payment', opened.patientRevision, { ...payment, amountMinor: 1 }));
    });

    await t.test('only one competing reviewed payment can apply at the same revision', async () => {
      const revision = (await get('patients', 'legacy')).revision;
      const outcomes = await Promise.allSettled(['concurrent-A', 'concurrent-B'].map(id =>
        apply('legacy', id, revision, { ...payment, amountMinor: 10000 })));
      assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
      assert.equal((await get('patients', 'legacy')).billing.balanceMinor, 50000);
    });

    await t.test('a payment can be reversed just once without changing stock', async () => {
      const draft = { kind: 'reversal', originalEntryId: 'first-payment', reason: 'Duplicate recording', returnStock: false, expectedStockRevisions: {} };
      const before = (await get('patients', 'legacy')).revision;
      const result = await apply('legacy', 'reverse_first-payment', before, draft);
      assert.equal(result.state.balanceMinor, 100000);
      assert.equal((await loadPaymentReceipt({ clinicId, patientId: 'legacy', entryId: first.entry.id })).reversed, true);
      await assert.rejects(() => apply('legacy', 'reverse_first-payment', result.patientRevision, draft));
      assert.equal((await get('inventory', 'MED-1')).stock, 8);
    });

    await t.test('two stock charge and return are atomic, and financial-only reversals leave stock alone', async () => {
      const lines = ['MED-1', 'MED-2'].map(itemCode => ({ itemCode, quantity: 2, expectedRevision: 0, unitPriceMinor: 12525 }));
      await assert.rejects(() => apply('missing', 'cannot-assume-zero', 0, { kind: 'charge', lines }));
      const charge = await apply('zero', 'stock-charge', 0, { kind: 'charge', lines });
      assert.equal(charge.state.balanceMinor, 50100);
      await assert.rejects(() => apply('zero', 'invalid-correction', charge.patientRevision, {
        kind: 'opening-correction', verifiedMinor: 120000, source: 'Fixture ledger', reason: 'Not reviewed',
      }), /Only a reviewed opening balance/);
      await denied(() => mutateClinicalRecord({
        clinicId, collection: 'inventory', id: 'MED-1', expectedRevision: 1, action: 'delete',
      }));
      assert.deepEqual(await Promise.all(lines.map(async ({ itemCode }) => (await get('inventory', itemCode)).stock)), [6, 6]);
      const reverse = { kind: 'reversal', originalEntryId: 'stock-charge', reason: 'Physical return', returnStock: true, expectedStockRevisions: { 'MED-1': 1, 'MED-2': 1 } };
      await assert.rejects(() => apply('zero', 'reverse_stock-charge', charge.patientRevision, { ...reverse, expectedStockRevisions: { 'MED-1': 0, 'MED-2': 1 } }));
      const returned = await apply('zero', 'reverse_stock-charge', charge.patientRevision, reverse);
      assert.equal(returned.state.balanceMinor, 0);
      assert.deepEqual(await Promise.all(lines.map(async ({ itemCode }) => (await get('inventory', itemCode)).stock)), [8, 8]);
      const again = await apply('zero', 'stock-charge-again', returned.patientRevision, { kind: 'charge', lines: lines.map(line => ({ ...line, expectedRevision: 2 })) });
      await apply('zero', 'reverse_stock-charge-again', again.patientRevision, {
        ...reverse, originalEntryId: 'stock-charge-again', returnStock: false, expectedStockRevisions: {},
      });
      assert.deepEqual(await Promise.all(lines.map(async ({ itemCode }) => (await get('inventory', itemCode)).stock)), [6, 6]);
    });

    await t.test('rules deny unsafe writes independently of the service', async () => {
      const raw = await get('billingEntries', 'first-payment');
      await denied(() => fs.setDoc(ref('billingEntries', 'standalone'), { ...raw, recordedAt: fs.serverTimestamp() }));
      await denied(() => fs.updateDoc(ref('billingEntries', 'first-payment'), { amountMinor: 1 }));
      await denied(() => fs.deleteDoc(ref('billingEntries', 'first-payment')));
      const current = await get('patients', 'legacy');
      const write = patch => mutateClinicalRecord({
        clinicId, collection: 'patients', id: 'legacy', expectedRevision: current.revision, action: 'save', data: { ...current, ...patch },
      });
      await denied(() => write({ balance: 0 }));
      await denied(() => write({ billing: { ...current.billing, balanceMinor: 0 } }));
      await denied(() => mutateClinicalRecord({ clinicId, collection: 'patients', id: 'untouched', expectedRevision: 0, action: 'delete' }));
      await denied(() => mutateClinicalRecord({ clinicId, collection: 'patients', id: 'legacy', expectedRevision: current.revision, action: 'delete' }));
      await denied(() => fs.getDoc(ref('billingEntries', 'first-payment', clients.viewer)));
      await denied(() => fs.getDoc(ref('billingEntries', 'first-payment', clients.outsider)));
      await denied(() => fs.getDoc(ref('billingEntries', 'first-payment', owner, `${clinicId}-foreign`)));
      select('viewer');
      await denied(() => apply('legacy', 'viewer-payment', current.revision, { ...payment, amountMinor: 10 }));
      select('editor');
      assert.equal((await loadPaymentReceipt({ clinicId, patientId: 'legacy', entryId: first.entry.id })).amountMinor, 50000);
      select('owner');
    });

    await t.test('rules reject forged details within an otherwise valid payment transaction', async () => {
      const original = await get('billingEntries', 'first-payment');
      const patient = await get('patients', 'legacy');
      const attempt = (id, patch = {}, update = {}) => {
        const seq = patient.billing.seq + 1;
        const event = { actorUid: uid, action: 'update', entityType: 'patients', entityId: 'legacy',
          time: fs.serverTimestamp(), seq: patient.revision + 1, eventId: `audit-${id}` };
        const updated = { ...patient.billing, seq, lastEntryId: id, balanceMinor: patient.billing.balanceMinor - 10000, ...update };
        const batch = fs.writeBatch(owner.db);
        batch.update(ref('patients', 'legacy'), { billing: updated, revision: event.seq });
        batch.set(ref('auditHeads', 'patients_legacy'), event);
        batch.set(ref('auditEvents', event.eventId), event);
        batch.set(ref('billingEntries', id), { ...original, recordedAt: fs.serverTimestamp(), seq, amountMinor: 10000,
          balanceBeforeMinor: patient.billing.balanceMinor, balanceAfterMinor: updated.balanceMinor, ...patch });
        return batch.commit();
      };
      await denied(() => attempt('forged-actor', { actorUid: 'someone-else' }));
      await denied(() => attempt('forged-time', { recordedAt: fs.Timestamp.fromMillis(localTime) }));
      await denied(() => attempt('forged-amount', { amountMinor: 9999 }));
      await denied(() => attempt('forged-date', { businessDayMs: original.businessDayMs - 86400000 }));
      await denied(() => attempt('forged-cutoff', {}, { cutoffMs: cutoffMs - 60000 }));
      await denied(() => attempt('cutoff-equality', { occurredAtMs: cutoffMs }));
      await attempt('valid-direct');
      assert.equal((await get('patients', 'legacy')).billing.balanceMinor, patient.billing.balanceMinor - 10000);
    });
    await t.test('an ordinary profile write preserves the legacy amount and the current financial summary', async () => {
      const before = await get('patients', 'legacy');
      await mutateClinicalRecord({
        clinicId, collection: 'patients', id: 'legacy', expectedRevision: before.revision, action: 'save',
        preservePatientBilling: true, data: { ...before, balance: 0, billing: undefined, legacyBillingBalance: 0, status: 'Discharged' },
      });
      const after = await get('patients', 'legacy');
      assert.equal(after.balance, 1500);
      assert.deepEqual(after.billing, before.billing);
      assert.equal(after.legacyBillingBalance, undefined);
      assert.equal(after.status, 'Discharged');
    });

    await t.test('unitemized settlement clears exactly the balance and remains auditable and reversible', async () => {
      const current = await get('patients', 'legacy');
      const item = await get('inventory', 'MED-1');
      const amountMinor = current.billing.balanceMinor;
      const businessDayMs = Math.floor((localTime + 28800000) / 86400000) * 86400000 - 28800000;
      const draft = { kind: 'unitemized-settlement', amountMinor, businessDayMs };
      const reverse = { kind: 'reversal', originalEntryId: 'settle-legacy', reason: 'Wrong date', returnStock: false, expectedStockRevisions: {} };
      const forged = (id, patch) => {
        const event = { actorUid: uid, action: 'update', entityType: 'patients', entityId: 'legacy',
          time: fs.serverTimestamp(), seq: current.revision + 1, eventId: `audit-${id}` };
        const seq = current.billing.seq + 1;
        const batch = fs.writeBatch(owner.db);
        batch.update(ref('patients', 'legacy'), { revision: event.seq, billing: { ...current.billing, seq, balanceMinor: 0, lastEntryId: id } });
        batch.set(ref('auditHeads', 'patients_legacy'), event);
        batch.set(ref('auditEvents', event.eventId), event);
        batch.set(ref('billingEntries', id), { ...draft, clinicId, patientId: 'legacy', actorUid: uid, recordedAt: fs.serverTimestamp(),
          seq, balanceBeforeMinor: amountMinor, balanceAfterMinor: 0, stockMoves: [], requestFingerprint: 'a'.repeat(64), ...patch });
        return batch.commit();
      };
      await denied(() => forged('settle-wrong-amount', { amountMinor: amountMinor - 1 }));
      await denied(() => forged('settle-fake-cash', { method: 'cash' }));
      await denied(() => forged('settle-stock', { stockMoves: [{ itemCode: 'MED-1', quantityDelta: 1 }] }));
      await assert.rejects(() => apply('legacy', 'settle-stale', current.revision - 1, draft));
      for (const role of ['viewer', 'outsider']) {
        select(role);
        await denied(() => apply('legacy', `settle-${role}`, current.revision, draft));
      }
      select('owner');
      const result = await apply('legacy', 'settle-legacy', current.revision, draft);
      assert.equal(result.state.balanceMinor, 0);
      assert.equal(result.entry.businessDayMs, businessDayMs);
      assert.equal(result.entry.amountMinor, amountMinor);
      assert.equal(result.entry.method, undefined);
      assert.equal((await apply('legacy', 'settle-legacy', current.revision, draft)).entry.id, result.entry.id);
      assert.equal((await loadBillingHistory({ clinicId, patientId: 'legacy' })).entries.filter(x => x.kind === draft.kind).length, 1);
      await assert.rejects(() => loadPaymentReceipt({ clinicId, patientId: 'legacy', entryId: result.entry.id }));
      const other = await get('patients', 'zero');
      await assert.rejects(() => apply('zero', 'reverse_settle-legacy', other.revision, reverse), /for this patient/);
      select('editor');
      const restored = await apply('legacy', 'reverse_settle-legacy', result.patientRevision, reverse);
      assert.equal(restored.state.balanceMinor, amountMinor);
      await assert.rejects(() => apply('legacy', 'reverse_settle-legacy', restored.patientRevision, reverse));
      select('owner');
      assert.deepEqual(await get('inventory', 'MED-1'), item);
    });

    await t.test('a billing stock move cannot also satisfy a treatment dispense', async () => {
      const patient = await get('patients', 'zero');
      const item = await get('inventory', 'MED-2');
      const draft = { kind: 'charge', lines: [{ itemCode: 'MED-2', quantity: 1, expectedRevision: item.revision, unitPriceMinor: 12525 }] };
      const treatmentId = 'combined-treatment';
      globalThis.__billingHandles = { ...owner, firestore: {
        ...fs,
        runTransaction: (db, fn) => fs.runTransaction(db, async tx => {
          const result = await fn(tx);
          const metadata = { actorUid: uid, action: 'create', entityType: 'consultations', entityId: treatmentId,
            time: fs.serverTimestamp(), seq: 1, eventId: 'combined-treatment-audit' };
          tx.set(ref('consultations', treatmentId), {
            id: treatmentId, revision: 1, date: '11/18/2026', client: '', patient: patient.name,
            type: 'Consultation', status: 'Completed', notes: 'Fixture', patientId: 'zero',
            appointmentId: null, occurredAt: fs.Timestamp.fromMillis(cutoffMs), recordedAt: fs.serverTimestamp(),
            staffUid: uid, staffName: 'Fixture', treatments: [{ id: 'T1', itemCode: 'MED-2', itemName: 'MED-2',
              category: 'Medicine', quantity: 1, unitPrice: 125.25, dose: '', notes: '' }],
            stockMoves: [{ itemCode: 'MED-2', quantity: 1 }],
          });
          tx.set(ref('auditHeads', `consultations_${treatmentId}`), metadata);
          tx.set(ref('auditEvents', metadata.eventId), metadata);
          return result;
        }),
      } };
      await denied(() => apply('zero', 'combined-charge', patient.revision, draft));
      select('owner');
      assert.equal((await get('inventory', 'MED-2')).stock, item.stock);
    });

    await t.test('close uses bounded clinic reads for Manila days, corrections and treatment links', async () => {
      const service = await compile('end-of-day.ts', { '@/lib/firebase': handles, '@/lib/billing-values': valuesUrl });
      const { loadEndOfDayPage } = await import(service);
      const day = Date.parse('2026-11-18T16:00:00Z');
      const nextDay = day + 86400000;
      const timestamp = value => ({ timestampValue: new Date(value).toISOString() });
      const str = value => ({ stringValue: value });
      const int = value => ({ integerValue: String(value) });
      const entry = (id, kind, fields) => seed('billingEntries', id, {
        clinicId: str(clinicId), patientId: str('legacy'), kind: str(kind), recordedAt: timestamp(nextDay),
        amountMinor: int(5500), ...fields,
      });
      const payment = (id, date) => entry(id, 'payment', { businessDayMs: int(date), occurredAtMs: int(date), method: str('cash') });
      const reversal = id => entry(`reverse_${id}`, 'reversal', { originalEntryId: str(id) });
      const visit = (id, status, date) => seed('appointments', id, {
        patientId: str('legacy'), patientName: str('Dobby'), status: str(status), occurredAt: timestamp(date),
        dueAt: timestamp(day - 86400000),
      });
      const treatment = (id, appointmentId, patientId, status) => seed('consultations', id, {
        appointmentId: str(appointmentId), patientId: str(patientId), status: str(status),
        occurredAt: timestamp(day), recordedAt: timestamp(nextDay + 86400000),
      });
      const write = async writes => assert.equal((await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents:commit`, {
        method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }),
      })).status, 200);
      const foreign = payment('close-elsewhere', day);
      foreign.update.name = foreign.update.name.replace(`/clinics/${clinicId}/`, `/clinics/${clinicId}-foreign/`);
      await write([
        payment('close-paid', day), payment('close-reversed', day), payment('close-next', nextDay), foreign,
        entry('close-settlement', 'unitemized-settlement', { businessDayMs: int(day) }),
        entry('close-charge', 'charge', { businessDayMs: int(day) }),
        entry('close-opening', 'opening', { businessDayMs: int(day) }),
        reversal('close-reversed'), reversal('close-settlement'), reversal('close-charge'),
        ...Array.from({ length: 26 }, (_, i) => visit(`close-${String(i).padStart(2, '0')}`, 'completed', day)),
        visit('close-next', 'completed', nextDay), visit('close-cancelled', 'cancelled', day),
        treatment('close-matched', 'close-25', 'legacy', 'Completed'),
        treatment('close-draft', 'close-24', 'legacy', 'Draft'),
        treatment('close-wrong-patient', 'close-23', 'zero', 'Completed'),
        treatment('close-unlinked', '', 'legacy', 'Completed'),
      ]);
      const query = (kind, overrides = {}) => loadEndOfDayPage(kind, { clinicId, uid: clients.owner.auth.currentUser.uid,
        dayStartMs: day, after: null, ...overrides });
      const daily = await query('entries');
      assert.deepEqual(daily.rows.filter(({ entry }) => entry.id.startsWith('close-')).map(({ entry, reversed }) => [entry.id, reversed]),
        [['close-paid', false], ['close-reversed', true], ['close-settlement', true]]);
      assert.deepEqual((await query('corrections')).rows.filter(({ original }) => original.id.startsWith('close-')), []);
      assert.deepEqual((await query('corrections', { dayStartMs: nextDay })).rows.map(({ original }) => original.id).filter(id => id.startsWith('close-')),
        ['close-reversed', 'close-settlement']);
      const first = await query('visits');
      assert.equal(first.rows.length, 25);
      assert.ok(first.next);
      assert.equal(first.rows.filter(row => row.linkedTreatment).length, 0);
      const last = await query('visits', { after: first.next });
      assert.deepEqual(last.rows.map(({ id, linkedTreatment }) => [id, linkedTreatment]), [['close-25', true]]);
      assert.equal(last.next, null);
      const balances = (await query('balances')).rows;
      assert.equal(balances.find(row => row.id === 'missing').legacyBalance, undefined);
      assert.equal(balances.find(row => row.id === 'legacy').ledgerMinor, (await get('patients', 'legacy')).billing.balanceMinor);
      await write([reversal('close-missing-original')]);
      await assert.rejects(() => query('corrections', { dayStartMs: nextDay }), /original/i);
      for (const role of ['viewer', 'outsider']) {
        const client = select(role);
        await denied(() => query('entries', { uid: client.auth.currentUser.uid }));
      }
      select('owner');
      const indexes = JSON.parse(await readFile(new URL('../firestore.indexes.json', import.meta.url), 'utf8'));
      for (const [collectionGroup, first, second] of [
        ['billingEntries', 'kind', 'businessDayMs'], ['billingEntries', 'kind', 'recordedAt'], ['appointments', 'status', 'occurredAt'],
      ]) {
        assert.ok(indexes.indexes.some(index => index.collectionGroup === collectionGroup && index.queryScope === 'COLLECTION'
          && index.fields.map(field => `${field.fieldPath}:${field.order}`).join() === `${first}:ASCENDING,${second}:ASCENDING`));
      }
    });
  } finally {
    delete globalThis.__billingHandles;
    await Promise.all(Object.values(clients).map(({ app }) => deleteApp(app)));
  }
});
