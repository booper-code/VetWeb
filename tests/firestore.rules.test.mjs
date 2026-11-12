/**
 * Firestore authorization tests for the multi-clinic model.
 *
 * Run with: npm run test:rules
 * Uses the emulator suite and a throwaway demo project, so it never touches
 * the real vetcloudpro data.
 */
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
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
  await setDoc(patientRef, { id: 'PAT-TEST', name: 'Test Patient' });
  pass('owner reads and writes clinic data');

  await updateDoc(clinicRef, { name: 'Renamed Clinic' });
  pass('owner renames clinic');
  await updateDoc(clinicRef, { aiEnabled: true });
  assert.equal((await getDoc(clinicRef)).data().aiEnabled, true);
  await updateDoc(clinicRef, { aiEnabled: false });
  assert.equal((await getDoc(clinicRef)).data().aiEnabled, false);
  pass('owner can enable and disable AI');
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
  await acceptInvite(clinicId, 'Renamed Clinic', viewerInvite, 'viewer');
  pass('viewer accepts invitation');
  assert.equal((await getDoc(patientRef)).exists(), true);
  pass('viewer reads clinic data');
  assert.equal((await getDoc(clinicRef)).data().aiEnabled, false);
  await denied('viewer cannot change AI setting', () => updateDoc(clinicRef, { aiEnabled: true }));
  await denied('viewer cannot write clinic data', () =>
    setDoc(doc(db, 'clinics', clinicId, 'patients', 'VIEWER-WRITE'), { id: 'VIEWER-WRITE' })
  );

  // --- Role change ---
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  await changeRole(clinicId, viewer.uid, 'editor');
  pass('owner changes viewer to editor and syncs the index');

  await signInWithEmailAndPassword(auth, emails.viewer, password);
  const viewerIndex = await getDoc(doc(db, 'users', viewer.uid, 'clinics', clinicId));
  assert.equal(viewerIndex.data().role, 'editor');
  pass('member index reflects the new role');

  await setDoc(doc(db, 'clinics', clinicId, 'patients', 'EDITOR-WRITE'), { id: 'EDITOR-WRITE' });
  pass('promoted member can now write clinic data');
  await denied('editor cannot change AI setting', () => updateDoc(clinicRef, { aiEnabled: true }));
  await denied('editor cannot manage the team', () =>
    updateDoc(doc(db, 'clinics', clinicId, 'members', viewer.uid), { role: 'viewer' })
  );

  // --- Removal ---
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
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
  const editorInvite = await invite(clinicId, 'Renamed Clinic', emails.editor, 'editor');
  const editor = await signUp(emails.editor);
  await acceptInvite(clinicId, 'Renamed Clinic', editorInvite, 'editor');
  pass('editor accepts invitation and writes clinic data');

  await signOut(auth);
  await signInWithEmailAndPassword(auth, emails.owner, password);
  await transferOwnership(clinicId, owner.uid, editor.uid);
  assert.equal((await getDoc(clinicRef)).data().ownerId, editor.uid);
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'members', editor.uid))).data().role, 'owner');
  assert.equal((await getDoc(doc(db, 'clinics', clinicId, 'members', owner.uid))).data().role, 'editor');
  pass('ownership transfer updates clinic, members, and indexes');

  await denied('previous owner can no longer manage the team', () =>
    updateDoc(doc(db, 'clinics', clinicId, 'members', editor.uid), { role: 'viewer' })
  );

  await signInWithEmailAndPassword(auth, emails.editor, password);
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

  console.log('\nAll Firestore rule scenarios passed.');
} finally {
  await signOut(auth).catch(() => {});
  await deleteApp(app);
}
