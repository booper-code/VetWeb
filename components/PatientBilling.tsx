'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { InventoryItem, PatientRecord } from '@/types';
import type { BillingEntry, BillingOperation } from '@/lib/billing';
import {
  BILLING_TIME_ZONE, PAYMENT_METHODS, billingLocalTime, formatBillingAmount, parseBillingDay, parseBillingLocalTime, parsePhpMinor,
  calculateBillingTransition, readLegacyBalance, type BillingDraft, type PaymentMethod, type ResolvedBillingDraft,
} from '@/lib/billing-values';
import { exportPaymentReceiptPdf } from '@/lib/pdf';
import { useBilling, type BillingGateway, type BillingSession } from '@/lib/useBilling';
import { BILLING_RECONCILIATION_LIMIT, billingLedgerKey, type BillingReconciliation } from '@/lib/billing-reconciliation';

const methods: Record<PaymentMethod, string> = { cash: 'Cash', 'e-wallet': 'E-wallet', 'bank-transfer': 'Bank transfer', card: 'Card', other: 'Other' };
const control = 'vc-input w-full';
const button = 'rounded-lg border border-field-outline bg-panel-subtle px-3 py-2 text-sm font-semibold text-content-title disabled:opacity-50';
const primary = 'rounded-lg bg-teal-700 px-3 py-2 text-sm font-bold text-white hover:bg-teal-800 disabled:opacity-50';
const labels = { opening: 'Verify opening balance', 'opening-correction': 'Correct opening balance', payment: 'Record payment',
  'unitemized-settlement': 'Mark paid in full', charge: 'Add charges', reversal: 'Reverse entry' };
const settlementWarning = 'Installment dates and methods won’t be recorded. This won’t be counted in daily collections.';
const settlementLabel = 'Paid in full — installments not itemized';
type Mode = keyof typeof labels;
type Reviewed = Pick<BillingOperation, 'operationId' | 'draft' | 'expectedPatientRevision'> & {
  beforeMinor: number | null; afterMinor: number; openingCutoff?: number;
};
const amountOrUnknown = (minor: number | null) => minor === null ? 'Unknown amount' : formatBillingAmount(minor);
const reviewedStock = (draft: BillingDraft) => draft.kind === 'charge' ? draft.lines.map(line => line.itemCode)
  : draft.kind === 'reversal' ? Object.keys(draft.expectedStockRevisions) : [];

function BillingReconciliationControl({ check, disabled }: { check: BillingSession['reconcile']; disabled: boolean }) {
  const [result, setResult] = useState<BillingReconciliation | 'error' | null>(null);
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  const run = async () => {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setChecking(true);
    setResult(null);
    try { setResult(await check()); }
    catch { setResult('error'); }
    finally { inFlight.current = false; setChecking(false); }
  };
  const status = result && result !== 'error' ? result.status : result;
  const problem = status === 'balance-mismatch' || status === 'history-mismatch' || status === 'error';
  const message = !result ? '' : result === 'error' ? 'Could not verify the ledger. Try again online.'
    : result.status === 'match' ? `The ledger matches the stored balance at the time of this check: ${formatBillingAmount(result.balanceMinor)} (${result.count} posted ${result.count === 1 ? 'entry' : 'entries'}).`
      : result.status === 'balance-mismatch' ? `Balance mismatch: stored ${formatBillingAmount(result.storedMinor)}; ledger totals ${formatBillingAmount(result.computedMinor)}. Review the source records.`
        : result.status === 'history-mismatch' ? 'The ledger history does not reconcile. An entry, sequence, or opening balance is inconsistent; review the posted history.'
          : result.status === 'changed' ? 'The balance changed during the check. Try again.'
            : result.status === 'limit' ? `Not verified: this check covers up to ${BILLING_RECONCILIATION_LIMIT} posted entries per patient.`
              : 'No verified ledger is available for this patient.';
  return <div className="space-y-1">
    <button type="button" className={button} disabled={disabled || checking} onClick={() => void run()}>Check ledger balance</button>
    {checking && <p role="status" className="text-sm text-content-hint">Checking posted entries…</p>}
    {message && <p role={problem ? 'alert' : 'status'} className={problem ? 'text-sm text-danger-text' : 'text-sm text-content-hint'}>{message} No records were changed.</p>}
  </div>;
}

