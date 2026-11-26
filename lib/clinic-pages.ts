import type { DocumentData, Firestore, Query, QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore';
import type { PatientRecord, InventoryItem, Consultation, TreatmentLine } from '@/types';
import { initializeFirebase } from '@/lib/firebase';
import { isExpiryDate, isStockedCategory } from '@/lib/stock-alert-values';

export const CLINIC_PAGE_SIZE = 50;
export type ClinicPageKind = 'activePatients' | 'dischargedPatients' | 'inventory' | 'consultations';
export type PatientDirectoryKind = 'activePatients' | 'dischargedPatients';
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

const timestampIso = (value: { toDate?: () => Date } | string | null | undefined) =>
  typeof value === 'string' ? Number.isFinite(Date.parse(value)) ? value : '' : value?.toDate?.().toISOString() ?? '';

function treatmentFromDocument(value: DocumentData): TreatmentLine | null {
  if (!value || typeof value.itemCode !== 'string' || !value.itemCode) return null;
  return {
    id: typeof value.id === 'string' ? value.id : value.itemCode,
    itemCode: value.itemCode,
    itemName: typeof value.itemName === 'string' ? value.itemName : '',
    category: ['Medicine', 'Supplies', 'Service', 'Grooming'].includes(value.category) ? value.category : 'Supplies',
    quantity: Number.isFinite(value.quantity) ? value.quantity : 0,
    unitPrice: Number.isFinite(value.unitPrice) ? value.unitPrice : 0,
    dose: typeof value.dose === 'string' ? value.dose : '',
    notes: typeof value.notes === 'string' ? value.notes : ''
  };
}

export function consultationFromDocument(id: string, data: DocumentData): Consultation {
  return {
    ...data, id,
    date: typeof data.date === 'string' ? data.date : '',
    client: typeof data.client === 'string' ? data.client : '',
    patient: typeof data.patient === 'string' ? data.patient : '',
    type: typeof data.type === 'string' ? data.type : '',
    notes: typeof data.notes === 'string' ? data.notes : '',
    status: data.status === 'Completed' ? 'Completed' : 'Draft',
    patientId: typeof data.patientId === 'string' ? data.patientId : undefined,
    appointmentId: typeof data.appointmentId === 'string' ? data.appointmentId : null,
    occurredAt: timestampIso(data.occurredAt) || undefined,
    historySortAt: data.historySortAt === null ? null : timestampIso(data.historySortAt) || undefined,
    recordedAt: timestampIso(data.recordedAt) || undefined,
    staffUid: typeof data.staffUid === 'string' ? data.staffUid : undefined,
    staffName: typeof data.staffName === 'string' ? data.staffName : undefined,
    treatments: Array.isArray(data.treatments)
      ? data.treatments.map(treatmentFromDocument).filter((line): line is TreatmentLine => line !== null)
      : undefined
  };
}

/** One bounded, clinic-scoped query, also used for the consultation startup fallback. */
export const loadClinicPage = async (
  clinicId: string,
  kind: ClinicPageKind,
  cursor: ClinicCursor = null,
  expectedUid?: string,
): Promise<ClinicPage> => {
  if (!clinicId || clinicId === 'demo-clinic') throw new Error('Cloud pagination requires a real clinic.');
  const { db, auth, firestore: fs } = await initializeFirebase();
  const requireIdentity = () => {
    if (expectedUid !== undefined && auth.currentUser?.uid !== expectedUid) {
      throw Object.assign(new Error('Clinic access changed.'), { code: 'unauthenticated' });
    }
  };
  requireIdentity();
  const collectionName = kind.endsWith('Patients') ? 'patients' : kind;
  const constraints = [];
  if (kind === 'activePatients') constraints.push(fs.where('status', 'in', ACTIVE_PATIENT_STATUSES));
  if (kind === 'dischargedPatients') constraints.push(fs.where('status', '==', 'Discharged'));
  // Filtered patient queries use their default document-ID order (single-field
  // indexes). Sorting by a new date field would silently exclude legacy records.
  // The fallback uses ID order so it can read legacy consultation rows even
  // before the history migration has been confirmed.
  if (cursor) constraints.push(fs.startAfter(cursor));
  constraints.push(fs.limit(CLINIC_PAGE_SIZE));
  const snapshot = await fs.getDocs(fs.query(
    fs.collection(db, 'clinics', clinicId, collectionName), ...constraints
  ));
  requireIdentity();
  const records = snapshot.docs.map(document => {
    const data = document.data();
    if (collectionName === 'patients') return patientFromDocument(document.id, data);
    if (kind === 'inventory') return inventoryFromDocument(document.id, data);
    return consultationFromDocument(document.id, data);
  });
  return {
    records,
    cursor: snapshot.docs.at(-1) ?? cursor,
    hasMore: snapshot.size === CLINIC_PAGE_SIZE
  };
};

export const isClinicInventoryAccessDenied = (error: unknown) =>
  ['permission-denied', 'unauthenticated'].includes((error as { code?: string })?.code ?? '');

type FirestoreModule = typeof import('firebase/firestore');
export async function subscribeConfirmedClinicQuery(
  uid: string,
  buildQuery: (db: Firestore, fs: FirestoreModule) => Query<DocumentData>,
  onServer: (snapshot: QuerySnapshot<DocumentData>) => void,
  onError: (error: Error) => void,
  onDenied: (error: Error) => void,
): Promise<() => void> {
  const { db, auth, firestore: fs } = await initializeFirebase();
  const query = buildQuery(db, fs);
  let active = true, denied = false;
  let stopQuery: (() => void) | undefined;
  const deny = (error: Error) => {
    if (!active || denied) return;
    denied = true;
    stopQuery?.();
    onDenied(error);
  };
  const current = () => active && !denied && auth.currentUser?.uid === uid;
  const stopAuth = auth.onAuthStateChanged(user => {
    if (!active || denied) return;
    if (user?.uid !== uid || !current()) {
      deny(new Error('Clinic access changed.'));
      return;
    }
    if (stopQuery) return;
    stopQuery = fs.onSnapshot(query, { includeMetadataChanges: true }, snapshot => {
      if (current() && !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) onServer(snapshot);
    }, error => {
      if (!current()) return;
      if (isClinicInventoryAccessDenied(error)) deny(error);
      else onError(error);
    });
  });
  return () => { active = false; stopAuth(); stopQuery?.(); };
}

export function subscribePatientDirectory(
  clinicId: string, uid: string, kind: PatientDirectoryKind, size: number,
  onServer: (page: { records: PatientRecord[]; hasMore: boolean }) => void,
  onError: (error: Error) => void, onDenied: (error: Error) => void,
) {
  return subscribeConfirmedClinicQuery(uid, (db, fs) => fs.query(
    fs.collection(db, 'clinics', clinicId, 'patients'),
    kind === 'activePatients' ? fs.where('status', 'in', ACTIVE_PATIENT_STATUSES) : fs.where('status', '==', 'Discharged'),
    fs.orderBy(fs.documentId()), fs.limit(size + 1)
  ), snapshot => onServer({
    records: snapshot.docs.slice(0, size).map(row => patientFromDocument(row.id, row.data())),
    hasMore: snapshot.size > size
  }), onError, onDenied);
}

export function subscribeClinicPatient(
  clinicId: string, uid: string, patientId: string,
  onServer: (record: PatientRecord | null) => void, onDenied: (error: Error) => void,
) {
  return subscribeConfirmedClinicQuery(uid, (db, fs) => fs.query(
    fs.collection(db, 'clinics', clinicId, 'patients'),
    fs.where(fs.documentId(), '==', patientId), fs.limit(1)
  ), snapshot => {
    const row = snapshot.docs[0];
    onServer(row ? patientFromDocument(row.id, row.data()) : null);
  }, () => { /* Keep the last available record during a transient connection error. */ }, onDenied);
}

export type ConsultationPrefix = { records: Consultation[]; hasMore: boolean; chronological: boolean };

export async function subscribeClinicConsultations(
  clinicId: string, uid: string, size: number, initiallyChronological: boolean,
  onServer: (page: ConsultationPrefix) => void, onError: (error: Error) => void, onDenied: (error: Error) => void,
): Promise<() => void> {
  if (!clinicId || clinicId === 'demo-clinic') throw new Error('Consultation sync requires a real clinic.');
  const { db, auth, firestore: fs } = await initializeFirebase();
  const records = fs.collection(db, 'clinics', clinicId, 'consultations');
  const marker = fs.doc(db, 'clinics', clinicId, 'workspaceConfig', 'consultationHistory');
  const options = { includeMetadataChanges: true };
  let active = true;
  let started = false;
  let denied = false;
  let version = 0;
  let chronological = initiallyChronological;
  let stopRows: (() => void) | undefined;
  let stopMarker: (() => void) | undefined;
  const isCurrent = () => active && !denied && auth.currentUser?.uid === uid;
  const deny = (error: Error) => {
    if (!active || denied) return;
    denied = true;
    stopRows?.();
    stopMarker?.();
    onDenied(error);
  };
  const fail = (error: Error) => {
    if (!isCurrent()) return;
    if (isClinicInventoryAccessDenied(error)) deny(error);
    else onError(error);
  };
  const watchRows = (ordered: boolean) => {
    chronological = ordered;
    const watch = ++version;
    stopRows?.();
    const order = ordered
      ? [fs.orderBy('historySortAt', 'desc'), fs.orderBy(fs.documentId(), 'desc')]
      : [fs.orderBy(fs.documentId())];
    stopRows = fs.onSnapshot(fs.query(records, ...order, fs.limit(size + 1)), options, snapshot => {
      if (!isCurrent() || version !== watch || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      onServer({
        records: snapshot.docs.slice(0, size).map(row => consultationFromDocument(row.id, row.data())),
        hasMore: snapshot.size > size, chronological: ordered,
      });
    }, error => { if (version === watch) fail(error); });
  };
  const stopAuth = auth.onAuthStateChanged(user => {
    if (!active || denied) return;
    if (user?.uid !== uid || auth.currentUser?.uid !== uid) {
      deny(new Error('Consultation history access changed.'));
      return;
    }
    if (started) return;
    started = true;
    watchRows(chronological);
    stopMarker = fs.onSnapshot(marker, options, snapshot => {
      if (!isCurrent() || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      const ready = snapshot.data()?.state === 'ready';
      if (ready !== chronological) watchRows(ready);
    }, fail);
  });
  return () => { active = false; stopAuth(); stopRows?.(); stopMarker?.(); };
}

/**
 * Server-confirmed inventory prefix. Metadata changes are included so the first
 * server snapshot arrives even when an identical cached snapshot was already
 * delivered; cache-only and pending-write snapshots are not confirmations.
 * The listener is rebound to the real Firebase auth user: a different signed-in
 * identity (or explicit rules denial) must never leave clinic rows on screen.
 */
export async function subscribeClinicInventory(
  clinicId: string,
  size: number,
  onServer: (page: { records: InventoryItem[]; hasMore: boolean; cursor: ClinicCursor }) => void,
  onError: (error: Error) => void,
  uid: string,
  onDenied: (error: Error) => void,
): Promise<() => void> {
  if (!clinicId || clinicId === 'demo-clinic') throw new Error('Inventory sync requires a real clinic.');
  const { db, auth, firestore: fs } = await initializeFirebase();
  const query = fs.query(
    fs.collection(db, 'clinics', clinicId, 'inventory'),
    fs.orderBy(fs.documentId()),
    fs.limit(size + 1),
  );
  let active = true;
  let version = 0;
  let stopListener: (() => void) | undefined;
  const deny = (error: Error) => { if (active) onDenied(error); };
  const stopAuth = auth.onAuthStateChanged(user => {
    if (!active) return;
    const captured = ++version;
    if (user?.uid !== uid || auth.currentUser?.uid !== uid) {
      deny(new Error('Clinic inventory access changed.'));
      return;
    }
    const isCurrent = () => active && version === captured && auth.currentUser?.uid === uid;
    stopListener?.();
    stopListener = fs.onSnapshot(query, { includeMetadataChanges: true }, snapshot => {
      if (!isCurrent() || snapshot.metadata?.fromCache || snapshot.metadata?.hasPendingWrites) return;
      const docs = snapshot.docs.slice(0, size);
      const records = docs.map(document => inventoryFromDocument(document.id, document.data()));
      // A confirmed snapshot can shift the prefix after a remote insert/delete.
      // Page requests must continue after the last row actually on screen.
      onServer({ records, hasMore: snapshot.size > size, cursor: docs.at(-1) ?? null });
    }, error => {
      if (!isCurrent()) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (isClinicInventoryAccessDenied(error)) deny(normalized);
      else onError(normalized);
    });
  });
  return () => { active = false; stopAuth(); stopListener?.(); };
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
