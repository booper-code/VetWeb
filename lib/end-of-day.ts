import type { DocumentData, QueryConstraint, QueryDocumentSnapshot } from 'firebase/firestore';
import type { Appointment, Consultation, PatientRecord } from '@/types';
import type { BillingEntry } from '@/lib/billing';
import { BILLING_DAY_MS, PAYMENT_METHODS, billingDayStartMs } from '@/lib/billing-values';
import { initializeFirebase } from '@/lib/firebase';
import type { CloseCorrection, CloseDayEntry, CloseKind, CloseOriginal, CloseRows, CloseVisit } from '@/lib/end-of-day-values';

export const CLOSE_PAGE_SIZE = 25;
export type CloseCursor = QueryDocumentSnapshot<DocumentData> | number;
export type ClosePage<K extends CloseKind> = { rows: CloseRows[K][]; next: CloseCursor | null };
type CloseParams = { clinicId: string; uid: string; dayStartMs: number; after: CloseCursor | null };
export type ClosePageLoader = <K extends CloseKind>(kind: K, params: CloseParams) => Promise<ClosePage<K>>;
type Readers = { [K in CloseKind]: () => Promise<ClosePage<K>> };

const dayEntry = (entry: BillingEntry): entry is CloseDayEntry['entry'] =>
  entry.kind === 'payment' || entry.kind === 'unitemized-settlement';
const originalEntry = (entry: BillingEntry): entry is CloseOriginal => dayEntry(entry) || entry.kind === 'charge';
const reversalId = (id: string) => `reverse_${id}`;
const inDay = (when: number, start: number) => when >= start && when < start + BILLING_DAY_MS;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value !== '.' && value !== '..' && !value.includes('/');

function reportEntry(clinicId: string, doc: QueryDocumentSnapshot<DocumentData>): BillingEntry {
  const { recordedAt, ...data } = doc.data();
  const recordedAtMs = recordedAt?.toMillis?.();
  if (data.clinicId !== clinicId || !validId(data.patientId) || !Number.isSafeInteger(recordedAtMs)
    || !Number.isSafeInteger(data.amountMinor) || data.amountMinor < 0
    || (data.kind === 'payment' && !PAYMENT_METHODS.includes(data.method))) {
    throw new Error('A billing entry could not be read for this report.');
  }
  return { ...data, id: doc.id, recordedAtMs } as BillingEntry;
}

function validateReversal(entry: BillingEntry, original: BillingEntry | undefined): CloseCorrection {
  if (entry.kind !== 'reversal' || !original || !originalEntry(original) || entry.originalEntryId !== original.id
    || entry.id !== reversalId(original.id) || entry.clinicId !== original.clinicId || entry.patientId !== original.patientId
    || entry.amountMinor !== original.amountMinor) {
    throw new Error('A reversal could not be matched to its original billing entry.');
  }
  return { entry, original };
}

function withReversal(entry: CloseDayEntry['entry'], reverse: BillingEntry | undefined): CloseDayEntry {
  if (reverse) validateReversal(reverse, entry);
  return { entry, reversed: !!reverse };
}

