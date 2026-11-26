import type {
  PayBasis,
  PayrollEntry,
  PayrollEntryType,
  PayrollPeriod,
  StaffMember,
  StaffPayProfile
} from '@/types';
import type { DocumentData, Firestore } from 'firebase/firestore';
import { initializeFirebase } from '@/lib/firebase';
import { mutateClinicalRecord, mutateClinicalRecords } from '@/lib/clinical-mutations';
import type { ClinicalMutation } from '@/lib/clinical-mutations';

type FirestoreModule = typeof import('firebase/firestore');
type FirebaseHandles = { db: Firestore; fs: FirestoreModule; uid?: string };
type PayrollActor = { uid: string; isCurrent: () => boolean };

const GENESIS = 'GENESIS';

const getHandles = async (): Promise<FirebaseHandles> => {
  const { db: initializedDb, firestore: initializedModule, auth } = await initializeFirebase();
  const db = initializedDb as Firestore | null;
  const fs = initializedModule as FirestoreModule | null;
  if (!db || !fs) throw new Error('Firebase is not available. Check the connection and try again.');
  return { db, fs, uid: auth?.currentUser?.uid };
};

const getWriteHandles = async (actor: PayrollActor) => {
  const handles = await getHandles();
  if (!actor.uid || handles.uid !== actor.uid) throw new Error('The signed-in account changed. Reopen Staff & Payroll.');
  if (!actor.isCurrent()) throw new Error('The clinic workspace changed. Reopen Staff & Payroll.');
  return { ...handles, uid: actor.uid };
};

const staffFromData = (id: string, data: DocumentData): StaffMember => ({
  id,
  revision: data.revision ?? 0,
  name: typeof data.name === 'string' ? data.name : 'Unnamed staff',
  kind: data.kind === 'veterinarian' ? 'veterinarian' : 'employee',
  position: typeof data.position === 'string' ? data.position : '',
  email: typeof data.email === 'string' ? data.email : '',
  phone: typeof data.phone === 'string' ? data.phone : '',
  active: data.active !== false,
  hiredAt: typeof data.hiredAt === 'string' ? data.hiredAt : '',
  notes: typeof data.notes === 'string' ? data.notes : ''
});

const periodFromData = (id: string, data: DocumentData): PayrollPeriod => ({
  id,
  revision: data.revision ?? 0,
  startDate: typeof data.startDate === 'string' ? data.startDate : '',
  endDate: typeof data.endDate === 'string' ? data.endDate : '',
  status: data.status === 'closed' ? 'closed' : 'open',
  createdAt: data.createdAt ?? null,
  closedAt: data.closedAt ?? null
});

const entryFromData = (id: string, data: DocumentData): PayrollEntry => ({
  id,
  seq: Number(data.seq) || 0,
  type: (data.type as PayrollEntryType) || 'adjustment',
  direction: data.direction === 'in' ? 'in' : 'out',
  staffId: typeof data.staffId === 'string' ? data.staffId : '',
  staffName: typeof data.staffName === 'string' ? data.staffName : '',
  amount: Number(data.amount) || 0,
  periodId: typeof data.periodId === 'string' ? data.periodId : '',
  note: typeof data.note === 'string' ? data.note : '',
  createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
  createdAt: data.createdAt ?? null,
  prevHash: typeof data.prevHash === 'string' ? data.prevHash : '',
  hash: typeof data.hash === 'string' ? data.hash : ''
});

export const listStaff = async (clinicId: string): Promise<StaffMember[]> => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDocs(fs.collection(db, 'clinics', clinicId, 'staff'));
  return snapshot.docs
    .map(member => staffFromData(member.id, member.data()))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
};

export const saveStaffMember = async (
  clinicId: string,
  staff: Omit<StaffMember, 'id'> & { id?: string },
  profile: StaffPayProfile | undefined,
  actor: PayrollActor
): Promise<StaffMember> => {
  const name = staff.name.trim();
  if (!name) throw new Error('Enter the staff member’s name.');
  if (profile && (!Number.isFinite(profile.rate) || profile.rate < 0)) throw new Error('Enter a valid pay rate.');

  const { db, fs, uid } = await getWriteHandles(actor);
  const payload = {
    name,
    kind: staff.kind,
    position: staff.position.trim(),
    email: staff.email?.trim().toLowerCase() ?? '',
    phone: staff.phone?.trim() ?? '',
    active: staff.active,
    hiredAt: staff.hiredAt ?? '',
    notes: staff.notes?.trim() ?? ''
  };

  const id = staff.id ?? fs.doc(fs.collection(db, 'clinics', clinicId, 'staff')).id;
  const writes: ClinicalMutation[] = [{
    clinicId, collection: 'staff', id, expectedRevision: staff.id ? staff.revision ?? 0 : null,
    expectedUid: uid, action: 'save', data: payload
  }];
  if (profile) writes.push({
    clinicId, collection: 'payProfiles', id, expectedRevision: profile.revision ?? null, expectedUid: uid, action: 'save',
    data: { payBasis: profile.payBasis, rate: profile.rate, updatedAt: fs.serverTimestamp() }
  });
  const [saved] = await mutateClinicalRecords(writes);
  return { id, ...payload, revision: saved.revision };
};

