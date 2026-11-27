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

const payProfileFromData = (data: DocumentData): StaffPayProfile => ({
  revision: data.revision ?? 0,
  payBasis: data.payBasis === 'monthly' ? 'monthly' : 'daily',
  rate: Number(data.rate) || 0
});

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
    profiles[profile.id] = payProfileFromData(profile.data());
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
  const { db, fs, uid } = await getWriteHandles(actor);
  const summary = fs.doc(db, 'clinics', clinicId, 'payrollPeriods', periodId, 'payoutState', 'summary');
  const assertSettled = (data: DocumentData | undefined) => {
    if ((data?.unpaidCount ?? 0) > 0) throw new PayrollPayoutLimitError('Finish confirmed payouts before closing this period.');
  };
  assertSettled((await fs.getDocFromServer(summary)).data());
  if (!actor.isCurrent()) throw new Error('The clinic workspace changed. Reopen Staff & Payroll.');
  try {
    await mutateClinicalRecord({
      clinicId, collection: 'payrollPeriods', id: periodId, expectedRevision: revision, expectedUid: uid, action: 'save',
      data: { status: 'closed', closedAt: fs.serverTimestamp() }
    });
  } catch (error) {
    if (actor.isCurrent() && error instanceof Error && 'code' in error && error.code === 'permission-denied') {
      const current = await fs.getDocFromServer(summary).catch(() => null);
      if (current && actor.isCurrent()) assertSettled(current.data());
    }
    throw error;
  }
};

