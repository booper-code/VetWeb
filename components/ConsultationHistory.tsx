"use client";

import { PageControls } from '@/components/PageControls';
import { compareConsultationHistory, consultationTime } from '@/lib/consultation-values';
import type { PageStatus } from '@/lib/useClinicPages';
import type { Consultation } from '@/types';

export function ConsultationHistory({ rows, status, onLoad, canEdit, onToggleStatus }: {
  rows: Consultation[];
  status?: PageStatus;
  onLoad: () => void;
  canEdit: boolean;
  onToggleStatus: (id: string) => void;
}) {
  const chronological = !status || status.chronological;
  // Firestore already ordered the cloud prefix, including timestamp precision
  // finer than one JavaScript millisecond.
  const ordered = status ? rows : [...rows].sort(compareConsultationHistory);
  const isUnknown = (row: Consultation) => consultationTime(row) === null;
  const dated = chronological ? ordered.filter(row => !isUnknown(row)) : ordered;
  const unknown = chronological ? ordered.filter(isUnknown) : [];
  const list = (entries: Consultation[]) => (
    <ul className="vc-clean-list">
      {entries.map(row => <li key={row.id} className="vc-clean-row">
        <div className="vc-clean-item">
          <strong>{row.patient || 'Unnamed patient'} · {row.type || 'Consultation'}</strong>
          <p>{row.occurredAt ? new Date(row.occurredAt).toLocaleString() : row.date || 'No visit date recorded'} · {row.id}</p>
        </div>
        <div className="vc-clean-actions">
          <span className={row.status === 'Draft' ? 'vc-badge vc-badge-amber' : 'vc-badge vc-badge-teal'}>{row.status}</span>
          {!row.patientId && canEdit && <button type="button" className="vc-btn vc-btn-sm"
            onClick={() => onToggleStatus(row.id)}>Change state</button>}
        </div>
      </li>)}
    </ul>
  );
  return (
    <details className="vc-card mt-4">
      <summary className="cursor-pointer text-sm font-bold">Consultation history</summary>
      <div className="mt-3 space-y-3">
        {status?.loaded && !chronological && <p className="vc-note">
          Consultation history is listed by record ID until chronological ordering is ready for this clinic.
        </p>}
        {dated.length > 0 && list(dated)}
        {unknown.length > 0 && <div>
          <h3 className="text-xs font-bold text-content-heading">Unknown date</h3>
          {list(unknown)}
        </div>}
        {ordered.length === 0 && (!status || status.loaded) && <p className="vc-note">No consultations recorded.</p>}
        {status && <PageControls label="consultations" status={status} onLoad={onLoad} />}
      </div>
    </details>
  );
}
