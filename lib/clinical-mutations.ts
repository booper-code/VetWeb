import type { DocumentData, Firestore, Transaction } from 'firebase/firestore';
import { initializeFirebase } from '@/lib/firebase';

export type ClinicalCollection = 'patients' | 'inventory' | 'consultations' | 'appointments';
export class ClinicalConflictError extends Error {
  constructor() {
    super('This record changed or was deleted. Reload it before saving again.');
    this.name = 'ClinicalConflictError';
  }
}

/**
 * expectedRevision=null means create; missing revisions on existing records are 0.
 * Callers must retain the revision from when editing began, not a fresh list row.
 * Transactions deliberately fail offline; never queue a clinical overwrite.
 */
export type ClinicalMutation = {
  clinicId: string;
  collection: ClinicalCollection;
  id?: string;
  expectedRevision: number | null;
  data?: DocumentData;
  action: 'save' | 'delete';
  preservePatientBilling?: boolean;
  billingStockEntryId?: string;
};

export async function mutateClinicalRecord(input: ClinicalMutation): Promise<{ id: string; revision: number }> {
  return (await mutateClinicalRecords([input]))[0];
}

/** Bounded multi-record commit: stock and patient billing cannot partially save. */
export async function mutateClinicalRecords(inputs: ClinicalMutation[]): Promise<{ id: string; revision: number }[]> {
  const { db: initializedDb, firestore: initializedModule, auth } = await initializeFirebase();
  const db = initializedDb as Firestore | null;
  const fs = initializedModule as typeof import('firebase/firestore') | null;
  const uid = auth?.currentUser?.uid;
  if (!db || !fs || !uid) throw new Error('Sign in and connect before saving.');
  const stableInputs = inputs.map(input =>
    !input.id && input.expectedRevision === null && input.action === 'save' && input.clinicId
      ? { ...input, id: fs.doc(fs.collection(db, 'clinics', input.clinicId, input.collection)).id }
      : input
  );
  return fs.runTransaction(db, async tx => {
    const stage = await prepareClinicalWrites(db, fs, tx, stableInputs);
    return stage(uid);
  });
}

/** Read and validate before staging writes in the caller's transaction. */
export async function prepareClinicalWrites(db: Firestore, fs: typeof import('firebase/firestore'), tx: Transaction, inputs: ClinicalMutation[]) {
  if (!inputs.length || inputs.length > 3 || inputs.some(input => input.clinicId !== inputs[0].clinicId)) {
    throw new Error('Save one clinic and at most three related records per operation.');
  }
  for (const input of inputs) if (!['patients', 'inventory', 'consultations', 'appointments'].includes(input.collection)
    || !['save', 'delete'].includes(input.action)
    || typeof input.clinicId !== 'string' || !input.clinicId
    || (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0))
    || (input.action === 'delete' && input.expectedRevision === null)
    || (input.expectedRevision !== null && !input.id)
    || (input.action === 'save' && !input.data)) throw new Error('Invalid clinical mutation.');
  const entries = inputs.map(input => {
    const entity = input.id
      ? fs.doc(db, 'clinics', input.clinicId, input.collection, input.id)
      : fs.doc(fs.collection(db, 'clinics', input.clinicId, input.collection));
    return { input, entity,
      head: fs.doc(db, 'clinics', input.clinicId, 'auditHeads', `${input.collection}_${entity.id}`),
      event: fs.doc(fs.collection(db, 'clinics', input.clinicId, 'auditEvents')) };
  });
  if (new Set(entries.map(entry => entry.entity.path)).size !== entries.length) throw new Error('Duplicate mutation target.');
  const prepared: ((typeof entries)[number] & { revision: number | null; seq: number; data: DocumentData })[] = [];
  for (const entry of entries) {
    const current = await tx.get(entry.entity);
    const previous = await tx.get(entry.head);
    const revision = current.exists() ? (current.data().revision ?? 0) : null;
    if (revision !== entry.input.expectedRevision
      || (revision === null && previous.exists())
      || (revision !== null && (previous.data()?.seq ?? 0) !== revision)) throw new ClinicalConflictError();
    const data = { ...entry.input.data };
    const stored = current.data();
    if (entry.input.preservePatientBilling && entry.input.collection === 'patients') {
      delete data.legacyBillingBalance;
      for (const field of ['balance', 'billableItems', 'billing']) {
        if (stored && field in stored) data[field] = stored[field];
        else delete data[field];
      }
    }
    if (entry.input.collection === 'inventory') {
      const reference = entry.input.billingStockEntryId ?? stored?.billingStockEntryId;
      if (reference === undefined) delete data.billingStockEntryId;
      else data.billingStockEntryId = reference;
    }
    prepared.push({ ...entry, revision, seq: (revision ?? 0) + 1, data });
  }
  return (uid: string) => prepared.map(({ input, entity, head, event, revision, seq, data }) => {
    const metadata = {
      actorUid: uid,
      action: input.action === 'delete' ? 'delete' : revision === null ? 'create' : 'update',
      entityType: input.collection,
      entityId: entity.id,
      time: fs.serverTimestamp(),
      seq,
      eventId: event.id
    };
    if (input.action === 'delete') tx.delete(entity);
    else tx.set(entity, { ...data, id: entity.id, revision: seq });
    tx.set(event, metadata);
    tx.set(head, metadata);
    return { id: entity.id, revision: seq };
  });
}
