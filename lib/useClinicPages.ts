"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PatientRecord, InventoryItem, Consultation } from '@/types';
import { appendUnique, CLINIC_PAGE_SIZE, loadClinicPage, subscribeClinicInventory } from '@/lib/clinic-pages';
import type { ClinicCursor, ClinicPageKind } from '@/lib/clinic-pages';

export type PageStatus = { busy: boolean; hasMore: boolean; loaded: boolean; error: string };
const empty = (): PageStatus => ({ busy: false, hasMore: true, loaded: false, error: '' });
const initial = () => ({
  activePatients: empty(), dischargedPatients: empty(), inventory: empty(), consultations: empty()
});

type InventoryListener = { unsubscribe: (() => void) | null; released: boolean };
type ServerInventoryPage = { records: InventoryItem[]; hasMore: boolean };

export function useClinicPages({
  clinicId, uid, authenticated, setPatients, setInventory, setConsultations
}: {
  clinicId: string | null; uid: string | null; authenticated: boolean;
  setPatients: Dispatch<SetStateAction<PatientRecord[]>>;
  setInventory: Dispatch<SetStateAction<InventoryItem[]>>;
  setConsultations: Dispatch<SetStateAction<Consultation[]>>;
}) {
  const [state, setState] = useState(initial);
  const generation = useRef(0);
  const cursors = useRef<Partial<Record<ClinicPageKind, ClinicCursor>>>({});
  const inFlight = useRef(new Set<ClinicPageKind>());
  const loadedPages = useRef<Partial<Record<ClinicPageKind, number>>>({});
  const listener = useRef<InventoryListener | null>(null);
  const listenerVersion = useRef(0);

  const releaseListener = useCallback((target: InventoryListener) => {
    if (target.released) return;
    target.released = true;
    target.unsubscribe?.();
  }, []);

  // Replacing or stopping a listener invalidates its callbacks immediately; a
  // late unsubscribe (or a still-pending start) is still released below.
  const stopInventoryListener = useCallback(() => {
    const previous = listener.current;
    listener.current = null;
    listenerVersion.current += 1;
    if (previous) releaseListener(previous);
  }, [releaseListener]);

  const startInventoryListener = useCallback((clinic: string, size: number) => {
    stopInventoryListener();
    const version = generation.current;
    const token = listenerVersion.current;
    const target: InventoryListener = { unsubscribe: null, released: false };
    listener.current = target;
    const isCurrent = () => generation.current === version && listenerVersion.current === token
      && listener.current === target && !target.released;
    const accept = (page: ServerInventoryPage) => {
      if (!isCurrent()) return;
      // Confirmed rows replace the cached first page so remote edits and
      // deletions render. Rows outside the previous prefix are kept until the
      // widened listener reports its own first snapshot.
      setInventory(page.records);
      setState(previous => ({ ...previous, inventory: { ...previous.inventory,
        busy: false, loaded: true, hasMore: page.hasMore, error: '' } }));
    };
    const fail = (error: Error) => {
      if (!isCurrent()) return;
      stopInventoryListener();
      setState(previous => ({ ...previous, inventory: { ...previous.inventory,
        busy: false, error: error.message || 'Could not keep inventory in sync.' } }));
    };
    void subscribeClinicInventory(clinic, size, accept, fail).then(unsubscribe => {
      if (target.released) unsubscribe();
      else target.unsubscribe = unsubscribe;
    }).catch(fail);
  }, [stopInventoryListener, setInventory]);

  const load = useCallback(async (kind: ClinicPageKind, reset = false) => {
    if (!authenticated || !clinicId || clinicId === 'demo-clinic' || inFlight.current.has(kind)) return;
    const version = generation.current;
    inFlight.current.add(kind);
    setState(previous => ({ ...previous, [kind]: { ...previous[kind], busy: true, error: '' } }));
    try {
      const page = await loadClinicPage(clinicId, kind, reset ? null : cursors.current[kind] ?? null);
      if (generation.current !== version) return;
      cursors.current[kind] = page.cursor;
      if (kind.endsWith('Patients')) {
        setPatients(previous => appendUnique(previous, page.records as PatientRecord[], record => record.id));
      } else if (kind === 'inventory') {
        setInventory(previous => appendUnique(previous, page.records as InventoryItem[], record => record.itemCode));
        loadedPages.current[kind] = (reset ? 0 : loadedPages.current[kind] ?? 0) + 1;
        startInventoryListener(clinicId, CLINIC_PAGE_SIZE * loadedPages.current[kind]!);
      } else {
        setConsultations(previous => appendUnique(previous, page.records as Consultation[], record => record.id));
      }
      setState(previous => ({ ...previous, [kind]: { busy: false, loaded: true, hasMore: page.hasMore, error: '' } }));
    } catch {
      if (generation.current !== version) return;
      setState(previous => ({ ...previous, [kind]: {
        ...previous[kind], busy: false, error: 'Could not load this page. Check your connection and retry.'
      } }));
    } finally {
      if (generation.current === version) inFlight.current.delete(kind);
    }
  }, [authenticated, clinicId, setPatients, setInventory, setConsultations, startInventoryListener]);

  useEffect(() => {
    generation.current += 1;
    cursors.current = {};
    loadedPages.current = {};
    inFlight.current = new Set();
    stopInventoryListener();
    if (!authenticated || !clinicId || clinicId === 'demo-clinic') return;
    let active = true;
    // Reset and load within an asynchronous task; a completed old-clinic request
    // cannot populate the next clinic's state.
    void Promise.resolve().then(async () => {
      if (!active) return;
      setState(initial());
      setPatients([]); setInventory([]); setConsultations([]);
      await Promise.all([load('activePatients', true), load('inventory', true), load('consultations', true)]);
    });
    return () => { active = false; generation.current += 1; stopInventoryListener(); };
  }, [authenticated, clinicId, uid, load, setPatients, setInventory, setConsultations, stopInventoryListener]);
  return { state, load };
}
