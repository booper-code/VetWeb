import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers/tsx-harness.mjs';

// The service runs in a vm realm, so normalise its objects before comparing.
const plain = value => value === null ? null : JSON.parse(JSON.stringify(value));

// A small in-memory Firestore double. It runs the real billing service source
// (not a copy) and can flip the signed-in scope after a transaction commits
// but before the service returns the result.
function harness() {
  const docs = new Map();
  const auth = { currentUser: { uid: 'payer' } };
  const timestamp = { toMillis: () => 1795000000000 };
  let inScope = true;
  let onCommitted;
  const ref = (...parts) => ({ path: parts.slice(1).join('/'), id: parts.at(-1) });
  const snapshot = value => ({ exists: () => value !== undefined, data: () => value });
  const firestore = {
    doc: (_db, ...parts) => ref('db', ...parts),
    collection: (_db, ...parts) => ref('db', ...parts),
    serverTimestamp: () => timestamp,
    async getDocFromServer(document) { return snapshot(docs.get(document.path)); },
    async runTransaction(_db, update) {
      const staged = new Map();
      const tx = {
        async get(document) { return snapshot(staged.has(document.path) ? staged.get(document.path) : docs.get(document.path)); },
        set(document, data) { staged.set(document.path, data); },
        delete(document) { staged.set(document.path, undefined); },
      };
      const result = await update(tx);
      for (const [path, data] of staged) {
        if (data === undefined) docs.delete(path);
        else docs.set(path, data);
      }
      onCommitted?.();
      return result;
    },
  };
  const service = loadSource('../../lib/billing.ts', {
    '@/lib/firebase': { initializeFirebase: async () => ({ db: 'db', firestore, auth }) },
    '@/lib/clinical-mutations': {
      ClinicalConflictError: class ClinicalConflictError extends Error {},
      prepareClinicalWrites: async (_db, fs, tx, writes) => uid => writes.map(write => {
        const entity = fs.doc('db', 'clinics', write.clinicId, write.collection, write.id);
        if (write.action === 'delete') tx.delete(entity);
        else tx.set(entity, { ...write.data, revision: write.expectedRevision + 1, actorUid: uid });
        return { id: write.id, revision: write.expectedRevision + 1 };
      }),
    },
  });
  const clinicId = 'fictional-clinic';
  const patientId = 'fictional-patient';
  const actor = { uid: auth.currentUser.uid, assertWorkspace: () => {
    if (!inScope) throw new Error('Open an editable clinic to use billing.');
  } };
  const operation = (operationId, amountMinor) => ({
    clinicId, patientId, operationId, expectedPatientRevision: 0,
    draft: { kind: 'payment', amountMinor, method: 'cash', occurredAtMs: 1795000000000 },
  });
  const recoveryPath = `clinics/${clinicId}/billingPaymentRecovery/payer/patients/${patientId}`;
  docs.set(`clinics/${clinicId}/patients/${patientId}`, {
    id: patientId, name: 'Fictional Patient', revision: 0, balance: 1000,
    billing: { lastEntryId: 'opening', seq: 1, openingMinor: 100000, balanceMinor: 100000,
      cutoffMs: 1794000000000, cutoffKind: 'reviewed' },
  });
  return {
    service, auth, operation, recoveryPath,
    reopen: () => { inScope = true; auth.currentUser = { uid: 'payer' }; },
    loseScopeAfterCommit: () => { onCommitted = () => {
      inScope = false;
      auth.currentUser = { uid: 'another-account' };
    }; },
    marker: () => docs.get(recoveryPath),
    entryIds: () => [...docs.keys()].filter(path => path.startsWith(`clinics/${clinicId}/billingEntries/`)).map(path => path.split('/').at(-1)),
    actor,
  };
}

test('an unaccepted payment result keeps its durable recovery marker', async () => {
  const app = harness();
  const operation = app.operation('lost-payment', 50000);
  app.loseScopeAfterCommit();
  await assert.rejects(app.service.commitBilling(operation, app.actor), /open an editable clinic/i);
  assert.deepEqual(app.entryIds(), ['lost-payment']);
  app.reopen();
  assert.deepEqual(plain(await app.service.loadUnconfirmedPayment(operation.clinicId, operation.patientId, app.actor)), operation);
});

test('acknowledgement clears only the matching posted payment and is idempotent', async () => {
  const app = harness();
  const operation = app.operation('recovered-payment', 50000);
  const committed = await app.service.commitBilling(operation, app.actor);
  const recover = () => app.service.loadUnconfirmedPayment(operation.clinicId, operation.patientId, app.actor);
  assert.deepEqual(plain(await recover()), operation);

  await app.service.acknowledgeBillingPayment(operation, app.actor);
  assert.equal(await recover(), null);
  assert.deepEqual(app.entryIds(), ['recovered-payment']);
  await app.service.acknowledgeBillingPayment(operation, app.actor);
  assert.deepEqual(app.entryIds(), ['recovered-payment']);

  // A replay of the acknowledged operation returns the original receipt.
  const replay = await app.service.commitBilling(operation, app.actor);
  assert.equal(replay.entry.id, operation.operationId);
  assert.deepEqual(app.entryIds(), ['recovered-payment']);

  // A separate later payment is still a legitimate new entry.
  const later = { ...operation, operationId: 'later-payment', draft: { ...operation.draft, amountMinor: 25000 },
    expectedPatientRevision: committed.patientRevision };
  const saved = await app.service.commitBilling(later, app.actor);
  assert.equal(saved.entry.id, 'later-payment');
  assert.equal(saved.state.balanceMinor, 25000);
  assert.deepEqual(app.entryIds().sort(), ['later-payment', 'recovered-payment']);
});

test('acknowledgement refuses another account, clinic, patient, receipt or operation ID', async () => {
  const cases = [
    { name: 'account', actor: actor => ({ ...actor, uid: 'another-account' }) },
    { name: 'clinic', operation: operation => ({ ...operation, clinicId: 'other-clinic' }) },
    { name: 'patient', operation: operation => ({ ...operation, patientId: 'other-patient' }) },
    { name: 'operation ID', operation: operation => ({ ...operation, operationId: 'another-payment' }) },
    { name: 'amount', operation: operation => ({ ...operation, draft: { ...operation.draft, amountMinor: 1 } }) },
    { name: 'invalid ID', operation: operation => ({ ...operation, operationId: 'bad/id' }) },
  ];
  for (const { name, actor: changeActor, operation: changeOperation } of cases) {
    const app = harness();
    const operation = app.operation('scoped-payment', 50000);
    await app.service.commitBilling(operation, app.actor);
    const actor = changeActor ? changeActor(app.actor) : app.actor;
    const target = changeOperation ? changeOperation(operation) : operation;
    await assert.rejects(() => app.service.acknowledgeBillingPayment(target, actor), undefined, name);
    assert.ok(app.marker(), `${name}: a rejected acknowledgement must leave the marker recoverable`);
  }
});
