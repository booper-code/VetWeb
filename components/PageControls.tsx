"use client";

import type { PageStatus } from '@/lib/useClinicPages';

export function PageControls({ label, status, onLoad }: {
  label: string; status: PageStatus; onLoad: () => void;
}) {
  return <div className="flex flex-wrap items-center gap-3 rounded-xl border border-outline-soft bg-panel p-3 text-sm">
    <span className="text-content-secondary">{label}: loaded records only.</span>
    {status.error && <span role="alert" className="text-danger-text">{status.error}</span>}
    {(status.hasMore || status.error) && <button type="button" onClick={onLoad} disabled={status.busy}
      className="rounded-lg bg-slate-900 px-3 py-2 font-bold text-white disabled:opacity-50">
      {status.busy ? 'Loading…' : status.error ? `Retry ${label}` : `Load more ${label}`}
    </button>}
    {status.loaded && !status.hasMore && <span className="text-content-hint">All available records loaded.</span>}
  </div>;
}
