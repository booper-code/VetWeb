import { useEffect, useRef, useState } from 'react';

export type ClinicScanPage<T, Cursor> = { rows: T[]; next: Cursor | null };
type ScanPhase = 'idle' | 'loading' | 'partial' | 'complete' | 'error';
type ScanState<Match> = { phase: ScanPhase; matches: Match[]; checked: number };
type ScanRun<Match, Criteria, Cursor> = {
  phase: ScanPhase;
  matches: Map<string, Match>;
  checked: number;
  after: Cursor | null;
  criteria: Criteria;
};

const PAGES_PER_ACTION = 5;
const emptyScan = <Match,>(): ScanState<Match> => ({ phase: 'idle', matches: [], checked: 0 });

export function useClinicScan<T, Match, Criteria, Cursor>({ load, select, identify, isCurrent }: {
  load: (after: Cursor | null) => Promise<ClinicScanPage<T, Cursor>>;
  select: (row: T, criteria: Criteria) => Match | null;
  identify: (match: Match) => string;
  isCurrent: () => boolean;
}) {
  const [state, setState] = useState(emptyScan<Match>);
  const active = useRef<ScanRun<Match, Criteria, Cursor> | null>(null);

  useEffect(() => () => { active.current = null; }, []);

  function reset() {
    active.current = null;
    setState(emptyScan());
  }

  async function run(scan: ScanRun<Match, Criteria, Cursor>) {
    const current = () => active.current === scan && isCurrent();
    const publish = (phase: ScanPhase) => {
      scan.phase = phase;
      setState({ phase, matches: [...scan.matches.values()], checked: scan.checked });
    };
    if (!current() || scan.phase === 'loading' || scan.phase === 'complete') return;
    publish('loading');
    try {
      for (let index = 0; index < PAGES_PER_ACTION && current(); index++) {
        const page = await load(scan.after);
        if (!current()) return;
        for (const row of page.rows) {
          const match = select(row, scan.criteria);
          if (match !== null) scan.matches.set(identify(match), match);
        }
        scan.checked += page.rows.length;
        scan.after = page.next;
        if (scan.after === null) {
          publish('complete');
          return;
        }
        publish(index + 1 === PAGES_PER_ACTION ? 'partial' : 'loading');
      }
    } catch {
      if (current()) publish('error');
    }
  }

  function start(criteria: Criteria) {
    const scan: ScanRun<Match, Criteria, Cursor> = {
      phase: 'idle', matches: new Map(), checked: 0, after: null, criteria,
    };
    active.current = scan;
    void run(scan);
  }

  function next() {
    const scan = active.current;
    if (scan?.phase === 'partial' || scan?.phase === 'error') void run(scan);
  }

  return { state, start, next, reset };
}
