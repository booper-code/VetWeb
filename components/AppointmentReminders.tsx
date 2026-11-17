"use client";

import { useEffect, useState } from 'react';
import type { Appointment } from '@/types';
import { appointmentReminders } from '@/lib/appointment-values';

export function AppointmentReminders({ rows, busy, error, fromCache, partial, range, onOpen, onRefresh }: {
  rows: Appointment[]; busy: boolean; error: string; fromCache: boolean; partial: boolean;
  range: string; onOpen: () => void; onRefresh: () => void;
}) {
  const [, refreshClock] = useState(0);
  useEffect(() => {
    const update = () => { if (!document.hidden) refreshClock(value => value + 1); };
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const reminders = appointmentReminders(rows);
  return <section aria-labelledby="reminders-heading" className="rounded-2xl border border-teal-200 bg-white p-5 text-black">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="reminders-heading" className="text-lg font-bold text-black">Appointments &amp; reminders</h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-lg border px-3 py-2 text-sm" disabled={busy} onClick={onRefresh}>Refresh appointments</button>
        <button type="button" className="rounded-lg bg-teal-700 px-3 py-2 text-sm text-white" onClick={onOpen}>Open appointments</button>
      </div>
    </div>
    <p className="my-2 text-xs text-black">Loaded schedule only · {range}{partial ? ' · More pages available' : ''}{fromCache ? ' · Cached snapshot, may be incomplete' : ''}. No background messages are sent. Refresh when returning.</p>
    {busy && <p role="status" className="text-sm">Loading appointments…</p>}
    {error && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-black">{error}</p>}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {([['Earlier than today', reminders.overdue], ['Due today', reminders.today], ['Next 6 days', reminders.upcoming]] as const).map(([label, list]) =>
        <div key={label} className="rounded-xl bg-slate-50 p-3">
          <p className="text-sm font-semibold text-black">{label}: {list.length} loaded</p>
          <ul className="mt-2 space-y-1 text-sm text-black">{list.slice(0, 3).map(row =>
            <li key={row.id}>{row.patientName} · {row.type} · {new Date(row.dueAt).toLocaleString()}</li>)}</ul>
        </div>)}
    </div>
  </section>;
}
