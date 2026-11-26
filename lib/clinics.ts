import type {
  ClinicInvitation,
  ClinicMember,
  ClinicMembership,
  ClinicSessionUser
} from '@/types';
import type { DocumentData, Firestore, Transaction } from 'firebase/firestore';
import { initializeFirebase } from '@/lib/firebase';
import { normalizeClinicRole } from '@/lib/clinic-role';
import { refreshInvitationVerification } from '@/lib/invitation-verification';

type FirestoreModule = typeof import('firebase/firestore');
type FirebaseHandles = { db: Firestore; fs: FirestoreModule };

const requireConnection = () => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Clinic management requires a connection. No change was submitted.');
  }
};

const getHandles = async (): Promise<FirebaseHandles> => {
  const { db: initializedDb, firestore: initializedModule } = await initializeFirebase();
  const db = initializedDb as Firestore | null;
  const fs = initializedModule as FirestoreModule | null;
  if (!db || !fs) throw new Error('Firebase is not available. Check the connection and try again.');
  return { db, fs };
};

const membershipFromData = (clinicId: string, data: DocumentData): ClinicMembership | null => {
  const role = normalizeClinicRole(data.role);
  if (!role) return null;
  return { clinicId, clinicName: typeof data.clinicName === 'string' ? data.clinicName : 'Untitled clinic', role };
};

export const listUserClinics = async (uid: string): Promise<ClinicMembership[]> => {
  const { db, fs } = await getHandles();
  const memberships = await fs.getDocs(fs.collection(db, 'users', uid, 'clinics'));

  // The clinic document owns the current name; the per-user index is a cache
  // that goes stale when an owner renames the clinic.
  const resolved = await Promise.all(
    memberships.docs.map(async snapshot => {
      const membership = membershipFromData(snapshot.id, snapshot.data());
      if (!membership) return null;
      try {
        const clinic = await fs.getDoc(fs.doc(db, 'clinics', snapshot.id));
        const liveName = clinic.exists() ? clinic.data().name : null;
        return typeof liveName === 'string' ? { ...membership, clinicName: liveName } : membership;
      } catch (error) {
        console.warn(`[Clinics] Could not read clinic ${snapshot.id}; using cached name.`, error);
        return membership;
      }
    })
  );

  return resolved
    .filter((membership): membership is ClinicMembership => membership !== null)
    .sort((a: ClinicMembership, b: ClinicMembership) => a.clinicName.localeCompare(b.clinicName));
};

/** Creates a clinic and both membership records in one atomic batch. */
export const createClinic = async (
  user: ClinicSessionUser,
  name: string
): Promise<ClinicMembership> => {
  requireConnection();
  const clinicName = name.trim();
  if (!clinicName) throw new Error('Enter a clinic name.');

  const { db, fs } = await getHandles();
  const clinicRef = fs.doc(fs.collection(db, 'clinics'));
  const memberRef = fs.doc(db, 'clinics', clinicRef.id, 'members', user.uid);
  const userClinicRef = fs.doc(db, 'users', user.uid, 'clinics', clinicRef.id);
  const createdAt = fs.serverTimestamp();

  const batch = fs.writeBatch(db);
  batch.set(clinicRef, {
    name: clinicName,
    ownerId: user.uid,
    createdAt
  });
  batch.set(memberRef, {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    role: 'owner',
    createdAt
  });
  batch.set(userClinicRef, {
    clinicId: clinicRef.id,
    clinicName,
    role: 'owner',
    joinedAt: createdAt
  });
  batch.set(fs.doc(db, 'clinics', clinicRef.id, 'workspaceConfig', 'consultationHistory'), { state: 'ready' });
  await batch.commit();

  return { clinicId: clinicRef.id, clinicName, role: 'owner' };
};

/** Renames a clinic. */
export const renameClinic = async (clinicId: string, name: string): Promise<string> => {
  requireConnection();
  const clinicName = name.trim();
  if (!clinicName) throw new Error('Enter a clinic name.');
  if (clinicName.length > 100) throw new Error('Clinic names are limited to 100 characters.');

  const { db, fs } = await getHandles();
  await fs.updateDoc(fs.doc(db, 'clinics', clinicId), { name: clinicName });
  return clinicName;
};

/** Controls whether AI features are shown to members of this clinic. */
export const setClinicAIEnabled = async (clinicId: string, enabled: boolean): Promise<void> => {
  requireConnection();
  const { db, fs } = await getHandles();
  await fs.updateDoc(fs.doc(db, 'clinics', clinicId), { aiEnabled: enabled });
};

/** A reversible storage safeguard; existing images stay readable. */
export const setClinicImageUploadsEnabled = async (clinicId: string, enabled: boolean): Promise<void> => {
  requireConnection();
  const { db, fs } = await getHandles();
  await fs.updateDoc(fs.doc(db, 'clinics', clinicId), { imageUploadsEnabled: enabled });
};

export const subscribeClinicImageUploads = async (
  clinicId: string, onChange: (enabled: boolean) => void, onError: (error: Error) => void
): Promise<() => void> => {
  const { db, fs } = await getHandles();
  return fs.onSnapshot(fs.doc(db, 'clinics', clinicId), snapshot => {
    onChange(snapshot.exists() && snapshot.data().imageUploadsEnabled !== false);
  }, onError);
};

