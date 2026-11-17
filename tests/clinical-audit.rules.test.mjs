import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth';
import * as fs from 'firebase/firestore';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('A local emulator is required.');
const projectId = 'demo-vetcloud-rules';
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const handlesUrl = moduleUrl('export const initializeFirebase = async () => globalThis.__auditHandles;');
const source = (await readFile(new URL('../lib/clinical-mutations.ts', import.meta.url), 'utf8'))
  .replace('@/lib/firebase', handlesUrl);
const { mutateClinicalRecord, mutateClinicalRecords } = await import(moduleUrl(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText));

test('clinical writes require atomic immutable audits and reject stale revisions', async t => {
  const clients = {};
  const clinicId = `audit-${Date.now()}`;
  const selectClient = role => {
    const client = clients[role];
    globalThis.__auditHandles = { ...client, firestore: fs };
    return client;
  };
  const ref = (client, collection, id) => fs.doc(client.db, 'clinics', clinicId, collection, id);
  const denied = operation => assert.rejects(operation, error => error.code === 'permission-denied');
  try {
    for (const role of ['owner', 'editor', 'viewer']) {
      const app = initializeApp({ apiKey: 'fake-key', projectId }, `${clinicId}-${role}`);
      const auth = getAuth(app);
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      const db = fs.getFirestore(app);
      const [hostname, port] = host.split(':');
      fs.connectFirestoreEmulator(db, hostname, Number(port));
      await createUserWithEmailAndPassword(auth, `${clinicId}-${role}@example.com`, 'AuditFixture123!');
      clients[role] = { app, auth, db };
    }
    const owner = selectClient('owner');
    const uid = owner.auth.currentUser.uid;
    const bootstrap = fs.writeBatch(owner.db);
    bootstrap.set(fs.doc(owner.db, 'clinics', clinicId), { name: 'Audit test', ownerId: uid, createdAt: fs.serverTimestamp() });
    bootstrap.set(ref(owner, 'members', uid), {
      uid, email: owner.auth.currentUser.email, displayName: 'Owner', role: 'owner', createdAt: fs.serverTimestamp()
    });
    bootstrap.set(fs.doc(owner.db, 'users', uid, 'clinics', clinicId), {
      clinicId, clinicName: 'Audit test', role: 'owner', joinedAt: fs.serverTimestamp()
    });
    await bootstrap.commit();
    const writes = ['editor', 'viewer'].map(role => ({
      update: {
        name: `projects/${projectId}/databases/(default)/documents/clinics/${clinicId}/members/${clients[role].auth.currentUser.uid}`,
        fields: { role: { stringValue: role } }
      }
    }));
    writes.push({ update: {
      name: `projects/${projectId}/databases/(default)/documents/clinics/${clinicId}/patients/legacy`,
      fields: { name: { stringValue: 'Synthetic legacy' }, status: { stringValue: 'Waiting' } }
    } });
    const seeded = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ writes })
    });
    assert.equal(seeded.status, 200);
    await denied(() => fs.setDoc(ref(owner, 'patients', 'unaudited'), { name: 'Denied' }));
    await denied(() => fs.setDoc(ref(owner, 'inventory', 'unaudited'), { stock: 1 }));
    let saved = await mutateClinicalRecord({
      clinicId, collection: 'patients', id: 'legacy', expectedRevision: 0,
      action: 'save', data: { name: 'Updated synthetic', status: 'Waiting' }
    });
    assert.equal(saved.revision, 1);
    assert.equal((await fs.getDoc(ref(owner, 'patients', 'legacy'))).data().revision, 1);
    await assert.rejects(mutateClinicalRecord({
      clinicId, collection: 'patients', id: 'legacy', expectedRevision: 0,
      action: 'save', data: { name: 'Stale editor' }
    }), error => error.name === 'ClinicalConflictError');
    const events = () => fs.getDocs(fs.collection(owner.db, 'clinics', clinicId, 'auditEvents'));
    assert.equal((await events()).size, 1);
    const event = (await events()).docs[0];
    assert.deepEqual(Object.keys(event.data()).sort(), ['action', 'actorUid', 'entityId', 'entityType', 'eventId', 'seq', 'time']);
    await denied(() => fs.updateDoc(event.ref, { action: 'delete' }));
    await denied(() => fs.deleteDoc(event.ref));
    await denied(() => fs.updateDoc(ref(owner, 'patients', 'legacy'), { revision: 2 }));
    selectClient('viewer');
    await denied(() => mutateClinicalRecord({
      clinicId, collection: 'patients', id: 'viewer-write', expectedRevision: null,
      action: 'save', data: { name: 'Denied' }
    }));
    await denied(() => fs.getDocs(fs.collection(clients.viewer.db, 'clinics', clinicId, 'auditEvents')));
    selectClient('editor');
    saved = await mutateClinicalRecord({
      clinicId, collection: 'inventory', id: 'item', expectedRevision: null,
      action: 'save', data: { itemCode: 'item', stock: 10 }
    });
    assert.equal(saved.revision, 1);
    await denied(() => fs.getDocs(fs.collection(clients.editor.db, 'clinics', clinicId, 'auditEvents')));
    selectClient('owner');
    const concurrent = await Promise.allSettled(['First editor', 'Second editor'].map(name => mutateClinicalRecord({
      clinicId, collection: 'patients', id: 'legacy', expectedRevision: 1,
      action: 'save', data: { name, status: 'Waiting' }
    })));
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await fs.getDoc(ref(owner, 'patients', 'legacy'))).data().revision, 2);
    await mutateClinicalRecord({ clinicId, collection: 'patients', id: 'legacy', expectedRevision: 2, action: 'delete' });
    assert.equal((await fs.getDoc(ref(owner, 'patients', 'legacy'))).exists(), false);
    assert.equal((await fs.getDoc(ref(owner, 'auditHeads', 'patients_legacy'))).data().seq, 3);
    await denied(() => fs.deleteDoc(ref(owner, 'auditHeads', 'patients_legacy')));
    await assert.rejects(mutateClinicalRecord({
      clinicId, collection: 'patients', id: 'legacy', expectedRevision: null,
      action: 'save', data: { name: 'Reused identity' }
    }), error => error.name === 'ClinicalConflictError');
    assert.equal((await events()).size, 4);
    const initial = [
      { clinicId, collection: 'patients', id: 'billing', expectedRevision: null, action: 'save', data: { name: 'Billing fixture', balance: 0 } },
      ...['stock-one', 'stock-two'].map(id => ({ clinicId, collection: 'inventory', id, expectedRevision: null, action: 'save', data: { stock: 10 } }))
    ];
    assert.deepEqual((await mutateClinicalRecords(initial)).map(result => result.revision), [1, 1, 1]);
    const change = initial.map((input, index) => ({ ...input, expectedRevision: index === 1 ? 0 : 1,
      data: index === 0 ? { name: 'Billing fixture', balance: 10 } : { stock: 9 } }));
    await assert.rejects(mutateClinicalRecords(change), error => error.name === 'ClinicalConflictError');
    assert.equal((await fs.getDoc(ref(owner, 'patients', 'billing'))).data().balance, 0);
    assert.equal((await fs.getDoc(ref(owner, 'inventory', 'stock-two'))).data().stock, 10);
    assert.equal((await events()).size, 7);
    assert.deepEqual((await mutateClinicalRecords(change.map(input => ({ ...input, expectedRevision: 1 }))))
      .map(result => result.revision), [2, 2, 2]);
    assert.equal((await events()).size, 10);
    await denied(() => fs.setDoc(ref(owner, 'consultations', 'unaudited'), { status: 'Draft' }));
    const legacyConsultation = {
      date: '01/01/2026', client: '', patient: 'Synthetic', type: 'Consultation', notes: ''
    };
    await mutateClinicalRecord({
      clinicId, collection: 'consultations', id: 'soap', expectedRevision: null,
      action: 'save', data: { ...legacyConsultation, status: 'Draft' }
    });
    await mutateClinicalRecord({
      clinicId, collection: 'consultations', id: 'soap', expectedRevision: 1,
      action: 'save', data: { ...legacyConsultation, status: 'Completed' }
    });
    assert.equal((await fs.getDoc(ref(owner, 'consultations', 'soap'))).data().status, 'Completed');
    assert.equal((await events()).size, 12);
    // The migration tool uses the same audited protocol through Firestore REST.
    await mutateClinicalRecord({
      clinicId, collection: 'patients', id: 'rest-patient', expectedRevision: null,
      action: 'save', data: { name: 'REST fixture', status: 'Waiting' }
    });
    const token = await owner.auth.currentUser.getIdToken();
    const root = `projects/${projectId}/databases/(default)/documents`;
    const api = `http://${host}/v1/${root}`;
    const entityName = `${root}/clinics/${clinicId}/patients/rest-patient`;
    const headName = `${root}/clinics/${clinicId}/auditHeads/patients_rest-patient`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const currentEntity = await (await fetch(`http://${host}/v1/${entityName}`, { headers })).json();
    const currentHead = await (await fetch(`http://${host}/v1/${headName}`, { headers })).json();
    const metadata = {
      actorUid: { stringValue: uid }, action: { stringValue: 'update' },
      entityType: { stringValue: 'patients' }, entityId: { stringValue: 'rest-patient' },
      seq: { integerValue: '2' }, eventId: { stringValue: 'rest-audit-event' }
    };
    const response = await fetch(`${api}:commit`, { method: 'POST', headers, body: JSON.stringify({ writes: [
      { update: { name: entityName, fields: { status: { stringValue: 'Confined' }, revision: { integerValue: '2' } } },
        updateMask: { fieldPaths: ['status', 'revision'] }, currentDocument: { updateTime: currentEntity.updateTime } },
      { update: { name: headName, fields: metadata }, currentDocument: { updateTime: currentHead.updateTime },
        updateTransforms: [{ fieldPath: 'time', setToServerValue: 'REQUEST_TIME' }] },
      { update: { name: `${root}/clinics/${clinicId}/auditEvents/rest-audit-event`, fields: metadata },
        currentDocument: { exists: false }, updateTransforms: [{ fieldPath: 'time', setToServerValue: 'REQUEST_TIME' }] }
    ] }) });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal((await fs.getDoc(ref(owner, 'patients', 'rest-patient'))).data().status, 'Confined');
    // B is owned by the same user: cross-clinic denials must come from audit
    // binding, not simply a missing membership in the second clinic.
    const secondClinic = `${clinicId}-b`;
    const second = fs.writeBatch(owner.db);
    second.set(fs.doc(owner.db, 'clinics', secondClinic), { name: 'Second audit fixture', ownerId: uid, createdAt: fs.serverTimestamp() });
    second.set(fs.doc(owner.db, 'clinics', secondClinic, 'members', uid), {
      uid, email: owner.auth.currentUser.email, displayName: 'Owner', role: 'owner', createdAt: fs.serverTimestamp()
    });
    second.set(fs.doc(owner.db, 'users', uid, 'clinics', secondClinic), {
      clinicId: secondClinic, clinicName: 'Second audit fixture', role: 'owner', joinedAt: fs.serverTimestamp()
    });
    await second.commit();

    let caseNumber = 0;
    const direct = (client, options = {}) => {
      const id = options.id ?? `adversarial-${++caseNumber}`;
      const eventId = options.eventId ?? `event-${id}-${caseNumber}`;
      const metadata = {
        actorUid: client.auth.currentUser.uid, action: 'create', entityType: 'patients',
        entityId: id, seq: 1, eventId, time: fs.serverTimestamp(), ...options.metadata,
      };
      const batch = fs.writeBatch(client.db);
      const entity = fs.doc(client.db, 'clinics', clinicId, 'patients', id);
      const head = fs.doc(client.db, 'clinics', options.headClinic ?? clinicId, 'auditHeads', `patients_${id}`);
      const event = fs.doc(client.db, 'clinics', options.eventClinic ?? clinicId, 'auditEvents', eventId);
      if (!options.skipEntity) batch.set(entity, { name: 'Direct synthetic write', revision: metadata.seq });
      batch.set(head, { ...metadata, ...options.head });
      if (!options.skipEvent) batch.set(event, { ...metadata, ...options.event });
      return { commit: () => batch.commit(), entity, head, event };
    };
    const rejectDirect = async options => {
      const attempt = direct(owner, options);
      const before = (await fs.getDoc(attempt.entity)).data();
      await denied(attempt.commit);
      assert.deepEqual((await fs.getDoc(attempt.entity)).data(), before, 'denied batch must not change clinical data');
    };
    const attacks = [
      ['forged actorUid', { metadata: { actorUid: clients.editor.auth.currentUser.uid } }],
      ['client timestamp', { metadata: { time: fs.Timestamp.fromMillis(1) } }],
      ['sequence gap on create', { metadata: { seq: 2 } }],
      ['sequence zero on create', { metadata: { seq: 0 } }],
      ['event claims a different patient', { event: { entityId: 'another-patient' } }],
      ['head claims a different patient', { head: { entityId: 'another-patient' } }],
      ['head is stored in another owned clinic', { headClinic: secondClinic }],
      ['event is stored in another owned clinic', { eventClinic: secondClinic }],
      ['head and event are stored in another owned clinic', { headClinic: secondClinic, eventClinic: secondClinic }],
      ['extra event fields', { event: { clinicalSnapshot: 'must not be accepted' } }],
      ['extra head fields', { head: { clinicalSnapshot: 'must not be accepted' } }],
      ['matching extra head/event fields', { metadata: { clinicalSnapshot: 'must not be accepted' } }],
      ['reuse of immutable existing event', { id: 'rest-patient', eventId: 'rest-audit-event',
        metadata: { action: 'update', seq: 3 }, skipEvent: true }],
      ['deleted ID recreation with null/create semantics', { id: 'legacy' }],
      ['deleted ID recreation with next sequence', { id: 'legacy', metadata: { seq: 4 } }],
      ['head/event without an entity transition', { id: 'rest-patient', skipEntity: true, metadata: { action: 'update', seq: 3 } }],
      ['delete action without deleting the entity', { id: 'rest-patient', skipEntity: true, metadata: { action: 'delete', seq: 3 } }],
      ['mismatched action', { event: { action: 'delete' } }],
      ['mismatched entity type', { event: { entityType: 'inventory' } }],
      ['malformed sequence type', { metadata: { seq: '1' } }],
      ['malformed actor type', { metadata: { actorUid: true } }],
    ];
    for (const [label, options] of attacks) await t.test(`direct audit attack denied: ${label}`, () => rejectDirect(options));
    await t.test('direct editor consistent head/event is allowed; inconsistent one is denied', async () => {
      const valid = direct(clients.editor);
      await valid.commit();
      assert.equal((await fs.getDoc(valid.entity)).data().revision, 1);
      const invalid = direct(clients.editor, { event: { actorUid: uid } });
      await denied(invalid.commit);
      assert.equal((await fs.getDoc(invalid.entity)).exists(), false);
      // Repeating/skipping an existing revision must fail without relying on
      // the helper's expectedRevision check.
      for (const seq of [1, 3]) {
        const attempt = direct(clients.editor, {
          id: valid.entity.id, eventId: `bad-update-${seq}`,
          metadata: { action: 'update', seq },
        });
        await denied(attempt.commit);
        assert.equal((await fs.getDoc(valid.entity)).data().revision, 1);
      }
    });
  } finally {
    delete globalThis.__auditHandles;
    await Promise.all(Object.values(clients).map(client => deleteApp(client.app)));
  }
});
