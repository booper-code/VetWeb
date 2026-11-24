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
type ServerInventoryPage = { records: InventoryItem[]; hasMore: boolean; cursor?: ClinicCursor };

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
  const listenerSize = useRef(0);
  const inventoryError = useRef('');
  const inventoryRetrySource = useRef<'listener' | 'page' | null>(null);
  const inventoryPageRetryAdvance = useRef(false);
  const confirmationVersion = useRef(0);

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
    listenerSize.current = size;
    const version = generation.current;
    const token = listenerVersion.current;
    const target: InventoryListener = { unsubscribe: null, released: false };
    listener.current = target;
    const isCurrent = () => generation.current === version && listenerVersion.current === token
      && listener.current === target && !target.released;
    const accept = (page: ServerInventoryPage) => {
      if (!isCurrent()) return;
      confirmationVersion.current += 1;
      // Confirmed rows replace the cached first page so remote edits and
      // deletions render. Keep the page cursor aligned with that prefix: after
      // a remote insert/delete the old getDocs tail may no longer be on screen.
      if (page.cursor !== undefined) cursors.current.inventory = page.cursor;
      inventoryError.current = '';
      setInventory(page.records);
      setState(previous => ({ ...previous, inventory: { ...previous.inventory,
        busy: false, loaded: true, hasMore: page.hasMore, error: '' } }));
    };
    const fail = (error: Error) => {
      if (!isCurrent()) return;
      const message = error.message || 'Could not keep inventory in sync.';
      inventoryError.current = message;
      inventoryRetrySource.current = 'listener';
      inventoryPageRetryAdvance.current = false;
      stopInventoryListener();
      setState(previous => ({ ...previous, inventory: { ...previous.inventory,
        busy: false, error: message } }));
    };
    // A Firebase identity mismatch or rules denial clears the whole inventory
    // view. Bumping generation also invalidates direct reads started earlier.
    const deny = () => {
      if (!isCurrent()) return;
      generation.current += 1;
      inventoryError.current = '';
      inventoryRetrySource.current = null;
      inventoryPageRetryAdvance.current = false;
      stopInventoryListener();
      cursors.current.inventory = null;
      loadedPages.current.inventory = 0;
      listenerSize.current = 0;
      setInventory([]);
      setState(previous => ({ ...previous, inventory: {
        ...empty(), hasMore: false, error: 'Inventory access changed. Reload the workspace.'
      } }));
    };
    void subscribeClinicInventory(clinic, size, accept, fail, uid ?? '', deny).then(unsubscribe => {
      if (target.released) unsubscribe();
      else target.unsubscribe = unsubscribe;
    }).catch(fail);
  }, [stopInventoryListener, setInventory, uid]);

  const load = useCallback(async (kind: ClinicPageKind, reset = false) => {
    if (!authenticated || !clinicId || clinicId === 'demo-clinic' || inFlight.current.has(kind)) return;
    // PageControls uses the same onLoad for Retry and Load more. Remember what
    // failed: a listener retry restarts at the same size, while a page-read
    // retry repeats its intended read (which may be the next page).
    const retrySource = kind === 'inventory' && inventoryError.current ? inventoryRetrySource.current : null;
    if (retrySource) {
      inventoryError.current = '';
      inventoryRetrySource.current = null;
    }
    const version = generation.current;
    const confirmedAtStart = confirmationVersion.current;
    inFlight.current.add(kind);
    setState(previous => ({ ...previous, [kind]: { ...previous[kind], busy: true, error: '' } }));
    try {
      const page = await loadClinicPage(clinicId, kind, reset ? null : cursors.current[kind] ?? null);
      if (generation.current !== version) return;
      if (kind.endsWith('Patients')) {
        cursors.current[kind] = page.cursor;
        setPatients(previous => appendUnique(previous, page.records as PatientRecord[], record => record.id));
      } else if (kind === 'inventory') {
        // An empty read leaves the last confirmed cursor in place; a stale
        // boundary must not rewind the next page to the beginning of the list.
        if (reset || page.records.length > 0) cursors.current[kind] = page.cursor;
        setInventory(previous => appendUnique(previous, page.records as InventoryItem[], record => record.itemCode));
        const pages = loadedPages.current[kind] ?? 0;
        if (reset) {
          loadedPages.current[kind] = 1;
          startInventoryListener(clinicId, CLINIC_PAGE_SIZE);
        } else if (retrySource === 'listener') {
          loadedPages.current[kind] = Math.max(pages, 1);
          startInventoryListener(clinicId, listenerSize.current || CLINIC_PAGE_SIZE * loadedPages.current[kind]!);
        } else if (retrySource === 'page') {
          loadedPages.current[kind] = inventoryPageRetryAdvance.current ? pages + 1 : Math.max(pages, 1);
          inventoryPageRetryAdvance.current = false;
          startInventoryListener(clinicId, CLINIC_PAGE_SIZE * loadedPages.current[kind]!);
        } else if (page.records.length > 0 || page.hasMore) {
          // Only an explicit Load more (with rows or a stale boundary) widens
          // the watched prefix.
          loadedPages.current[kind] = pages + 1;
          startInventoryListener(clinicId, CLINIC_PAGE_SIZE * loadedPages.current[kind]!);
        } else if (!listener.current) {
          loadedPages.current[kind] = Math.max(pages, 1);
          startInventoryListener(clinicId, listenerSize.current || CLINIC_PAGE_SIZE * loadedPages.current[kind]!);
        }
      } else {
        cursors.current[kind] = page.cursor;
        setConsultations(previous => appendUnique(previous, page.records as Consultation[], record => record.id));
      }
      setState(previous => ({ ...previous, [kind]: { busy: false, loaded: true,
        // A newer server confirmation owns hasMore; an older page read must not
        // restore a stale Load more state.
        hasMore: confirmationVersion.current === confirmedAtStart ? page.hasMore : previous[kind].hasMore,
        error: '' } }));
    } catch {
      if (generation.current !== version) return;
      if (kind === 'inventory') {
        inventoryError.current = 'Could not load this page. Check your connection and retry.';
        if (retrySource === 'listener') {
          inventoryRetrySource.current = 'listener';
        } else {
          inventoryRetrySource.current = 'page';
          // Preserve the original intent across repeated page-read failures.
          if (retrySource !== 'page') inventoryPageRetryAdvance.current = !reset;
        }
      }
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
    listenerSize.current = 0;
    inventoryError.current = '';
    inventoryRetrySource.current = null;
    inventoryPageRetryAdvance.current = false;
    confirmationVersion.current = 0;
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
