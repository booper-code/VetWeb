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
const handles = url('export const initializeFirebase = async () => globalThis.__appointmentHandles;');
const mutationUrl = await compile('clinical-mutations.ts', { '@/lib/firebase': handles });
const valuesUrl = await compile('appointment-values.ts');
const appointmentUrl = await compile('appointments.ts', {
  '@/lib/firebase': handles, '@/lib/clinical-mutations': mutationUrl, '@/lib/appointment-values': valuesUrl,
});
const { saveAppointment, loadAppointmentsPage } = await import(appointmentUrl);
const { mutateClinicalRecord } = await import(mutationUrl);
const { defaultAppointmentWindow, appointmentWindowBounds } = await import(valuesUrl);

test('appointments are bounded, clinic-scoped, audited and role-protected', async t => {
  const clients = {};
  const clinicId = `appointments-${Date.now()}`;
  const ref = (client, collection, id, clinic = clinicId) => fs.doc(client.db, 'clinics', clinic, collection, id);
  const denied = operation => assert.rejects(operation, error => error.code === 'permission-denied');
  const select = role => { const client = clients[role]; globalThis.__appointmentHandles = { ...client, firestore: fs }; return client; };
  const draft = { patientId: 'patient', type: 'Vaccination', status: 'scheduled',
    dueAt: new Date(Date.now() + 3600000).toISOString(), durationMinutes: 30, notes: 'Synthetic appointment', occurredAt: null };
  try {
    for (const role of ['owner', 'editor', 'viewer', 'outsider']) {
      const app = initializeApp({ apiKey: 'fake-key', projectId }, `${clinicId}-${role}`);
      const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      const db = fs.getFirestore(app); const [hostname, port] = host.split(':');
      fs.connectFirestoreEmulator(db, hostname, Number(port));
      await createUserWithEmailAndPassword(auth, `${clinicId}-${role}@example.com`, 'AppointmentFixture123!');
      clients[role] = { app, auth, db };
    }
    const owner = select('owner'), uid = owner.auth.currentUser.uid;
    const bootstrap = fs.writeBatch(owner.db);
    bootstrap.set(fs.doc(owner.db, 'clinics', clinicId), { name: 'Synthetic appointments', ownerId: uid, createdAt: fs.serverTimestamp() });
    bootstrap.set(ref(owner, 'members', uid), { uid, email: owner.auth.currentUser.email, displayName: 'Fixture', role: 'owner', createdAt: fs.serverTimestamp() });
    bootstrap.set(fs.doc(owner.db, 'users', uid, 'clinics', clinicId), { clinicId, clinicName: 'Synthetic appointments', role: 'owner', joinedAt: fs.serverTimestamp() });
    await bootstrap.commit();
    const writes = ['editor', 'viewer'].map(role => ({
      update: { name: `projects/${projectId}/databases/(default)/documents/clinics/${clinicId}/members/${clients[role].auth.currentUser.uid}`, fields: { role: { stringValue: role } } },
    }));
    const patient = { name: 'Synthetic patient', ownerName: 'Fixture', ownerContact: '+639123456789', ownerEmail: 'fixture@example.com' };
    writes.push({ update: {
      name: `projects/${projectId}/databases/(default)/documents/clinics/${clinicId}/patients/patient`,
      fields: Object.fromEntries(Object.entries(patient).map(([key, value]) => [key, { stringValue: value }])),
    } });
    const seeded = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }),
    });
    assert.equal(seeded.status, 200);
    const save = (id, expectedRevision = null, patch = {}) => saveAppointment({ clinicId, id, expectedRevision, draft: { ...draft, ...patch } });
    await t.test('owner creates an appointment with canonical patient details and a server audit', async () => {
      const saved = await save('visit');
      assert.equal(saved.patientName, patient.name);
      assert.equal(saved.revision, 1);
      const stored = (await fs.getDoc(ref(owner, 'appointments', 'visit'))).data();
      assert.equal(stored.createdBy, uid);
      assert.equal(stored.updatedBy, uid);
      assert.ok(stored.createdAt.toMillis() > 0);
      assert.equal((await fs.getDoc(ref(owner, 'auditHeads', 'appointments_visit'))).data().seq, 1);
    });
    await t.test('editor and viewer can read; outsiders and other-clinic paths are denied', async () => {
      for (const role of ['editor', 'viewer']) assert.equal((await fs.getDoc(ref(clients[role], 'appointments', 'visit'))).exists(), true);
      await denied(() => fs.getDoc(ref(clients.outsider, 'appointments', 'visit')));
      await denied(() => fs.getDoc(ref(owner, 'appointments', 'visit', `${clinicId}-foreign`)));
    });
    await t.test('viewer cannot save even a complete audited appointment', async () => {
      select('viewer'); await denied(() => save('viewer-denied')); select('owner');
    });
    await t.test('editor reschedules and stale edits are rejected', async () => {
      select('editor');
      const saved = await save('visit', 1, { type: 'Follow-up' });
      assert.equal(saved.revision, 2);
      await assert.rejects(save('visit', 1), error => error.name === 'ClinicalConflictError');
      select('owner');
    });
    await t.test('same revision concurrent saves cannot both succeed', async () => {
      const attempts = await Promise.allSettled([save('visit', 2, { notes: 'First' }), save('visit', 2, { notes: 'Second' })]);
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((await fs.getDoc(ref(owner, 'appointments', 'visit'))).data().revision, 3);
    });
    await t.test('backdated actual visits retain a separate current recorded timestamp', async () => {
      const occurredAt = new Date(Date.now() - 8 * 3600000).toISOString();
      const saved = await save('completed', null, { status: 'completed', occurredAt });
      assert.equal(saved.occurredAt, occurredAt);
      assert.ok(new Date(saved.createdAt) > new Date(saved.occurredAt));
    });
    const valid = (await fs.getDoc(ref(owner, 'appointments', 'visit'))).data();
    const direct = patch => mutateClinicalRecord({
      clinicId, collection: 'appointments', id: 'visit', expectedRevision: 3, action: 'save',
      data: { ...valid, ...patch, updatedAt: fs.serverTimestamp(), updatedBy: uid },
    });
    for (const [label, patch] of [
      ['malformed due date', { dueAt: 'tomorrow' }], ['negative duration', { durationMinutes: -1 }],
      ['fractional duration', { durationMinutes: 30.5 }], ['oversized notes', { notes: 'x'.repeat(2001) }],
      ['unknown field', { arbitraryToolData: 'denied' }], ['forged creation actor', { createdBy: clients.editor.auth.currentUser.uid }],
      ['forged creation time', { createdAt: fs.Timestamp.fromMillis(1) }], ['patient identity substitution', { patientId: 'foreign-patient' }],
      ['patient snapshot forgery', { patientName: 'Wrong patient' }],
      ['future actual visit', { status: 'completed', occurredAt: fs.Timestamp.fromMillis(Date.now() + 86400000) }],
      ['actual time on scheduled appointment', { occurredAt: fs.Timestamp.now() }],
    ]) await t.test(`rules reject direct audited write: ${label}`, () => denied(() => direct(patch)));
    await t.test('unaudited writes and all hard deletes are denied', async () => {
      await denied(() => fs.updateDoc(ref(owner, 'appointments', 'visit'), { notes: 'No audit' }));
      await denied(() => fs.deleteDoc(ref(owner, 'appointments', 'visit')));
      await denied(() => mutateClinicalRecord({ clinicId, collection: 'appointments', id: 'visit', expectedRevision: 3, action: 'delete' }));
    });
    await t.test('missing or cross-clinic patients cannot create appointments', async () => {
      await assert.rejects(save('missing-patient', null, { patientId: 'foreign-patient' }), /Patient not found/);
    });
    await t.test('cancellation keeps history and still works after a patient is deleted', async () => {
      await mutateClinicalRecord({ clinicId, collection: 'patients', id: 'patient', expectedRevision: 0, action: 'delete' });
      const saved = await save('visit', 3, { status: 'cancelled' });
      assert.equal(saved.status, 'cancelled');
      assert.equal(saved.patientName, patient.name);
      assert.equal(saved.revision, 4);
    });
    await t.test('bounded range pages handle equal timestamps without omissions or duplicates', async () => {
      const range = defaultAppointmentWindow(), bounds = appointmentWindowBounds(range);
      const due = new Date(new Date(bounds.start).getTime() + 12 * 3600000);
      // Seed only the local emulator, not the app protocol, to keep the test quick.
      const pagingWrites = [];
      for (let index = 0; index < 55; index++) pagingWrites.push({ update: {
        name: `projects/${projectId}/databases/(default)/documents/clinics/${clinicId}/appointments/page-${String(index).padStart(3, '0')}`,
        fields: { ...Object.fromEntries(Object.entries({ patientName: 'Paging fixture', status: 'scheduled', type: 'Checkup', id: 'incorrect-stored-id' }).map(([k, v]) => [k, { stringValue: v }])),
          dueAt: { timestampValue: due.toISOString() }, revision: { integerValue: '1' } },
      } });
      const response = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents:commit`, {
        method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: pagingWrites }),
      });
      assert.equal(response.status, 200);
      const first = await loadAppointmentsPage(clinicId, range);
      assert.equal(first.records.length, 50); assert.equal(first.hasMore, true);
      const second = await loadAppointmentsPage(clinicId, range, first.cursor);
      assert.equal(second.hasMore, false);
      const all = [...first.records, ...second.records];
      assert.equal(new Set(all.map(row => row.id)).size, all.length);
      assert.equal(all.filter(row => row.id.startsWith('page-')).length, 55);
      assert.ok(all.every(row => row.id !== 'incorrect-stored-id'));
      const none = await loadAppointmentsPage(clinicId, { from: '2001-01-01', through: '2001-01-02' });
      assert.equal(none.records.length, 0);
      await denied(() => loadAppointmentsPage(`${clinicId}-foreign`, range));
    });
    await t.test('offline reads use the cached range; offline saves never queue', async () => {
      const range = defaultAppointmentWindow();
      await loadAppointmentsPage(clinicId, range);
      const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
      Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
      await fs.disableNetwork(owner.db);
      try {
        const cached = await loadAppointmentsPage(clinicId, range);
        assert.equal(cached.fromCache, true);
        assert.ok(cached.records.length > 0);
        await assert.rejects(save('offline-no-queue'), /not queued offline/);
      } finally {
        if (descriptor) Object.defineProperty(globalThis.navigator, 'onLine', descriptor);
        else delete globalThis.navigator.onLine;
        await fs.enableNetwork(owner.db);
      }
      assert.equal((await fs.getDoc(ref(owner, 'appointments', 'offline-no-queue'))).exists(), false);
    });
  } finally {
    delete globalThis.__appointmentHandles;
    await Promise.all(Object.values(clients).map(client => deleteApp(client.app)));
  }
});