export const listPayProfiles = async (clinicId: string): Promise<Record<string, StaffPayProfile>> => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDocs(fs.collection(db, 'clinics', clinicId, 'payProfiles'));
  const profiles: Record<string, StaffPayProfile> = {};
  snapshot.docs.forEach(profile => {
    const data = profile.data();
    profiles[profile.id] = {
      revision: data.revision ?? 0,
      payBasis: data.payBasis === 'monthly' ? 'monthly' : 'daily',
      rate: Number(data.rate) || 0
    };
  });
  return profiles;
};

export const listPayrollPeriods = async (clinicId: string): Promise<PayrollPeriod[]> => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDocs(fs.collection(db, 'clinics', clinicId, 'payrollPeriods'));
  return snapshot.docs
    .map(period => periodFromData(period.id, period.data()))
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
};

export const createPayrollPeriod = async (
  clinicId: string,
  startDate: string,
  endDate: string,
  actor: PayrollActor
): Promise<PayrollPeriod> => {
  if (!startDate || !endDate) throw new Error('Choose a start and end date.');
  if (endDate < startDate) throw new Error('The end date must be on or after the start date.');

  const { fs, uid } = await getWriteHandles(actor);
  const saved = await mutateClinicalRecord({
    clinicId, collection: 'payrollPeriods', expectedRevision: null, expectedUid: uid, action: 'save',
    data: { startDate, endDate, status: 'open', createdAt: fs.serverTimestamp() }
  });
  return { id: saved.id, revision: saved.revision, startDate, endDate, status: 'open' };
};

export const closePayrollPeriod = async (clinicId: string, periodId: string, revision: number, actor: PayrollActor): Promise<void> => {
  const { fs, uid } = await getWriteHandles(actor);
  await mutateClinicalRecord({
    clinicId, collection: 'payrollPeriods', id: periodId, expectedRevision: revision, expectedUid: uid, action: 'save',
    data: { status: 'closed', closedAt: fs.serverTimestamp() }
  });
};

export const listPayrollEntries = async (clinicId: string): Promise<PayrollEntry[]> => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDocs(
    fs.query(fs.collection(db, 'clinics', clinicId, 'payrollLedger'), fs.orderBy('seq', 'asc'))
  );
  return snapshot.docs.map(entry => entryFromData(entry.id, entry.data()));
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
};

/** Deterministic string for hashing. Server timestamps are excluded because
 *  they are only resolved after the write completes. */
const canonicalEntry = (entry: {
  seq: number;
  type: string;
  direction: string;
  staffId: string;
  staffName: string;
  amount: number;
  periodId?: string;
  note?: string;
  createdBy: string;
  prevHash: string;
}) =>
  JSON.stringify([
    entry.seq,
    entry.type,
    entry.direction,
    entry.staffId,
    entry.staffName,
    entry.amount,
    entry.periodId ?? '',
    entry.note ?? '',
    entry.createdBy,
    entry.prevHash
  ]);

export const appendPayrollEntry = async ({
  clinicId,
  user,
  type,
  direction,
  staff,
  amount,
  periodId,
  note
}: {
  clinicId: string;
  user: { uid: string };
  type: PayrollEntryType;
  direction: 'in' | 'out';
  staff: Pick<StaffMember, 'id' | 'name'>;
  amount: number;
  periodId?: string;
  note?: string;
}): Promise<PayrollEntry> => {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than zero.');

  const { db, fs } = await getHandles();
  const ledger = fs.collection(db, 'clinics', clinicId, 'payrollLedger');
  const metaRef = fs.doc(db, 'clinics', clinicId, 'payrollMeta', 'ledger');
  const ref = fs.doc(ledger);

  // The client SDK cannot query inside a transaction, so the head of the chain
  // (last seq + hash) is kept in a small metadata document. It is updated in
  // the same transaction as the new entry, and the ledger itself is append-only.
  return fs.runTransaction(db, async transaction => {
    const metaSnapshot = await transaction.get(metaRef);
    const meta = metaSnapshot.data();
    const previousSeq = meta ? Number(meta.seq) : 0;
    const seq = Number.isFinite(previousSeq) && previousSeq > 0 ? previousSeq + 1 : 1;
    const prevHash = meta && typeof meta.hash === 'string' && meta.hash ? meta.hash : GENESIS;

    const payload = {
      seq,
      type,
      direction,
      staffId: staff.id,
      staffName: staff.name,
      amount,
      periodId: periodId ?? '',
      note: note?.trim() ?? '',
      createdBy: user.uid,
      prevHash
    };

    const hash = await sha256(canonicalEntry(payload));

    transaction.set(ref, {
      ...payload,
      hash,
      createdAt: fs.serverTimestamp()
    });
    transaction.set(
      metaRef,
      { seq, hash, updatedAt: fs.serverTimestamp() },
      { merge: true }
    );

    return { id: ref.id, ...payload, hash };
  });
};

