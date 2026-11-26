/**
 * Firestore authorization tests for the multi-clinic model.
 *
 * Run with: npm run test:rules
 * Uses the emulator suite and a throwaway demo project, so it never touches
 * the real vetcloudpro data.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as firestoreModule from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  sendEmailVerification,
  applyActionCode,
  signOut
} from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch
} from 'firebase/firestore';

const projectId = 'demo-vetcloud-rules';
const password = 'VetDemoPass2026!';
const hash64 = 'a'.repeat(64);

const app = initializeApp({ apiKey: 'fake-api-key', authDomain: 'localhost', projectId }, `rules-${Date.now()}`);
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);

// Execute the real client functions against emulator handles, never production.
globalThis.__invitationTestHandles = { auth, db, firestore: firestoreModule };
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const handlesUrl = moduleUrl('export const initializeFirebase = async () => globalThis.__invitationTestHandles;');
async function loadClientModule(path, replacements) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
  return moduleUrl(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText);
}
const verificationUrl = await loadClientModule('../lib/invitation-verification.ts', {
  '@/lib/firebase': handlesUrl,
  "'firebase/auth'": JSON.stringify(import.meta.resolve('firebase/auth'))
});
const clinicsUrl = await loadClientModule('../lib/clinics.ts', {
  '@/lib/firebase': handlesUrl,
  '@/lib/invitation-verification': verificationUrl,
  '@/lib/clinic-role': await loadClientModule('../lib/clinic-role.ts', {})
});
const { acceptClinicInvitation, createClinic: createClientClinic, createClinicInvitation, listUserClinics } = await import(clinicsUrl);
const { refreshInvitationVerification } = await import(verificationUrl);
const clinicalUrl = await loadClientModule('../lib/clinical-mutations.ts', {
  '@/lib/firebase': handlesUrl
});
const { mutateClinicalRecord, mutateClinicalRecords } = await import(clinicalUrl);
const { saveStaffMember, createPayrollPeriod, closePayrollPeriod } = await import(await loadClientModule('../lib/payroll.ts', {
  '@/lib/firebase': handlesUrl,
  '@/lib/clinical-mutations': clinicalUrl
}));

async function verifyCurrentEmail() {
  await sendEmailVerification(auth.currentUser);
  const response = await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${projectId}/oobCodes`);
  assert.equal(response.ok, true);
  const { oobCodes } = await response.json();
  const code = oobCodes.filter(item => item.email === auth.currentUser.email && item.requestType === 'VERIFY_EMAIL').at(-1);
  assert.ok(code);
  await applyActionCode(auth, code.oobCode);
  assert.equal(await refreshInvitationVerification(auth.currentUser.uid), true);
}

// An unsigned JWT is accepted only by the Firestore emulator. This explicitly
// covers absent claims, which ordinary email/password Auth tokens always have.
async function adversarialClaim(clinicId, invitationRef, uid, email, verified) {
  const claims = {
    sub: uid, user_id: uid, email, aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'password' },
    ...(verified === undefined ? {} : { email_verified: verified })
  };
  const token = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
  const root = `projects/${projectId}/databases/(default)/documents`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const invitePath = `${root}/clinics/${clinicId}/invitations/${invitationRef.id}`;
  const read = await fetch(`http://127.0.0.1:8080/v1/${invitePath}`, { headers });
  assert.equal(read.status, 403, `invite get denied for email_verified=${verified}`);
  const fields = data => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { stringValue: value }]));
  const response = await fetch(`http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents:commit`, {
    method: 'POST', headers,
    body: JSON.stringify({ writes: [
       { update: { name: `${root}/clinics/${clinicId}/members/${uid}`, fields: fields({ uid, email, displayName: 'Adversary', role: 'member', invitationId: invitationRef.id }) },
        updateTransforms: [{ fieldPath: 'joinedAt', setToServerValue: 'REQUEST_TIME' }] },
       { update: { name: `${root}/users/${uid}/clinics/${clinicId}`, fields: fields({ clinicId, clinicName: 'Renamed Clinic', role: 'member', invitationId: invitationRef.id }) },
        updateTransforms: [{ fieldPath: 'joinedAt', setToServerValue: 'REQUEST_TIME' }] },
      { update: { name: invitePath, fields: fields({ status: 'accepted', acceptedBy: uid }) },
        updateMask: { fieldPaths: ['status', 'acceptedBy'] },
        updateTransforms: [{ fieldPath: 'acceptedAt', setToServerValue: 'REQUEST_TIME' }] }
    ] })
  });
  assert.equal(response.status, 403, `direct atomic claim denied for email_verified=${verified}`);
  pass(`invite get and direct claim reject email_verified=${verified}`);
}

const suffix = Date.now();
const emails = Object.fromEntries(
  ['owner', 'viewer', 'editor', 'outsider'].map(role => [role, `${role}-${suffix}@example.com`])
);

const pass = label => console.log(`PASS ${label}`);

async function denied(label, operation) {
  let didDeny = false;
  try {
    await operation();
  } catch (error) {
    if (error?.code !== 'permission-denied') throw error;
    didDeny = true;
  }
  assert.equal(didDeny, true, `${label}: expected permission-denied`);
  pass(label);
}

async function signUp(email) {
  await signOut(auth).catch(() => {});
  await createUserWithEmailAndPassword(auth, email, password);
  return auth.currentUser;
}

async function invite(clinicId, clinicName, email, role) {
  const ref = doc(collection(db, 'clinics', clinicId, 'invitations'));
  await setDoc(ref, {
    clinicId,
    clinicName,
    email,
    role,
    status: 'pending',
    createdBy: auth.currentUser.uid,
    createdByEmail: auth.currentUser.email,
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 7 * 86400000))
  });
  return ref;
}

async function acceptInvite(clinicId, clinicName, invitationRef, role) {
  const uid = auth.currentUser.uid;
  const email = auth.currentUser.email;
  const displayName = email.split('@')[0];
  const memberRef = doc(db, 'clinics', clinicId, 'members', uid);
  const indexRef = doc(db, 'users', uid, 'clinics', clinicId);

  await runTransaction(db, async transaction => {
    const invitation = await transaction.get(invitationRef);
    const existingIndex = await transaction.get(indexRef);
    assert.equal(invitation.data().status, 'pending');
    assert.equal(existingIndex.exists(), false);

    transaction.set(memberRef, {
      uid,
      email,
      displayName,
      role,
      joinedAt: serverTimestamp(),
      invitationId: invitationRef.id
    });
    transaction.set(indexRef, {
      clinicId,
      clinicName,
      role,
      joinedAt: serverTimestamp(),
      invitationId: invitationRef.id
    });
    transaction.update(invitationRef, {
      status: 'accepted',
      acceptedBy: uid,
      acceptedAt: serverTimestamp()
    });
  });
}

async function createClinic(name) {
  const clinicRef = doc(collection(db, 'clinics'));
  const uid = auth.currentUser.uid;
  const batch = writeBatch(db);
  batch.set(clinicRef, { name, ownerId: uid, createdAt: serverTimestamp() });
  batch.set(doc(db, 'clinics', clinicRef.id, 'members', uid), {
    uid,
    email: auth.currentUser.email,
    displayName: 'Owner',
    role: 'owner',
    createdAt: serverTimestamp()
  });
  batch.set(doc(db, 'users', uid, 'clinics', clinicRef.id), {
    clinicId: clinicRef.id,
    clinicName: name,
    role: 'owner',
    joinedAt: serverTimestamp()
  });
  await batch.commit();
  return clinicRef;
}

async function changeRole(clinicId, memberUid, role) {
  const memberRef = doc(db, 'clinics', clinicId, 'members', memberUid);
  const indexRef = doc(db, 'users', memberUid, 'clinics', clinicId);
  await runTransaction(db, async transaction => {
    await transaction.get(memberRef);
    transaction.update(memberRef, { role });
    transaction.update(indexRef, { role });
  });
}

async function removeMember(clinicId, memberUid) {
  const memberRef = doc(db, 'clinics', clinicId, 'members', memberUid);
  const indexRef = doc(db, 'users', memberUid, 'clinics', clinicId);
  await runTransaction(db, async transaction => {
    await transaction.get(memberRef);
    transaction.delete(memberRef);
    transaction.delete(indexRef);
  });
}

async function transferOwnership(clinicId, fromUid, toUid) {
  const clinicRef = doc(db, 'clinics', clinicId);
  const fromMemberRef = doc(db, 'clinics', clinicId, 'members', fromUid);
  const toMemberRef = doc(db, 'clinics', clinicId, 'members', toUid);
  const fromIndexRef = doc(db, 'users', fromUid, 'clinics', clinicId);
  const toIndexRef = doc(db, 'users', toUid, 'clinics', clinicId);

  await runTransaction(db, async transaction => {
    await transaction.get(clinicRef);
    await transaction.get(fromMemberRef);
    await transaction.get(toMemberRef);
    transaction.update(clinicRef, { ownerId: toUid });
    transaction.update(fromMemberRef, { role: 'editor' });
    transaction.update(toMemberRef, { role: 'owner' });
    transaction.update(fromIndexRef, { role: 'editor' });
    transaction.update(toIndexRef, { role: 'owner' });
  });
}

async function seedLegacyInvite(clinicId, clinicName, email, role, owner) {
  const ref = doc(collection(db, 'clinics', clinicId, 'invitations'));
  const fields = Object.fromEntries(Object.entries({
    clinicId, clinicName, email, role, status: 'pending', createdBy: owner.uid, createdByEmail: owner.email
  }).map(([name, stringValue]) => [name, { stringValue }]));
  fields.expiresAt = { timestampValue: new Date(Date.now() + 86400000).toISOString() };
  const response = await fetch(`http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents/${ref.path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  assert.equal(response.status, 200, await response.text());
  return ref;
}

async function rejectIncompleteTransfers(clinicId, fromUid, toUid) {
  const writes = [
    ['clinic ownerId', doc(db, 'clinics', clinicId), { ownerId: toUid }],
    ['source membership', doc(db, 'clinics', clinicId, 'members', fromUid), { role: 'editor' }],
    ['destination membership', doc(db, 'clinics', clinicId, 'members', toUid), { role: 'owner' }],
    ['source index', doc(db, 'users', fromUid, 'clinics', clinicId), { role: 'editor' }],
    ['destination index', doc(db, 'users', toUid, 'clinics', clinicId), { role: 'owner' }]
  ];
  // Every nonempty proper subset must fail, including transfers that keep the
  // old owner privileged and transfers that leave either picker index stale.
  for (let mask = 1; mask < 31; mask++) {
    const selected = writes.filter((_, index) => mask & (1 << index));
    await denied(`incomplete transfer rejected: ${selected.map(([name]) => name).join(', ')}`, () => {
      const batch = writeBatch(db);
      for (const [, ref, data] of selected) batch.update(ref, data);
      return batch.commit();
    });
  }
  assert.equal((await getDoc(doc(db, 'clinics', clinicId))).data().ownerId, fromUid);
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'members', fromUid))).data().role, 'owner');
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'members', toUid))).data().role, 'member');
  assert.equal((await getDoc(doc(db, 'users', fromUid, 'clinics', clinicId))).data().role, 'owner');
}

async function appendLedgerEntry(clinicId, staff) {
  const ledgerRef = doc(collection(db, 'clinics', clinicId, 'payrollLedger'));
  await setDoc(ledgerRef, {
    seq: 1,
    type: 'advance',
    direction: 'out',
    staffId: staff.id,
    staffName: staff.name,
    amount: 500,
    periodId: '',
    note: 'Advance',
    createdBy: auth.currentUser.uid,
    prevHash: 'GENESIS',
    hash: hash64,
    createdAt: serverTimestamp()
  });
  return ledgerRef;
}

const staffPayload = {
  name: 'Dr. Test Vet',
  kind: 'veterinarian',
  position: 'Veterinarian',
  email: 'vet@example.com',
  phone: '0917',
  active: true,
  hiredAt: '2025-01-01',
  notes: ''
};

try {
  // --- Unauthenticated ---
  await denied('unauthenticated user denied clinic data', () =>
    getDoc(doc(db, 'clinics', 'test-clinic', 'patients', 'test-patient'))
  );

  // --- Owner bootstrap ---
  const owner = await signUp(emails.owner);
  const clinicRef = await createClinic('Rules Test Clinic');
  const clinicId = clinicRef.id;
  pass('owner creates clinic with atomic owner membership/index');

  const patientRef = doc(db, 'clinics', clinicId, 'patients', 'PAT-TEST');
  await mutateClinicalRecord({ clinicId, collection: 'patients', id: patientRef.id, expectedRevision: null, action: 'save', data: { name: 'Test Patient' } });
  pass('owner reads and writes clinic data');

  await updateDoc(clinicRef, { name: 'Renamed Clinic' });
  pass('owner renames clinic');
  await updateDoc(clinicRef, { aiEnabled: true });
  assert.equal((await getDoc(clinicRef)).data().aiEnabled, true);
  await updateDoc(clinicRef, { aiEnabled: false });
  assert.equal((await getDoc(clinicRef)).data().aiEnabled, false);
  pass('owner can enable and disable AI');
  await updateDoc(clinicRef, { imageUploadsEnabled: false });
  await updateDoc(clinicRef, { imageUploadsEnabled: true });
  await denied('upload setting must be boolean', () => updateDoc(clinicRef, { imageUploadsEnabled: 'yes' }));
  await denied('AI setting must be boolean', () => updateDoc(clinicRef, { aiEnabled: 'yes' }));
  await denied('AI setting cannot change other clinic fields', () =>
    updateDoc(clinicRef, { aiEnabled: true, name: 'Unexpected' })
  );
  await denied('owner cannot change ownerId without a transfer', () =>
    updateDoc(clinicRef, { ownerId: 'someone-else' })
  );

  // --- Member invite ---
  const createdInvite = await createClinicInvitation({
    clinicId, clinicName: 'Renamed Clinic', email: emails.viewer, user: owner
  });
  assert.equal(createdInvite.role, 'member');
  const viewerInvite = doc(db, 'clinics', clinicId, 'invitations', createdInvite.id);
  const viewer = await signUp(emails.viewer);
  assert.equal(viewer.emailVerified, false);
  await denied('unverified signup cannot read invite', () => getDoc(viewerInvite));
  await adversarialClaim(clinicId, viewerInvite, viewer.uid, viewer.email, false);
  await adversarialClaim(clinicId, viewerInvite, viewer.uid, viewer.email, undefined);
  await adversarialClaim(clinicId, viewerInvite, viewer.uid, emails.outsider, true);
  assert.equal((await getDoc(doc(db, 'users', viewer.uid, 'clinics', clinicId))).exists(), false);
  await assert.rejects(() => acceptClinicInvitation(clinicId, viewerInvite.id, {
    uid: viewer.uid, email: viewer.email, displayName: 'Viewer'
  }), /Verify your email/);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  assert.equal(auth.currentUser.emailVerified, false);
  assert.equal((await getDoc(viewerInvite)).data().status, 'pending');
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'members', viewer.uid))).exists(), false);
  pass('unverified owner retains access; rejected claims leave no membership');
  await signInWithEmailAndPassword(auth, emails.viewer, password);
  await verifyCurrentEmail();
  await acceptClinicInvitation(clinicId, viewerInvite.id, {
    uid: viewer.uid, email: viewer.email, displayName: 'Viewer'
  });
  pass('verified recipient accepts Member invitation');
  assert.equal((await getDoc(patientRef)).exists(), true);
  pass('member reads clinic data');
  assert.equal((await getDoc(clinicRef)).data().aiEnabled, false);
  await updateDoc(clinicRef, { aiEnabled: true });
  await updateDoc(clinicRef, { imageUploadsEnabled: false });
  pass('member manages clinic settings');
  await denied('member cannot bypass clinical audit', () =>
    setDoc(doc(db, 'clinics', clinicId, 'patients', 'VIEWER-WRITE'), { id: 'VIEWER-WRITE' })
  );

  // --- Role change ---
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  await denied('role change requires matching index update', () =>
    updateDoc(doc(db, 'clinics', clinicId, 'members', viewer.uid), { role: 'editor' })
  );
  await denied('index cannot grant a role absent from membership', () =>
    updateDoc(doc(db, 'users', viewer.uid, 'clinics', clinicId), { role: 'editor' })
  );
  await denied('owner cannot reassign member roles', () => changeRole(clinicId, viewer.uid, 'editor'));

  await signInWithEmailAndPassword(auth, emails.viewer, password);
  const viewerIndex = await getDoc(doc(db, 'users', viewer.uid, 'clinics', clinicId));
  assert.equal(viewerIndex.data().role, 'member');
  pass('member index retains its role');

  await mutateClinicalRecord({ clinicId, collection: 'patients', id: 'EDITOR-WRITE', expectedRevision: null, action: 'save', data: {} });
  pass('member writes audited clinic data');

  // --- Structured clinical activity / treatment entry ---
  const consultPatientId = 'CONS-PAT';
  await mutateClinicalRecord({
    clinicId, collection: 'patients', id: consultPatientId, expectedRevision: null, action: 'save',
    data: { name: 'Consult Patient', ownerName: 'Consult Owner' }
  });
  const treatmentBase = {
    date: '11/17/2026', client: 'Consult Owner', patient: 'Consult Patient',
    type: 'Consultation', status: 'Completed', notes: 'Day-end treatment entry',
    patientId: consultPatientId, appointmentId: null,
    occurredAt: Timestamp.fromDate(new Date(Date.now() - 3_600_000)),
    recordedAt: serverTimestamp(), staffUid: viewer.uid, staffName: 'Rules Editor'
  };
  await mutateClinicalRecord({
    clinicId, collection: 'consultations', id: 'CONS-SERVICE', expectedRevision: null, action: 'save',
    data: {
      ...treatmentBase,
      treatments: [{
        id: 'TRT-SVC', itemCode: 'SRV-CONS', itemName: 'Consultation', category: 'Service',
        quantity: 1, unitPrice: 500, dose: '', notes: ''
      }],
      stockMoves: []
    }
  });
  pass('editor records a structured treatment with a service line');

  const appointmentBase = {
    patientId: consultPatientId, patientName: 'Consult Patient', ownerName: 'Consult Owner',
    ownerContact: '', ownerEmail: '', type: 'Checkup', durationMinutes: 30, notes: '',
    dueAt: Timestamp.fromDate(new Date(Date.now() - 7_200_000)),
    occurredAt: Timestamp.fromDate(new Date(Date.now() - 3_600_000)), status: 'completed',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    createdBy: viewer.uid, updatedBy: viewer.uid
  };
  await mutateClinicalRecord({
    clinicId, collection: 'appointments', id: 'CONS-APPT', expectedRevision: null, action: 'save',
    data: appointmentBase
  });
  await mutateClinicalRecord({
    clinicId, collection: 'consultations', id: 'CONS-APPT-LINK', expectedRevision: null, action: 'save',
    data: { ...treatmentBase, appointmentId: 'CONS-APPT', treatments: [], stockMoves: [] }
  });
  pass('a completed appointment can be linked to a treatment record');

  await mutateClinicalRecord({
    clinicId, collection: 'appointments', id: 'CONS-APPT-SCHEDULED', expectedRevision: null, action: 'save',
    data: {
      ...appointmentBase, status: 'scheduled', occurredAt: null,
      dueAt: Timestamp.fromDate(new Date(Date.now() + 3_600_000))
    }
  });
  await denied('an uncompleted appointment cannot be linked to a treatment record', () =>
    mutateClinicalRecord({
      clinicId, collection: 'consultations', id: 'CONS-APPT-PENDING', expectedRevision: null, action: 'save',
      data: { ...treatmentBase, appointmentId: 'CONS-APPT-SCHEDULED', treatments: [], stockMoves: [] }
    })
  );

  await mutateClinicalRecord({
    clinicId, collection: 'inventory', id: 'MED-CONS', expectedRevision: null, action: 'save',
    data: { itemName: 'Amoxicillin', category: 'Medicine', stock: 10, buyingPrice: 1, sellingPrice: 5, threshold: 1 }
  });
  await mutateClinicalRecords([
    {
      clinicId, collection: 'consultations', id: 'CONS-STOCK', expectedRevision: null, action: 'save',
      data: {
        ...treatmentBase,
        treatments: [{
          id: 'TRT-MED', itemCode: 'MED-CONS', itemName: 'Amoxicillin', category: 'Medicine',
          quantity: 2, unitPrice: 5, dose: '1 tablet', notes: ''
        }],
        stockMoves: [{ itemCode: 'MED-CONS', quantity: 2 }]
      }
    },
    {
      clinicId, collection: 'inventory', id: 'MED-CONS', expectedRevision: 1, action: 'save',
      data: { itemName: 'Amoxicillin', category: 'Medicine', stock: 8, buyingPrice: 1, sellingPrice: 5, threshold: 1 }
    }
  ]);
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'inventory', 'MED-CONS'))).data().stock, 8);
  pass('stock is dispensed exactly once in the same audited transaction');

  await denied('a declared stock move must actually update inventory', () =>
    mutateClinicalRecord({
      clinicId, collection: 'consultations', id: 'CONS-NO-STOCK', expectedRevision: null, action: 'save',
      data: {
        ...treatmentBase,
        treatments: [{
          id: 'TRT-MED-2', itemCode: 'MED-CONS', itemName: 'Amoxicillin', category: 'Medicine',
          quantity: 1, unitPrice: 5, dose: '', notes: ''
        }],
        stockMoves: [{ itemCode: 'MED-CONS', quantity: 1 }]
      }
    })
  );
  await denied('future actual visit time is denied', () =>
    mutateClinicalRecord({
      clinicId, collection: 'consultations', id: 'CONS-FUTURE', expectedRevision: null, action: 'save',
      data: {
        ...treatmentBase,
        occurredAt: Timestamp.fromDate(new Date(Date.now() + 3_600_000)),
        treatments: []
      }
    })
  );
  await denied('consultation hard delete is denied even for an editor', () =>
    deleteDoc(doc(db, 'clinics', clinicId, 'consultations', 'CONS-SERVICE'))
  );
  await denied('treatment lines cannot be changed after stock has moved', () =>
    mutateClinicalRecord({
      clinicId, collection: 'consultations', id: 'CONS-STOCK', expectedRevision: 1, action: 'save',
      data: {
        ...treatmentBase,
        revision: 1,
        treatments: [{
          id: 'TRT-MED', itemCode: 'MED-CONS', itemName: 'Amoxicillin', category: 'Medicine',
          quantity: 1, unitPrice: 5, dose: '', notes: ''
        }],
        stockMoves: [{ itemCode: 'MED-CONS', quantity: 2 }]
      }
    })
  );
  pass('clinical-activity rules reject unsafe stock, time and edit transitions');
  await denied('member cannot manage the team', () =>
    updateDoc(doc(db, 'clinics', clinicId, 'members', viewer.uid), { role: 'viewer' })
  );

  // --- Removal ---
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  await denied('member removal requires index deletion', () =>
    deleteDoc(doc(db, 'clinics', clinicId, 'members', viewer.uid))
  );
  await denied('index deletion requires member removal', () =>
    deleteDoc(doc(db, 'users', viewer.uid, 'clinics', clinicId))
  );
  await removeMember(clinicId, viewer.uid);
  pass('owner removes member');

  // The clinic index lives under the member's own user document, so it has to
  // be read while signed in as that member.
  await signInWithEmailAndPassword(auth, emails.viewer, password);
  const removedIndex = await getDoc(doc(db, 'users', viewer.uid, 'clinics', clinicId));
  assert.equal(removedIndex.exists(), false);
  pass('removal deletes the member clinic index');

  await denied('removed member loses clinic access', () => getDoc(patientRef));
  await denied('removed member cannot write clinic data', () =>
    setDoc(doc(db, 'clinics', clinicId, 'patients', 'REMOVED-WRITE'), { id: 'REMOVED-WRITE' })
  );

  // --- Member invitation and permanent ownership ---
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  const rejoinInvite = await invite(clinicId, 'Renamed Clinic', emails.viewer, 'member');
  await signInWithEmailAndPassword(auth, emails.viewer, password);
  await acceptInvite(clinicId, 'Renamed Clinic', rejoinInvite, 'member');
  pass('removed member can accept a fresh invitation');
  await signInWithEmailAndPassword(auth, emails.owner, password);
  const editorInvite = await invite(clinicId, 'Renamed Clinic', emails.editor, 'member');
  const editor = await signUp(emails.editor);
  await verifyCurrentEmail();
  await acceptInvite(clinicId, 'Renamed Clinic', editorInvite, 'member');
  await denied('member cannot invite someone', () => invite(clinicId, 'Renamed Clinic', emails.outsider, 'member'));
  await denied('member cannot remove another member', () => removeMember(clinicId, viewer.uid));

  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  await rejectIncompleteTransfers(clinicId, owner.uid, editor.uid);
  await denied('owner cannot transfer ownership', () => transferOwnership(clinicId, owner.uid, editor.uid));
  assert.equal((await getDoc(clinicRef)).data().ownerId, owner.uid);
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'members', editor.uid))).data().role, 'member');
  const pending = await invite(clinicId, 'Renamed Clinic', emails.outsider, 'member');
  await signInWithEmailAndPassword(auth, emails.editor, password);
  assert.equal((await listUserClinics(editor.uid))[0].role, 'member');
  await denied('member cannot revoke a pending invite', () => updateDoc(pending, { status: 'revoked', revokedAt: serverTimestamp() }));
  await updateDoc(clinicRef, { name: 'Member Renamed Clinic' });

  // --- Staff & payroll ---
  const payrollActor = { uid: editor.uid, isCurrent: () => true };
  await denied('direct staff save requires an audit event', () =>
    setDoc(doc(db, 'clinics', clinicId, 'staff', 'unaudited'), staffPayload));
  const staff = await saveStaffMember(clinicId, staffPayload, { payBasis: 'daily', rate: 800 }, payrollActor);
  const staffRef = doc(db, 'clinics', clinicId, 'staff', staff.id);
  const profileRef = doc(db, 'clinics', clinicId, 'payProfiles', staff.id);
  await assert.rejects(saveStaffMember(clinicId, { ...staff, position: 'Draft from a previous account' }, undefined, {
    uid: owner.uid, isCurrent: () => true
  }), /account changed/i);
  await denied('pay rates cannot bypass the audit transaction', () => updateDoc(profileRef, { rate: 900 }));
  const editedStaff = await saveStaffMember(clinicId, { ...staff, position: 'Synthetic lead' }, {
    payBasis: 'monthly', rate: 14000, revision: 1
  }, payrollActor);
  await assert.rejects(saveStaffMember(clinicId, { ...editedStaff, position: 'Stale pay rate must roll back staff' }, {
    payBasis: 'daily', rate: 800, revision: 1
  }, payrollActor), { name: 'ClinicalConflictError' });
  assert.equal((await getDoc(staffRef)).data().position, 'Synthetic lead');
  assert.equal((await getDoc(profileRef)).data().rate, 14000);
  await denied('payroll period creation requires an audit event', () =>
    setDoc(doc(db, 'clinics', clinicId, 'payrollPeriods', 'unaudited'), {
      startDate: '2026-11-09', endDate: '2026-11-15', status: 'open', createdAt: serverTimestamp()
    }));
  const period = await createPayrollPeriod(clinicId, '2026-11-09', '2026-11-15', payrollActor);
  const periodRef = doc(db, 'clinics', clinicId, 'payrollPeriods', period.id);
  await denied('direct payroll close requires an audit event', () =>
    updateDoc(periodRef, { status: 'closed', closedAt: serverTimestamp() }));
  await closePayrollPeriod(clinicId, period.id, period.revision, payrollActor);
  assert.equal((await getDoc(periodRef)).data().status, 'closed');
  const payrollEvents = (await getDocs(collection(db, 'clinics', clinicId, 'auditEvents'))).docs
    .filter(row => ['staff', 'payProfiles', 'payrollPeriods'].includes(row.data().entityType));
  assert.deepEqual(payrollEvents.map(row => {
    const { action, entityType, seq, actorUid, ...fields } = row.data();
    assert.equal(actorUid, editor.uid);
    assert.deepEqual(Object.keys(fields).sort(), ['entityId', 'eventId', 'time']);
    return `${entityType}:${action}:${seq}`;
  }).sort(), ['payProfiles:create:1', 'payProfiles:update:2', 'payrollPeriods:create:1',
    'payrollPeriods:update:2', 'staff:create:1', 'staff:update:2']);
  await denied('Member cannot edit payroll audit events', () => updateDoc(payrollEvents[0].ref, { action: 'delete' }));

  const ledgerRef = await appendLedgerEntry(clinicId, { id: staffRef.id, name: staffPayload.name });
  pass('owner appends ledger entry');
  await denied('ledger entries cannot be edited', () => updateDoc(ledgerRef, { amount: 9999 }));
  await denied('ledger entries cannot be deleted', () => deleteDoc(ledgerRef));
  await denied('ledger rejects negative amounts', () =>
    setDoc(doc(collection(db, 'clinics', clinicId, 'payrollLedger')), {
      seq: 2,
      type: 'adjustment',
      direction: 'in',
      staffId: staffRef.id,
      staffName: staffPayload.name,
      amount: -5,
      periodId: '',
      note: '',
      createdBy: auth.currentUser.uid,
      prevHash: hash64,
      hash: hash64,
      createdAt: serverTimestamp()
    })
  );

  await setDoc(
    doc(db, 'clinics', clinicId, 'payrollMeta', 'ledger'),
    { seq: 1, hash: hash64, updatedAt: serverTimestamp() },
    { merge: true }
  );
  pass('owner updates ledger head');

  // Both roles can read payroll.
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  assert.equal((await getDocs(collection(db, 'clinics', clinicId, 'payrollPeriods'))).size, 1);
  assert.equal((await getDoc(profileRef)).data().rate, 14000);
  await denied('Owner cannot delete payroll audit events', () => deleteDoc(payrollEvents[0].ref));

  // --- Outsider ---
  await signUp(emails.outsider);
  await denied('outsider cannot read clinic data', () => getDoc(patientRef));
  await denied('outsider cannot change AI setting', () => updateDoc(clinicRef, { aiEnabled: true }));
  await denied('outsider cannot read staff', () => getDocs(collection(db, 'clinics', clinicId, 'staff')));
  await denied('outsider cannot append ledger entries', () =>
    appendLedgerEntry(clinicId, { id: staffRef.id, name: staffPayload.name })
  );

  await verifyCurrentEmail();
  const legacyViewer = await seedLegacyInvite(clinicId, 'Member Renamed Clinic', emails.outsider, 'viewer', owner);
  const legacyEditor = await seedLegacyInvite(clinicId, 'Member Renamed Clinic', emails.outsider, 'editor', owner);
  await assert.rejects(() => acceptClinicInvitation(clinicId, legacyViewer.id, {
    uid: auth.currentUser.uid, email: emails.outsider, displayName: 'Legacy invitee'
  }), /new Member invitation/);
  await denied('legacy Viewer invitation requires reissue in the rules', () =>
    acceptInvite(clinicId, 'Member Renamed Clinic', legacyViewer, 'member')
  );
  const legacyMembership = await acceptClinicInvitation(clinicId, legacyEditor.id, {
    uid: auth.currentUser.uid, email: emails.outsider, displayName: 'Legacy invitee'
  });
  assert.equal(legacyMembership.role, 'member');
  pass('legacy Editor invitation creates a Member');

  await signInWithEmailAndPassword(auth, emails.editor, password);
  assert.equal((await getDoc(clinicRef)).data().ownerId, owner.uid);
  assert.equal((await getDoc(ledgerRef)).exists(), true);

  const newClinic = await createClientClinic({ uid: editor.uid, email: editor.email, displayName: 'Fictional creator' }, 'Empty chronology clinic');
  const historyMarker = doc(db, 'clinics', newClinic.clinicId, 'workspaceConfig', 'consultationHistory');
  assert.equal((await getDoc(historyMarker)).data()?.state, 'ready');
  await denied('new Owner cannot rewrite the consultation readiness marker', () => updateDoc(historyMarker, { state: 'preparing' }));
  await denied('an existing clinic Owner cannot bypass consultation history migration', async () => {
    await signInWithEmailAndPassword(auth, emails.owner, password);
    return setDoc(doc(db, 'clinics', clinicId, 'workspaceConfig', 'consultationHistory'), { state: 'ready' });
  });
  console.log('\nAll Firestore rule scenarios passed.');
} finally {
  await signOut(auth).catch(() => {});
  await deleteApp(app);
}
