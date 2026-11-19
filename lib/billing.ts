import type { DocumentData, QueryDocumentSnapshot, Transaction } from 'firebase/firestore';
import { initializeFirebase } from '@/lib/firebase';
import { ClinicalConflictError, prepareClinicalWrites, type ClinicalMutation } from '@/lib/clinical-mutations';
import {
  BILLING_TIME_ZONE, billingDayStartMs, calculateBillingTransition, readLegacyBalance,
  type BillingDraft, type BillingState, type BillingStockMove, type PaymentMethod, type ResolvedBillingDraft,
} from '@/lib/billing-values';

export type BillingOperation = { clinicId: string; patientId: string; operationId: string; expectedPatientRevision: number; draft: BillingDraft };
type ReceiptValues = { clinicName: string; patientName: string; occurredAtMs: number; businessDayMs: number; timeZone: typeof BILLING_TIME_ZONE; method: PaymentMethod };
export type PaymentReceipt = ReceiptValues & { id: string; amountMinor: number; balanceAfterMinor: number; reversed: boolean };
type EntryValues = { id: string; clinicId: string; patientId: string; actorUid: string; recordedAtMs: number; seq: number; balanceBeforeMinor: number; balanceAfterMinor: number; amountMinor: number; stockMoves: BillingStockMove[] };
export type BillingEntry = EntryValues & (
  | { kind: 'opening'; cutoffMs: number; source: string; reason: string; legacyOriginalMinor: number | null }
  | { kind: 'opening-correction'; source: string; reason: string }
  | ({ kind: 'payment'; reference: string; note: string } & ReceiptValues)
  | { kind: 'unitemized-settlement'; businessDayMs: number }
  | { kind: 'charge'; lines: { itemCode: string; itemName: string; category: string; quantity: number; unitPriceMinor: number }[] }
  | { kind: 'reversal'; originalEntryId: string; reason: string; returnStock: boolean }
);
export type BillingRecords = { patient: DocumentData; inventory: (DocumentData & { itemCode: string })[]; missingItemCodes?: string[] };
export type BillingCommit = { entry: BillingEntry; state: BillingState; patientRevision: number; stock: {
  itemCode: string; stock: number; revision: number; billingStockEntryId?: string;
}[]; records?: BillingRecords };
export type BillingCursor = QueryDocumentSnapshot<DocumentData>;
export type BillingPage = { entries: BillingEntry[]; next: BillingCursor | null };
const PAGE_SIZE = 25;
const operationPattern = /^[A-Za-z0-9-]{1,100}$/;
const pathSegment = (key: string) => typeof key === 'string' && key.length > 0 && key.length <= 200 && !key.includes('/') && key !== '.' && key !== '..';

async function billingConnection(clinicId: string, patientId: string) {
  if (!pathSegment(clinicId) || clinicId === 'demo-clinic' || !pathSegment(patientId)) throw new Error('Choose an online clinic and patient.');
  const { db, firestore: fs, auth } = await initializeFirebase();
  const uid = auth?.currentUser?.uid;
  if (!db || !fs || !uid) throw new Error('Sign in and connect before accessing billing.');
  return { db, fs, uid };
}

const decoded = (id: string, { recordedAt, ...data }: DocumentData): BillingEntry =>
  ({ ...data, id, recordedAtMs: recordedAt.toMillis() }) as BillingEntry;

const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
});

