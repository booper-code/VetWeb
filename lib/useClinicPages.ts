"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PatientRecord, InventoryItem, Consultation } from '@/types';
import { appendUnique, CLINIC_PAGE_SIZE, isClinicInventoryAccessDenied, loadClinicPage, subscribeClinicConsultations, subscribeClinicInventory, subscribePatientDirectory } from '@/lib/clinic-pages';
import type { ClinicCursor, ClinicPageKind, PatientDirectoryKind } from '@/lib/clinic-pages';

export type PageStatus = { busy: boolean; hasMore: boolean; loaded: boolean; error: string; accessDenied?: boolean; chronological?: boolean };
const empty = (): PageStatus => ({ busy: false, hasMore: true, loaded: false, error: '' });
const initial = () => ({
  activePatients: empty(), dischargedPatients: empty(), inventory: empty(), consultations: empty()
});

type InventoryListener = { unsubscribe: (() => void) | null; released: boolean; failed: boolean };
type ServerInventoryPage = { records: InventoryItem[]; hasMore: boolean; cursor?: ClinicCursor };
type PrefixListener = InventoryListener & { size: number; awaiting: boolean };
type LiveKind = PatientDirectoryKind | 'consultations';
const initialPrefix = () => ({
  target: null as PrefixListener | null, confirmed: false, ids: new Set<string>(), chronological: false, hasMore: true, denied: false,
});
const initialLiveWatches = () => ({ consultations: initialPrefix(), activePatients: initialPrefix(), dischargedPatients: initialPrefix() });

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
  const inventoryEventVersion = useRef(0);
  const confirmedHasMore = useRef(false);
  const inventoryDenied = useRef(false);
  const live = useRef(initialLiveWatches());

  const releaseListener = useCallback((target: InventoryListener) => {
    if (target.released) return;
    target.released = true;
    target.unsubscribe?.();
  }, []);

  const stopPrefixListener = useCallback((kind: LiveKind) => {
    const previous = live.current[kind].target;
    live.current[kind].target = null;
    if (previous) releaseListener(previous);
  }, [releaseListener]);

  const stopLiveListeners = useCallback(() => {
    stopPrefixListener('consultations');
    stopPrefixListener('activePatients');
    stopPrefixListener('dischargedPatients');
  }, [stopPrefixListener]);

  const denyPrefix = useCallback((kind: LiveKind) => {
    const denied = {
      ...empty(), hasMore: false, accessDenied: true,
      error: `${kind === 'consultations' ? 'Consultation' : 'Patient'} access changed. Reload the workspace.`
    };
    if (kind === 'consultations') {
      live.current.consultations.denied = true;
      stopPrefixListener(kind);
      setConsultations([]);
      setState(previous => ({ ...previous, consultations: denied }));
    } else {
      live.current.activePatients.denied = true;
      live.current.dischargedPatients.denied = true;
      stopPrefixListener('activePatients');
      stopPrefixListener('dischargedPatients');
      setPatients([]);
      setState(previous => ({ ...previous, activePatients: denied, dischargedPatients: denied }));
    }
  }, [setConsultations, setPatients, stopPrefixListener]);

  const replacePatientPrefix = useCallback((kind: PatientDirectoryKind, records: PatientRecord[]) => {
    const oldIds = live.current[kind].ids;
    const other = live.current[kind === 'activePatients' ? 'dischargedPatients' : 'activePatients'].ids;
    const incoming = new Map(records.map(row => [row.id, row]));
    live.current[kind].ids = new Set(incoming.keys());
    setPatients(previous => {
      const prior = new Map(previous.map(row => [row.id, row]));
      return [
        ...previous.filter(row => !incoming.has(row.id) && (!oldIds.has(row.id) || other.has(row.id))),
        ...records.map(row => {
          const existing = prior.get(row.id);
          return existing && (existing.revision ?? 0) > (row.revision ?? 0) ? existing : row;
        })
      ];
    });
  }, [setPatients]);

  const settlePrefixFallback = useCallback((kind: LiveKind, hasMore?: boolean) => {
    const watch = live.current[kind];
    if (watch.target) watch.target.awaiting = false;
    if (hasMore !== undefined) watch.hasMore = hasMore;
  }, []);

  const startPrefixListener = useCallback((clinic: string, kind: LiveKind, size: number) => {
    const watch = live.current[kind];
    if (!uid || watch.denied) return;
    stopPrefixListener(kind);
    const target: PrefixListener = { size, awaiting: true, unsubscribe: null, released: false, failed: false };
    watch.target = target;
    const isCurrent = () => live.current[kind] === watch && watch.target === target && !target.released;
    const deny = () => { if (isCurrent()) denyPrefix(kind); };
    const fail = (error: Error) => {
      if (!isCurrent()) return;
      if (isClinicInventoryAccessDenied(error)) { deny(); return; }
      target.failed = true;
      target.awaiting = false;
      setState(previous => ({ ...previous, [kind]: {
        ...previous[kind], busy: false, error: 'Could not keep these records in sync. Check your connection and retry.'
      } }));
    };
    const accept = (records: Consultation[] | PatientRecord[], hasMore: boolean, chronological = false) => {
      if (!isCurrent() || target.failed) return;
      target.awaiting = false;
      watch.confirmed = true;
      watch.chronological = chronological;
      watch.hasMore = hasMore;
      if (kind === 'consultations') setConsultations(records as Consultation[]);
      else replacePatientPrefix(kind, records as PatientRecord[]);
      setState(previous => ({ ...previous, [kind]: {
        busy: false, hasMore, loaded: true, error: '', chronological
      } }));
    };
    setState(previous => ({ ...previous, [kind]: { ...previous[kind], busy: true, error: '' } }));
    const started = kind === 'consultations'
      ? subscribeClinicConsultations(clinic, uid, size, watch.chronological,
        page => accept(page.records, page.hasMore, page.chronological), fail, deny)
      : subscribePatientDirectory(clinic, uid, kind, size,
        page => accept(page.records, page.hasMore), fail, deny);
    void started.then(unsubscribe => {
      if (target.released) unsubscribe();
      else target.unsubscribe = unsubscribe;
    }).catch(fail);
  }, [denyPrefix, replacePatientPrefix, setConsultations, stopPrefixListener, uid]);

  // Replacing or stopping a listener invalidates its callbacks immediately; a
  // late unsubscribe (or a still-pending start) is still released below.
  const stopInventoryListener = useCallback(() => {
    const previous = listener.current;
    listener.current = null;
    listenerVersion.current += 1;
    if (previous) releaseListener(previous);
  }, [releaseListener]);

  const denyInventory = useCallback(() => {
    inventoryDenied.current = true;
    inventoryError.current = '';
    inventoryRetrySource.current = null;
    inventoryPageRetryAdvance.current = false;
    stopInventoryListener();
    cursors.current.inventory = null;
    loadedPages.current.inventory = 0;
    listenerSize.current = 0;
    setInventory([]);
    setState(previous => ({ ...previous, inventory: {
      ...empty(), hasMore: false, accessDenied: true, error: 'Inventory access changed. Reload the workspace.'
    } }));
  }, [setInventory, stopInventoryListener]);

  const startInventoryListener = useCallback((clinic: string, size: number) => {
    if (!uid || inventoryDenied.current) return;
    stopInventoryListener();
    listenerSize.current = size;
    const version = generation.current;
    const token = listenerVersion.current;
    const target: InventoryListener = { unsubscribe: null, released: false, failed: false };
    listener.current = target;
    const isCurrent = () => generation.current === version && listenerVersion.current === token
      && listener.current === target && !target.released;
    const accept = (page: ServerInventoryPage) => {
      if (!isCurrent() || target.failed) return;
      inventoryEventVersion.current += 1;
      confirmedHasMore.current = page.hasMore;
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
      if (isClinicInventoryAccessDenied(error)) { denyInventory(); return; }
      if (target.failed) return;
      // Firestore's query error is terminal, but keep observing Firebase Auth
      // until Retry replaces this subscription or the workspace is closed.
      target.failed = true;
      inventoryEventVersion.current += 1;
      const message = error.message || 'Could not keep inventory in sync.';
      inventoryError.current = message;
      inventoryRetrySource.current = 'listener';
      inventoryPageRetryAdvance.current = false;
      setState(previous => ({ ...previous, inventory: { ...previous.inventory,
        busy: false, error: message } }));
    };
    void subscribeClinicInventory(clinic, size, accept, fail, uid, () => {
      if (isCurrent()) denyInventory();
    }).then(unsubscribe => {
      if (target.released) unsubscribe();
      else target.unsubscribe = unsubscribe;
    }).catch(fail);
  }, [stopInventoryListener, setInventory, uid, denyInventory]);

  const load = useCallback(async (kind: ClinicPageKind, reset = false) => {
    if (!authenticated || !clinicId || clinicId === 'demo-clinic') return;
    const prefix = kind === 'inventory' ? null : live.current[kind];
    if (prefix && (!uid || prefix.denied)) return;
    if (kind !== 'inventory' && !reset && prefix?.target) {
      const target = prefix.target;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setState(previous => ({ ...previous, [kind]: {
          ...previous[kind], busy: false, error: 'Reconnect before requesting more records.'
        } }));
        return;
      }
      if (target.failed || (!target.awaiting && prefix.hasMore)) {
        startPrefixListener(clinicId, kind, target.size + (!target.failed && prefix.confirmed ? CLINIC_PAGE_SIZE : 0));
      }
      return;
    }
    if (inFlight.current.has(kind)) return;
    if (kind === 'inventory' && (!uid || inventoryDenied.current)) return;
    // PageControls uses the same onLoad for Retry and Load more. Remember what
    // failed: a listener retry restarts at the same size, while a page-read
    // retry repeats its intended read (which may be the next page).
    const retrySource = kind === 'inventory' && inventoryError.current ? inventoryRetrySource.current : null;
    if (retrySource) {
      inventoryError.current = '';
      inventoryRetrySource.current = null;
    }
    const version = generation.current;
    const inventoryEventAtStart = inventoryEventVersion.current;
    inFlight.current.add(kind);
    setState(previous => ({ ...previous, [kind]: { ...previous[kind], busy: true, error: '' } }));
    if (kind !== 'inventory') startPrefixListener(clinicId, kind, CLINIC_PAGE_SIZE);
    try {
      const cursor = reset ? null : cursors.current[kind] ?? null;
      const page = await loadClinicPage(clinicId, kind, cursor, uid ?? undefined);
      if (generation.current !== version) return;
      if (kind === 'inventory') {
        if (inventoryDenied.current) return;
        const pages = loadedPages.current.inventory ?? 0;
        if (inventoryEventVersion.current !== inventoryEventAtStart) {
          // Do not apply any part of an older page result. Honor Load more
          // only if the newer confirmation still has another page.
          if (!inventoryError.current && confirmedHasMore.current && !reset && retrySource !== 'listener'
            && (retrySource !== 'page' || inventoryPageRetryAdvance.current)) {
            loadedPages.current.inventory = pages + 1;
            inventoryPageRetryAdvance.current = false;
            startInventoryListener(clinicId, CLINIC_PAGE_SIZE * (pages + 1));
          }
          setState(previous => ({ ...previous, inventory: { ...previous.inventory, busy: false } }));
          return;
        }
        // An empty read leaves the last confirmed cursor in place; a stale
        // boundary must not rewind the next page to the beginning of the list.
        if (reset || page.records.length > 0) cursors.current[kind] = page.cursor;
        setInventory(previous => appendUnique(previous, page.records as InventoryItem[], record => record.itemCode));
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
        if (!prefix || prefix.denied || prefix.confirmed) return;
        settlePrefixFallback(kind, page.hasMore);
        if (kind === 'consultations') setConsultations(page.records as Consultation[]);
        else replacePatientPrefix(kind, page.records as PatientRecord[]);
        setState(previous => ({ ...previous, [kind]: {
          ...previous[kind], busy: false, loaded: true, hasMore: page.hasMore
        } }));
        return;
      }
      setState(previous => ({ ...previous, [kind]: { busy: false, loaded: true, hasMore: page.hasMore, error: '' } }));
    } catch (error) {
      if (generation.current !== version) return;
      if (kind !== 'inventory' && prefix) {
        if (prefix.denied) return;
        if (isClinicInventoryAccessDenied(error)) { denyPrefix(kind); return; }
        if (prefix.confirmed || prefix.target?.failed) return;
        settlePrefixFallback(kind);
      }
      if (kind === 'inventory') {
        if (inventoryDenied.current) return;
        if (isClinicInventoryAccessDenied(error)) { denyInventory(); return; }
        if (inventoryEventVersion.current !== inventoryEventAtStart) {
          setState(previous => ({ ...previous, inventory: { ...previous.inventory, busy: false } }));
          return;
        }
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
  }, [authenticated, clinicId, uid, setInventory, setConsultations, startInventoryListener,
    denyInventory, startPrefixListener, denyPrefix, replacePatientPrefix, settlePrefixFallback]);

  useEffect(() => {
    generation.current += 1;
    cursors.current = {};
    loadedPages.current = {};
    inFlight.current = new Set();
    listenerSize.current = 0;
    inventoryError.current = '';
    inventoryRetrySource.current = null;
    inventoryPageRetryAdvance.current = false;
    inventoryEventVersion.current = 0;
    confirmedHasMore.current = false;
    inventoryDenied.current = false;
    stopInventoryListener();
    stopLiveListeners();
    live.current = initialLiveWatches();
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
    return () => { active = false; generation.current += 1; stopInventoryListener(); stopLiveListeners(); };
  }, [authenticated, clinicId, uid, load, setPatients, setInventory, setConsultations, stopInventoryListener, stopLiveListeners]);
  return { state, load };
}
