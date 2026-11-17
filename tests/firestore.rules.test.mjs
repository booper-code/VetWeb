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
  '@/lib/invitation-verification': verificationUrl
});
const { acceptClinicInvitation } = await import(clinicsUrl);
const { refreshInvitationVerification } = await import(verificationUrl);
const clinicalUrl = await loadClientModule('../lib/clinical-mutations.ts', {
  '@/lib/firebase': handlesUrl
});
const { mutateClinicalRecord, mutateClinicalRecords } = await import(clinicalUrl);

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
      { update: { name: `${root}/clinics/${clinicId}/members/${uid}`, fields: fields({ uid, email, displayName: 'Adversary', role: 'viewer', invitationId: invitationRef.id }) },
        updateTransforms: [{ fieldPath: 'joinedAt', setToServerValue: 'REQUEST_TIME' }] },
      { update: { name: `${root}/users/${uid}/clinics/${clinicId}`, fields: fields({ clinicId, clinicName: 'Renamed Clinic', role: 'viewer', invitationId: invitationRef.id }) },
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
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'members', toUid))).data().role, 'editor');
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

  // --- Viewer invite ---
  const viewerInvite = await invite(clinicId, 'Renamed Clinic', emails.viewer, 'viewer');
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
  pass('viewer accepts invitation');
  assert.equal((await getDoc(patientRef)).exists(), true);
  pass('viewer reads clinic data');
  assert.equal((await getDoc(clinicRef)).data().aiEnabled, false);
  await denied('viewer cannot change AI setting', () => updateDoc(clinicRef, { aiEnabled: true }));
  await denied('viewer cannot change image upload setting', () => updateDoc(clinicRef, { imageUploadsEnabled: false }));
  await denied('viewer cannot write clinic data', () =>
    setDoc(doc(db, 'clinics', clinicId, 'patients', 'VIEWER-WRITE'), { id: 'VIEWER-WRITE' })
  );
  await denied('viewer cannot record a treatment', () =>
    mutateClinicalRecord({
      clinicId, collection: 'consultations', id: 'VIEWER-CONSULT', expectedRevision: null, action: 'save',
      data: {
        date: '11/17/2026', client: '', patient: 'Test Patient', type: 'Consultation',
        status: 'Completed', notes: '', patientId: patientRef.id, appointmentId: null,
        occurredAt: Timestamp.fromDate(new Date(Date.now() - 3_600_000)),
        recordedAt: serverTimestamp(), staffUid: viewer.uid, staffName: 'Viewer',
        treatments: [], stockMoves: []
      }
    })
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
  await changeRole(clinicId, viewer.uid, 'editor');
  pass('owner changes viewer to editor and syncs the index');

  await signInWithEmailAndPassword(auth, emails.viewer, password);
  const viewerIndex = await getDoc(doc(db, 'users', viewer.uid, 'clinics', clinicId));
  assert.equal(viewerIndex.data().role, 'editor');
  pass('member index reflects the new role');

  await mutateClinicalRecord({ clinicId, collection: 'patients', id: 'EDITOR-WRITE', expectedRevision: null, action: 'save', data: {} });
  pass('promoted member can now write clinic data');

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
  await denied('editor cannot change AI setting', () => updateDoc(clinicRef, { aiEnabled: true }));
  await denied('editor cannot manage the team', () =>
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

  // --- Editor invite + ownership transfer ---
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  const rejoinInvite = await invite(clinicId, 'Renamed Clinic', emails.viewer, 'viewer');
  await signInWithEmailAndPassword(auth, emails.viewer, password);
  await acceptInvite(clinicId, 'Renamed Clinic', rejoinInvite, 'viewer');
  pass('removed member can accept a fresh invitation');
  await signInWithEmailAndPassword(auth, emails.owner, password);
  const editorInvite = await invite(clinicId, 'Renamed Clinic', emails.editor, 'editor');
  const editor = await signUp(emails.editor);
  await verifyCurrentEmail();
  await acceptInvite(clinicId, 'Renamed Clinic', editorInvite, 'editor');
  pass('editor accepts invitation and writes clinic data');

  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  await rejectIncompleteTransfers(clinicId, owner.uid, editor.uid);
  await transferOwnership(clinicId, owner.uid, editor.uid);
  assert.equal((await getDoc(clinicRef)).data().ownerId, editor.uid);
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'members', editor.uid))).data().role, 'owner');
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'members', owner.uid))).data().role, 'editor');
  assert.equal((await getDoc(doc(db, 'users', owner.uid, 'clinics', clinicId))).data().role, 'editor');

  await denied('previous owner can no longer manage the team', () =>
    updateDoc(doc(db, 'clinics', clinicId, 'members', editor.uid), { role: 'viewer' })
  );
  await denied('previous owner cannot reclaim ownership', () =>
    transferOwnership(clinicId, editor.uid, owner.uid)
  );
  await denied('previous owner cannot rename clinic', () =>
    updateDoc(clinicRef, { name: 'Reclaimed Clinic' })
  );

  await signInWithEmailAndPassword(auth, emails.editor, password);
  assert.equal((await getDoc(doc(db, 'users', editor.uid, 'clinics', clinicId))).data().role, 'owner');
  pass('ownership transfer updates clinic, members, and both indexes');
  await updateDoc(clinicRef, { name: 'Editor Owned Clinic' });
  pass('new owner can rename the clinic');

  // --- Staff & payroll ---
  const staffRef = doc(collection(db, 'clinics', clinicId, 'staff'));
  await setDoc(staffRef, staffPayload);
  pass('owner creates staff member');
  await setDoc(doc(db, 'clinics', clinicId, 'payProfiles', staffRef.id), {
    payBasis: 'daily',
    rate: 800,
    updatedAt: serverTimestamp()
  });
  pass('owner sets pay profile');

  const periodRef = doc(collection(db, 'clinics', clinicId, 'payrollPeriods'));
  await setDoc(periodRef, {
    startDate: '2026-11-09',
    endDate: '2026-11-15',
    status: 'open',
    createdAt: serverTimestamp()
  });
  pass('owner creates payroll period');

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

  // --- Editor (now a regular member) cannot see payroll ---
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  await denied('non-owner cannot read payroll periods', () =>
    getDocs(collection(db, 'clinics', clinicId, 'payrollPeriods'))
  );
  await denied('non-owner cannot read pay profiles', () =>
    getDoc(doc(db, 'clinics', clinicId, 'payProfiles', staffRef.id))
  );

  // --- Outsider ---
  await signUp(emails.outsider);
  await denied('outsider cannot read clinic data', () => getDoc(patientRef));
  await denied('outsider cannot change AI setting', () => updateDoc(clinicRef, { aiEnabled: true }));
  await denied('outsider cannot read staff', () => getDocs(collection(db, 'clinics', clinicId, 'staff')));
  await denied('outsider cannot append ledger entries', () =>
    appendLedgerEntry(clinicId, { id: staffRef.id, name: staffPayload.name })
  );

  await signInWithEmailAndPassword(auth, emails.editor, password);
  await transferOwnership(clinicId, editor.uid, viewer.uid);
  assert.equal((await getDoc(clinicRef)).data().ownerId, viewer.uid);
  assert.equal((await getDoc(doc(db, 'users', editor.uid, 'clinics', clinicId))).data().role, 'editor');
  await denied('second previous owner loses payroll access', () => getDoc(ledgerRef));
  await signInWithEmailAndPassword(auth, emails.viewer, password);
  assert.equal((await getDoc(doc(db, 'users', viewer.uid, 'clinics', clinicId))).data().role, 'owner');
  await updateDoc(clinicRef, { name: 'Viewer Owned Clinic' });
  pass('new owner can subsequently transfer ownership to an existing viewer');

  console.log('\nAll Firestore rule scenarios passed.');
} finally {
  await signOut(auth).catch(() => {});
  await deleteApp(app);
}
