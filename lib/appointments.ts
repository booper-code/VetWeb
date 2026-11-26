import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import type { Appointment, AppointmentDraft } from '@/types';
import { initializeFirebase } from '@/lib/firebase';
import { subscribeConfirmedClinicQuery } from '@/lib/clinic-pages';
import { mutateClinicalRecord, ClinicalConflictError } from '@/lib/clinical-mutations';
import { appointmentValidationError, appointmentWindowBounds, APPOINTMENT_PAGE_SIZE } from '@/lib/appointment-values';
import type { AppointmentWindow } from '@/lib/appointment-values';

export type AppointmentCursor = QueryDocumentSnapshot<DocumentData> | null;
const iso = (value: { toDate?: () => Date } | undefined | null) => value?.toDate?.().toISOString() ?? '';
function contactFromDocument(value: DocumentData | undefined) {
  const dueAt = iso(value?.dueAt), contactedAt = iso(value?.contactedAt);
  return dueAt && contactedAt && typeof value?.contactedBy === 'string'
    ? { followUpContact: { dueAt, contactedAt, contactedBy: value.contactedBy } } : {};
}
export function appointmentFromDocument(id: string, data: DocumentData): Appointment {
  const { followUpContact, ...values } = data;
  return { ...values, ...contactFromDocument(followUpContact), id, dueAt: iso(data.dueAt), occurredAt: iso(data.occurredAt) || null,
    createdAt: iso(data.createdAt), updatedAt: iso(data.updatedAt) } as Appointment;
}
const appointmentQueryConstraints = (fs: typeof import('firebase/firestore'), window: AppointmentWindow) => {
  const { start, end } = appointmentWindowBounds(window);
  return [
    fs.where('dueAt', '>=', fs.Timestamp.fromDate(new Date(start))),
    fs.where('dueAt', '<', fs.Timestamp.fromDate(new Date(end))),
    fs.orderBy('dueAt'),
  ];
};

export async function loadAppointmentsPage(clinicId: string, window: AppointmentWindow, cursor: AppointmentCursor = null, uid?: string) {
  if (!clinicId || clinicId === 'demo-clinic') throw new Error('Cloud appointments need a clinic.');
  const { db, auth, firestore: fs } = await initializeFirebase();
  const checkAccount = () => {
    if (uid !== undefined && auth.currentUser?.uid !== uid) {
      throw Object.assign(new Error('Appointment access changed.'), { code: 'unauthenticated' });
    }
  };
  checkAccount();
  const query = fs.query(fs.collection(db, 'clinics', clinicId, 'appointments'), ...appointmentQueryConstraints(fs, window),
    ...(cursor ? [fs.startAfter(cursor)] : []), fs.limit(APPOINTMENT_PAGE_SIZE));
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const page = await (offline ? fs.getDocsFromCache(query) : fs.getDocs(query));
  checkAccount();
  return { records: page.docs.map(doc => appointmentFromDocument(doc.id, doc.data())),
    cursor: page.docs.at(-1) ?? cursor, hasMore: page.size === APPOINTMENT_PAGE_SIZE, fromCache: page.metadata.fromCache };
}

export function subscribeAppointments(
  clinicId: string, uid: string, window: AppointmentWindow, size: number,
  onServer: (page: { records: Appointment[]; hasMore: boolean }) => void,
  onError: (error: Error) => void, onDenied: (error: Error) => void,
) {
  return subscribeConfirmedClinicQuery(uid, (db, fs) => fs.query(fs.collection(db, 'clinics', clinicId, 'appointments'),
    ...appointmentQueryConstraints(fs, window), fs.limit(size + 1)),
  snapshot => onServer({
    records: snapshot.docs.slice(0, size).map(row => appointmentFromDocument(row.id, row.data())),
    hasMore: snapshot.size > size
  }), onError, onDenied);
}

/** Fixed, validated domain action; a future assistant must use this, not arbitrary writes. */
export async function saveAppointment(input: {
  clinicId: string; id: string; expectedRevision: number | null; draft: AppointmentDraft; expectedUid?: string;
}): Promise<Appointment> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Reconnect before saving. Appointment changes are not queued offline.');
  const invalid = appointmentValidationError(input.draft);
  if (invalid) throw new Error(invalid);
  if (!input.clinicId || input.clinicId === 'demo-clinic' || !input.id || input.id.includes('/')) throw new Error('Invalid appointment workspace or ID.');
  const { db, firestore: fs, auth } = await initializeFirebase();
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in before saving an appointment.');
  if (input.expectedUid && input.expectedUid !== uid) throw new Error('The signed-in account changed. Reopen the appointment before saving.');
  const existing = await fs.getDoc(fs.doc(db, 'clinics', input.clinicId, 'appointments', input.id));
  if ((existing.exists() ? existing.data().revision : null) !== input.expectedRevision) throw new ClinicalConflictError();
  const previous = existing.data();
  if (previous && previous.patientId !== input.draft.patientId) throw new Error('The linked patient cannot be changed. Cancel and create another appointment.');
  const patient = await fs.getDoc(fs.doc(db, 'clinics', input.clinicId, 'patients', input.draft.patientId));
  if (!patient.exists() && !previous) throw new Error('Patient not found in this clinic. Reload the patient list.');
  const source = patient.exists() ? patient.data() : previous!;
  const data = {
    ...input.draft, dueAt: fs.Timestamp.fromDate(new Date(input.draft.dueAt)),
    occurredAt: input.draft.occurredAt ? fs.Timestamp.fromDate(new Date(input.draft.occurredAt)) : null,
    patientName: patient.exists() ? source.name : source.patientName,
    ownerName: source.ownerName ?? '', ownerContact: source.ownerContact ?? '', ownerEmail: source.ownerEmail ?? '',
    createdAt: previous?.createdAt ?? fs.serverTimestamp(), createdBy: previous?.createdBy ?? uid,
    updatedAt: fs.serverTimestamp(), updatedBy: uid,
    ...(previous?.followUpContact ? { followUpContact: previous.followUpContact } : {}),
  };
  const saved = await mutateClinicalRecord({ clinicId: input.clinicId, id: input.id,
    collection: 'appointments', expectedRevision: input.expectedRevision, expectedUid: uid, action: 'save', data });
  // Prefer server entry times, never present a guessed client time as recorded.
  try {
    const confirmed = await fs.getDoc(fs.doc(db, 'clinics', input.clinicId, 'appointments', saved.id));
    if (confirmed.exists()) return appointmentFromDocument(confirmed.id, confirmed.data());
  } catch { /* The audited commit succeeded; a failed readback is not a failed save. */ }
  return { ...input.draft, id: saved.id, revision: saved.revision,
    ...contactFromDocument(previous?.followUpContact),
    patientName: data.patientName, ownerName: data.ownerName, ownerContact: data.ownerContact, ownerEmail: data.ownerEmail,
    createdAt: previous ? iso(previous.createdAt) : '', updatedAt: '', createdBy: data.createdBy, updatedBy: uid };
}