export function WorkspacePatientBilling({ patient, inventory, canEdit, gateway }: {
  patient: PatientRecord; inventory: InventoryItem[]; canEdit: boolean; gateway: BillingGateway;
}) {
  const billing = useBilling(patient.id, gateway, canEdit, patient.billing?.seq, patient);
  return <PatientBilling patient={patient} inventory={inventory} canEdit={canEdit} billing={billing} />;
}

export function PatientBilling({ patient, inventory, canEdit, billing }: {
  patient: PatientRecord; inventory: InventoryItem[]; canEdit: boolean; billing: BillingSession;
}) {
  const heading = useId();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [matches, setMatches] = useState(true);
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<BillingEntry | null>(null);
  const [returnStock, setReturnStock] = useState<boolean | null>(null);
  const [review, setReview] = useState<Reviewed | null>(null);
  const [settlement, setSettlement] = useState<{ amountMinor: number; revision: number } | null>(null);
  const [settlementToday, setSettlementToday] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState<string[] | null>(null);
  const rawBalance = patient.legacyBillingBalance === undefined ? patient.balance : patient.legacyBillingBalance;
  const legacy = readLegacyBalance(rawBalance);
  const balance = patient.billing?.balanceMinor ?? (legacy.kind === 'valid' ? legacy.minor : null);
  const settlementBalance = settlement ?? { amountMinor: patient.billing?.balanceMinor ?? 0, revision: patient.revision ?? 0 };
  const needsOpening = !patient.billing && (legacy.kind === 'invalid' || legacy.minor !== 0);
  const reversed = new Set(billing.entries.flatMap(entry => entry.kind === 'reversal' ? [entry.originalEntryId] : []));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!mode || !dialog.current) return;
    const element = dialog.current;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    element.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => { if (element.open && typeof element.close === 'function') element.close(); };
  }, [mode]);

  const start = (action: Mode, button: HTMLElement, entry?: BillingEntry) => {
    opener.current = button;
    setMode(action); setMatches(legacy.kind === 'valid'); setAmount(''); setSource(''); setReason(''); setError('');
    const now = billingLocalTime(Date.now());
    setDate(action === 'payment' ? now : action === 'unitemized-settlement' ? now.slice(0, 10) : '');
    setSettlementToday(now.slice(0, 10));
    setSettlement(action === 'unitemized-settlement'
      ? { amountMinor: patient.billing?.balanceMinor ?? 0, revision: patient.revision ?? 0 } : null);
    setMethod('cash'); setReference(''); setNote(''); setSearch(''); setSelected({});
    setReview(null); setRetrying(false); setReturnStock(null); setTarget(entry ?? null); setRefreshRequired(null);
  };
  const dismiss = () => {
    if (inFlight.current) return;
    if (dialog.current?.open && typeof dialog.current.close === 'function') dialog.current.close();
    setMode(null); setReview(null); setRetrying(false);
    setError('');
    opener.current?.focus();
  };
  const prepare = () => {
    if (!mode || !canEdit || review || refreshRequired) return;
    try {
      let draft: BillingDraft;
      let resolved: ResolvedBillingDraft;
      let cutoff: number | undefined;
      if (mode === 'opening' || mode === 'opening-correction') {
        cutoff = mode === 'opening' ? parseBillingLocalTime(date) : patient.billing?.cutoffMs;
        const verifiedMinor = mode === 'opening' && matches && legacy.kind === 'valid' ? legacy.minor : parsePhpMinor(amount);
        draft = mode === 'opening'
          ? { kind: 'opening', verifiedMinor, source, cutoffMs: cutoff!, ...(matches ? {} : { reason }) }
          : { kind: 'opening-correction', verifiedMinor, source, reason };
        resolved = draft;
      } else if (mode === 'payment') {
        draft = resolved = { kind: 'payment', amountMinor: parsePhpMinor(amount), method, occurredAtMs: parseBillingLocalTime(date), reference, note };
      } else if (mode === 'charge') {
        const lines = Object.entries(selected).map(([itemCode, qty]) => {
          const item = inventory.find(row => row.itemCode === itemCode);
          const price = readLegacyBalance(item?.sellingPrice);
          if (!item || price.kind !== 'valid') throw new Error('Reload the catalog before charging this item.');
          return { itemCode, quantity: Number(qty), unitPriceMinor: price.minor, expectedRevision: item.revision ?? 0, itemName: item.itemName, category: item.category, stock: item.stock };
        });
        draft = { kind: 'charge', lines: lines.map(({ itemCode, quantity, unitPriceMinor, expectedRevision }) => ({ itemCode, quantity, unitPriceMinor, expectedRevision })) };
        resolved = { kind: 'charge', lines };
      } else {
         if (!target || (target.kind !== 'charge' && target.kind !== 'payment' && target.kind !== 'unitemized-settlement')) {
           throw new Error('Choose a reversible billing entry.');
         }
        if (target.stockMoves.length && returnStock === null) throw new Error('Confirm whether the stock was physically returned.');
        const expectedStockRevisions: Record<string, number> = {};
        if (returnStock) for (const move of target.stockMoves) {
          const item = inventory.find(row => row.itemCode === move.itemCode);
          if (!item) throw new Error('Load the returned item in Inventory before reversing this charge.');
          expectedStockRevisions[move.itemCode] = item.revision ?? 0;
        }
        draft = { kind: 'reversal', originalEntryId: target.id, reason, returnStock: returnStock === true, expectedStockRevisions };
        resolved = { ...draft, original: target };
      }
      const transition = calculateBillingTransition(patient.billing ?? null, rawBalance, resolved, Date.now());
      setReview({
        draft, operationId: draft.kind === 'reversal' ? `reverse_${draft.originalEntryId}` : crypto.randomUUID(),
        expectedPatientRevision: patient.revision ?? 0,
        beforeMinor: mode === 'opening-correction' ? patient.billing?.openingMinor ?? null : balance,
        afterMinor: mode === 'opening-correction' ? transition.next.openingMinor : transition.next.balanceMinor, openingCutoff: cutoff,
      });
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Review the billing details.'); }
  };
  const reloadReviewed = async (itemCodes: string[]) => {
    try {
      await billing.refresh(itemCodes);
      if (mounted.current) {
        setRefreshRequired(null);
        setError('The records changed and were refreshed. Review the new amounts before confirming.');
      }
    } catch {
      if (mounted.current) {
        setRefreshRequired(itemCodes);
        setError('Could not refresh the changed records. Reload them before reviewing again.');
      }
    }
  };
  const confirm = async (candidate = review) => {
    if (!canEdit || !candidate || inFlight.current) return;
    if (!retrying && candidate.expectedPatientRevision !== (patient.revision ?? 0)) {
      const itemCodes = reviewedStock(candidate.draft);
      setSettlement(null);
      setReview(null); setRefreshRequired(itemCodes);
      await reloadReviewed(itemCodes);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      const { draft, operationId, expectedPatientRevision } = candidate;
      await billing.submit({ draft, operationId, expectedPatientRevision });
      inFlight.current = false;
      if (mounted.current) {
        setMode(null); setReview(null); setRetrying(false);
        if (dialog.current?.open && typeof dialog.current.close === 'function') dialog.current.close();
        if (draft.kind === 'unitemized-settlement') document.getElementById(heading)?.focus();
        else opener.current?.focus();
      }
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof Error && e.name === 'ClinicalConflictError') {
        setReview(null); setRetrying(false);
        setSettlement(null);
        const itemCodes = reviewedStock(candidate.draft);
        setRefreshRequired(itemCodes);
        await reloadReviewed(itemCodes);
      } else {
        setRetrying(true);
        setError(`${e instanceof Error ? e.message : 'The save was not confirmed.'} Retry the same review to avoid a duplicate.`);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const submitSettlement = () => {
    if (!canEdit || refreshRequired || inFlight.current) return;
    try {
      const draft = { kind: 'unitemized-settlement' as const, amountMinor: settlementBalance.amountMinor, businessDayMs: parseBillingDay(date) };
      if (settlementBalance.revision === (patient.revision ?? 0)) {
        calculateBillingTransition(patient.billing ?? null, rawBalance, draft, Date.now());
      }
      const candidate = { draft, operationId: crypto.randomUUID(), expectedPatientRevision: settlementBalance.revision,
        beforeMinor: draft.amountMinor, afterMinor: 0 };
      setReview(candidate);
      void confirm(candidate);
    } catch (e) { setError(e instanceof Error ? e.message : 'Check the settlement date.'); }
  };
  const resume = async () => {
    if (!billing.pending || inFlight.current) return;
    inFlight.current = true; setSaving(true); setError('');
    const operation = billing.pending;
    try {
      await billing.submit(operation);
    } catch (e) {
      if (e instanceof Error && e.name === 'ClinicalConflictError') await reloadReviewed(reviewedStock(operation.draft));
      else if (mounted.current) setError('The outcome is still unconfirmed. Retry this same save before entering another.');
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const print = async (entryId: string) => {
    if (printing) return;
    setPrinting(true);
    setError('');
    try {
      const receipt = await billing.receipt(entryId);
      if (mounted.current) await exportPaymentReceiptPdf(receipt);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not open the saved receipt.');
    } finally { if (mounted.current) setPrinting(false); }
  };

  return <section aria-labelledby={heading} className="bg-panel rounded-2xl p-4 sm:p-6 border border-outline-soft shadow-sm space-y-4 min-w-0">
    <div className="flex flex-wrap justify-between gap-3">
      <div><h4 id={heading} tabIndex={-1} className="font-bold text-content-heading">Patient billing</h4>
        <p className="text-sm text-content-hint">{needsOpening ? 'Legacy balance — not verified' : 'Outstanding balance'}</p></div>
      <strong className="text-xl text-content-title">{amountOrUnknown(balance)}</strong>
    </div>
    {canEdit && billing.pending && <div className="bg-panel-subtle rounded-xl border border-outline-soft p-3 space-y-2">
      <p className="font-bold">Unconfirmed billing save</p>
      <p className="text-sm">Retry the save that was already reviewed. New entries are blocked until it is resolved.</p>
      {billing.pending.draft.kind === 'payment' && <p className="text-sm">{formatBillingAmount(billing.pending.draft.amountMinor)} · {methods[billing.pending.draft.method]} · {billingLocalTime(billing.pending.draft.occurredAtMs).replace('T', ' ')} Manila</p>}
      {billing.pending.draft.kind === 'unitemized-settlement' && <p className="text-sm">{settlementLabel} · {formatBillingAmount(billing.pending.draft.amountMinor)} · {billingLocalTime(billing.pending.draft.businessDayMs).slice(0, 10)} Manila</p>}
      <button type="button" className={primary} disabled={saving} onClick={() => void resume()}>Retry unconfirmed save</button>
    </div>}
    {canEdit && !billing.pending && <div className="flex flex-wrap gap-2">
      {needsOpening ? <button type="button" className={primary} onClick={e => start('opening', e.currentTarget)}>Verify opening balance</button>
        : <>
          <button type="button" className={primary} disabled={!patient.billing || !balance} onClick={e => start('payment', e.currentTarget)}>Record payment</button>
          {!!patient.billing && patient.billing.balanceMinor > 0 && <button type="button" className={button}
            onClick={e => start('unitemized-settlement', e.currentTarget)}>{labels['unitemized-settlement']}</button>}
          <button type="button" className={button} onClick={e => start('charge', e.currentTarget)}>Add charges</button>
          {patient.billing?.cutoffKind === 'reviewed' && <button type="button" className={button} onClick={e => start('opening-correction', e.currentTarget)}>Correct opening balance</button>}
        </>}
    </div>}
    {canEdit && <div>
      <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-bold text-content-heading">Billing history</h5>
        <button type="button" className={button} disabled={billing.busy}
          onClick={() => void billing.refresh().catch(() => setError('Could not refresh the patient record. Try again online.'))}>Refresh billing</button></div>
      {patient.billing && <BillingReconciliationControl key={billingLedgerKey(patient.billing)} check={billing.reconcile} disabled={!!billing.pending || saving} />}
      {billing.error && <p role="alert" className="text-danger-text">{billing.error}</p>}
      {billing.busy && <p role="status" className="text-sm text-content-hint">Loading billing history…</p>}
      {!billing.entries.length && !billing.busy && !billing.error && <p className="text-sm text-content-hint">No new billing entries.</p>}
      <ul className="divide-y divide-hairline">
        {billing.entries.map(entry => <li key={entry.id} className="flex flex-wrap justify-between items-start py-2 gap-2 text-sm">
          <div className="min-w-0 break-words"><strong>{entry.kind === 'payment' ? 'Payment' : entry.kind === 'charge' ? 'Charge' : entry.kind === 'opening'
             ? 'Opening balance verified' : entry.kind === 'opening-correction' ? 'Opening correction'
               : entry.kind === 'unitemized-settlement' ? settlementLabel : 'Reversal'} · {formatBillingAmount(entry.amountMinor)}</strong>
            {reversed.has(entry.id) && <span> · Reversed</span>}
             {entry.kind === 'payment' && <p>{methods[entry.method]} · {billingLocalTime(entry.occurredAtMs).replace('T', ' ')} Manila</p>}
             {entry.kind === 'unitemized-settlement' && <p>Fully paid on {billingLocalTime(entry.businessDayMs).slice(0, 10)} Manila</p>}
            {entry.kind === 'charge' && <p>{entry.lines.map(line => `${line.quantity} × ${line.itemName}`).join(', ')}</p>}
            {'reason' in entry && entry.reason && <p>{entry.reason}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {entry.kind === 'payment' && <button type="button" className={button} disabled={printing} onClick={() => void print(entry.id)}>Print receipt</button>}
             {!billing.pending && (entry.kind === 'payment' || entry.kind === 'charge' || entry.kind === 'unitemized-settlement') && !reversed.has(entry.id)
              && <button type="button" className={button} onClick={e => start('reversal', e.currentTarget, entry)}>Reverse entry</button>}
          </div>
        </li>)}
      </ul>
      {billing.hasMore && <button type="button" className={button} disabled={billing.busy} onClick={() => void billing.loadMore()}>Load more billing entries</button>}
    </div>}
    {!mode && error && <p role="alert" className="text-danger-text">{error}</p>}
    {!!patient.billableItems?.length && <div className="border-t border-hairline pt-3"><h5 className="font-bold">Legacy charges (read-only)</h5>
      <ul className="text-sm text-content-hint">{patient.billableItems.map(item => <li key={item.id}>{item.itemName} · {item.date} · PHP {item.total.toFixed(2)}</li>)}</ul></div>}
    {mode && <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss(); }}
      className="m-auto bg-panel text-content-title border border-outline-soft rounded-2xl shadow-xl w-[92vw] max-w-xl max-h-[90dvh] overflow-auto p-4 sm:p-6 backdrop:bg-black/60">
      <p className="text-xs font-bold uppercase text-content-hint">Patient billing · {patient.name}</p>
      <h5 id={titleId} className="text-xl font-bold text-content-heading my-2">{labels[mode]}</h5>
      <form className="space-y-3" noValidate onSubmit={event => {
        event.preventDefault();
        if (review) void confirm();
        else if (mode === 'unitemized-settlement') submitSettlement();
        else prepare();
      }}>
        {!review && (mode === 'opening' || mode === 'opening-correction') && <>
          <p>Balance currently in VetCloudPro: <strong>{amountOrUnknown(mode === 'opening-correction' ? patient.billing?.openingMinor ?? null : balance)}</strong></p>
          {mode === 'opening' && legacy.kind === 'valid' && <div className="flex flex-wrap gap-2">
            <button type="button" className={button} aria-pressed={matches} onClick={() => setMatches(true)}>Yes, it matches</button>
            <button type="button" className={button} aria-pressed={!matches} onClick={() => setMatches(false)}>No, it differs</button>
          </div>}
          {(!matches || mode === 'opening-correction') && <label className="block">Verified amount<input inputMode="decimal" className={control} value={amount} onChange={e => setAmount(e.target.value)} /></label>}
          <label className="block">Checked against<select className={control} value={source} onChange={e => setSource(e.target.value)}>
            <option value="">Select a clinic record</option><option>Paper ledger</option><option>Prior clinic export</option><option>Other clinic record</option>
          </select></label>
          {mode === 'opening' && <label className="block">Balance as of (Asia/Manila)<input type="datetime-local" className={control} value={date} onChange={e => setDate(e.target.value)} /></label>}
          {(!matches || mode === 'opening-correction') && <label className="block">Reason for correction<textarea className={control} value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label>}
          <p className="text-sm text-content-hint">This verifies the starting balance. It does not record a payment or change stock.</p>
        </>}
        {!review && mode === 'payment' && <>
          <p className="text-sm text-content-hint">Record money already received. This does not collect a payment.</p>
          <label className="block">Amount received (PHP)<input inputMode="decimal" className={control} value={amount} onChange={e => setAmount(e.target.value)} /></label>
          <label className="block">Payment method<select className={control} value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map(value => <option key={value} value={value}>{methods[value]}</option>)}
          </select></label>
          <label className="block">Received at (Asia/Manila)<input type="datetime-local" className={control} value={date} onChange={e => setDate(e.target.value)} /></label>
          <label className="block">Reference (optional)<input className={control} maxLength={120} value={reference} onChange={e => setReference(e.target.value)} /></label>
          <label className="block">Note (optional)<textarea className={control} maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></label>
        </>}
        {!review && mode === 'unitemized-settlement' && <>
          <p>Clear the outstanding balance of <strong>{formatBillingAmount(settlementBalance.amountMinor)}</strong> only if it was fully paid and that payment isn’t already reflected in this balance.</p>
          <label className="block">Fully paid on (Asia/Manila)<input type="date" className={control} value={date}
            max={settlementToday} onChange={e => setDate(e.target.value)} /></label>
          <p className="text-sm text-content-hint">{settlementWarning}</p>
        </>}
        {!review && mode === 'charge' && <>
          <p className="text-sm text-content-hint">Select up to two catalog lines. Medicine or supplies are newly dispensed with this charge. Do not select stock already dispensed on a treatment record.</p>
          <label className="block">Find loaded catalog items<input className={control} value={search} onChange={e => setSearch(e.target.value)} /></label>
          <fieldset className="max-h-52 overflow-auto"><legend>Select charge lines</legend>
            {inventory.filter(item => (item.itemName + ' ' + item.itemCode).toLowerCase().includes(search.toLowerCase())).map(item =>
              <div key={item.itemCode} className="flex flex-wrap gap-2 items-center py-1">
                <label className="flex gap-2 items-center"><input type="checkbox" checked={item.itemCode in selected}
                  disabled={!(item.itemCode in selected) && Object.keys(selected).length >= 2}
                  onChange={e => { const next = { ...selected }; if (e.target.checked) next[item.itemCode] = '1'; else delete next[item.itemCode]; setSelected(next); }} />
                  {item.itemName} · PHP {item.sellingPrice.toFixed(2)}</label>
                {item.itemCode in selected && <label>Qty <input type="number" min={1} className="vc-input w-20" value={selected[item.itemCode]}
                  onChange={e => setSelected({ ...selected, [item.itemCode]: e.target.value })} /></label>}
              </div>)}
          </fieldset>
        </>}
        {!review && mode === 'reversal' && target && <>
          {target.kind === 'unitemized-settlement'
            ? <p>Reverse the paid-in-full entry and restore the outstanding balance by {formatBillingAmount(target.amountMinor)}. This does not issue a refund.</p>
            : <p>Reverse {target.kind === 'payment' ? 'payment' : 'charge'} of {formatBillingAmount(target.amountMinor)}. This does not issue a refund.</p>}
          <label className="block">Reason for reversal<textarea className={control} value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label>
          {!!target.stockMoves.length && <label className="block">Was all stock physically returned?<select className={control} value={returnStock === null ? '' : String(returnStock)}
            onChange={e => setReturnStock(e.target.value === '' ? null : e.target.value === 'true')}>
            <option value="">Choose one</option><option value="true">Yes, restore the original stock</option><option value="false">No, only reverse the charge</option>
          </select></label>}
        </>}
        {review && <div className="bg-panel-subtle rounded-xl border border-hairline p-3 space-y-2">
          <p className="font-bold">What will change</p>
          <p>{amountOrUnknown(review.beforeMinor)} → {formatBillingAmount(review.afterMinor)}</p>
          {review.openingCutoff !== undefined && <p>Opening balance through {billingLocalTime(review.openingCutoff).replace('T', ' ')} {BILLING_TIME_ZONE}.</p>}
          {review.draft.kind === 'payment' && <p>{formatBillingAmount(review.draft.amountMinor)} · {methods[review.draft.method]} · {billingLocalTime(review.draft.occurredAtMs).replace('T', ' ')} {BILLING_TIME_ZONE}</p>}
          {review.draft.kind === 'unitemized-settlement' && <p>Fully paid on {billingLocalTime(review.draft.businessDayMs).slice(0, 10)} Manila. {settlementWarning}</p>}
          {review.draft.kind === 'charge' && <ul>{review.draft.lines.map(line => <li key={line.itemCode}>{line.quantity} × {inventory.find(item => item.itemCode === line.itemCode)?.itemName ?? line.itemCode}</li>)}</ul>}
          {review.draft.kind === 'reversal' && <p>{review.draft.returnStock ? 'Confirmed return: stock will be restored.' : 'Stock will not change.'}</p>}
          {(review.draft.kind === 'opening' || review.draft.kind === 'opening-correction') && <p>No payment or stock change is recorded.</p>}
        </div>}
        {error && <p role="alert" className="text-danger-text">{error}</p>}
        {refreshRequired && <button type="button" className={button} onClick={() => void reloadReviewed(refreshRequired)}>Reload reviewed records</button>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={button} disabled={saving} onClick={dismiss}>{retrying ? 'Close and check history' : 'Not now'}</button>
          {review && !retrying && <button type="button" className={button} disabled={saving} onClick={() => { setReview(null); setError(''); }}>Edit review</button>}
          <button type="submit" className={primary} disabled={saving || !canEdit || !!refreshRequired}>{saving ? 'Saving…' : retrying ? 'Retry same review'
            : mode === 'unitemized-settlement' ? 'Confirm paid in full' : !review
            ? 'Review update' : mode === 'payment' ? 'Confirm payment' : mode === 'opening' || mode === 'opening-correction'
              ? `Confirm ${formatBillingAmount(review.afterMinor)}` : mode === 'charge' ? 'Confirm charges' : 'Confirm reversal'}</button>
        </div>
      </form>
    </dialog>}
  </section>;
}
