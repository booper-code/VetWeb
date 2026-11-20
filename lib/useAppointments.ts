"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Appointment, AppointmentDraft, PatientRecord } from '@/types';
import { loadAppointmentsPage, saveAppointment } from '@/lib/appointments';
import type { AppointmentCursor } from '@/lib/appointments';
import { appointmentValidationError, defaultAppointmentWindow, inAppointmentWindow } from '@/lib/appointment-values';
import type { AppointmentWindow } from '@/lib/appointment-values';
import { currentFollowUpContact, isDueFollowUp } from '@/lib/follow-up-values';
import type { createMutationScope } from '@/lib/mutation-scope';

const emptyPage = () => ({ rows: [] as Appointment[], hasMore: true, busy: false, loaded: false, error: '', fromCache: false, refreshedAt: '' });
export function useAppointments({
  clinicId, uid, online, canEdit, patients, scope, workspaceGeneration,
}: {
  clinicId: string | null; uid: string | null; online: boolean; canEdit: boolean; patients: PatientRecord[];
  scope: ReturnType<typeof createMutationScope>; workspaceGeneration: number;
}) {
  const key = `${clinicId}:${uid}`;
  const [window, setWindow] = useState(defaultAppointmentWindow);
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
    const todayWindow = defaultAppointmentWindow();
    if (reset && rollingWindow.current &&
        (window.from !== todayWindow.from || window.through !== todayWindow.through)) {
      generation.current += 1; locked.current = false; cursor.current = null; committed.current.clear();
      setPage({ ...emptyPage(), key }); setWindow(todayWindow);
      return;
    }
    if (reset) { generation.current += 1; cursor.current = null; committed.current.clear(); }
    const version = generation.current;
    locked.current = true;
    setPage(previous => ({ ...(reset ? emptyPage() : previous), key, busy: true, error: '' }));
    try {
      const result = clinicId === 'demo-clinic'
        ? { records: demo.current.filter(row => inAppointmentWindow(row, window)), hasMore: false, cursor: null, fromCache: false }
        : await loadAppointmentsPage(clinicId, window, cursor.current);
      if (generation.current !== version || !scope.isCurrent(workspaceGeneration)) return;
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
          busy: false, loaded: true, error: '', refreshedAt: new Date().toISOString() };
      });
    } catch {
      if (generation.current === version && scope.isCurrent(workspaceGeneration)) {
        setPage(previous => ({ ...previous, busy: false, error: 'Could not load appointments. Check your connection, clinic access and matching published rules, then retry.' }));
      }
    } finally {
      if (generation.current === version) locked.current = false;
    }
  }, [clinicId, uid, key, window, scope, workspaceGeneration]);

  useEffect(() => {
    let active = true;
    const completedInScope = committed.current;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (!clinicId) { demo.current = []; setPage({ ...emptyPage(), key }); }
      else void load(true);
    });
    return () => { active = false; generation.current += 1; locked.current = false; completedInScope.clear(); };
  }, [clinicId, key, load]);

  const changeWindow = (value: AppointmentWindow) => {
    const todayWindow = defaultAppointmentWindow();
    rollingWindow.current = value.from === todayWindow.from && value.through === todayWindow.through;
    generation.current += 1; locked.current = false; cursor.current = null; committed.current.clear();
    setPage({ ...emptyPage(), key });
    setWindow(value);
  };
  const save = async (id: string, expectedRevision: number | null, draft: AppointmentDraft): Promise<boolean> => {
    if (!clinicId || !uid || !scope.isCurrent(workspaceGeneration)) return false;
    if (!canEdit || (clinicId !== 'demo-clinic' && !online)) throw new Error('An online owner or editor session is required. No change was submitted.');
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
      if (!scope.isCurrent(workspaceGeneration) || generation.current !== version) return false;
      committed.current.set(saved.id, saved);
      setPage(previous => ({
        ...previous, rows: [...previous.rows.filter(row => row.id !== id), ...(inAppointmentWindow(saved, window) ? [saved] : [])]
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id)),
      }));
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
