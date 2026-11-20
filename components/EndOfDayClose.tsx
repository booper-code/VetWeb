'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { billingLocalTime, formatBillingAmount, PAYMENT_METHODS, type PaymentMethod } from '@/lib/billing-values';
import { formatCloseMinor, summarizeBalances, summarizeCollections } from '@/lib/end-of-day-values';
import { useEndOfDay, type CloseSection } from '@/lib/useEndOfDay';

type ViewProps = {
  report: ReturnType<typeof useEndOfDay>;
  onOpenPatient: (id: string, stillOpen: () => boolean) => Promise<void>;
  onBack: () => void;
  clerkPreview?: ReactNode;
};

const methods: Record<PaymentMethod, string> = { cash: 'Cash', 'e-wallet': 'E-wallet', 'bank-transfer': 'Bank transfer', card: 'Card', other: 'Other' };
const localTime = (ms: number) => `${billingLocalTime(ms).replace('T', ' ')} Manila`;

function ClosePanel({ title, state, onMore, moreLabel, children }: {
  title: string; state: CloseSection<unknown>; onMore?: () => void; moreLabel?: string; children: ReactNode;
}) {
  const id = useId();
  return <section aria-labelledby={id} className="min-w-0 space-y-3 rounded-xl border border-outline-soft bg-panel p-4 sm:p-5">
    <h2 id={id} className="font-bold text-content-heading">{title}</h2>
    {state.status === 'loading' && <p role="status" className="vc-note">Loading report data…</p>}
    {state.status === 'error' && <p role="alert" className="text-sm text-danger-text">{state.error}</p>}
    {state.status === 'partial' && <p role="status" className="text-sm text-warning-text-deep">Incomplete coverage. Load more to see the full result.</p>}
    {state.status === 'complete' && children}
    {(state.status === 'complete' || state.status === 'partial') && state.refreshedAtMs !== null &&
      <p className="vc-note">Last read: {localTime(state.refreshedAtMs)}</p>}
    {state.status === 'partial' && onMore && <button type="button" className="vc-btn vc-btn-sm" onClick={onMore}>{moreLabel}</button>}
  </section>;
}

export function WorkspaceEndOfDayClose({ onOpenPatient, onBack, clerkPreview, ...options }: Omit<ViewProps, 'report'> & Parameters<typeof useEndOfDay>[0]) {
  const report = useEndOfDay(options);
  return <EndOfDayClose report={report} onOpenPatient={onOpenPatient} onBack={onBack} clerkPreview={clerkPreview} />;
}

