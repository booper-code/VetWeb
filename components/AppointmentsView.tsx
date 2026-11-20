"use client";

import { useEffect, useRef, useState } from 'react';
import type { Appointment, AppointmentDraft, AppointmentStatus, AppointmentType, PatientRecord } from '@/types';
import type { AppointmentWindow } from '@/lib/appointment-values';
import {
  APPOINTMENT_TYPES, APPOINTMENT_STATUSES, appointmentWindowBounds, fromLocalDateTime, toLocalDateTime,
  appointmentValidationError, reminderMailto, reminderWhatsApp, reminderMessage, appointmentCalendar, localDate,
} from '@/lib/appointment-values';
import { assistantEditorTime, assistantManilaTime, matchAssistantReschedule, type AssistantReschedule } from '@/lib/workspace-assistant';

type Form = { id: string; revision: number | null; patientId: string; type: AppointmentType; status: AppointmentStatus;
  dueLocal: string; duration: string; notes: string; occurredLocal: string; snapshot?: Appointment;
  assistant?: { proposal: AssistantReschedule; originalEditorTime: string } };
const fieldClass = 'vc-input';
const buttonClass = 'vc-btn';

function editForm(row: Appointment, dueLocal = toLocalDateTime(row.dueAt)): Form {
  return { id: row.id, revision: row.revision, patientId: row.patientId, type: row.type, status: row.status,
    dueLocal, duration: String(row.durationMinutes), notes: row.notes,
    occurredLocal: row.occurredAt ? toLocalDateTime(row.occurredAt) : '', snapshot: row };
}