async function fingerprint(operation: BillingOperation): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(operation));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function commitBilling(input: BillingOperation): Promise<BillingCommit> {
  const { clinicId, patientId, operationId, expectedPatientRevision, draft } = input;
  const idOkay = draft.kind === 'reversal'
    ? operationPattern.test(draft.originalEntryId) && operationId === `reverse_${draft.originalEntryId}`
    : operationPattern.test(operationId);
  if (!idOkay || !Number.isSafeInteger(expectedPatientRevision) || expectedPatientRevision < 0) throw new Error('Invalid reviewed billing operation.');
  const { db, fs, uid } = await billingConnection(clinicId, patientId);
  const receiptRef = fs.doc(db, 'clinics', clinicId, 'billingEntries', operationId);
  const patientRef = fs.doc(db, 'clinics', clinicId, 'patients', patientId);
  const requestFingerprint = await fingerprint(input);
  const readInventory = async (tx: Transaction, itemCode: string) => {
    if (!pathSegment(itemCode)) throw new Error('Invalid billing item.');
    return (await tx.get(fs.doc(db, 'clinics', clinicId, 'inventory', itemCode))).data();
  };
  const result = await fs.runTransaction(db, async tx => {
    const before = (await tx.get(patientRef)).data();
    if (!before) throw new ClinicalConflictError();
    const previous = (await tx.get(receiptRef)).data();
    if (previous) {
      if (previous.actorUid !== uid || previous.patientId !== patientId || previous.requestFingerprint !== requestFingerprint) {
        throw new Error('That billing operation ID was already used for a different review.');
      }
      const stock: BillingCommit['stock'] = [];
      const inventory: BillingRecords['inventory'] = [];
      const missingItemCodes: string[] = [];
      for (const { itemCode } of previous.stockMoves as BillingStockMove[]) {
        const item = await readInventory(tx, itemCode);
        if (item) {
          stock.push({ itemCode, stock: item.stock, revision: item.revision ?? 0, billingStockEntryId: item.billingStockEntryId });
          inventory.push({ ...item, itemCode });
        } else missingItemCodes.push(itemCode);
      }
      return { state: before.billing as BillingState, patientRevision: before.revision ?? 0, stock,
        records: { patient: before, inventory, missingItemCodes } };
    }
    if ((before.revision ?? 0) !== expectedPatientRevision) throw new ClinicalConflictError();
    const inventory = new Map<string, DocumentData>();
    let resolved: ResolvedBillingDraft;
    if (draft.kind === 'charge') {
      if (draft.lines.length < 1 || draft.lines.length > 2) throw new Error('Confirm one or two charge lines at a time.');
      const lines = [];
      for (const line of draft.lines) {
        const item = await readInventory(tx, line.itemCode);
        const price = readLegacyBalance(item?.sellingPrice);
        if (!item || item.itemCode !== line.itemCode || (item.revision ?? 0) !== line.expectedRevision
          || price.kind !== 'valid' || price.minor !== line.unitPriceMinor) throw new ClinicalConflictError();
        inventory.set(line.itemCode, item);
        lines.push({ ...line, itemName: item.itemName, category: item.category, stock: item.stock });
      }
      resolved = { kind: 'charge', lines };
    } else if (draft.kind === 'reversal') {
      const original = (await tx.get(fs.doc(db, 'clinics', clinicId, 'billingEntries', draft.originalEntryId))).data();
      if (!original || original.patientId !== patientId || (original.kind !== 'payment' && original.kind !== 'charge' && original.kind !== 'unitemized-settlement')) {
        throw new Error('Choose a reversible billing entry for this patient.');
      }
      if (draft.returnStock && original.kind === 'charge') {
        for (const { itemCode } of original.stockMoves as BillingStockMove[]) {
          const item = await readInventory(tx, itemCode);
          if (!item || (item.revision ?? 0) !== draft.expectedStockRevisions[itemCode]) throw new ClinicalConflictError();
          inventory.set(itemCode, item);
        }
      }
      resolved = { ...draft, original: { kind: original.kind, amountMinor: original.amountMinor, stockMoves: original.stockMoves } };
    } else {
      resolved = draft;
    }
    const transition = calculateBillingTransition(before.billing ?? null, before.balance, resolved, Date.now());
    const state = { ...transition.next, lastEntryId: operationId };
    const legacy = readLegacyBalance(before.balance);
    let details: DocumentData = {};
    switch (resolved.kind) {
      case 'opening':
        details = { cutoffMs: resolved.cutoffMs, source: resolved.source.trim(), reason: resolved.reason?.trim() ?? '', legacyOriginalMinor: legacy.kind === 'valid' ? legacy.minor : null };
        break;
      case 'opening-correction':
        details = { source: resolved.source.trim(), reason: resolved.reason.trim() };
        break;
      case 'payment': {
        const clinic = (await tx.get(fs.doc(db, 'clinics', clinicId))).data();
        details = {
          method: resolved.method, occurredAtMs: resolved.occurredAtMs, businessDayMs: billingDayStartMs(resolved.occurredAtMs),
          timeZone: BILLING_TIME_ZONE, reference: resolved.reference?.trim() ?? '', note: resolved.note?.trim() ?? '',
          clinicName: clinic?.name ?? 'Clinic', patientName: before.name ?? 'Unnamed patient',
        };
        break;
      }
      case 'charge':
        details = { lines: resolved.lines.map(({ itemCode, itemName, category, quantity, unitPriceMinor }) => ({ itemCode, itemName, category, quantity, unitPriceMinor })) };
        break;
      case 'unitemized-settlement':
        details = { businessDayMs: resolved.businessDayMs };
        break;
      case 'reversal':
        details = { originalEntryId: resolved.originalEntryId, reason: resolved.reason.trim(), returnStock: resolved.returnStock };
        break;
    }
    const writes: ClinicalMutation[] = [{ clinicId, collection: 'patients', id: patientId, expectedRevision: expectedPatientRevision, action: 'save', data: { ...before, billing: state } }];
    const stock: BillingCommit['stock'] = [];
    for (const { itemCode, quantityDelta } of transition.stockMoves) {
      const item = inventory.get(itemCode);
      if (!item || !Number.isSafeInteger(item.stock) || !Number.isSafeInteger(item.stock + quantityDelta) || item.stock + quantityDelta < 0) throw new ClinicalConflictError();
      const revisedStock = item.stock + quantityDelta;
      const revision = item.revision ?? 0;
      writes.push({ clinicId, collection: 'inventory', id: itemCode, expectedRevision: revision, action: 'save',
        data: { ...item, stock: revisedStock }, billingStockEntryId: operationId });
      stock.push({ itemCode, stock: revisedStock, revision: revision + 1, billingStockEntryId: operationId });
    }
    const stage = await prepareClinicalWrites(db, fs, tx, writes);
    stage(uid);
    tx.set(receiptRef, {
      ...details, clinicId, patientId, actorUid: uid, recordedAt: fs.serverTimestamp(), requestFingerprint,
      seq: state.seq, kind: draft.kind, balanceBeforeMinor: before.billing?.balanceMinor ?? 0, balanceAfterMinor: state.balanceMinor,
      amountMinor: resolved.kind === 'reversal' ? resolved.original.amountMinor
        : resolved.kind === 'opening-correction' ? resolved.verifiedMinor : Math.abs(transition.deltaMinor),
      stockMoves: transition.stockMoves,
    });
    return { state, patientRevision: expectedPatientRevision + 1, stock };
  });
  const committed = (await fs.getDocFromServer(receiptRef)).data();
  if (!committed) throw new Error('The billing result could not be read. Retry the same review.');
  return { ...result, entry: decoded(operationId, committed) };
}

