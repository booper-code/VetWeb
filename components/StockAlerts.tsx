"use client";

import { useState } from 'react';
import type { InventoryItem } from '@/types';
import { manilaStockDay, stockAlertFor, type StockAlert } from '@/lib/stock-alert-values';
import { useClinicScan, type ClinicScanPage } from '@/lib/useClinicScan';

const reasonLabels: Record<StockAlert['reasons'][number], string> = {
  reorder: 'Reorder',
  expired: 'Expired',
  'expires-today': 'Expires today',
  'expiring-soon': 'Expiring soon',
};

export function StockAlerts({ online, isCurrent, load }: {
  online: boolean;
  isCurrent: () => boolean;
  load: (after: string | null) => Promise<ClinicScanPage<InventoryItem, string>>;
}) {
  const [day, setDay] = useState<string | null>(null);
  const canRead = () => online && isCurrent();
  const { state, start, next } = useClinicScan({ load, select: stockAlertFor, identify: item => item.itemCode, isCurrent: canRead });

  function refresh() {
    if (!canRead()) return;
    const today = manilaStockDay(new Date());
    setDay(today);
    start(today);
  }

  return (
    <section aria-label="Stock alerts" className="space-y-3 rounded-[14px] border border-line bg-panel p-4">
      <h3 className="font-bold text-ink">Stock alerts</h3>
      <p className="text-sm text-muted">
        Check the clinic catalog for items to reorder or expiring within 30 days. Stock without a recorded expiry date cannot be checked for expiry.
      </p>
      {!online ? <p role="status" className="text-sm text-muted">Offline: connect to check clinic-wide stock alerts.</p> : <>
        {state.phase !== 'idle' && <p role="status" className="text-sm text-muted">
          {state.checked} {state.checked === 1 ? 'item' : 'items'} checked as of {day} Manila.{' '}
          {state.phase === 'loading' && 'Checking stock…'}
          {state.phase === 'partial' && 'Partial results. More catalog items may remain.'}
          {state.phase === 'error' && 'Scan stopped before completion. Retry to continue.'}
          {state.phase === 'complete' && (state.matches.length ? 'Scan complete. Refresh after stock or expiry changes.' : 'No stock alerts found.')}
        </p>}
        {state.matches.length > 0 && <ul aria-label="Alerted inventory items" className="max-h-80 space-y-1 overflow-y-auto">
          {state.matches.map(item => <li key={item.itemCode} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-2">
            <div className="min-w-0 break-words">
              <p className="font-semibold text-ink">{item.itemName}</p>
              <p className="text-xs text-muted">{item.itemCode} · {item.stock} in stock{item.threshold > 0 ? ` · threshold ${item.threshold}` : ''}
                {item.expiryDate ? ` · expiry ${item.expiryDate}` : ''}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {item.reasons.map(reason => <span key={reason} className={`vc-badge ${reason === 'expired' || reason === 'reorder' ? 'vc-badge-red' : 'vc-badge-amber'}`}>
                {reasonLabels[reason]}
              </span>)}
            </div>
          </li>)}
        </ul>}
        <div className="flex flex-wrap gap-2">
          {state.phase === 'idle' && <button type="button" className="vc-btn vc-btn-primary" onClick={refresh}>Check stock alerts</button>}
          {state.phase === 'partial' && <button type="button" className="vc-btn vc-btn-primary" onClick={next}>Continue scan</button>}
          {state.phase === 'error' && <button type="button" className="vc-btn vc-btn-primary" onClick={next}>Retry scan</button>}
          {state.phase !== 'idle' && state.phase !== 'loading' && <button type="button" className="vc-btn" onClick={refresh}>Refresh alerts</button>}
        </div>
      </>}
    </section>
  );
}