export function AppointmentsView({
  rows, patients, canEdit, isDemo, online, busy, loaded, error, hasMore, fromCache, window: dateWindow, refreshedAt,
  onWindow, onLoad, onSave, onOpenPatient, onRecordTreatment, clinicId, searchQuery, assistantEnabled, assistantReview,
}: {
  rows: Appointment[]; patients: PatientRecord[]; canEdit: boolean; isDemo: boolean; online: boolean;
  busy: boolean; loaded: boolean; error: string; hasMore: boolean; fromCache: boolean; refreshedAt: string;
  window: AppointmentWindow; clinicId: string; searchQuery: string;
  onWindow: (window: AppointmentWindow) => void; onLoad: (reset?: boolean) => Promise<void>;
  onSave: (id: string, revision: number | null, draft: AppointmentDraft,
    proposal?: AssistantReschedule, stillOpen?: () => boolean) => Promise<boolean>;
  onOpenPatient: (id: string, stillOpen: () => boolean) => Promise<void>;
  onRecordTreatment?: (row: Appointment, stillOpen: () => boolean) => Promise<void>;
  assistantEnabled?: boolean;
  assistantReview?: AssistantReschedule;
}) {
  const [rangeDraft, setRange] = useState<AppointmentWindow | null>(null);
  const range = rangeDraft ?? dateWindow;
  const [status, setStatus] = useState('scheduled');
  const [type, setType] = useState('all');
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  const [opening, setOpening] = useState('');
  const [refineOpen, setRefineOpen] = useState(false);
  const [handledReview, setHandledReview] = useState<AssistantReschedule | null>(null);
  const mounted = useRef(false);
  const lock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const editable = canEdit && (isDemo || online);
  const canUseAssistant = assistantEnabled && editable;
  const scheduleReady = loaded && !busy && !error && !fromCache;
  const pendingReview = canUseAssistant && assistantReview !== handledReview ? assistantReview : undefined;
  const q = searchQuery.trim().toLowerCase();
  const visible = rows.filter(row => (status === 'all' || row.status === status) && (type === 'all' || row.type === type)
    && `${row.patientName} ${row.ownerName} ${row.patientId} ${row.type}`.toLowerCase().includes(q));

  function reviewTarget(proposal: AssistantReschedule) {
    if (!canUseAssistant || !scheduleReady) return null;
    const row = matchAssistantReschedule(proposal, rows);
    return row?.status === 'scheduled' ? row : null;
  }

  function openAssistantReview(proposal: AssistantReschedule) {
    setHandledReview(proposal);
    const target = reviewTarget(proposal);
    const dueLocal = assistantEditorTime(proposal.proposedDueAt);
    if (!target || !dueLocal) {
      setMessage('The assistant draft is no longer available. Ask again with a current schedule and a time this device can display.');
      return;
    }
    setMessage(''); setFormError('');
    setForm({ ...editForm(target, dueLocal), assistant: { proposal, originalEditorTime: dueLocal } });
  }

  // A new handoff can initialize a closed editor, but can never replace an open form without a click.
  if (pendingReview && !form && !saving) openAssistantReview(pendingReview);
  if (form?.assistant && !saving && (!canUseAssistant || (scheduleReady && !reviewTarget(form.assistant.proposal)))) {
    setForm(null);
    setMessage('The assistant draft expired because the appointment or workspace changed. Nothing was saved.');
  }

  function start(row?: Appointment) {
    if (form && !window.confirm('Discard the current appointment form and open another?')) return;
    setMessage(''); setFormError('');
    setForm(row ? editForm(row)
      : { id: crypto.randomUUID(), revision: null, patientId: '', type: 'Checkup', status: 'scheduled',
        dueLocal: `${localDate(new Date())}T09:00`, duration: '30', notes: '', occurredLocal: '' });
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form || !editable || lock.current) return;
    if (form.assistant && !reviewTarget(form.assistant.proposal)) {
      setFormError('The appointment or schedule changed. Refresh and ask again before saving this draft.');
      return;
    }
    let draft: AppointmentDraft;
    try {
      const dueAt = fromLocalDateTime(form.dueLocal);
      if (form.assistant && form.dueLocal === form.assistant.originalEditorTime && dueAt !== form.assistant.proposal.proposedDueAt) {
        throw new Error('The device timezone changed. Open the assistant draft again before saving.');
      }
      draft = { patientId: form.patientId, type: form.type, status: form.status,
        dueAt, durationMinutes: Number(form.duration), notes: form.notes.trim(),
        occurredAt: form.status === 'completed' ? fromLocalDateTime(form.occurredLocal) : null };
      const invalid = appointmentValidationError(draft);
      if (invalid) throw new Error(invalid);
    } catch (error) { setFormError(error instanceof Error ? error.message : 'Check the appointment details.'); return; }
    const patientName = form.snapshot?.patientName ?? patients.find(patient => patient.id === form.patientId)?.name ?? form.patientId;
    if (!window.confirm(`Save ${form.type} for ${patientName} on ${new Date(draft.dueAt).toLocaleString()} as ${form.status}?${draft.occurredAt ? ` Actual visit: ${new Date(draft.occurredAt).toLocaleString()}.` : ''} This does not record treatments, stock use or payments.`)) return;
    lock.current = true; setSaving(true); setFormError('');
    try {
      const saved = form.assistant
        ? await onSave(form.id, form.revision, draft, form.assistant.proposal, () => mounted.current)
        : await onSave(form.id, form.revision, draft);
      if (!mounted.current) return;
      if (!saved) { setFormError('Workspace or schedule changed. The save may have completed; refresh before retrying.'); return; }
      setForm(null); setMessage('Appointment saved. It appears only if it matches the selected date/status/type filters.');
    } catch (error) {
      if (mounted.current) setFormError(error instanceof Error ? error.message : 'Appointment was not confirmed saved. Refresh and retry.');
    } finally { lock.current = false; if (mounted.current) setSaving(false); }
  }
  const draftChanged = (change: Partial<Form>) => setForm(previous => previous ? { ...previous, ...change } : null);
  function calendar(row: Appointment) {
    const url = URL.createObjectURL(new Blob([appointmentCalendar(row, clinicId)], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'clinic-appointment.ics';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function openPatient(id: string) {
    setOpening(id); setMessage('');
    try { await onOpenPatient(id, () => mounted.current); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Patient could not be opened.'); }
    finally { if (mounted.current) setOpening(''); }
  }
  async function openTreatment(row: Appointment) {
    if (!onRecordTreatment) return;
    setOpening(row.id); setMessage('');
    try { await onRecordTreatment(row, () => mounted.current); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'The treatment form could not be opened.'); }
    finally { if (mounted.current) setOpening(''); }
  }
  async function copyReminder(row: Appointment) {
    try {
      await navigator.clipboard.writeText(reminderMessage(row));
      if (mounted.current) setMessage('Reminder copied. Review it and send manually.');
    } catch { if (mounted.current) setMessage('Clipboard unavailable. Use the reminder text shown below.'); }
  }
  return <section className="vc-stack text-ink">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-2xl font-black text-ink">Appointments &amp; reminders</h2>
        <p className="mt-1 text-sm text-muted">Schedule checkups, vaccines and follow-ups. Times use this device’s timezone: <strong>{timezone}</strong>.</p></div>
      <button type="button" className="vc-btn vc-btn-primary ml-auto" disabled={!editable || saving} onClick={() => start()}>New appointment</button>
    </div>
    <p className="rounded-[12px] border border-warning-stroke bg-warning-wash p-3 text-sm text-ink">
      Scheduling only: marking complete never records vaccine administration, clinical treatment, inventory usage or payment automatically.
      Completed visits can open a linked treatment form, which still needs its own review and save.
      {' '}{isDemo ? 'Demo appointments stay in memory for this sign-in only.' : 'Offline access is read-only; no changes are queued.'}
    </p>
    {!refineOpen ? (
      <div className="vc-bottom-strip">
        <span className="vc-led" aria-hidden="true" />
        <div>
          <strong>Schedule</strong>
          <p>
            Showing {status === 'all' ? 'all statuses' : status} from {range.from} through {range.through}.
            Refine only when you need a different range or visit type.
          </p>
        </div>
        <button type="button" className="vc-btn vc-btn-sm" disabled={saving || busy} onClick={() => setRefineOpen(true)}>
          Refine schedule
        </button>
      </div>
    ) : (
      <>
        <form className="flex flex-wrap items-end gap-3 rounded-[14px] border border-line bg-panel p-4" onSubmit={event => {
          event.preventDefault();
          try { appointmentWindowBounds(range); setMessage(''); onWindow(range); setRange(null); }
          catch (error) { setMessage(error instanceof Error ? error.message : 'Check dates.'); }
        }}>
          <label className="text-sm font-semibold">From<input className={fieldClass} aria-label="Appointments from" type="date" required value={range.from} disabled={saving} onChange={event => setRange({ ...range, from: event.target.value })} /></label>
          <label className="text-sm font-semibold">Through<input className={fieldClass} aria-label="Appointments through" type="date" required value={range.through} disabled={saving} onChange={event => setRange({ ...range, through: event.target.value })} /></label>
          <button className={buttonClass} disabled={saving || busy}>Apply dates</button>
          <button type="button" className={buttonClass} disabled={saving || busy} onClick={() => void onLoad(true)}>Refresh schedule</button>
          <button type="button" className={buttonClass} disabled={saving || busy} onClick={() => setRefineOpen(false)}>Hide filters</button>
        </form>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm font-semibold">Status<select className={fieldClass} value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{APPOINTMENT_STATUSES.map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="text-sm font-semibold">Visit type<select className={fieldClass} value={type} onChange={event => setType(event.target.value)}><option value="all">All types</option>{APPOINTMENT_TYPES.map(value => <option key={value}>{value}</option>)}</select></label>
        </div>
      </>
    )}
    <p className="text-xs text-content-emphasis">Showing {visible.length} of {rows.length} loaded appointments for {dateWindow.from} through {dateWindow.through}, earliest first.
      {' '}Filters and header search cover loaded records only.{hasMore ? ' More pages may contain matching records.' : ''}
      {fromCache ? ' Cached results may be incomplete or outdated.' : ''}{refreshedAt && ` Last refreshed ${new Date(refreshedAt).toLocaleString()}.`}</p>
    {error && <p role="alert" className="rounded-lg border border-danger-stroke-strong bg-danger-wash p-3 text-content-emphasis">{error}</p>}
    {message && <p role="status" className="rounded-[12px] bg-soft p-3 text-sm">{message}</p>}
    {pendingReview && form && <div className="space-y-2 rounded-[12px] border border-warning-stroke bg-warning-wash p-3 text-sm">
      <p role="status">An assistant draft is ready. Your open form has not been replaced.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={saving || !scheduleReady} onClick={() => openAssistantReview(pendingReview)}>Replace form with assistant draft</button>
        <button type="button" className={buttonClass} onClick={() => setHandledReview(pendingReview)}>Dismiss assistant draft</button>
      </div>
    </div>}
    {form && <form onSubmit={event => void submit(event)} aria-label="Appointment details" className="space-y-4 rounded-[14px] border border-brand-outline bg-panel p-5">
      <h3 className="font-bold text-content-emphasis">{form.revision === null ? 'New appointment' : 'Edit appointment'}</h3>
      {form.assistant && <p className="vc-note">Assistant draft: {assistantManilaTime(form.assistant.proposal.originalDueAt)} → {assistantManilaTime(form.assistant.proposal.proposedDueAt)}. Nothing saved yet. The date and time field below uses this device’s timezone.</p>}
      <p className="text-xs text-content-emphasis">Choose a loaded patient. If missing, load their active/history page in Admission &amp; Medical first. Patient identity is fixed after creation.</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="text-sm">Patient<select className={fieldClass} required disabled={saving || !editable || form.revision !== null} value={form.patientId} onChange={event => draftChanged({ patientId: event.target.value })}>
          <option value="">Select patient</option>
          {form.snapshot && !patients.some(patient => patient.id === form.patientId) && <option value={form.patientId}>{form.snapshot.patientName} · {form.patientId}</option>}
          {patients.map(patient => <option key={patient.id} value={patient.id}>{patient.name} · {patient.ownerName} · {patient.id}</option>)}
        </select></label>
        <label className="text-sm">Type<select className={fieldClass} value={form.type} disabled={saving || !editable} onChange={event => draftChanged({ type: event.target.value as AppointmentType })}>{APPOINTMENT_TYPES.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="text-sm">Scheduled date &amp; time<input className={fieldClass} type="datetime-local" required value={form.dueLocal} disabled={saving || !editable} onChange={event => draftChanged({ dueLocal: event.target.value })} /></label>
        <label className="text-sm">Duration (minutes)<input className={fieldClass} type="number" required min="5" max="480" step="1" value={form.duration} disabled={saving || !editable} onChange={event => draftChanged({ duration: event.target.value })} /></label>
        <label className="text-sm">Appointment status<select className={fieldClass} value={form.status} disabled={saving || !editable} onChange={event => draftChanged({ status: event.target.value as AppointmentStatus, occurredLocal: '' })}>{APPOINTMENT_STATUSES.map(value => <option key={value}>{value}</option>)}</select></label>
        {form.status === 'completed' && <label className="text-sm">Actual visit date &amp; time<input className={fieldClass} type="datetime-local" required value={form.occurredLocal} disabled={saving || !editable} onChange={event => draftChanged({ occurredLocal: event.target.value })} /></label>}
      </div>
      <p className="text-xs text-content-emphasis">Entering work later? Set the actual visit time above. The server separately records when this entry was saved.</p>
      <label className="block text-sm">Scheduling notes<textarea className={fieldClass} maxLength={2000} value={form.notes} disabled={saving || !editable} onChange={event => draftChanged({ notes: event.target.value })} /></label>
      {formError && <p role="alert" className="rounded-lg border border-danger-stroke-strong bg-danger-wash p-3 text-content-emphasis">{formError}</p>}
      <div className="flex flex-wrap gap-2"><button className="vc-btn vc-btn-primary" disabled={saving || !editable}>{saving ? 'Saving…' : 'Review & save appointment'}</button>
        <button type="button" className={buttonClass} disabled={saving} onClick={() => setForm(null)}>Discard form</button></div>
    </form>}
    <div className="space-y-3">
      {visible.map(row => <article key={row.id} className="space-y-3 rounded-[13px] border border-line bg-panel p-4">
        <div className="flex flex-wrap justify-between gap-2">
          <div><h3 className="font-bold text-content-emphasis">{row.patientName} · {row.type}</h3><p className="text-sm text-content-emphasis">{new Date(row.dueAt).toLocaleString()} · {row.durationMinutes} min · {row.status}</p></div>
          <button type="button" className={buttonClass} disabled={!editable || saving} onClick={() => start(row)}>Edit appointment for {row.patientName}</button>
        </div>
        <p className="text-sm text-content-emphasis">Owner: {row.ownerName} · {row.ownerContact || 'No contact on file'}</p>
        {row.occurredAt && <p className="text-sm text-content-emphasis">Actual visit: {new Date(row.occurredAt).toLocaleString()}</p>}
        <p className="text-xs text-content-emphasis">Recorded: {row.createdAt ? new Date(row.createdAt).toLocaleString() : 'Refresh for server entry time'} · Last saved: {row.updatedAt ? new Date(row.updatedAt).toLocaleString() : 'Refresh for server entry time'}</p>
        {row.notes && <p className="whitespace-pre-wrap break-words text-sm text-content-emphasis">{row.notes}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} disabled={!!opening || saving} onClick={() => void openPatient(row.patientId)}>Open patient {row.patientName}</button>
          {onRecordTreatment && row.status === 'completed' && (
            <button type="button" className="vc-btn vc-btn-primary" disabled={!editable || !!opening || saving}
              onClick={() => void openTreatment(row)}>Record treatment &amp; stock</button>
          )}
          <button type="button" className={buttonClass} onClick={() => calendar(row)}>Download calendar</button>
          {row.status === 'scheduled' && <>
            <button type="button" className={buttonClass} onClick={() => void copyReminder(row)}>Copy reminder</button>
            {reminderMailto(row) && <a className={buttonClass} href={reminderMailto(row)!}>Draft email</a>}
            {reminderWhatsApp(row) && <a className={buttonClass} href={reminderWhatsApp(row)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Draft WhatsApp</a>}
          </>}
        </div>
        {row.status === 'scheduled' && <details className="text-sm text-content-emphasis"><summary>Manual reminder text</summary><p className="mt-2">{reminderMessage(row)}</p>
          <p className="mt-1 text-xs">Review the recipient before sharing. WhatsApp needs a saved +country-code number. These tools open an external app; they do not confirm delivery.</p></details>}
      </article>)}
      {!visible.length && loaded && !busy && <p className="rounded-lg bg-panel-subtle p-4 text-sm">No matching loaded appointments. Adjust the date/status/type filters or load more.</p>}
      {busy && <p role="status">Loading appointments…</p>}
      {(hasMore || error) && <button type="button" className={buttonClass} disabled={busy || saving} onClick={() => void onLoad(!loaded)}>
        {error ? 'Retry appointment page' : 'Load more appointments'}</button>}
    </div>
  </section>;
}