export const loadEndOfDayPage: ClosePageLoader = async (kind, { clinicId, uid, dayStartMs, after }) => {
  if (!validId(clinicId) || clinicId === 'demo-clinic' || typeof after === 'number'
    || billingDayStartMs(dayStartMs) !== dayStartMs) throw new Error('Choose a clinic and Manila business day.');
  const { db, firestore: fs, auth } = await initializeFirebase();
  const checkAccount = () => {
    if (!uid || auth?.currentUser?.uid !== uid) throw new Error('The signed-in account changed. Reload the report.');
  };
  checkAccount();
  const start = fs.Timestamp.fromMillis(dayStartMs);
  const end = fs.Timestamp.fromMillis(dayStartMs + BILLING_DAY_MS);
  const collection = (name: string) => fs.collection(db, 'clinics', clinicId, name);
  const byId = fs.orderBy(fs.documentId());
  const read = async (name: string, constraints: QueryConstraint[]) => {
    checkAccount();
    const snap = await fs.getDocsFromServer(fs.query(collection(name), ...constraints, byId,
      ...(after ? [fs.startAfter(after)] : []), fs.limit(CLOSE_PAGE_SIZE)));
    return { docs: snap.docs, next: snap.size === CLOSE_PAGE_SIZE ? snap.docs.at(-1)! : null };
  };
  const billingByIds = async (ids: string[]) => {
    if (!ids.length) return new Map<string, BillingEntry>();
    checkAccount();
    const snap = await fs.getDocsFromServer(fs.query(collection('billingEntries'),
      fs.where(fs.documentId(), 'in', [...new Set(ids)]), fs.limit(CLOSE_PAGE_SIZE)));
    return new Map(snap.docs.map(doc => [doc.id, reportEntry(clinicId, doc)]));
  };
  const readers: Readers = {
    entries: async () => {
      const { docs, next } = await read('billingEntries', [
        fs.where('kind', 'in', ['payment', 'unitemized-settlement']), fs.where('businessDayMs', '==', dayStartMs), fs.orderBy('businessDayMs'),
      ]);
      const reversals = await billingByIds(docs.map(doc => reversalId(doc.id)));
      return { next, rows: docs.map(doc => {
        const entry = reportEntry(clinicId, doc);
        if (!dayEntry(entry)) throw new Error('An unexpected entry was found in the collections report.');
        return withReversal(entry, reversals.get(reversalId(entry.id)));
      }) };
    },
    corrections: async () => {
      const { docs, next } = await read('billingEntries', [
        fs.where('kind', '==', 'reversal'), fs.where('recordedAt', '>=', start), fs.where('recordedAt', '<', end), fs.orderBy('recordedAt'),
      ]);
      const reversals = docs.map(doc => {
        const entry = reportEntry(clinicId, doc);
        if (entry.kind !== 'reversal' || !validId(entry.originalEntryId)) throw new Error('A reversal is missing its original entry ID.');
        return entry;
      });
      const originals = await billingByIds(reversals.map(entry => entry.originalEntryId));
      return { next, rows: reversals.map(entry => validateReversal(entry, originals.get(entry.originalEntryId)))
        .filter(({ original }) => original.kind !== 'charge') };
    },
    balances: async () => {
      const { docs, next } = await read('patients', []);
      return { next, rows: docs.map(doc => {
        const data = doc.data();
        return { id: doc.id, ledgerMinor: data.billing?.balanceMinor, legacyBalance: data.balance };
      }) };
    },
    visits: async () => {
      const { docs, next } = await read('appointments', [
        fs.where('status', '==', 'completed'), fs.where('occurredAt', '>=', start), fs.where('occurredAt', '<', end), fs.orderBy('occurredAt'),
      ]);
      const rows: CloseVisit[] = [];
      for (let index = 0; index < docs.length; index += 5) {
        checkAccount();
        rows.push(...await Promise.all(docs.slice(index, index + 5).map(async doc => {
          const data = doc.data();
          const occurredAtMs = data.occurredAt?.toMillis?.();
          if (!validId(data.patientId) || !Number.isSafeInteger(occurredAtMs)) throw new Error('Could not read a completed visit.');
          const links = await fs.getDocsFromServer(fs.query(collection('consultations'),
            fs.where('appointmentId', '==', doc.id), fs.where('patientId', '==', data.patientId),
            fs.where('status', '==', 'Completed'), fs.limit(1)));
          return { id: doc.id, patientId: data.patientId, patientName: data.patientName || 'Unnamed patient',
            occurredAtMs, linkedTreatment: !links.empty };
        })));
      }
      return { next, rows };
    },
  };
  const result = await readers[kind]();
  checkAccount();
  return result;
};

export function createDemoEndOfDayLoader({ entries, patients, appointments, consultations }: {
  entries: BillingEntry[]; patients: PatientRecord[]; appointments: Appointment[]; consultations: Consultation[];
}): ClosePageLoader {
  const entriesById = new Map(entries.map(entry => [entry.id, entry]));
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return async (kind, { clinicId, dayStartMs, after }) => {
    if (clinicId !== 'demo-clinic' || (after !== null && typeof after !== 'number')
      || billingDayStartMs(dayStartMs) !== dayStartMs) throw new Error('Choose a demo clinic business day.');
    const offset = after ?? 0;
    function page<T>(rows: T[]) {
      const visible = rows.slice(offset, offset + CLOSE_PAGE_SIZE);
      return { rows: visible, next: visible.length === CLOSE_PAGE_SIZE ? offset + CLOSE_PAGE_SIZE : null };
    }
    const readers: Readers = {
      entries: async () => page(entries.filter(dayEntry).filter(entry => entry.businessDayMs === dayStartMs)
        .sort(byId).map(entry => withReversal(entry, entriesById.get(reversalId(entry.id))))),
      corrections: async () => {
        const chunk = page(entries.filter(entry => entry.kind === 'reversal' && inDay(entry.recordedAtMs, dayStartMs))
          .sort((a, b) => a.recordedAtMs - b.recordedAtMs || byId(a, b)));
        return { next: chunk.next, rows: chunk.rows.flatMap(entry => {
          if (entry.kind !== 'reversal') return [];
          const correction = validateReversal(entry, entriesById.get(entry.originalEntryId));
          return correction.original.kind === 'charge' ? [] : [correction];
        }) };
      },
      balances: async () => page([...patients].sort(byId).map(patient => ({
        id: patient.id, ledgerMinor: patient.billing?.balanceMinor,
        legacyBalance: patient.legacyBillingBalance === undefined ? patient.balance : patient.legacyBillingBalance,
      }))),
      visits: async () => page(appointments.flatMap(visit => {
        const occurredAtMs = Date.parse(visit.occurredAt ?? '');
        if (visit.status !== 'completed' || !inDay(occurredAtMs, dayStartMs)) return [];
        return [{ id: visit.id, patientId: visit.patientId, patientName: visit.patientName, occurredAtMs,
          linkedTreatment: consultations.some(record => record.appointmentId === visit.id
            && record.patientId === visit.patientId && record.status === 'Completed') }];
      }).sort((a, b) => a.occurredAtMs - b.occurredAtMs || byId(a, b))),
    };
    return readers[kind]();
  };
}
