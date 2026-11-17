import type { Consultation, ConsultationDraft, InventoryItem, PatientRecord, TreatmentLine } from '@/types';

export const CONSULTATION_TYPES = [
  'Consultation',
  'Vaccination',
  'Deworming',
  'Surgery',
  'Grooming',
  'Follow-up',
  'Laboratory'
] as const;

export const MAX_TREATMENT_LINES = 12;
export const MAX_STOCK_LINES = 2;

const STOCK_CATEGORIES: InventoryItem['category'][] = ['Medicine', 'Supplies'];

export const isStockTreatment = (line: Pick<TreatmentLine, 'category'>) =>
  STOCK_CATEGORIES.includes(line.category);

/** Value for a `datetime-local` input in the device's local timezone. */
export function toLocalDateTimeValue(value: Date | string = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function consultationOccurredAt(consultation: Consultation): string {
  if (consultation.occurredAt && Number.isFinite(Date.parse(consultation.occurredAt))) {
    return new Date(consultation.occurredAt).toISOString();
  }
  return '';
}

/** New records use the precise event time; legacy rows fall back to their display date. */
export function consultationTime(consultation: Consultation): number {
  const precise = Date.parse(consultation.occurredAt || '');
  if (Number.isFinite(precise)) return precise;
  const legacy = Date.parse(consultation.date || '');
  return Number.isFinite(legacy) ? legacy : 0;
}

export function consultationMatchesPatient(consultation: Consultation, patient: PatientRecord): boolean {
  if (consultation.patientId) return consultation.patientId === patient.id;
  return consultation.patient.trim().toLowerCase() === patient.name.trim().toLowerCase();
}

/**
 * Pure validation shared by the demo flow, the cloud action and the UI.
 * Stock lines must be present in the loaded inventory before anything is saved.
 */
export function consultationValidationError(
  draft: ConsultationDraft,
  inventory: InventoryItem[]
): string {
  if (!draft.patientId) return 'Choose a patient before recording a treatment.';
  if (!draft.staffUid || !draft.staffName.trim()) return 'Sign in before recording a treatment.';

  const when = Date.parse(draft.occurredAt);
  if (!Number.isFinite(when)) return 'Enter a valid visit date and time.';
  if (when > Date.now() + 5_000) return 'The visit time cannot be in the future.';
  const year = new Date(when).getUTCFullYear();
  if (year < 2000 || year > 2100) return 'The visit time is outside the supported range.';

  if (!CONSULTATION_TYPES.includes(draft.type as typeof CONSULTATION_TYPES[number])) {
    return 'Choose a valid visit type.';
  }
  if (draft.notes.length > 5000) return 'Clinical notes must be 5000 characters or fewer.';
  if (draft.treatments.length > MAX_TREATMENT_LINES) {
    return `Add at most ${MAX_TREATMENT_LINES} treatment lines.`;
  }

  const stockLines = draft.treatments.filter(isStockTreatment);
  if (stockLines.length > MAX_STOCK_LINES) {
    return `Apply at most ${MAX_STOCK_LINES} stock items per treatment record.`;
  }

  const seen = new Set<string>();
  for (const line of draft.treatments) {
    if (!line.itemCode || !line.itemName.trim()) return 'Each treatment line needs an item.';
    if (line.itemCode.includes('/')) return 'That item code cannot be used.';
    if (seen.has(line.itemCode)) return 'Each item can appear only once per treatment record.';
    seen.add(line.itemCode);

    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10_000) {
      return 'Use whole positive quantities.';
    }
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      return `The price for ${line.itemName} is invalid. Reload inventory and retry.`;
    }
    if (line.dose.length > 200) return 'A dose must be 200 characters or fewer.';
    if (line.notes.length > 500) return 'A treatment note must be 500 characters or fewer.';

    if (isStockTreatment(line)) {
      const item = inventory.find(entry => entry.itemCode === line.itemCode);
      if (!item) {
        return `${line.itemName} is not loaded. Load the inventory item before recording it.`;
      }
      if (line.quantity > item.stock) {
        return `Only ${item.stock} ${item.itemName} left in stock.`;
      }
    }
  }

  return '';
}

/** Stock decrements that must commit with the consultation, exactly once. */
export function treatmentStockChanges(lines: TreatmentLine[], inventory: InventoryItem[]): InventoryItem[] {
  return lines.filter(isStockTreatment).map(line => {
    const item = inventory.find(entry => entry.itemCode === line.itemCode);
    return item ? { ...item, stock: item.stock - line.quantity } : null;
  }).filter((item): item is InventoryItem => item !== null);
}

/** Demo records are built locally; the cloud action mirrors this shape with Firestore timestamps. */
export function buildConsultationRecord(
  id: string,
  draft: ConsultationDraft,
  patient: PatientRecord,
  recordedAt: string = new Date().toISOString()
): Consultation {
  return {
    id,
    date: new Date(draft.occurredAt).toLocaleDateString(),
    client: patient.ownerName,
    patient: patient.name,
    type: draft.type,
    status: 'Completed',
    notes: draft.notes,
    patientId: patient.id,
    appointmentId: draft.appointmentId || null,
    occurredAt: new Date(draft.occurredAt).toISOString(),
    recordedAt,
    staffUid: draft.staffUid,
    staffName: draft.staffName,
    treatments: draft.treatments.map(line => ({ ...line })),
    stockMoves: draft.treatments.filter(isStockTreatment).map(line => ({
      itemCode: line.itemCode,
      quantity: line.quantity
    }))
  };
}