/** Listen for the clinic-wide setting, including changes made by another member. */
export const subscribeClinicAI = async (
  clinicId: string,
  onChange: (enabled: boolean) => void,
  onError: (error: Error) => void
): Promise<() => void> => {
  const { db, fs } = await getHandles();
  return fs.onSnapshot(
    fs.doc(db, 'clinics', clinicId),
    snapshot => onChange(snapshot.exists() && snapshot.data().aiEnabled === true),
    onError
  );
};

export const listClinicMembers = async (clinicId: string): Promise<ClinicMember[]> => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDocs(fs.collection(db, 'clinics', clinicId, 'members'));
  return snapshot.docs.flatMap(member => {
    const { email, displayName, role: storedRole } = member.data();
    const role = normalizeClinicRole(storedRole);
    return role ? [{ uid: member.id, email: email ?? '', displayName: displayName ?? '', role }] : [];
  });
};

export const listClinicInvitations = async (clinicId: string): Promise<ClinicInvitation[]> => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDocs(fs.collection(db, 'clinics', clinicId, 'invitations'));
  return snapshot.docs
    .map(invite => ({ id: invite.id, ...invite.data() }) as ClinicInvitation)
    .filter((invite: ClinicInvitation) => invite.status === 'pending');
};

export const createClinicInvitation = async ({
  clinicId,
  clinicName,
  email,
  user
}: {
  clinicId: string;
  clinicName: string;
  email: string;
  user: ClinicSessionUser;
}): Promise<ClinicInvitation> => {
  requireConnection();
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) throw new Error('Enter the invitee’s email address.');

  const { db, fs } = await getHandles();
  const invitationRef = fs.doc(fs.collection(db, 'clinics', clinicId, 'invitations'));
  const expiresAt = fs.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const invitation = {
    clinicId,
    clinicName,
    email: normalizedEmail,
    role: 'member' as const,
    status: 'pending' as const,
    createdBy: user.uid,
    createdByEmail: user.email,
    createdAt: fs.serverTimestamp(),
    expiresAt
  };

  await fs.setDoc(invitationRef, invitation);
  return { id: invitationRef.id, ...invitation };
};

export const getClinicInvitation = async (clinicId: string, invitationId: string) => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDoc(fs.doc(db, 'clinics', clinicId, 'invitations', invitationId));
  if (!snapshot.exists()) return null;
  return { id: snapshot.id, ...snapshot.data() } as ClinicInvitation;
};

export const acceptClinicInvitation = async (
  clinicId: string,
  invitationId: string,
  user: ClinicSessionUser
): Promise<ClinicMembership> => {
  // These checks improve the user-facing errors. Matching Firestore rules must
  // enforce invite status, expiry, email, and atomic membership writes too.
  if (!await refreshInvitationVerification(user.uid)) {
    throw new Error('Verify your email address before accepting an invitation.');
  }
  const { db, fs } = await getHandles();
  const invitationRef = fs.doc(db, 'clinics', clinicId, 'invitations', invitationId);
  const memberRef = fs.doc(db, 'clinics', clinicId, 'members', user.uid);
  const userClinicRef = fs.doc(db, 'users', user.uid, 'clinics', clinicId);

  return fs.runTransaction(db, async (transaction: Transaction) => {
    const invitationSnapshot = await transaction.get(invitationRef);
    if (!invitationSnapshot.exists()) throw new Error('This invitation link is invalid or has been removed.');

    const invitation = invitationSnapshot.data() as ClinicInvitation;
    if (invitation.status !== 'pending') throw new Error('This invitation has already been used or revoked.');
    if (invitation.expiresAt?.toMillis && invitation.expiresAt.toMillis() < Date.now()) {
      throw new Error('This invitation has expired. Ask the clinic owner for a new link.');
    }
    if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new Error(`This invitation was addressed to ${invitation.email}. Sign in with that email address.`);
    }

    const existingIndex = await transaction.get(userClinicRef);
    if (existingIndex.exists()) throw new Error('You already have access to this clinic.');

    const clinicName = invitation.clinicName;
    if (invitation.role !== 'member' && invitation.role !== 'editor') {
      throw new Error('Ask the clinic owner to issue a new Member invitation.');
    }
    const role = 'member' as const;
    const joinedAt = fs.serverTimestamp();
    transaction.set(memberRef, {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      role,
      joinedAt,
      invitationId
    });
    transaction.set(userClinicRef, {
      clinicId,
      clinicName,
      role,
      joinedAt,
      invitationId
    });
    transaction.update(invitationRef, {
      status: 'accepted',
      acceptedBy: user.uid,
      acceptedAt: joinedAt
    });

    return { clinicId, clinicName, role };
  });
};

/** Removes a non-owner member and their clinic index. */
export const removeClinicMember = async (clinicId: string, memberUid: string): Promise<void> => {
  requireConnection();
  const { db, fs } = await getHandles();
  const memberRef = fs.doc(db, 'clinics', clinicId, 'members', memberUid);
  const indexRef = fs.doc(db, 'users', memberUid, 'clinics', clinicId);

  await fs.runTransaction(db, async transaction => {
    const member = await transaction.get(memberRef);
    if (!member.exists()) return;
    if (member.data().role === 'owner') throw new Error('The clinic owner cannot be removed.');

    transaction.delete(memberRef);
    transaction.delete(indexRef);
  });
};

export const revokeClinicInvitation = async (clinicId: string, invitationId: string) => {
  requireConnection();
  const { db, fs } = await getHandles();
  await fs.updateDoc(
    fs.doc(db, 'clinics', clinicId, 'invitations', invitationId),
    { status: 'revoked', revokedAt: fs.serverTimestamp() }
  );
};