export async function loadBillingRecords({ clinicId, patientId, itemCodes }: { clinicId: string; patientId: string; itemCodes: string[] }): Promise<BillingRecords> {
  if (itemCodes.length > 2 || itemCodes.some(code => !pathSegment(code))) throw new Error('Review one or two inventory lines.');
  const { db, fs } = await billingConnection(clinicId, patientId);
  const [patient, ...items] = await Promise.all([
    fs.getDocFromServer(fs.doc(db, 'clinics', clinicId, 'patients', patientId)),
    ...itemCodes.map(code => fs.getDocFromServer(fs.doc(db, 'clinics', clinicId, 'inventory', code))),
  ]);
  const current = patient.data();
  if (!current) throw new Error('This patient is no longer available.');
  return { patient: current, inventory: items.flatMap(row => row.exists() ? [{ ...row.data(), itemCode: row.id }] : []),
    missingItemCodes: items.filter(row => !row.exists()).map(row => row.id) };
}

export async function loadBillingHistory({ clinicId, patientId, after }: { clinicId: string; patientId: string; after?: BillingCursor }): Promise<BillingPage> {
  const { db, fs } = await billingConnection(clinicId, patientId);
  const snapshot = await fs.getDocsFromServer(fs.query(
    fs.collection(db, 'clinics', clinicId, 'billingEntries'),
    fs.where('patientId', '==', patientId), fs.orderBy('seq', 'desc'),
    ...(after ? [fs.startAfter(after)] : []), fs.limit(PAGE_SIZE),
  ));
  return { entries: snapshot.docs.map(doc => decoded(doc.id, doc.data())), next: snapshot.size === PAGE_SIZE ? snapshot.docs.at(-1) ?? null : null };
}

export async function loadPaymentReceipt({ clinicId, patientId, entryId }: { clinicId: string; patientId: string; entryId: string }): Promise<PaymentReceipt> {
  if (!operationPattern.test(entryId)) throw new Error('Choose a posted payment.');
  const { db, fs } = await billingConnection(clinicId, patientId);
  return fs.runTransaction(db, async tx => {
    const payment = (await tx.get(fs.doc(db, 'clinics', clinicId, 'billingEntries', entryId))).data();
    if (!payment || payment.kind !== 'payment' || payment.patientId !== patientId) throw new Error('No matching receipt for this patient.');
    const reversal = await tx.get(fs.doc(db, 'clinics', clinicId, 'billingEntries', `reverse_${entryId}`));
    const { clinicName, patientName, occurredAtMs, businessDayMs, timeZone, method, amountMinor, balanceAfterMinor } = payment;
    return { id: entryId, clinicName, patientName, occurredAtMs, businessDayMs, timeZone, method, amountMinor, balanceAfterMinor, reversed: reversal.exists() };
  });
}
