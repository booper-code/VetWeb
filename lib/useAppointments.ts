"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Appointment, AppointmentDraft, PatientRecord } from '@/types';
import { loadAppointmentsPage, saveAppointment, subscribeAppointments } from '@/lib/appointments';
import type { AppointmentCursor } from '@/lib/appointments';
import { APPOINTMENT_PAGE_SIZE, appointmentValidationError, defaultAppointmentWindow, inAppointmentWindow } from '@/lib/appointment-values';
import type { AppointmentWindow } from '@/lib/appointment-values';
import { isClinicInventoryAccessDenied } from '@/lib/clinic-pages';
import { currentFollowUpContact, isDueFollowUp } from '@/lib/follow-up-values';
import type { createMutationScope } from '@/lib/mutation-scope';

const emptyPage = () => ({ rows: [] as Appointment[], hasMore: true, busy: false, loaded: false, error: '', fromCache: false, refreshedAt: '' });
const initialWatch = (key: string) => ({ key, confirmed: false, denied: false, failed: false, hasMore: true });
export function useAppointments({
  clinicId, uid, online, canEdit, patients, scope, workspaceGeneration,
}: {
  clinicId: string | null; uid: string | null; online: boolean; canEdit: boolean; patients: PatientRecord[];
  scope: ReturnType<typeof createMutationScope>; workspaceGeneration: number;
}) {
  const key = `${clinicId}:${uid}`;
  const [window, setWindow] = useState(defaultAppointmentWindow);
  const watchKey = JSON.stringify([clinicId, uid, window.from, window.through, workspaceGeneration]);
  const [watch, setWatch] = useState(() => ({ key: watchKey, size: APPOINTMENT_PAGE_SIZE, retry: 0 }));
  const watchSize = watch.key === watchKey ? watch.size : APPOINTMENT_PAGE_SIZE;
  const watchRetry = watch.key === watchKey ? watch.retry : 0;
  const live = useRef(initialWatch(watchKey));
  const snapshotVersion = useRef(0);
  const rollingWindow = useRef(true);
  const [page, setPage] = useState(() => ({ ...emptyPage(), key }));
  const generation = useRef(0);
  const locked = useRef(false);
  const cursor = useRef<AppointmentCursor>(null);
  const saving = useRef(new Set<string>());
  const committed = useRef(new Map<string, Appointment>());
  const demo = useRef<Appointment[]>([]);
  const load = useCallback(async (reset = false) => {
    if (!clinicId || !uid || !scope.isCurrent(workspaceGeneration) || (locked.current && !reset)) return;
    const current = live.current;
    if (current.key === watchKey && current.denied) return;
    const todayWindow = defaultAppointmentWindow();
    if (reset && rollingWindow.current &&
        (window.from !== todayWindow.from || window.through !== todayWindow.through)) {
      generation.current += 1; locked.current = false; cursor.current = null; committed.current.clear();
      setPage({ ...emptyPage(), key }); setWindow(todayWindow);
      return;
    }
    if (clinicId !== 'demo-clinic' && current.key === watchKey && (current.confirmed || current.failed)) {
      if (!online) {
        setPage(previous => ({ ...previous, busy: false, error: 'Reconnect before requesting more appointments.' }));
        return;
      }
      if (!reset && !current.failed && !current.hasMore) return;
      locked.current = true;
      setPage(previous => ({ ...previous, busy: true, error: '' }));
      setWatch({ key: watchKey,
        size: current.failed ? watchSize : reset ? APPOINTMENT_PAGE_SIZE : watchSize + APPOINTMENT_PAGE_SIZE,
        retry: watchRetry + 1 });
      return;
    }
    if (reset) { generation.current += 1; cursor.current = null; committed.current.clear(); }
    const version = generation.current;
    const liveVersion = snapshotVersion.current;
    locked.current = true;
    setPage(previous => ({ ...(reset ? emptyPage() : previous), key, busy: true, error: '' }));
    try {
      const result = clinicId === 'demo-clinic'
        ? { records: demo.current.filter(row => inAppointmentWindow(row, window)), hasMore: false, cursor: null, fromCache: false }
        : await loadAppointmentsPage(clinicId, window, cursor.current, uid);
      if (generation.current !== version || !scope.isCurrent(workspaceGeneration)) return;
      if (snapshotVersion.current !== liveVersion) return;
      cursor.current = result.cursor;
      setPage(previous => {
        const rows = reset ? [] : previous.rows;
        const merged = new Map(rows.map(row => [row.id, row]));
        for (const row of [...result.records, ...committed.current.values()]) {
          if (!merged.has(row.id) || row.revision >= merged.get(row.id)!.revision) merged.set(row.id, row);
        }
        // A read begun before our commit cannot roll back its revision or
        // resurrect a row that we just rescheduled outside this date window.
        return { key, rows: [...merged.values()].filter(row => inAppointmentWindow(row, window))
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id)),
          hasMore: result.hasMore, fromCache: result.fromCache || (!reset && previous.fromCache),
          busy: false, loaded: true, error: current.failed ? previous.error : '', refreshedAt: new Date().toISOString() };
      });
      if (!reset && clinicId !== 'demo-clinic' && result.records.length) {
        setWatch(previous => ({ key: watchKey, retry: 0,
          size: (previous.key === watchKey ? previous.size : APPOINTMENT_PAGE_SIZE) + APPOINTMENT_PAGE_SIZE }));
      }
    } catch (error) {
      if (generation.current === version && scope.isCurrent(workspaceGeneration) && snapshotVersion.current === liveVersion) {
        if (isClinicInventoryAccessDenied(error)) {
          current.denied = true;
          setPage({ ...emptyPage(), key, hasMore: false, error: 'Appointment access changed. Reload the workspace.' });
        } else {
          setPage(previous => ({ ...previous, busy: false, error: 'Could not load appointments. Check your connection and clinic access, then retry.' }));
        }
      }
    } finally {
      if (generation.current === version) locked.current = false;
    }
  }, [clinicId, uid, key, window, scope, workspaceGeneration, watchKey, watchRetry, watchSize, online]);

  const loadFirstPage = useEffectEvent(() => { void load(true); });
  useEffect(() => {
    let active = true;
    const completedInScope = committed.current;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (!clinicId) { demo.current = []; setPage({ ...emptyPage(), key }); }
      else loadFirstPage();
    });
    return () => { active = false; generation.current += 1; locked.current = false; completedInScope.clear(); };
  }, [clinicId, key, window, workspaceGeneration]);

  useEffect(() => {
    if (!clinicId || clinicId === 'demo-clinic' || !uid) return;
    let active = true;
    let release: (() => void) | undefined;
    if (live.current.key !== watchKey) live.current = initialWatch(watchKey);
    const current = live.current;
    current.failed = false;
    const isCurrent = () => active && live.current === current && !current.denied && scope.isCurrent(workspaceGeneration);
    const deny = () => {
      if (!isCurrent()) return;
      current.denied = true;
      snapshotVersion.current += 1;
      locked.current = false;
      committed.current.clear();
      setPage({ ...emptyPage(), key, hasMore: false, error: 'Appointment access changed. Reload the workspace.' });
    };
    const fail = (error: Error) => {
      if (!isCurrent()) return;
      if (isClinicInventoryAccessDenied(error)) { deny(); return; }
      current.failed = true;
      locked.current = false;
      setPage(previous => ({ ...previous, busy: false, error: 'Could not keep appointments in sync. Refresh the schedule to retry.' }));
    };
    void subscribeAppointments(clinicId, uid, window, watchSize, page => {
      if (!isCurrent() || current.failed) return;
      current.confirmed = true;
      current.hasMore = page.hasMore;
      snapshotVersion.current += 1;
      locked.current = false;
      setPage({ key, rows: page.records, hasMore: page.hasMore, fromCache: false,
        busy: false, loaded: true, error: '', refreshedAt: new Date().toISOString() });
    }, fail, deny).then(unsubscribe => {
      if (isCurrent()) release = unsubscribe;
      else unsubscribe();
    }).catch(fail);
    return () => { active = false; release?.(); };
  }, [clinicId, uid, key, window, watchKey, watchSize, watchRetry, scope, workspaceGeneration]);

  const changeWindow = (value: AppointmentWindow) => {
    const todayWindow = defaultAppointmentWindow();
    rollingWindow.current = value.from === todayWindow.from && value.through === todayWindow.through;
    generation.current += 1; locked.current = false; cursor.current = null; committed.current.clear();
    setPage({ ...emptyPage(), key });
    setWindow(value);
  };
  const save = async (id: string, expectedRevision: number | null, draft: AppointmentDraft): Promise<boolean> => {
    if (!clinicId || !uid || !scope.isCurrent(workspaceGeneration)) return false;
    if (clinicId !== 'demo-clinic' && live.current.key === watchKey && live.current.denied) return false;
     if (!canEdit || (clinicId !== 'demo-clinic' && !online)) throw new Error('An online clinic session is required. No change was submitted.');
    const invalid = appointmentValidationError(draft);
    if (invalid) throw new Error(invalid);
    const savingKey = `${key}:${id}`;
    if (saving.current.has(savingKey)) throw new Error('This appointment is already saving.');
    saving.current.add(savingKey);
    const version = generation.current;
    try {
      let saved: Appointment;
      if (clinicId === 'demo-clinic') {
        const previous = demo.current.find(row => row.id === id);
        if ((previous?.revision ?? null) !== expectedRevision) throw new Error('Appointment changed. Refresh before saving again.');
        const patient = patients.find(row => row.id === draft.patientId);
        if (!patient && !previous) throw new Error('Select a loaded patient.');
        if (previous && previous.patientId !== draft.patientId) throw new Error('Cancel and create another appointment to change the patient.');
        const now = new Date().toISOString();
        saved = { ...draft, id, revision: (expectedRevision ?? 0) + 1,
          patientName: patient?.name ?? previous!.patientName, ownerName: patient?.ownerName ?? previous!.ownerName,
          ownerContact: patient?.ownerContact ?? previous!.ownerContact, ownerEmail: patient?.ownerEmail ?? previous?.ownerEmail ?? '',
           createdAt: previous?.createdAt ?? now, updatedAt: now, createdBy: previous?.createdBy ?? uid, updatedBy: uid,
           ...(previous?.followUpContact ? { followUpContact: previous.followUpContact } : {}) };
        demo.current = [...demo.current.filter(row => row.id !== id), saved];
      } else saved = await saveAppointment({ clinicId, id, expectedRevision, draft, expectedUid: uid });
      if (!scope.isCurrent(workspaceGeneration) || generation.current !== version
        || (clinicId !== 'demo-clinic' && live.current.denied)) return false;
      committed.current.set(saved.id, saved);
      const prefixConfirmed = clinicId !== 'demo-clinic' && live.current.confirmed;
      setPage(previous => {
        const existing = previous.rows.find(row => row.id === id);
        if ((existing && existing.revision > saved.revision)
          || (!existing && prefixConfirmed)) return previous;
        return { ...previous, rows: [...previous.rows.filter(row => row.id !== id), ...(inAppointmentWindow(saved, window) ? [saved] : [])]
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id)) };
      });
      return true;
    } catch (error) {
      if (!scope.isCurrent(workspaceGeneration) || generation.current !== version) return false;
      throw error;
    } finally { saving.current.delete(savingKey); }
  };
  // Do not return the internal `key`: spreading hook props into JSX would leak
  // it and React 19 rejects a `key` arriving through a props spread.
  const demoRecords = useCallback(() => clinicId === 'demo-clinic' ? [...demo.current] : [], [clinicId]);
  const applyFollowUpContact = (row: Appointment) => {
    if (!scope.isCurrent(workspaceGeneration)) return;
    const prior = committed.current.get(row.id);
    if (!prior || row.revision >= prior.revision) committed.current.set(row.id, row);
    setPage(previous => previous.key === key ? {
      ...previous, rows: previous.rows.flatMap(existing => existing.id !== row.id || existing.revision > row.revision ? [existing]
        : inAppointmentWindow(row, window) ? [row] : []),
    } : previous);
  };
  const recordDemoFollowUpContact = (row: Appointment, contacted: boolean) => {
    if (clinicId !== 'demo-clinic' || !uid || !canEdit || !scope.isCurrent(workspaceGeneration)) throw new Error('Choose an editable demo workspace.');
    const current = demo.current.find(item => item.id === row.id);
    if (!current || current.revision !== row.revision) throw new Error('This appointment changed. Refresh the queue.');
    const now = Date.now(), at = new Date(now).toISOString();
    if (!isDueFollowUp(current, now) || contacted === !!currentFollowUpContact(current)) throw new Error('This follow-up changed. Refresh the queue.');
    const updated: Appointment = { ...current, revision: current.revision + 1, updatedAt: at, updatedBy: uid };
    if (contacted) updated.followUpContact = { dueAt: current.dueAt, contactedAt: at, contactedBy: uid };
    else delete updated.followUpContact;
    demo.current = demo.current.map(item => item.id === row.id ? updated : item);
    applyFollowUpContact(updated);
    return updated;
  };
  const current = page.key === key ? page : emptyPage();
  return {
    rows: current.rows, hasMore: current.hasMore, busy: current.busy, loaded: current.loaded,
    error: current.error, fromCache: current.fromCache, refreshedAt: current.refreshedAt,
    window, changeWindow, load, save, demoRecords, recordDemoFollowUpContact, applyFollowUpContact
  };
}
