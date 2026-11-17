import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import type { PatientRecord, InventoryItem, Consultation } from '@/types';
import { initializeFirebase } from '@/lib/firebase';

export const CLINIC_PAGE_SIZE = 50;
export type ClinicPageKind = 'activePatients' | 'dischargedPatients' | 'inventory' | 'consultations';
export type ClinicCursor = QueryDocumentSnapshot<DocumentData> | null;
export const ACTIVE_PATIENT_STATUSES = ['Waiting', 'In Treatment', 'Confined', 'Ready for Pickup'];
export type ClinicPage = { records: (PatientRecord | InventoryItem | Consultation)[]; cursor: ClinicCursor; hasMore: boolean };

export const patientFromDocument = (id: string, data: DocumentData): PatientRecord => ({
  ...data,
  id,
  name: typeof data.name === 'string' ? data.name : 'Unnamed patient',
  ownerName: typeof data.ownerName === 'string' ? data.ownerName : '',
  ownerContact: typeof data.ownerContact === 'string' ? data.ownerContact : '',
  species: typeof data.species === 'string' ? data.species : '',
  breed: typeof data.breed === 'string' ? data.breed : '',
  gender: ['Male', 'Female', 'Unknown'].includes(data.gender) ? data.gender : 'Unknown',
  weight: Number.isFinite(data.weight) ? data.weight : 0,
  balance: Number.isFinite(data.balance) ? data.balance : 0,
  admissionTypes: Array.isArray(data.admissionTypes) ? data.admissionTypes : [],
  reason: typeof data.reason === 'string' ? data.reason : '',
  status: [...ACTIVE_PATIENT_STATUSES, 'Discharged'].includes(data.status) ? data.status : 'Waiting'
});

/** One bounded, clinic-scoped query. Legacy records need no timestamp migration. */
export const loadClinicPage = async (
  clinicId: string,
  kind: ClinicPageKind,
  cursor: ClinicCursor = null
): Promise<ClinicPage> => {
  if (!clinicId || clinicId === 'demo-clinic') throw new Error('Cloud pagination requires a real clinic.');
  const { db, firestore: fs } = await initializeFirebase();
  const collectionName = kind.endsWith('Patients') ? 'patients' : kind;
  const constraints = [];
  if (kind === 'activePatients') constraints.push(fs.where('status', 'in', ACTIVE_PATIENT_STATUSES));
  if (kind === 'dischargedPatients') constraints.push(fs.where('status', '==', 'Discharged'));
  // Filtered patient queries use their default document-ID order (single-field
  // indexes). Sorting by a new date field would silently exclude legacy records.
  // Legacy consultation dates are locale strings and cannot be sorted safely
  // across years. Retain stable ID order until an explicit date migration.
  if (cursor) constraints.push(fs.startAfter(cursor));
  constraints.push(fs.limit(CLINIC_PAGE_SIZE));
  const snapshot = await fs.getDocs(fs.query(
    fs.collection(db, 'clinics', clinicId, collectionName), ...constraints
  ));
  const records = snapshot.docs.map(document => {
    const data = document.data();
    if (collectionName === 'patients') return patientFromDocument(document.id, data);
    if (kind === 'inventory') return {
      ...data, itemCode: document.id,
      itemName: typeof data.itemName === 'string' ? data.itemName : 'Unnamed item',
      category: ['Medicine', 'Supplies', 'Service', 'Grooming'].includes(data.category) ? data.category : 'Supplies',
      stock: Number.isFinite(data.stock) ? data.stock : 0,
      buyingPrice: Number.isFinite(data.buyingPrice) ? data.buyingPrice : 0,
      sellingPrice: Number.isFinite(data.sellingPrice) ? data.sellingPrice : 0,
      threshold: Number.isFinite(data.threshold) ? data.threshold : 0
    } as InventoryItem;
    return {
      ...data, id: document.id,
      date: typeof data.date === 'string' ? data.date : '',
      client: typeof data.client === 'string' ? data.client : '',
      patient: typeof data.patient === 'string' ? data.patient : '',
      type: typeof data.type === 'string' ? data.type : '',
      notes: typeof data.notes === 'string' ? data.notes : '',
      status: data.status === 'Completed' ? 'Completed' : 'Draft'
    } as Consultation;
  });
  return {
    records,
    cursor: snapshot.docs.at(-1) ?? cursor,
    hasMore: snapshot.size === CLINIC_PAGE_SIZE
  };
};

export function appendUnique<T>(existing: T[], incoming: T[], identity: (item: T) => string): T[] {
  const seen = new Set(existing.map(identity));
  return [...existing, ...incoming.filter(item => {
    const id = identity(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  })];
}
