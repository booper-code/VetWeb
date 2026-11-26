import type { DocumentSnapshot } from 'firebase/firestore';
import type { ClinicRole } from '@/types';
import { initializeFirebase } from '@/lib/firebase';
import { normalizeClinicRole } from '@/lib/clinic-role';

const fresh = (snapshot: DocumentSnapshot) =>
  snapshot.exists() && !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;

function verifiedRole(snapshot: DocumentSnapshot): ClinicRole | null {
  return fresh(snapshot) ? normalizeClinicRole(snapshot.data()?.role) : null;
}

export async function watchAssistantRole(clinicId: string, uid: string, onRole: (role: ClinicRole | null) => void) {
  const { auth, db, firestore } = await initializeFirebase();
  let stopMember: (() => void) | undefined;
  let version = 0;
  let active = true;
  const stopAuth = auth.onAuthStateChanged(user => {
    if (!active) return;
    const captured = ++version;
    stopMember?.();
    stopMember = undefined;
    onRole(null);
    if (user?.uid !== uid || auth.currentUser?.uid !== uid) return;
    const isCurrent = () => active && version === captured && auth.currentUser?.uid === uid;
    const member = firestore.doc(db, 'clinics', clinicId, 'members', uid);
    stopMember = firestore.onSnapshot(member, { includeMetadataChanges: true },
      snapshot => { if (isCurrent()) onRole(verifiedRole(snapshot)); },
      () => { if (isCurrent()) onRole(null); });
  });
  return () => { active = false; stopAuth(); stopMember?.(); };
}

/** Recheck canonical access immediately before a handoff or assistant-draft save. */
export async function readAssistantRole(clinicId: string, uid: string): Promise<ClinicRole | null> {
  try {
    const { auth, db, firestore } = await initializeFirebase();
    if (auth.currentUser?.uid !== uid) return null;
    const [member, clinic] = await Promise.all([
      firestore.getDocFromServer(firestore.doc(db, 'clinics', clinicId, 'members', uid)),
      firestore.getDocFromServer(firestore.doc(db, 'clinics', clinicId)),
    ]);
    if (auth.currentUser?.uid !== uid || !fresh(clinic) || clinic.data()?.aiEnabled !== true) return null;
    return verifiedRole(member);
  } catch { return null; }
}
