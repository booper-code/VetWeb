"use client";

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PatientRecord } from '@/types';
import { patientSearchMatch } from '@/lib/patient-search-values';
import { useClinicScan, type ClinicScanPage } from '@/lib/useClinicScan';

export type ClinicPatientSearchProps = {
  online: boolean;
  isCurrent: () => boolean;
  load: (after: string | null) => Promise<ClinicScanPage<PatientRecord, string>>;
  onOpenPatient: (id: string, stillOpen: () => boolean) => Promise<void>;
};

export function ClinicPatientSearch({ online, isCurrent, load, onOpenPatient }: ClinicPatientSearchProps) {
  const [query, setQuery] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState(false);
  const opening = useRef<symbol | null>(null);
  const canRead = () => online && isCurrent();
  const { state, start, next, reset } = useClinicScan({ load, select: patientSearchMatch, identify: match => match.id, isCurrent: canRead });

  useEffect(() => () => { opening.current = null; }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRead()) return;
    opening.current = null;
    setOpeningId(null);
    setOpenError(false);
    const normalized = query.trim().toLowerCase();
    setTooShort(normalized.length < 2);
    if (normalized.length < 2) reset();
    else start(normalized);
  }

  async function open(id: string) {
    if (!canRead() || opening.current !== null) return;
    const request = Symbol();
    opening.current = request;
    const stillOpen = () => opening.current === request && canRead();
    setOpeningId(id);
    setOpenError(false);
    try {
      await onOpenPatient(id, stillOpen);
    } catch {
      if (stillOpen()) setOpenError(true);
    } finally {
      if (stillOpen()) {
        opening.current = null;
        setOpeningId(null);
      }
    }
  }

  return (
    <section className="space-y-3 rounded-[14px] border border-line bg-panel p-4" aria-label="Clinic-wide patient search">
      <h3 className="font-bold text-ink">Search clinic patients</h3>
      {!online ? <p role="status" className="text-sm text-muted">
        Offline: use the workspace search to filter loaded records. Clinic-wide search requires a connection.
      </p> : <>
        <p className="text-sm text-muted">Search active and discharged records by patient name, owner name, or patient ID.</p>
        <form aria-label="Search clinic patients" onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <input type="search" aria-label="Patient name, owner name, or patient ID" value={query}
            maxLength={150} onChange={event => setQuery(event.target.value)}
            className="vc-input min-w-0 flex-1" placeholder="Name, owner, or patient ID" />
          <button type="submit" className="vc-btn vc-btn-primary">Search</button>
        </form>
        {tooShort && <p role="status" className="text-sm text-muted">Enter at least two characters.</p>}
        {state.phase !== 'idle' && <p role="status" className="text-sm text-muted">
          {state.checked} {state.checked === 1 ? 'patient' : 'patients'} checked.{' '}
          {state.phase === 'loading' && 'Searching…'}
          {state.phase === 'partial' && 'Partial results. More clinic records may remain.'}
          {state.phase === 'error' && 'Search stopped before completion. Retry to continue.'}
          {state.phase === 'complete' && (state.matches.length ? 'Search complete.' : 'No matching patients.')}
        </p>}
        {openError && <p role="alert" className="text-sm text-warning-text-deep">Could not open this patient. Try again or run a new search.</p>}
        {state.matches.length > 0 && <ul className="max-h-80 space-y-1 overflow-y-auto" aria-label="Matching patients">
          {state.matches.map(match => <li key={match.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-2">
            <div className="min-w-0 break-words">
              <p className="font-semibold text-ink">{match.name}</p>
              <p className="text-xs text-muted">{match.ownerName || 'Owner not recorded'} · {match.id} · {match.status}</p>
            </div>
            <button type="button" className="vc-btn" onClick={() => void open(match.id)} disabled={openingId !== null}
              aria-label={`Open patient ${match.name} (${match.id})`}>
              {openingId === match.id ? 'Opening…' : 'Open patient'}
            </button>
          </li>)}
        </ul>}
        {state.phase === 'partial' && <button type="button" className="vc-btn" onClick={next}>Continue search</button>}
        {state.phase === 'error' && <button type="button" className="vc-btn" onClick={next}>Retry search</button>}
      </>}
    </section>
  );
}
