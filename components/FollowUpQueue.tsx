'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Appointment } from '@/types';
import { reminderMailto, reminderWhatsApp } from '@/lib/appointment-values';
import { BILLING_DAY_MS, billingLocalTime } from '@/lib/billing-values';
import { currentFollowUpContact, followUpDayEndMs, isDueFollowUp } from '@/lib/follow-up-values';
import type { FollowUpCursor, FollowUpPage } from '@/lib/follow-up';

type Props = {
  load: (after: FollowUpCursor, endMs: number) => Promise<FollowUpPage>;
  onContact: (row: Appointment, contacted: boolean) => Promise<Appointment>;
  onOpenPatient: (id: string, stillOpen: () => boolean) => Promise<void>;
  onBack: () => void;
  isCurrent: () => boolean;
  canEdit: boolean;
  online: boolean;
};
const initialPage = () => ({ rows: [] as Appointment[], next: null as FollowUpCursor, endMs: 0, loaded: false, loading: true });
const clinicTime = (ms: number) => `${billingLocalTime(ms).replace('T', ' ')} Manila`;

export function FollowUpQueue({ load, onContact, onOpenPatient, onBack, isCurrent, canEdit, online }: Props) {
  const [page, setPage] = useState(initialPage);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [opening, setOpening] = useState(false);
  const generation = useRef(0);
  const loading = useRef(false);
  const contactBusy = useRef(false);
  const openVersion = useRef(0);
  const loadPage = useCallback(async (after: FollowUpCursor, endMs: number) => {
    if (!isCurrent() || !online || loading.current || contactBusy.current) return;
    const version = ++generation.current;
    loading.current = true;
    setError('');
    setPage(previous => ({ ...(after === null ? initialPage() : previous), endMs, loading: true }));
    try {
      const result = await load(after, endMs);
      if (generation.current !== version || !isCurrent()) return;
      setPage(previous => {
        const combined = after === null ? result.rows : [...previous.rows, ...result.rows];
        const rows = new Map<string, Appointment>();
        for (const row of combined) {
          const existing = rows.get(row.id);
          if (!existing || row.revision >= existing.revision) rows.set(row.id, row);
        }
        return { rows: [...rows.values()], next: result.next, loaded: true, endMs, loading: false };
      });
    } catch {
      if (generation.current === version && isCurrent()) {
        setError('Could not load the follow-up queue. Check your connection and refresh.');
        setPage(previous => ({ ...previous, loading: false }));
      }
    } finally {
      if (generation.current === version) loading.current = false;
    }
  }, [isCurrent, load, online]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void loadPage(null, followUpDayEndMs(Date.now())); });
    return () => {
      active = false;
      generation.current += 1;
      openVersion.current += 1;
      loading.current = false;
    };
  }, [loadPage]);

  const contact = async (row: Appointment, contacted: boolean) => {
    if (!canEdit || !online || !isCurrent() || loading.current || contactBusy.current) return;
    contactBusy.current = true;
    setSaving(row.id);
    setError('');
    const version = generation.current;
    try {
      const updated = await onContact(row, contacted);
      if (generation.current !== version || !isCurrent()) return;
      setPage(previous => ({ ...previous, rows: previous.rows.flatMap(existing => existing.id !== updated.id ? [existing]
        : isDueFollowUp(updated, previous.endMs - 1) ? [updated] : []) }));
    } catch (reason) {
      if (generation.current === version && isCurrent()) {
        const message = reason instanceof Error ? reason.message : 'Could not confirm contact.';
        setError(/refresh/i.test(message) ? message : `${message} Refresh before trying again.`);
      }
    } finally {
      contactBusy.current = false;
      if (generation.current === version && isCurrent()) setSaving('');
    }
  };

  const openPatient = async (id: string) => {
    const request = ++openVersion.current;
    const stillOpen = () => openVersion.current === request && isCurrent();
    setOpening(true);
    setError('');
    try { await onOpenPatient(id, stillOpen); }
    catch { if (stillOpen()) setError('Could not open this patient. Refresh the queue and try again.'); }
    finally { if (stillOpen()) setOpening(false); }
  };

  return <div className="min-w-0 space-y-4">
    <div className="vc-page-heading">
      <div>
        <p className="vc-kicker">Clinic operations</p>
        <h1>Follow-up queue</h1>
        <p>Scheduled follow-ups due today or overdue in Asia/Manila. Appointment remains scheduled when contact is recorded.</p>
      </div>
      <button type="button" className="vc-btn" onClick={onBack}>Back to overview</button>
    </div>
    {!online ? <p role="status" className="vc-note">Offline. Reconnect to see the current follow-up queue.</p> : <>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="vc-btn" disabled={page.loading || !!saving}
          onClick={() => void loadPage(null, followUpDayEndMs(Date.now()))}>Refresh queue</button>
        {page.endMs > 0 && <p className="vc-note">As of {billingLocalTime(page.endMs - 1).slice(0, 10)} Manila · Refresh for the latest clinic records.</p>}
      </div>
      <p className="vc-note">Contact owners manually and verify the recipient before using a draft. Nothing is sent automatically.</p>
      {error && <p role="alert" className="text-sm text-danger-text">{error}</p>}
      {page.loading && <p role="status" className="vc-note">Loading follow-ups…</p>}
      {page.loaded && !page.rows.length && !page.loading && !error && <p className="vc-note">No scheduled follow-ups are due.</p>}
      {page.rows.length > 0 && <ul className="space-y-3" aria-label="Due follow-ups">
        {page.rows.map(row => {
          const recorded = currentFollowUpContact(row);
          const dueAt = Date.parse(row.dueAt);
          const overdue = dueAt < page.endMs - BILLING_DAY_MS;
          const email = reminderMailto(row), whatsapp = reminderWhatsApp(row);
          return <li key={row.id} className="min-w-0 space-y-2 rounded-xl border border-outline-soft bg-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 break-words"><h2 className="font-semibold text-content-heading">{row.patientName}</h2>
                <p className="vc-note">{clinicTime(dueAt)}</p></div>
              <span className={`vc-badge ${overdue ? 'vc-badge-red' : ''}`}>{overdue ? 'Overdue' : 'Due today'}</span>
            </div>
            <p className="text-sm">{recorded ? `Contact recorded · ${clinicTime(Date.parse(recorded.contactedAt))}` : 'Needs contact'}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="vc-btn vc-btn-sm" disabled={opening}
                onClick={() => void openPatient(row.patientId)}>Open patient {row.patientName}</button>
              {canEdit && email && <a className="vc-btn vc-btn-sm" href={email}>Draft email</a>}
              {canEdit && whatsapp && <a className="vc-btn vc-btn-sm" href={whatsapp} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Draft WhatsApp</a>}
              {canEdit && <button type="button" className={`vc-btn vc-btn-sm ${recorded ? '' : 'vc-btn-primary'}`} disabled={page.loading || !!saving}
                onClick={() => void contact(row, !recorded)}>{saving === row.id ? 'Saving…' : recorded ? 'Undo contact' : 'Mark contacted'}</button>}
            </div>
          </li>;
        })}
      </ul>}
      {page.next !== null && <div className="space-y-2">
        <p role="status" className="vc-note">More follow-ups are available. The list is not complete yet.</p>
        <button type="button" className="vc-btn" disabled={page.loading || !!saving}
          onClick={() => void loadPage(page.next, page.endMs)}>Load more follow-ups</button>
      </div>}
    </>}
  </div>;
}
