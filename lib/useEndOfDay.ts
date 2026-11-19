'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { billingLocalTime, parseBillingDay } from '@/lib/billing-values';
import type { CloseCursor, ClosePageLoader } from '@/lib/end-of-day';
import type { CloseKind, CloseRows } from '@/lib/end-of-day-values';

type Status = 'idle' | 'loading' | 'partial' | 'complete' | 'error' | 'offline';
export type CloseSection<T> = { rows: T[]; status: Status; refreshedAtMs: number | null; error: string };
type Sections = { [K in CloseKind]: CloseSection<CloseRows[K]> };
type Session = {
  key: string; active: boolean; dayStartMs: number;
  cursors: Record<CloseKind, CloseCursor | null>; busy: Set<CloseKind>;
};
type EndOfDayOptions = {
  clinicId: string; uid: string; workspaceGeneration: number; isCurrent: (generation: number) => boolean;
  enabled: boolean; online: boolean; load: ClosePageLoader;
};

const kinds: CloseKind[] = ['entries', 'corrections', 'balances', 'visits'];
const emptySection = (status: Status) => ({ rows: [], status, refreshedAtMs: null, error: '' });
const emptySections = (status: Status): Sections => ({
  entries: emptySection(status), corrections: emptySection(status), balances: emptySection(status), visits: emptySection(status),
});
const rowId = (row: CloseRows[CloseKind]) => 'entry' in row ? row.entry.id : row.id;
const today = () => billingLocalTime(Date.now()).slice(0, 10);

export function useEndOfDay({ clinicId, uid, workspaceGeneration, isCurrent, enabled, online, load }: EndOfDayOptions) {
  const [latestDay, setLatestDay] = useState(today);
  const [day, selectDay] = useState(latestDay);
  const [refreshId, setRefreshId] = useState(0);
  const current = useRef<Session | null>(null);
  const key = JSON.stringify([clinicId, uid, workspaceGeneration, enabled, online, day, refreshId]);
  let dayStartMs = 0;
  let dayError = '';
  try {
    dayStartMs = parseBillingDay(day);
    if (day > latestDay) dayError = 'Choose today or an earlier Manila business day.';
  } catch { dayError = 'Choose a valid Manila business day.'; }
  const initialStatus = !enabled || dayError ? 'idle' : !online ? 'offline' : 'loading';
  const [state, setState] = useState(() => ({ key, load, sections: emptySections(initialStatus) }));
  let sections = state.sections;
  if (state.key !== key || state.load !== load) {
    // Clear before paint, including if a previously used scope (e.g. connected)
    // comes back. An effect-only reset can briefly show a stale complete total.
    sections = emptySections(initialStatus);
    setState({ key, load, sections });
  }

  const run = useCallback(async <K extends CloseKind,>(kind: K, session: Session, append: boolean) => {
    const active = () => session.active && current.current === session && isCurrent(workspaceGeneration);
    if (!active() || session.busy.has(kind) || (append && session.cursors[kind] === null)) return;
    const update = (change: (section: CloseSection<CloseRows[K]>) => CloseSection<CloseRows[K]>) => setState(previous => {
      if (!active() || previous.key !== session.key || previous.load !== load) return previous;
      return { ...previous, sections: { ...previous.sections, [kind]: change(previous.sections[kind]) } };
    });
    session.busy.add(kind);
    update(section => ({ ...section, rows: append ? section.rows : [], status: 'loading', error: '' }));
    try {
      const page = await load(kind, { clinicId, uid, dayStartMs: session.dayStartMs, after: append ? session.cursors[kind] : null });
      if (!active()) return;
      session.cursors[kind] = page.next;
      const refreshedAtMs = Date.now();
      update(section => ({ rows: [...new Map((append ? [...section.rows, ...page.rows] : page.rows).map(row => [rowId(row), row])).values()],
        status: page.next === null ? 'complete' : 'partial', refreshedAtMs, error: '' }));
    } catch {
      if (active()) update(section => ({ ...section, status: 'error',
        error: 'Could not load this section. Check the connection and clinic access, then refresh the report.' }));
    } finally { session.busy.delete(kind); }
  }, [clinicId, uid, workspaceGeneration, isCurrent, load]);

  useEffect(() => {
    if (!enabled || !online || dayError || !isCurrent(workspaceGeneration)) return;
    const session: Session = { key, dayStartMs, active: true, busy: new Set(),
      cursors: { entries: null, corrections: null, balances: null, visits: null } };
    current.current = session;
    void Promise.resolve().then(() => {
      for (const kind of kinds) void run(kind, session, false);
    });
    return () => { session.active = false; };
  }, [dayError, dayStartMs, enabled, isCurrent, key, online, run, workspaceGeneration]);

  const invalidate = () => { if (current.current) current.current.active = false; };
  return {
    day, dayError, latestDay, sections,
    setDay: (value: string) => { if (value !== day) { invalidate(); selectDay(value); } },
    refresh: () => { invalidate(); setLatestDay(today()); setRefreshId(value => value + 1); },
    loadMore: (kind: CloseKind) => {
      const session = current.current;
      if (session?.key === key && sections[kind].status === 'partial') void run(kind, session, true);
    },
  };
}
