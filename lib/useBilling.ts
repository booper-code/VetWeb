'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BillingCommit, BillingCursor, BillingEntry, BillingOperation, BillingPage, PaymentReceipt } from '@/lib/billing';
import type { BillingReconciliation } from '@/lib/billing-reconciliation';

export type BillingGateway = {
  submit(operationId: string, draft: BillingOperation['draft'], patientId: string, expectedPatientRevision: number): Promise<BillingCommit>;
  pending(patientId: string): BillingOperation | null;
  history(patientId: string, after?: BillingCursor): Promise<BillingPage>;
  reconcile(patientId: string): Promise<BillingReconciliation>;
  receipt(patientId: string, entryId: string): Promise<PaymentReceipt>;
  refreshRecords(patientId: string, itemCodes: string[]): Promise<void>;
};

export function useBilling(patientId: string, gateway: BillingGateway, enabled: boolean) {
  const [entries, setEntries] = useState<BillingEntry[]>([]);
  const [next, setNext] = useState<BillingCursor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<BillingOperation | null>(null);
  const request = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async (after?: BillingCursor) => {
    const id = ++request.current;
    if (!enabled) return;
    setBusy(true);
    setError('');
    try {
      if (!after) setPending(gateway.pending(patientId));
      const page = await gateway.history(patientId, after);
      if (request.current !== id) return;
      setEntries(previous => after
        ? [...previous, ...page.entries.filter(item => !previous.some(row => row.id === item.id))]
        : page.entries);
      setNext(page.next);
    } catch {
      if (request.current === id) setError('Could not load the billing history. Refresh before checking a payment.');
    } finally {
      if (request.current === id) setBusy(false);
    }
  }, [enabled, gateway, patientId]);

  useEffect(() => {
    let active = true;
    if (enabled) void Promise.resolve().then(() => { if (active) return load(); });
    return () => { active = false; request.current += 1; };
  }, [enabled, load]);

  return {
    entries: enabled ? entries : [],
    pending: enabled ? pending : null, busy: enabled && busy, error: enabled ? error : '', hasMore: enabled && next !== null,
    refresh: async (itemCodes: string[] = []) => {
      await gateway.refreshRecords(patientId, itemCodes);
      if (mounted.current) await load();
    },
    loadMore: async () => { if (!busy && next) await load(next); },
    reconcile: () => gateway.reconcile(patientId),
    receipt: (entryId: string) => gateway.receipt(patientId, entryId),
    submit: async (operation: Pick<BillingOperation, 'operationId' | 'draft' | 'expectedPatientRevision'>) => {
      const { operationId, draft, expectedPatientRevision } = operation;
      try {
        const result = await gateway.submit(operationId, draft, patientId, expectedPatientRevision);
        request.current += 1;
        if (mounted.current) void load();
        return result;
      } finally {
        if (mounted.current) {
          try { setPending(gateway.pending(patientId)); } catch { /* The clinic closed while the operation was pending. */ }
        }
      }
    },
  };
}

export type BillingSession = ReturnType<typeof useBilling>;
