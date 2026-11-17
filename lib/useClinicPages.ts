"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PatientRecord, InventoryItem, Consultation } from '@/types';
import { appendUnique, loadClinicPage } from '@/lib/clinic-pages';
import type { ClinicCursor, ClinicPageKind } from '@/lib/clinic-pages';

export type PageStatus = { busy: boolean; hasMore: boolean; loaded: boolean; error: string };
const empty = (): PageStatus => ({ busy: false, hasMore: true, loaded: false, error: '' });
const initial = () => ({
  activePatients: empty(), dischargedPatients: empty(), inventory: empty(), consultations: empty()
});

export function useClinicPages({
  clinicId, authenticated, setPatients, setInventory, setConsultations
}: {
  clinicId: string | null; authenticated: boolean;
  setPatients: Dispatch<SetStateAction<PatientRecord[]>>;
  setInventory: Dispatch<SetStateAction<InventoryItem[]>>;
  setConsultations: Dispatch<SetStateAction<Consultation[]>>;
}) {
  const [state, setState] = useState(initial);
  const generation = useRef(0);
  const cursors = useRef<Partial<Record<ClinicPageKind, ClinicCursor>>>({});
  const inFlight = useRef(new Set<ClinicPageKind>());
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
  }, [authenticated, clinicId, setPatients, setInventory, setConsultations]);

  useEffect(() => {
    generation.current += 1;
    cursors.current = {};
    inFlight.current = new Set();
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
    return () => { active = false; generation.current += 1; };
  }, [authenticated, clinicId, load, setPatients, setInventory, setConsultations]);
  return { state, load };
}