export const listPayrollEntries = async (clinicId: string): Promise<PayrollEntry[]> => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDocsFromServer(
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

export class PayrollPayoutLimitError extends Error {}

export type PayrollPayoutLimit = { approvedMinor: number; paidMinor: number };

export const loadReconciledPayrollAmount = async (clinicId: string, staffId: string, actor: PayrollActor): Promise<number> => {
  const { db, fs } = await getWriteHandles(actor);
  const snapshot = await fs.getDocFromServer(fs.doc(db, 'clinics', clinicId, 'payrollReconciliations', staffId));
  if (!actor.isCurrent()) throw new Error('The clinic workspace changed. Reopen Staff & Payroll.');
  return snapshot.data()?.appliedMinor ?? 0;
};

const assertPayable = (period: DocumentData | undefined, limit: DocumentData | undefined, amountMinor: number) => {
  if (period?.status !== 'open') throw new PayrollPayoutLimitError('This payroll period is closed or unavailable.');
  if (!limit) throw new PayrollPayoutLimitError('Confirm the payout limit for this staff member first.');
  const remainingMinor = limit.approvedMinor - limit.paidMinor;
  if (remainingMinor <= 0) throw new PayrollPayoutLimitError('No pay remains for this staff member in this period.');
  if (amountMinor > remainingMinor) {
    const remaining = (remainingMinor / 100).toLocaleString('en-PH', { style: 'currency', currency: 'PHP' });
    throw new PayrollPayoutLimitError(`Only ${remaining} remains payable for this staff member in this period.`);
  }
};

export const watchPayrollPayoutLimits = async (
  clinicId: string,
  periodId: string,
  onLimits: (limits: Record<string, PayrollPayoutLimit> | null) => void,
  onError: (error: Error) => void
) => {
  const { db, fs } = await getHandles();
  const limits = fs.collection(db, 'clinics', clinicId, 'payrollPeriods', periodId, 'payoutLimits');
  return fs.onSnapshot(limits, { includeMetadataChanges: true }, snapshot => {
    if (snapshot.metadata.fromCache) {
      onLimits(null);
      return;
    }
    if (snapshot.metadata.hasPendingWrites) return;
    onLimits(Object.fromEntries(snapshot.docs.map(row => {
      const { approvedMinor, paidMinor } = row.data();
      return [row.id, { approvedMinor, paidMinor }];
    })));
  }, onError);
};

export const confirmPayrollPayoutLimit = async (
  clinicId: string,
  periodId: string,
  staffId: string,
  reviewed: PayrollPayoutLimit & { unassignedPaidMinor: number },
  actor: PayrollActor
): Promise<void> => {
  const { db, fs, uid } = await getWriteHandles(actor);
  const periodRef = fs.doc(db, 'clinics', clinicId, 'payrollPeriods', periodId);
  const limitRef = fs.doc(periodRef, 'payoutLimits', staffId);
  const summaryRef = fs.doc(periodRef, 'payoutState', 'summary');
  const reconciliationRef = fs.doc(db, 'clinics', clinicId, 'payrollReconciliations', staffId);
  const profileRef = fs.doc(db, 'clinics', clinicId, 'payProfiles', staffId);
  const headRef = fs.doc(db, 'clinics', clinicId, 'payrollMeta', 'ledger');
  const ledger = fs.collection(db, 'clinics', clinicId, 'payrollLedger');

  await fs.runTransaction(db, async transaction => {
    const [periodSnapshot, limitSnapshot, profileSnapshot] = await Promise.all([
      transaction.get(periodRef), transaction.get(limitRef), transaction.get(profileRef)
    ]);
    const period = periodSnapshot.data();
    if (!period || period.status !== 'open') throw new PayrollPayoutLimitError('This payroll period is closed or unavailable.');
    if (limitSnapshot.exists()) throw new PayrollPayoutLimitError('The payout limit has already been confirmed.');
    const profile = profileSnapshot.data();
    if (!profile) throw new PayrollPayoutLimitError('Set a pay rate before confirming the payout limit.');

    // Read the ledger head before the query so an intervening append invalidates
    // the transaction and the reviewed amounts are checked against fresh data.
    await transaction.get(headRef);
    const history = await fs.getDocsFromServer(fs.query(ledger, fs.where('staffId', '==', staffId)));
    const { approvedMinor, paidMinor, unassignedMinor } = payrollBalanceForPeriod(
      payProfileFromData(profile), periodFromData(periodId, period),
      history.docs.map(row => entryFromData(row.id, row.data())), staffId
    );
    const { unassignedPaidMinor } = reviewed;
    if (!Number.isSafeInteger(unassignedPaidMinor) || unassignedPaidMinor < 0 || unassignedPaidMinor > unassignedMinor) {
      throw new PayrollPayoutLimitError('The reconciled amount must come from this staff member’s older unassigned payouts.');
    }
    const reconciliation = unassignedPaidMinor > 0 ? await transaction.get(reconciliationRef) : null;
    const appliedMinor = (reconciliation?.data()?.appliedMinor ?? 0) + unassignedPaidMinor;
    if (reconciliation && appliedMinor > unassignedMinor) {
      throw new PayrollPayoutLimitError('Some of those older payouts were already applied to another period. Review the remaining amount.');
    }
    const reconciledPaidMinor = paidMinor + unassignedPaidMinor;
    if (approvedMinor !== reviewed.approvedMinor || reconciledPaidMinor !== reviewed.paidMinor) {
      throw new PayrollPayoutLimitError('Payroll changed. Reopen Staff & Payroll and review the current amounts before confirming again.');
    }
    if (!Number.isSafeInteger(approvedMinor) || !Number.isSafeInteger(reconciledPaidMinor)
      || reconciledPaidMinor < 0 || approvedMinor <= 0 || reconciledPaidMinor > approvedMinor) {
      throw new PayrollPayoutLimitError('The already-paid amount exceeds the calculated payout limit or cannot be confirmed.');
    }
    const summary = reconciledPaidMinor < approvedMinor ? await transaction.get(summaryRef) : null;
    if (!actor.isCurrent()) throw new Error('The clinic workspace changed. Reopen Staff & Payroll.');
    if (reconciliation) transaction.set(reconciliationRef, { appliedMinor, lastPeriodId: periodId });
    if (summary) transaction.set(summaryRef, { unpaidCount: (summary.data()?.unpaidCount ?? 0) + 1, lastStaffId: staffId });
    transaction.set(limitRef, {
      approvedMinor, paidMinor: reconciledPaidMinor, unassignedPaidMinor,
      lastEntryId: '', confirmedBy: uid, confirmedAt: fs.serverTimestamp()
    });
  });
};

export const appendPayrollEntry = async ({
  clinicId,
  actor,
  type,
  direction,
  staff,
  amount,
  periodId,
  note
}: {
  clinicId: string;
  actor: PayrollActor;
  type: PayrollEntryType;
  direction: 'in' | 'out';
  staff: Pick<StaffMember, 'id' | 'name'>;
  amount: number;
  periodId?: string;
  note?: string;
}): Promise<PayrollEntry> => {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than zero.');
  const amountMinor = payrollMinor(amount);
  if (type === 'payout') {
    if (!periodId) throw new Error('Choose a payroll period before recording a salary payout.');
    if (direction !== 'out') throw new Error('Salary payouts must be recorded as cash out.');
    if (!Number.isSafeInteger(amountMinor) || amount !== amountMinor / 100) {
      throw new Error('Enter a payout amount with up to two decimal places.');
    }
  }

  const { db, fs, uid } = await getWriteHandles(actor);
  const ledger = fs.collection(db, 'clinics', clinicId, 'payrollLedger');
  const metaRef = fs.doc(db, 'clinics', clinicId, 'payrollMeta', 'ledger');
  const ref = fs.doc(ledger);
  const periodRef = type === 'payout' && periodId ? fs.doc(db, 'clinics', clinicId, 'payrollPeriods', periodId) : null;
  const limitRef = periodRef ? fs.doc(periodRef, 'payoutLimits', staff.id) : null;

  // Reading and updating the head keeps concurrent appends in ledger order.
  return fs.runTransaction(db, async transaction => {
    if (!actor.isCurrent()) throw new Error('The clinic workspace changed. Reopen Staff & Payroll.');
    const metaSnapshot = await transaction.get(metaRef);
    const meta = metaSnapshot.data();
    const previousSeq = meta ? Number(meta.seq) : 0;
    const seq = Number.isFinite(previousSeq) && previousSeq > 0 ? previousSeq + 1 : 1;
    const prevHash = meta && typeof meta.hash === 'string' && meta.hash ? meta.hash : GENESIS;

    if (periodRef && limitRef) {
      const [periodSnapshot, limitSnapshot] = await Promise.all([
        transaction.get(periodRef), transaction.get(limitRef)
      ]);
      const limit = limitSnapshot.data();
      assertPayable(periodSnapshot.data(), limit, amountMinor);
      if (limit && limit.paidMinor + amountMinor === limit.approvedMinor) {
        const summaryRef = fs.doc(periodRef, 'payoutState', 'summary');
        const summary = (await transaction.get(summaryRef)).data();
        if (!summary || summary.unpaidCount < 1) throw new PayrollPayoutLimitError('The confirmed payroll balance could not be verified.');
        transaction.set(summaryRef, { unpaidCount: summary.unpaidCount - 1, lastStaffId: staff.id });
      }
      transaction.update(limitRef, { paidMinor: fs.increment(amountMinor), lastEntryId: ref.id });
    }

    const payload = {
      seq,
      type,
      direction,
      staffId: staff.id,
      staffName: staff.name,
      amount,
      periodId: periodId ?? '',
      note: note?.trim() ?? '',
      createdBy: uid,
      prevHash
    };

    const hash = await sha256(canonicalEntry(payload));
    if (!actor.isCurrent()) throw new Error('The clinic workspace changed. Reopen Staff & Payroll.');

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
  }).catch(async (error: unknown) => {
    if (periodRef && limitRef && actor.isCurrent() && error instanceof Error
      && 'code' in error && error.code === 'permission-denied') {
      // Rules can reject a stale payout before Firestore retries the transaction.
      // Re-read the balance to explain the conflict without submitting again.
      const snapshots = await Promise.all([
        fs.getDocFromServer(periodRef), fs.getDocFromServer(limitRef)
      ]).catch(() => null);
      if (snapshots && actor.isCurrent()) assertPayable(snapshots[0].data(), snapshots[1].data(), amountMinor);
    }
    throw error;
  });
};

export type PayrollHead = { seq: number; hash: string };

export const getPayrollHead = async (clinicId: string): Promise<PayrollHead | null> => {
  const { db, fs } = await getHandles();
  const snapshot = await fs.getDocFromServer(fs.doc(db, 'clinics', clinicId, 'payrollMeta', 'ledger'));
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

const payrollMinor = (amount: number): number => Math.round((amount + Math.abs(amount) * Number.EPSILON) * 100);

export const payrollBalanceForPeriod = (
  profile: StaffPayProfile | undefined,
  period: Pick<PayrollPeriod, 'id' | 'startDate' | 'endDate'>,
  entries: PayrollEntry[],
  staffId: string
) => {
  const base = basePayForPeriod(profile, period);
  const advance = advanceBalanceForStaff(entries, staffId);
  let paidMinor = 0;
  let unassignedMinor = 0;
  for (const entry of entries) {
    if (entry.type !== 'payout' || entry.staffId !== staffId) continue;
    if (entry.periodId === period.id) paidMinor += payrollMinor(entry.amount);
    else if (!entry.periodId) unassignedMinor += payrollMinor(entry.amount);
  }
  const approvedMinor = payrollMinor(base - advance);
  return { base, advance, paidMinor, unassignedMinor, approvedMinor, remaining: Math.max(approvedMinor - paidMinor, 0) / 100 };
};

export const currentPeriodEntries = (entries: PayrollEntry[], periodId: string): PayrollEntry[] =>
  entries.filter(entry => entry.periodId === periodId);

export const payBasisLabel = (basis: PayBasis): string =>
  basis === 'monthly' ? 'Monthly' : 'Daily';
