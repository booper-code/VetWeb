import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import type { PatientRecord, InventoryItem, Consultation } from '@/types';
import { initializeFirebase } from '@/lib/firebase';
import { isExpiryDate, isStockedCategory } from '@/lib/stock-alert-values';

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
  balance: Number.isSafeInteger(data.billing?.balanceMinor) && data.billing.balanceMinor >= 0
    ? data.billing.balanceMinor / 100 : Number.isFinite(data.balance) && data.balance >= 0 ? data.balance : 0,
  legacyBillingBalance: Number.isFinite(data.balance) ? data.balance : null,
  admissionTypes: Array.isArray(data.admissionTypes) ? data.admissionTypes : [],
  reason: typeof data.reason === 'string' ? data.reason : '',
  status: [...ACTIVE_PATIENT_STATUSES, 'Discharged'].includes(data.status) ? data.status : 'Waiting'
});

export const inventoryFromDocument = (itemCode: string, data: DocumentData): InventoryItem => {
  const { expiryDate, ...fields } = data;
  return {
    ...fields, itemCode,
    itemName: typeof data.itemName === 'string' ? data.itemName : 'Unnamed item',
    category: ['Medicine', 'Supplies', 'Service', 'Grooming'].includes(data.category) ? data.category : 'Supplies',
    stock: Number.isFinite(data.stock) ? data.stock : 0,
    buyingPrice: Number.isFinite(data.buyingPrice) ? data.buyingPrice : 0,
    sellingPrice: Number.isFinite(data.sellingPrice) ? data.sellingPrice : 0,
    threshold: Number.isFinite(data.threshold) ? data.threshold : 0,
    ...(isStockedCategory(data.category) && isExpiryDate(expiryDate) ? { expiryDate } : {}),
  };
};

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
    if (kind === 'inventory') return inventoryFromDocument(document.id, data);
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

/**
 * Server-confirmed inventory prefix. Metadata changes are included so the first
 * server snapshot arrives even when an identical cached snapshot was already
 * delivered; cache-only and pending-write snapshots are not confirmations.
 */
export async function subscribeClinicInventory(
  clinicId: string,
  size: number,
  onServer: (page: { records: InventoryItem[]; hasMore: boolean; cursor: ClinicCursor }) => void,
  onError: (error: Error) => void,
): Promise<() => void> {
  if (!clinicId || clinicId === 'demo-clinic') throw new Error('Inventory sync requires a real clinic.');
  const { db, firestore: fs } = await initializeFirebase();
  const query = fs.query(
    fs.collection(db, 'clinics', clinicId, 'inventory'),
    fs.orderBy(fs.documentId()),
    fs.limit(size + 1),
  );
  return fs.onSnapshot(query, { includeMetadataChanges: true }, snapshot => {
    if (snapshot.metadata?.fromCache || snapshot.metadata?.hasPendingWrites) return;
    const docs = snapshot.docs.slice(0, size);
    const records = docs.map(document => inventoryFromDocument(document.id, document.data()));
    // A confirmed snapshot can shift the prefix after a remote insert/delete.
    // Page requests must continue after the last row actually on screen.
    onServer({ records, hasMore: snapshot.size > size, cursor: docs.at(-1) ?? null });
  }, error => onError(error instanceof Error ? error : new Error(String(error))));
}

/** Server aggregation returns only the catalog size, not inventory documents or cached page counts. */
export async function loadInventoryCatalogCount(clinicId: string): Promise<number> {
  if (!clinicId || clinicId === 'demo-clinic') throw new Error('A cloud inventory count requires a real clinic.');
  const { db, firestore: fs } = await initializeFirebase();
  const snapshot = await fs.getCountFromServer(fs.collection(db, 'clinics', clinicId, 'inventory'));
  return snapshot.data().count;
}

type ClinicScanRecords = { patients: PatientRecord; inventory: InventoryItem };
const scanMappers: { [K in keyof ClinicScanRecords]: (id: string, data: DocumentData) => ClinicScanRecords[K] } = {
  patients: patientFromDocument,
  inventory: inventoryFromDocument,
};

/** Server-only reads that don't add a clinic-wide scan to trusted-device storage. */
export async function loadClinicScanPage<K extends keyof ClinicScanRecords>(
  clinicId: string, kind: K, after: string | null,
): Promise<{ rows: ClinicScanRecords[K][]; next: string | null }> {
  if (!clinicId || clinicId === 'demo-clinic') throw new Error('A cloud scan requires a real clinic.');
  const { app } = await initializeFirebase();
  const fs = await import('firebase/firestore/lite');
  const db = fs.getFirestore(app);
  const snapshot = await fs.getDocs(fs.query(
    fs.collection(db, 'clinics', clinicId, kind),
    fs.orderBy(fs.documentId()),
    ...(after === null ? [] : [fs.startAfter(after)]),
    fs.limit(CLINIC_PAGE_SIZE),
  ));
  return {
    rows: snapshot.docs.map(document => scanMappers[kind](document.id, document.data())),
    next: snapshot.size === CLINIC_PAGE_SIZE ? snapshot.docs.at(-1)!.id : null,
  };
}

/** The demo uses the same paging contract without initializing Firebase. */
export function loadDemoClinicScanPage<T>(records: T[], identity: (record: T) => string, after: string | null) {
  const rows = records.filter(row => after === null || identity(row) > after)
    .sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0)
    .slice(0, CLINIC_PAGE_SIZE);
  return { rows, next: rows.length === CLINIC_PAGE_SIZE ? identity(rows[rows.length - 1]) : null };
}

export function appendUnique<T>(existing: T[], incoming: T[], identity: (item: T) => string): T[] {
  const seen = new Set(existing.map(identity));
  return [...existing, ...incoming.filter(item => {
    const id = identity(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  })];
}
