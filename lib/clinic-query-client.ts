// Bounded, clinic-scoped, server-only reads for the local query engine.
//
// Every read is built from an allowlisted table name (never a caller-supplied
// path), ordered by document id and limited. Pages are fetched with the lite
// SDK so no clinic-wide scan is written to the trusted-device cache. Each page
// is re-checked for scope/account/cancellation, and the whole run has a hard
// page cap and timeout. Nothing here mutates records.

import {
  CLINIC_TABLES, projectQueryRow, roleAllowed, type QueryRow, type QuerySource, type TableId,
} from '@/lib/clinic-query';
import { assistantResourceId } from '@/lib/assistant-tools';
import { initializeFirebase } from '@/lib/firebase';
import type { ClinicRole } from '@/types';

export const CLINIC_QUERY_PAGE_SIZE = 50;
export const CLINIC_QUERY_MAX_PAGES = 4;
export const CLINIC_QUERY_TIMEOUT_MS = 8000;

export type ClinicQueryContext = {
  clinicId: string;
  uid: string;
  role: ClinicRole | null;
};

export async function readClinicQuerySource(
  ctx: ClinicQueryContext,
  table: TableId,
  signal: AbortSignal,
  current: () => boolean,
): Promise<QuerySource> {
  const live = () => !signal.aborted && current();
  if (!live() || !assistantResourceId.test(ctx.clinicId) || ctx.clinicId === 'demo-clinic' ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return { status: 'unavailable' };
  }
  if (!roleAllowed(ctx.role, CLINIC_TABLES[table].role)) return { status: 'denied' };

  try {
    const { app, auth } = await initializeFirebase();
    if (!live() || auth.currentUser?.uid !== ctx.uid) return { status: 'unavailable' };
    const fs = await import('firebase/firestore/lite');
    const db = fs.getFirestore(app);
    const rows: QueryRow[] = [];
    let after: string | null = null;
    let complete = false;

    for (let page = 0; page < CLINIC_QUERY_MAX_PAGES; page++) {
      if (!live() || auth.currentUser?.uid !== ctx.uid) return { status: 'unavailable' };
      const query: ReturnType<typeof fs.query> = fs.query(
        fs.collection(db, 'clinics', ctx.clinicId, table),
        fs.orderBy(fs.documentId()),
        ...(after === null ? [] : [fs.startAfter(after)]),
        fs.limit(CLINIC_QUERY_PAGE_SIZE),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const snapshot: Awaited<ReturnType<typeof fs.getDocs>> = await Promise.race([
        fs.getDocs(query),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('clinic query timeout')), CLINIC_QUERY_TIMEOUT_MS);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });

      if (!live() || auth.currentUser?.uid !== ctx.uid) return { status: 'unavailable' };
      for (const document of snapshot.docs) {
        rows.push(projectQueryRow(table, document.id, document.data() as Record<string, unknown>));
      }
      if (snapshot.size < CLINIC_QUERY_PAGE_SIZE || snapshot.docs.length === 0) {
        complete = true;
        break;
      }
      after = snapshot.docs[snapshot.docs.length - 1].id;
    }
    return { status: 'ok', rows, complete };
  } catch (error) {
    // A rule change or role change during the read is a denial, not an empty
    // result. Other failures are explicitly unavailable, never "no results".
    const code = (error as { code?: unknown } | null)?.code;
    return { status: code === 'permission-denied' ? 'denied' : 'unavailable' };
  }
}
