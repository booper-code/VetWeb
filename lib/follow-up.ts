import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import type { Appointment } from '@/types';
import { appointmentFromDocument } from '@/lib/appointments';
import { ClinicalConflictError, mutateClinicalRecord } from '@/lib/clinical-mutations';
import { initializeFirebase } from '@/lib/firebase';
import { subscribeConfirmedClinicQuery } from '@/lib/clinic-pages';
import { FOLLOW_UP_PAGE_SIZE, currentFollowUpContact, isDueFollowUp } from '@/lib/follow-up-values';

export type FollowUpCursor = QueryDocumentSnapshot<DocumentData> | number | null;
export type FollowUpPage = { rows: Appointment[]; next: FollowUpCursor };
export type FollowUpSubscription = (
  size: number, endMs: number, onPage: (page: FollowUpPage) => void,
  onError: (error: Error) => void, onDenied: (error: Error) => void,
) => Promise<() => void>;
type Identity = { clinicId: string; uid: string };

const validId = (value: string) => !!value && value !== '.' && value !== '..' && !value.includes('/');
async function connection({ clinicId, uid }: Identity) {
  if (!validId(clinicId) || clinicId === 'demo-clinic') throw new Error('Choose a clinic workspace.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Reconnect to load or record follow-ups.');
  const { db, firestore: fs, auth } = await initializeFirebase();
  const checkAccount = () => {
    if (!uid || auth.currentUser?.uid !== uid) throw new Error('The signed-in account changed. Refresh the follow-up queue.');
  };
  checkAccount();
  return { db, fs, checkAccount };
}

const followUpConstraints = (fs: typeof import('firebase/firestore'), endMs: number) => [
  fs.where('status', '==', 'scheduled'), fs.where('type', '==', 'Follow-up'), fs.where('dueAt', '<', fs.Timestamp.fromMillis(endMs)),
  fs.orderBy('dueAt'), fs.orderBy(fs.documentId()),
];

export async function loadFollowUpPage(input: Identity & { endMs: number; after?: FollowUpCursor }): Promise<FollowUpPage> {
  const { clinicId, endMs, after } = input;
  if (typeof after === 'number' || !Number.isSafeInteger(endMs)) throw new Error('Invalid follow-up page.');
  const { db, fs, checkAccount } = await connection(input);
  const snapshot = await fs.getDocsFromServer(fs.query(fs.collection(db, 'clinics', clinicId, 'appointments'),
    ...followUpConstraints(fs, endMs), ...(after ? [fs.startAfter(after)] : []), fs.limit(FOLLOW_UP_PAGE_SIZE)));
  checkAccount();
  return {
    rows: snapshot.docs.map(doc => appointmentFromDocument(doc.id, doc.data())),
    next: snapshot.size === FOLLOW_UP_PAGE_SIZE ? snapshot.docs.at(-1)! : null,
  };
}

export function subscribeFollowUps(
  { clinicId, uid }: Identity, ...[size, endMs, onPage, onError, onDenied]: Parameters<FollowUpSubscription>
) {
  if (!validId(clinicId) || clinicId === 'demo-clinic' || !uid || !Number.isSafeInteger(endMs)) {
    return Promise.reject(new Error('Choose a clinic workspace and a valid follow-up date.'));
  }
  return subscribeConfirmedClinicQuery(uid, (db, fs) => fs.query(fs.collection(db, 'clinics', clinicId, 'appointments'),
    ...followUpConstraints(fs, endMs), fs.limit(size + 1)),
  snapshot => onPage({
    rows: snapshot.docs.slice(0, size).map(doc => appointmentFromDocument(doc.id, doc.data())),
    next: snapshot.size > size ? snapshot.docs[size - 1] : null
  }), onError, onDenied);
}

export function loadDemoFollowUpPage(rows: Appointment[], endMs: number, after: FollowUpCursor): FollowUpPage {
  const offset = typeof after === 'number' ? after : 0;
  const eligible = rows.filter(row => isDueFollowUp(row, endMs - 1))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
  return { rows: eligible.slice(offset, offset + FOLLOW_UP_PAGE_SIZE),
    next: eligible.length > offset + FOLLOW_UP_PAGE_SIZE ? offset + FOLLOW_UP_PAGE_SIZE : null };
}

export async function recordFollowUpContact(input: Identity & { row: Appointment; contacted?: boolean }): Promise<Appointment> {
  const { clinicId, uid, row, contacted = true } = input;
  if (!validId(row.id)) throw new Error('Choose a due follow-up.');
  const { db, fs, checkAccount } = await connection(input);
  const reference = fs.doc(db, 'clinics', clinicId, 'appointments', row.id);
  const snapshot = await fs.getDocFromServer(reference);
  checkAccount();
  if (!snapshot.exists() || snapshot.data().revision !== row.revision) throw new ClinicalConflictError();
  const data = snapshot.data();
  const current = appointmentFromDocument(snapshot.id, data);
  if (!isDueFollowUp(current, Date.now())) throw new Error('Contact can only be recorded for a due follow-up.');
  if (contacted === !!currentFollowUpContact(current)) throw new Error(contacted
    ? 'Contact was already recorded for this scheduled time.' : 'No contact is recorded for this scheduled time.');
  const updated: DocumentData = { ...data, updatedAt: fs.serverTimestamp(), updatedBy: uid };
  if (contacted) updated.followUpContact = { dueAt: data.dueAt, contactedAt: fs.serverTimestamp(), contactedBy: uid };
  else delete updated.followUpContact;
  await mutateClinicalRecord({ clinicId, collection: 'appointments', id: row.id, action: 'save', expectedRevision: row.revision,
    data: updated });
  checkAccount();
  try {
    const confirmed = await fs.getDocFromServer(reference);
    checkAccount();
    if (confirmed.exists()) return appointmentFromDocument(confirmed.id, confirmed.data());
  } catch { /* The commit may have succeeded even if the readback failed. */ }
  throw new Error('The contact change may have saved. Refresh before trying again.');
}
