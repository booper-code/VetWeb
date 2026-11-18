"use client";

import { useEffect, useRef, useState } from 'react';
import type { QueryDocumentSnapshot, DocumentData, QueryConstraint } from 'firebase/firestore';
import { initializeFirebase } from '@/lib/firebase';

type Event = { id: string; actorUid: string; action: string; entityType: string; entityId: string; seq: number; time?: { toDate: () => Date } };
export function AuditLogView({ clinicId, searchQuery }: { clinicId: string; searchQuery: string }) {
  const [events, setEvents] = useState<Event[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [more, setMore] = useState(true);
  const cursor = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const scope = useRef(0);
  const locked = useRef(false);
  async function load(version = scope.current) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError('');
    try {
      const { db, firestore: fs } = await initializeFirebase();
      const constraints: QueryConstraint[] = [fs.orderBy('time', 'desc'), fs.limit(25)];
      if (cursor.current) constraints.push(fs.startAfter(cursor.current));
      const page = await fs.getDocs(fs.query(fs.collection(db, 'clinics', clinicId, 'auditEvents'), ...constraints));
      if (version !== scope.current) return;
      const incoming = page.docs.map(document => ({ ...document.data(), id: document.id } as Event));
      setEvents(previous => {
        const ids = new Set(previous.map(event => event.id));
        return [...previous, ...incoming.filter(event => !ids.has(event.id))];
      });
      cursor.current = page.docs.at(-1) ?? cursor.current;
      setMore(page.size === 25);
    } catch {
      if (version === scope.current) setError('Could not load audit events. Check your connection and owner access.');
    } finally {
      if (version === scope.current) { locked.current = false; setBusy(false); }
    }
  }
  useEffect(() => {
    const version = ++scope.current;
    void Promise.resolve().then(() => {
      if (version !== scope.current) return;
      setEvents([]); cursor.current = null; locked.current = false;
      void load(version);
    });
    return () => { scope.current += 1; };
    // The clinic-keyed parent remounts this view; no user data is shared across scopes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);
  const q = searchQuery.trim().toLowerCase();
  const visible = events.filter(event => `${event.action} ${event.entityType} ${event.entityId} ${event.actorUid}`.toLowerCase().includes(q));
  return <section className="space-y-4">
    <h2 className="text-2xl font-bold text-content-title">Clinical audit trail</h2>
    <p className="text-sm text-content-secondary">Owner-only mutation metadata for patients, inventory, consultations and appointments. Events cannot be edited or deleted through application rules. This is not a regulatory compliance certification.</p>
    <p className="text-xs text-content-hint">Search covers the {events.length} loaded events. Newest events first.</p>
    {error && <p role="alert" className="text-danger-text">{error}</p>}
    <div className="overflow-x-auto rounded-xl border border-outline-soft bg-panel">
      <table className="w-full text-left text-sm">
        <thead><tr>{['Time', 'Action', 'Record', 'Revision', 'Actor UID'].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead>
        <tbody>{visible.map(event => <tr key={event.id} className="border-t border-hairline">
          <td className="p-3">{event.time?.toDate?.().toLocaleString() ?? 'Pending'}</td>
          <td className="p-3">{event.action}</td><td className="max-w-xs break-all p-3">{event.entityType}/{event.entityId}</td>
          <td className="p-3">{event.seq}</td><td className="max-w-xs break-all p-3 font-mono text-xs">{event.actorUid}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {!visible.length && !busy && <p className="text-content-secondary">No matching loaded events.</p>}
    {(more || error) && <button type="button" disabled={busy} onClick={() => void load()}
      className="rounded-xl bg-slate-900 px-4 py-2 font-bold text-white disabled:opacity-50">
      {busy ? 'Loading audit events…' : error ? 'Retry audit events' : 'Load more audit events'}
    </button>}
  </section>;
}