export type PayrollHead = { seq: number; hash: string };

export const getPayrollHead = async (clinicId: string): Promise<PayrollHead | null> => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDoc(fs.doc(db, 'clinics', clinicId, 'payrollMeta', 'ledger'));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return { seq: Number(data.seq) || 0, hash: typeof data.hash === 'string' ? data.hash : '' };
};

export type ChainVerification =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAt: number; reason: string };

/** Recomputes the chain and compares it with the recorded head. Any edited,
 *  reordered, or deleted entry — including trailing entries — breaks it. */
export const verifyPayrollChain = async (
  entries: PayrollEntry[],
  head?: PayrollHead | null
): Promise<ChainVerification> => {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  let previous = GENESIS;

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];

    if (entry.seq !== index + 1) {
      return { ok: false, count: sorted.length, brokenAt: entry.seq, reason: 'A ledger entry is missing or reordered.' };
    }
    if (entry.prevHash !== previous) {
      return { ok: false, count: sorted.length, brokenAt: entry.seq, reason: 'An earlier entry was modified.' };
    }

    const expected = await sha256(canonicalEntry(entry));
    if (expected !== entry.hash) {
      return { ok: false, count: sorted.length, brokenAt: entry.seq, reason: 'This entry does not match its recorded hash.' };
    }

    previous = entry.hash;
  }

  if (head && head.seq > 0) {
    if (sorted.length !== head.seq) {
      return {
        ok: false,
        count: sorted.length,
        brokenAt: sorted.length + 1,
        reason: `The ledger has ${sorted.length} entries but the recorded head is #${head.seq}.`
      };
    }
    if (previous !== head.hash) {
      return { ok: false, count: sorted.length, brokenAt: head.seq, reason: 'The last entry does not match the recorded head.' };
    }
  }

  return { ok: true, count: sorted.length };
};

// Payroll periods are calendar dates, not instants in the device timezone.
const payrollDate = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};

const countWorkingDays = (start: Date, end: Date): number => {
  let days = 0;
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
};

const workingDaysInMonth = (date: Date): number => {
  const first = new Date(date);
  first.setUTCDate(1);
  const last = new Date(first);
  last.setUTCMonth(first.getUTCMonth() + 1, 0);
  return countWorkingDays(first, last);
};

export const basePayForPeriod = (
  profile: StaffPayProfile | undefined,
  period: Pick<PayrollPeriod, 'startDate' | 'endDate'>
): number => {
  if (!profile) return 0;
  const start = payrollDate(period.startDate);
  const end = payrollDate(period.endDate);
  if (!start || !end || end < start) return 0;
  const periodDays = countWorkingDays(start, end);
  if (profile.payBasis === 'daily') return profile.rate * periodDays;

  // Monthly rates are pro-rated by working days so half-month cutoffs are fair.
  const monthDays = workingDaysInMonth(start);
  return monthDays > 0 ? (profile.rate * periodDays) / monthDays : profile.rate;
};

/** Positive means the clinic has released more cash to the staff member than
 *  has been repaid. Payouts and adjustments do not change this balance. */
export const advanceBalanceForStaff = (entries: PayrollEntry[], staffId: string): number =>
  entries
    .filter(entry => entry.staffId === staffId)
    .reduce((balance, entry) => {
      if (entry.type === 'advance') return balance + entry.amount;
      if (entry.type === 'repayment') return balance - entry.amount;
      return balance;
    }, 0);

export const currentPeriodEntries = (entries: PayrollEntry[], periodId: string): PayrollEntry[] =>
  entries.filter(entry => entry.periodId === periodId);

export const payBasisLabel = (basis: PayBasis): string =>
  basis === 'monthly' ? 'Monthly' : 'Daily';
