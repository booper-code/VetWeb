import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, loadSource } from './helpers/tsx-harness.mjs';

const snapshot = (data, fromCache = false, hasPendingWrites = false) => ({
  exists: () => data !== null, data: () => data, metadata: { fromCache, hasPendingWrites },
});

test('only live canonical membership can unlock the assistant; auth changes invalidate it', async () => {
  let authChanged, memberChanged, memberError, stopped = 0;
  const auth = { currentUser: { uid: 'fixture-staff' }, onAuthStateChanged(listener) {
    authChanged = listener;
    return () => { stopped++; };
  } };
  const firestore = {
    doc: (_db, ...path) => path,
    onSnapshot(path, options, callback, onError) {
      assert.deepEqual(path, ['clinics', 'fixture-clinic', 'members', 'fixture-staff']);
      assert.equal(options.includeMetadataChanges, true);
      memberChanged = callback; memberError = onError;
      return () => { stopped++; };
    },
  };
  const { watchAssistantRole } = loadSource('../../lib/workspace-assistant-access.ts', {
    '@/lib/firebase': { initializeFirebase: async () => ({ auth, firestore, db: {} }) },
  });
  const seen = [];
  const stop = await watchAssistantRole('fixture-clinic', 'fixture-staff', role => seen.push(role));
  authChanged(auth.currentUser);
  memberChanged(snapshot({ role: 'owner' }, true));
  memberChanged(snapshot({ role: 'owner' }, false, true));
  memberChanged(snapshot({ role: 'editor' }));
  memberChanged(snapshot({ role: 'viewer' }));
  memberError();
  auth.currentUser = { uid: 'another-fixture' };
  authChanged(auth.currentUser);
  memberChanged(snapshot({ role: 'owner' }));
  stop();
  assert.deepEqual(seen, [null, null, null, 'member', 'member', null, null]);
  assert.equal(stopped, 2);
});

test('fresh assistant access reads membership and the owner switch, then checks the same UID again', async () => {
  const auth = { currentUser: { uid: 'fixture-staff' } };
  let enabled = true, role = 'editor', waiting = null;
  const reads = [];
  const firestore = {
    doc: (_db, ...path) => path,
    async getDocFromServer(path) {
      reads.push(path.join('/'));
      await waiting?.promise;
      return snapshot(path.length === 2 ? { aiEnabled: enabled } : { role });
    },
  };
  const { readAssistantRole } = loadSource('../../lib/workspace-assistant-access.ts', {
    '@/lib/firebase': { initializeFirebase: async () => ({ auth, firestore, db: {} }) },
  });
  assert.equal(await readAssistantRole('fixture-clinic', 'fixture-staff'), 'member');
  role = 'viewer';
  assert.equal(await readAssistantRole('fixture-clinic', 'fixture-staff'), 'member');
  enabled = false;
  assert.equal(await readAssistantRole('fixture-clinic', 'fixture-staff'), null);
  enabled = true;
  waiting = deferred();
  const outstanding = readAssistantRole('fixture-clinic', 'fixture-staff');
  await Promise.resolve();
  auth.currentUser = { uid: 'other-fixture' };
  waiting.resolve();
  assert.equal(await outstanding, null);
  const before = reads.length;
  assert.equal(await readAssistantRole('fixture-clinic', 'fixture-staff'), null);
  assert.equal(reads.length, before);
  assert.ok(reads.includes('clinics/fixture-clinic/members/fixture-staff'));
  assert.ok(reads.includes('clinics/fixture-clinic'));
});

test('a signed-in account change blocks appointment saves before any record read or transaction', async () => {
  let attempts = 0;
  const init = async () => ({
    auth: { currentUser: { uid: 'other-fixture' } },
    db: {},
    firestore: { doc() { attempts++; }, runTransaction() { attempts++; } },
  });
  const mocks = { '@/lib/firebase': { initializeFirebase: init } };
  const { saveAppointment } = loadSource('../../lib/appointments.ts', mocks);
  const { mutateClinicalRecord } = loadSource('../../lib/clinical-mutations.ts', mocks);
  const draft = {
    patientId: 'patient-fixture', type: 'Checkup', status: 'scheduled',
    dueAt: '2026-11-24T06:30:00.000Z', durationMinutes: 30, notes: '', occurredAt: null,
  };
  const input = { clinicId: 'fixture-clinic', id: 'fixture-appointment', expectedRevision: 3, expectedUid: 'fixture-staff' };
  await assert.rejects(saveAppointment({ ...input, draft }), /signed-in account changed/i);
  await assert.rejects(mutateClinicalRecord({ ...input, collection: 'appointments', action: 'save', data: draft }), /signed-in account changed/i);
  assert.equal(attempts, 0);
});
