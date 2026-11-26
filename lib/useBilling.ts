'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { BillingCommit, BillingCursor, BillingEntry, BillingOperation, BillingPage, PaymentReceipt } from '@/lib/billing';
import type { BillingReconciliation } from '@/lib/billing-reconciliation';
import type { PatientRecord } from '@/types';

export type BillingGateway = {
  submit(operationId: string, draft: BillingOperation['draft'], patientId: string, expectedPatientRevision: number, patient?: PatientRecord): Promise<BillingCommit>;
  pending(patientId: string): BillingOperation | null;
  history(patientId: string, after?: BillingCursor): Promise<BillingPage>;
  reconcile(patientId: string): Promise<BillingReconciliation>;
  receipt(patientId: string, entryId: string): Promise<PaymentReceipt>;
  refreshRecords(patientId: string, itemCodes: string[]): Promise<void>;
};

export function useBilling(patientId: string, gateway: BillingGateway, enabled: boolean, postedSequence = 0, patient?: PatientRecord) {
  const [entries, setEntries] = useState<BillingEntry[]>([]);
  const [next, setNext] = useState<BillingCursor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<BillingOperation | null>(null);
  const request = useRef(0);
  const depth = useRef(1);
  const loadedDepth = useRef(1);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async (after?: BillingCursor) => {
    const id = ++request.current;
    if (!enabled) return;
    const requestedDepth = after ? loadedDepth.current + 1 : depth.current;
    if (after) depth.current = Math.max(depth.current, requestedDepth);
    setBusy(true);
    setError('');
    try {
      if (!after) setPending(gateway.pending(patientId));
      const page = await gateway.history(patientId, after);
      if (request.current !== id) return;
      const incoming = [...page.entries];
      let nextCursor = page.next;
      let pagesRead = after ? requestedDepth : 1;
      if (!after) {
        for (; pagesRead < requestedDepth && nextCursor !== null; pagesRead++) {
          const tail = await gateway.history(patientId, nextCursor);
          if (request.current !== id) return;
          incoming.push(...tail.entries);
          nextCursor = tail.next;
        }
      }
      loadedDepth.current = pagesRead;
      setEntries(previous => after
        ? [...previous, ...incoming.filter(item => !previous.some(row => row.id === item.id))]
        : incoming);
      setNext(nextCursor);
    } catch {
      if (request.current === id) setError('Could not load the billing history. Refresh before checking a payment.');
    } finally {
      if (request.current === id) setBusy(false);
    }
  }, [enabled, gateway, patientId]);

  const reloadPostedHistory = useEffectEvent(() => { void load(); });
  useEffect(() => { depth.current = 1; loadedDepth.current = 1; }, [patientId]);
  useEffect(() => {
    let active = true;
    if (enabled) void Promise.resolve().then(() => { if (active) reloadPostedHistory(); });
    return () => { active = false; request.current += 1; };
  }, [enabled, patientId, postedSequence]);

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
        const result = await gateway.submit(operationId, draft, patientId, expectedPatientRevision, patient);
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