export function EndOfDayClose({ report, onOpenPatient, onBack, clerkPreview }: ViewProps) {
  const { day, dayError, sections } = report;
  const patientRequest = useRef(0);
  const [patientError, setPatientError] = useState('');
  const [opening, setOpening] = useState(false);
  const offline = sections.entries.status === 'offline';
  useEffect(() => () => { patientRequest.current++; }, [day, offline]);

  const cancelPatientOpen = () => { patientRequest.current++; setPatientError(''); setOpening(false); };
  const openPatient = async (id: string) => {
    const request = ++patientRequest.current;
    const stillOpen = () => patientRequest.current === request;
    setOpening(true);
    setPatientError('');
    try { await onOpenPatient(id, stillOpen); }
    catch { if (stillOpen()) setPatientError('Could not open this patient. Refresh the report and try again.'); }
    finally { if (stillOpen()) setOpening(false); }
  };

  const entries = sections.entries.status === 'complete' ? sections.entries.rows : [];
  const totals = summarizeCollections(entries);
  const balances = summarizeBalances(sections.balances.status === 'complete' ? sections.balances.rows : []);
  const settlements = entries.filter(({ entry }) => entry.kind === 'unitemized-settlement');
  const unmatched = sections.visits.rows.filter(visit => !visit.linkedTreatment);
  return <div className="space-y-4 min-w-0">
    <div className="vc-page-heading">
      <div>
        <p className="vc-kicker">Read-only report</p>
        <h1>End-of-Day Close</h1>
        <p>Refreshing reads the latest records. This report does not lock the day or save a snapshot.</p>
      </div>
      <button type="button" className="vc-btn" onClick={() => { cancelPatientOpen(); onBack(); }}>Back to overview</button>
    </div>
    {clerkPreview}
    <div className="flex flex-wrap items-end gap-3">
      <label className="vc-label min-w-0">Business day (Asia/Manila)
        <input className="vc-input min-w-0 max-w-full" type="date" value={day} max={report.latestDay}
          onChange={event => { cancelPatientOpen(); report.setDay(event.target.value); }} />
      </label>
      <button type="button" className="vc-btn" disabled={offline || !!dayError}
        onClick={() => { cancelPatientOpen(); report.refresh(); }}>Refresh report</button>
    </div>
    {dayError && <p role="alert" className="text-sm text-danger-text">{dayError}</p>}
    {offline ? <p role="status" className="rounded-xl border border-warning-stroke bg-warning-wash p-4 text-warning-text-deep">
      Offline. Reconnect for the latest clinic figures. Cached data is not shown as a complete report.
    </p> : <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <ClosePanel title="Recorded collections" state={sections.entries} onMore={() => report.loadMore('entries')} moreLabel="Load more collections and settlements">
        <p className="vc-note">Payments by the day received, after reversals. Charges, opening balances and unitemized installments are excluded.</p>
        <dl className="space-y-1">
          {PAYMENT_METHODS.map(method => <div key={method} className="flex flex-wrap justify-between gap-2 border-b border-hairline py-1">
            <dt>{methods[method]}</dt><dd className="font-semibold">{formatCloseMinor(totals[method])}</dd>
          </div>)}
        </dl>
      </ClosePanel>
      <ClosePanel title="Corrections recorded this day" state={sections.corrections} onMore={() => report.loadMore('corrections')} moreLabel="Load more corrections">
        <p className="vc-note">Reversals update the original entry. They are not refunds or a second deduction from collections.</p>
        {sections.corrections.rows.length ? <ul className="space-y-2">
          {sections.corrections.rows.map(({ entry, original }) => <li key={entry.id} className="break-words border-b border-hairline pb-2">
            <p className="font-semibold">{original.kind === 'payment' ? 'Payment reversal' : 'Settlement reversal'} · {formatBillingAmount(entry.amountMinor)}</p>
            {original.kind !== 'charge' && <p className="vc-note">Original business day: {billingLocalTime(original.businessDayMs).slice(0, 10)} Manila · Patient {entry.patientId}</p>}
          </li>)}
        </ul> : <p className="vc-note">No payment or settlement corrections recorded this day.</p>}
      </ClosePanel>
      <ClosePanel title="Paid in full — not itemized" state={sections.entries}>
        <p className="text-sm text-warning-text-deep">Installment dates and methods weren’t itemized. These amounts are not included in daily collections.</p>
        {settlements.length ? <ul className="space-y-2">
          {settlements.map(({ entry, reversed }) => <li key={entry.id} className="break-words border-b border-hairline pb-2">
            <p className="font-semibold">{formatBillingAmount(entry.amountMinor)}{reversed ? ' · Reversed' : ''}</p>
            <p className="vc-note">Patient {entry.patientId}</p>
          </li>)}
        </ul> : <p className="vc-note">No unitemized settlements dated this day.</p>}
      </ClosePanel>
      <ClosePanel title="Current outstanding balances" state={sections.balances} onMore={() => report.loadMore('balances')} moreLabel="Load more balances">
        <p className="vc-note">Current clinic balances, not balances as of the selected day.</p>
        <dl className="space-y-2">
          <div className="flex flex-wrap justify-between gap-2"><dt>Current ledger debt</dt><dd className="font-semibold">{formatCloseMinor(balances.ledgerMinor)}</dd></div>
          <div className="flex flex-wrap justify-between gap-2"><dt>Unverified legacy amount ({balances.unverifiedCount})</dt>
            <dd className="font-semibold text-warning-text-deep">{formatCloseMinor(balances.unverifiedMinor)}</dd></div>
          <div className="flex flex-wrap justify-between gap-2"><dt>Patients with unknown balances</dt>
            <dd className="font-semibold text-warning-text-deep">{balances.unknownCount}</dd></div>
        </dl>
      </ClosePanel>
      <ClosePanel title="Completed visits" state={sections.visits} onMore={() => report.loadMore('visits')} moreLabel="Load more completed visits">
        <p className="vc-note">Visits use the actual visit time. An unlinked or older treatment record may still exist.</p>
        {patientError && <p role="alert" className="text-sm text-danger-text">{patientError}</p>}
        {unmatched.length ? <ul className="space-y-2">
          {unmatched.map(visit => <li key={visit.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-2">
            <div className="min-w-0 break-words"><p className="font-semibold">{visit.patientName}</p>
              <p className="vc-note">{localTime(visit.occurredAtMs)}</p>
              <p className="text-sm font-semibold text-warning-text-deep">No linked treatment</p>
            </div>
            <button type="button" className="vc-btn vc-btn-sm" disabled={opening} onClick={() => void openPatient(visit.patientId)}>Open patient {visit.patientName}</button>
          </li>)}
        </ul> : <p className="vc-note">{sections.visits.rows.length ? 'All completed visits have linked treatment.' : 'No completed visits this day.'}</p>}
      </ClosePanel>
    </div>}
  </div>;
}
