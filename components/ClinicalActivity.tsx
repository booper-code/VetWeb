"use client";

import { Fragment, useMemo, useRef, useState } from 'react';
import { Activity, Loader2, PlusCircle, Stethoscope, X } from 'lucide-react';
import type { Consultation, ConsultationDraft, InventoryItem, PatientRecord, TreatmentLine } from '@/types';
import {
  CONSULTATION_TYPES,
  MAX_STOCK_LINES,
  compareConsultationHistory,
  consultationMatchesPatient,
  consultationTime,
  consultationValidationError,
  isStockTreatment,
  toLocalDateTimeValue
} from '@/lib/consultation-values';

const newLineId = () => `TRT-${crypto.randomUUID()}`;

export const ClinicalActivity = ({
  patient,
  consultations,
  chronological = false,
  inventory,
  canEdit,
  staffUid,
  staffName,
  appointmentId = null,
  initialOccurredAt,
  onSave,
  triggerToast
}: {
  patient: PatientRecord;
  consultations: Consultation[];
  chronological?: boolean;
  inventory: InventoryItem[];
  canEdit: boolean;
  staffUid: string;
  staffName: string;
  appointmentId?: string | null;
  initialOccurredAt?: string;
  onSave: (draft: ConsultationDraft) => Promise<boolean>;
  triggerToast: (msg: string) => void;
}) => {
  const linkedVisitTime = appointmentId ? toLocalDateTimeValue(initialOccurredAt || new Date()) : '';
  const defaultOccurredAt = () => linkedVisitTime || toLocalDateTimeValue();
  const [showForm, setShowForm] = useState(Boolean(appointmentId));
  const [occurredAt, setOccurredAt] = useState(defaultOccurredAt);
  const [type, setType] = useState<string>('Consultation');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<TreatmentLine[]>([]);
  const [itemCode, setItemCode] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [dose, setDose] = useState('');
  const [lineNotes, setLineNotes] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const saving = useRef(false);

  const patientConsultations = useMemo(() => {
    const matching = consultations.filter(entry => consultationMatchesPatient(entry, patient));
    return chronological ? matching : matching.sort(compareConsultationHistory);
  }, [chronological, consultations, patient]);
  const firstUnknown = patientConsultations.findIndex(entry => consultationTime(entry) === null);

  const selectedItem = inventory.find(entry => entry.itemCode === itemCode) ?? null;
  const stockLineCount = lines.filter(isStockTreatment).length;

  const resetForm = () => {
    setOccurredAt(defaultOccurredAt());
    setType('Consultation');
    setNotes('');
    setLines([]);
    setItemCode('');
    setQuantity(1);
    setDose('');
    setLineNotes('');
    setError('');
    setShowForm(false);
  };

  const addLine = () => {
    if (!selectedItem) {
      setError('Choose an inventory item or service first.');
      return;
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      setError('Use a whole positive quantity.');
      return;
    }
    const existing = lines.find(line => line.itemCode === selectedItem.itemCode);
    const nextQuantity = (existing?.quantity ?? 0) + quantity;
    if (isStockTreatment(selectedItem) && nextQuantity > selectedItem.stock) {
      setError(`Only ${selectedItem.stock} ${selectedItem.itemName} left in stock.`);
      return;
    }
    if (!existing && isStockTreatment(selectedItem) && stockLineCount >= MAX_STOCK_LINES) {
      setError(`Apply at most ${MAX_STOCK_LINES} stock items per treatment record.`);
      return;
    }
    setLines(previous => existing
      ? previous.map(line => line.itemCode === existing.itemCode
        ? { ...line, quantity: nextQuantity, dose: dose || line.dose, notes: lineNotes || line.notes }
        : line)
      : [...previous, {
        id: newLineId(),
        itemCode: selectedItem.itemCode,
        itemName: selectedItem.itemName,
        category: selectedItem.category,
        quantity,
        unitPrice: selectedItem.sellingPrice,
        dose,
        notes: lineNotes
      }]);
    setItemCode('');
    setQuantity(1);
    setDose('');
    setLineNotes('');
    setError('');
  };

  const removeLine = (id: string) => setLines(previous => previous.filter(line => line.id !== id));

  const handleSave = async () => {
    if (!canEdit || saving.current) return;
    if (itemCode || dose.trim() || lineNotes.trim()) {
      setError('Choose a treatment item and click Add line, or clear the unfinished line before saving.');
      return;
    }
    const visitTime = new Date(occurredAt);
    const draft: ConsultationDraft = {
      patientId: patient.id,
      occurredAt: Number.isFinite(visitTime.getTime()) ? visitTime.toISOString() : '',
      type,
      notes: notes.trim(),
      appointmentId,
      treatments: lines,
      staffUid,
      staffName
    };
    const invalid = consultationValidationError(draft, inventory);
    if (invalid) {
      setError(invalid);
      return;
    }
    saving.current = true;
    setIsSaving(true);
    setError('');
    try {
      const saved = await onSave(draft);
      if (!saved) return;
      resetForm();
      triggerToast(draft.treatments.some(isStockTreatment)
        ? 'Treatment record saved. Stock moves were applied once.'
        : 'Treatment record saved. No stock changed.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The treatment record was not saved.');
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-panel rounded-2xl p-6 border border-outline-soft shadow-sm space-y-4">
      <div className="flex flex-col gap-3 border-b border-hairline pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="text-sm font-bold text-content-heading flex items-center gap-2">
            <Activity className="w-5 h-5 text-brand-text" />
            Clinical activity
          </h4>
          <p className="text-xs text-content-hint mt-1">
            Visit time is stored separately from the recorded/audit time. Medicine and supply lines move stock once; they do not add charges.
          </p>
        </div>
        {canEdit && !showForm && (
          <button
            type="button"
            onClick={() => {
              setOccurredAt(defaultOccurredAt());
              setShowForm(true);
            }}
            className="vc-btn vc-btn-primary shrink-0"
          >
            <PlusCircle className="h-4 w-4" aria-hidden="true" />
            Record treatment
          </button>
        )}
      </div>

      {!canEdit && (
        <p className="text-xs font-semibold text-content-hint">
           View-only: an online clinic session is required to record treatments.
        </p>
      )}

      {showForm && canEdit && (
        <div className="rounded-xl border border-brand-stroke bg-brand-wash/40 p-4 space-y-4">
          {appointmentId && (
            <p className="rounded-lg border border-brand-stroke bg-panel px-3 py-2 text-[11px] font-semibold text-brand-text-max">
              Linked to the completed appointment visit at {new Date(occurredAt).toLocaleString()}. Saving creates a separate treatment record; it does not change the appointment.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="vc-label">
              Actual visit time
              <input
                type="datetime-local"
                value={occurredAt}
                max={toLocalDateTimeValue()}
                onChange={event => setOccurredAt(event.target.value)}
                className="vc-input"
              />
            </label>
            <label className="vc-label">
              Visit type
              <select value={type} onChange={event => setType(event.target.value)} className="vc-input">
                {CONSULTATION_TYPES.map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <div className="vc-label">
              Recorded by
              <div className="flex min-h-[38px] items-center rounded-[9px] border border-outline-soft bg-panel-raised px-3 text-xs font-bold text-content-secondary">
                {staffName || 'Signed-in staff'}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-outline-soft bg-panel p-3 space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-content-faint">Treatment &amp; service lines</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              <select
                aria-label="Treatment item"
                value={itemCode}
                onChange={event => setItemCode(event.target.value)}
                className="vc-input lg:col-span-2"
              >
                <option value="">Choose medicine, supply or service…</option>
                {inventory.map(item => (
                  <option key={item.itemCode} value={item.itemCode}>
                    {item.itemName} · {item.category}
                    {isStockTreatment(item) ? ` · ${item.stock} left` : ''}
                  </option>
                ))}
              </select>
              <input
                aria-label="Quantity"
                type="number"
                min={1}
                step={1}
                value={quantity}
                onChange={event => setQuantity(Number(event.target.value))}
                className="vc-input"
                placeholder="Qty"
              />
              <button type="button" onClick={addLine} className="vc-btn justify-center">
                <PlusCircle className="h-4 w-4" aria-hidden="true" /> Add line
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                aria-label="Dose or instructions"
                type="text"
                maxLength={200}
                value={dose}
                onChange={event => setDose(event.target.value)}
                className="vc-input"
                placeholder="Dose / instructions (e.g. 0.5 mL once daily)"
              />
              <input
                aria-label="Line note"
                type="text"
                maxLength={500}
                value={lineNotes}
                onChange={event => setLineNotes(event.target.value)}
                className="vc-input"
                placeholder="Optional line note"
              />
            </div>

            {lines.length === 0 ? (
              <p className="text-xs text-content-hint">No treatment lines yet. A notes-only visit is allowed.</p>
            ) : (
              <ul className="divide-y divide-hairline">
                {lines.map(line => (
                  <li key={line.id} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-content-heading">
                        {line.itemName} × {line.quantity}
                        <span className="ml-2 font-medium text-content-hint">{line.category}</span>
                      </p>
                      {(line.dose || line.notes) && (
                        <p className="text-[11px] text-content-hint mt-0.5">
                          {[line.dose, line.notes].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLine(line.id)}
                      className="text-content-faint hover:text-danger-icon"
                      aria-label={`Remove ${line.itemName}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {stockLineCount > 0 && (
              <p className="text-[11px] font-medium text-warning-text">
                {stockLineCount} stock line{stockLineCount === 1 ? '' : 's'} will be dispensed exactly once when saved.
              </p>
            )}
          </div>

          <label className="vc-label">
            Clinical notes
            <textarea
              value={notes}
              onChange={event => setNotes(event.target.value)}
              maxLength={5000}
              className="vc-input min-h-[96px] resize-y"
              placeholder="Findings, diagnosis and follow-up instructions. Do not use AI output as a clinical decision."
            />
          </label>

          {error && <p role="alert" className="text-xs font-bold text-danger-text bg-danger-wash border border-danger-stroke rounded-lg px-3 py-2">{error}</p>}

          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={resetForm} disabled={isSaving} className="vc-btn">Cancel</button>
            <button type="button" onClick={handleSave} disabled={isSaving} className="vc-btn vc-btn-primary">
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Save treatment
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {patientConsultations.length === 0 ? (
          <div className="vc-empty">
            <Stethoscope className="h-6 w-6 text-slate-300 mx-auto mb-2" aria-hidden="true" />
            No clinical activity recorded for this patient yet.
          </div>
        ) : patientConsultations.map((entry, index) => (
          <Fragment key={entry.id}>
          {index === firstUnknown && <h3 className="text-xs font-bold text-content-heading">Unknown date</h3>}
          <article className="rounded-xl border border-outline-soft p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h5 className="text-sm font-bold text-content-title break-words">
                  {entry.treatments?.[0]?.itemName || entry.type}
                  {entry.treatments && entry.treatments.length > 1 && ` + ${entry.treatments.length - 1} more`}
                </h5>
                <p className="text-[11px] text-content-hint mt-0.5">
                  {!!entry.treatments?.length && `Visit type: ${entry.type} · `}
                  Visit {entry.occurredAt ? new Date(entry.occurredAt).toLocaleString() : entry.date || 'time not recorded'}
                  {entry.staffName ? ` · ${entry.staffName}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {entry.appointmentId && (
                  <span className="rounded-md border border-outline-soft bg-panel-subtle px-2 py-0.5 text-[10px] font-bold text-content-secondary">
                    Appointment linked
                  </span>
                )}
                <span className={`vc-badge ${entry.status === 'Completed' ? 'vc-badge-teal' : 'vc-badge-amber'}`}>
                  {entry.status}
                </span>
              </div>
            </div>
            {entry.notes && <p className="mt-2 text-xs leading-relaxed text-content-copy whitespace-pre-wrap">{entry.notes}</p>}
            {entry.treatments && entry.treatments.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {entry.treatments.map(line => (
                  <li key={line.id} className="min-w-0 break-words rounded-md bg-panel-subtle border border-outline-soft px-2 py-1 text-[11px] font-semibold text-content-copy">
                    {line.itemName} × {line.quantity}
                    {line.dose ? ` · ${line.dose}` : ''}
                    {line.notes ? ` · ${line.notes}` : ''}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10px] text-content-faint">
              {entry.recordedAt
                ? `Recorded ${new Date(entry.recordedAt).toLocaleString()}`
                : 'Entry time is available in the audit trail.'}
            </p>
          </article>
          </Fragment>
        ))}
      </div>
    </div>
  );
};
