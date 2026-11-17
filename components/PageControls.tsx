"use client";

import type { PageStatus } from '@/lib/useClinicPages';

export function PageControls({ label, status, onLoad }: {
  label: string; status: PageStatus; onLoad: () => void;
}) {
  return <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
    <span className="text-slate-600">{label}: loaded records only.</span>
    {status.error && <span role="alert" className="text-red-700">{status.error}</span>}
    {(status.hasMore || status.error) && <button type="button" onClick={onLoad} disabled={status.busy}
      className="rounded-lg bg-slate-900 px-3 py-2 font-bold text-white disabled:opacity-50">
      {status.busy ? 'Loading…' : status.error ? `Retry ${label}` : `Load more ${label}`}
    </button>}
    {status.loaded && !status.hasMore && <span className="text-slate-500">All available records loaded.</span>}
  </div>;
}
