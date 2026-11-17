import type { DocumentData } from 'firebase/firestore';
import type { Consultation, ConsultationDraft, InventoryItem, TreatmentLine } from '@/types';
import { initializeFirebase } from '@/lib/firebase';
import { mutateClinicalRecords } from '@/lib/clinical-mutations';
import {
  consultationValidationError,
  isStockTreatment,
  MAX_STOCK_LINES
} from '@/lib/consultation-values';

const iso = (value: { toDate?: () => Date } | string | null | undefined) =>
  typeof value === 'string' ? value : value?.toDate?.().toISOString() ?? '';

function treatmentFromData(value: DocumentData): TreatmentLine | null {
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
    ...data,
    id,
    date: typeof data.date === 'string' ? data.date : '',
    client: typeof data.client === 'string' ? data.client : '',
    patient: typeof data.patient === 'string' ? data.patient : '',
    type: typeof data.type === 'string' ? data.type : 'Consultation',
    status: data.status === 'Draft' ? 'Draft' : 'Completed',
    notes: typeof data.notes === 'string' ? data.notes : '',
    patientId: typeof data.patientId === 'string' ? data.patientId : undefined,
    appointmentId: typeof data.appointmentId === 'string' ? data.appointmentId : null,
    occurredAt: iso(data.occurredAt) || undefined,
    recordedAt: iso(data.recordedAt) || undefined,
    staffUid: typeof data.staffUid === 'string' ? data.staffUid : undefined,
    staffName: typeof data.staffName === 'string' ? data.staffName : undefined,
    treatments: Array.isArray(data.treatments)
      ? data.treatments.map(treatmentFromData).filter((line): line is TreatmentLine => line !== null)
      : undefined
  } as Consultation;
}

/**
 * Records one completed treatment visit and, in the same audited transaction,
 * decrements stock for medicine/supply lines. Clinical content is never created
 * automatically; the caller must be an online owner or editor.
 */
export async function saveConsultation(input: {
  clinicId: string;
  draft: ConsultationDraft;
  inventory: InventoryItem[];
}): Promise<{ consultation: Consultation; inventory: InventoryItem[] }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Reconnect before recording a treatment. Clinical writes are not queued offline.');
  }
  const invalid = consultationValidationError(input.draft, input.inventory);
  if (invalid) throw new Error(invalid);
  if (!input.clinicId || input.clinicId === 'demo-clinic') throw new Error('A connected clinic is required for cloud treatment records.');

  const { db, firestore: fs, auth } = await initializeFirebase();
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in before recording a treatment.');

  const patientRef = fs.doc(db, 'clinics', input.clinicId, 'patients', input.draft.patientId);
  const patient = await fs.getDoc(patientRef);
  if (!patient.exists()) throw new Error('Patient not found in this clinic. Reload the patient list.');

  if (input.draft.appointmentId) {
    const appointment = await fs.getDoc(
      fs.doc(db, 'clinics', input.clinicId, 'appointments', input.draft.appointmentId)
    );
    if (!appointment.exists() || appointment.data().patientId !== input.draft.patientId) {
      throw new Error('The linked appointment no longer matches this patient.');
    }
    if (appointment.data().status !== 'completed') {
      throw new Error('Only a completed appointment can be linked to a treatment record.');
    }
  }

  // Rebuild every line from the clinic inventory: names, categories and prices
  // cannot be spoofed, and stock cannot be taken from an unloaded item.
  const treatments: TreatmentLine[] = [];
  const inventoryWrites: { data: InventoryItem; expectedRevision: number }[] = [];
  for (const line of input.draft.treatments) {
    const itemRef = fs.doc(db, 'clinics', input.clinicId, 'inventory', line.itemCode);
    const itemSnapshot = await fs.getDoc(itemRef);
    if (!itemSnapshot.exists()) {
      throw new Error(`${line.itemName} is not available in this clinic. Reload inventory and retry.`);
    }
    const item = itemSnapshot.data();
    const stock = Number.isFinite(item.stock) ? item.stock : 0;
    const category: InventoryItem['category'] =
      ['Medicine', 'Supplies', 'Service', 'Grooming'].includes(item.category) ? item.category : 'Supplies';
    if (isStockTreatment({ category }) && line.quantity > stock) {
      throw new Error(`Only ${stock} ${typeof item.itemName === 'string' ? item.itemName : line.itemName} left in stock.`);
    }
    treatments.push({
      id: line.id,
      itemCode: line.itemCode,
      itemName: typeof item.itemName === 'string' ? item.itemName : line.itemName,
      category,
      quantity: line.quantity,
      unitPrice: Number.isFinite(item.sellingPrice) ? item.sellingPrice : 0,
      dose: line.dose,
      notes: line.notes
    });
    if (isStockTreatment({ category })) {
      inventoryWrites.push({
        data: { ...(item as InventoryItem), itemCode: line.itemCode, stock: stock - line.quantity },
        expectedRevision: Number.isSafeInteger(item.revision) ? item.revision : 0
      });
    }
  }
  if (inventoryWrites.length > MAX_STOCK_LINES) {
    throw new Error(`Apply at most ${MAX_STOCK_LINES} stock items per treatment record.`);
  }

  const data = {
    date: new Date(input.draft.occurredAt).toLocaleDateString(),
    client: typeof patient.data().ownerName === 'string' ? patient.data().ownerName : '',
    patient: typeof patient.data().name === 'string' ? patient.data().name : '',
    type: input.draft.type,
    status: 'Completed',
    notes: input.draft.notes,
    patientId: input.draft.patientId,
    appointmentId: input.draft.appointmentId || null,
    occurredAt: fs.Timestamp.fromDate(new Date(input.draft.occurredAt)),
    recordedAt: fs.serverTimestamp(),
    staffUid: uid,
    staffName: input.draft.staffName.trim(),
    treatments,
    stockMoves: treatments.filter(line => isStockTreatment(line)).map(line => ({
      itemCode: line.itemCode,
      quantity: line.quantity
    }))
  };

  const saved = await mutateClinicalRecords([
    {
      clinicId: input.clinicId,
      collection: 'consultations',
      expectedRevision: null,
      action: 'save',
      data
    },
    ...inventoryWrites.map(write => ({
      clinicId: input.clinicId,
      collection: 'inventory' as const,
      id: write.data.itemCode,
      expectedRevision: write.expectedRevision,
      action: 'save' as const,
      data: write.data
    }))
  ]);

  const consultationResult = saved[0];
  const inventory = inventoryWrites.map((write, index) => ({
    ...write.data,
    revision: saved[index + 1]?.revision
  }));

  let consultation: Consultation = {
    ...data,
    id: consultationResult.id,
    revision: consultationResult.revision,
    occurredAt: new Date(input.draft.occurredAt).toISOString(),
    recordedAt: new Date().toISOString(),
    appointmentId: data.appointmentId,
    treatments
  } as unknown as Consultation;

  try {
    const confirmed = await fs.getDoc(
      fs.doc(db, 'clinics', input.clinicId, 'consultations', consultationResult.id)
    );
    if (confirmed.exists()) consultation = consultationFromDocument(confirmed.id, confirmed.data());
  } catch {
    // The audited commit succeeded; a failed readback is not a failed save.
  }

  return { consultation, inventory };
}
