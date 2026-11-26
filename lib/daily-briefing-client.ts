// Fresh, bounded, clinic-scoped reads for the local daily briefing.
//
// No provider call, no forwarded data, no writes. Every read uses the server
// (never a cached page), is scoped to the signed-in clinic, and is rechecked
// after the reads. The three sections are independent: one failing read does
// not hide the others or invent an empty result.

import type { ClinicRole, InventoryItem } from '@/types';
import { BILLING_DAY_MS, billingDayStartMs } from '@/lib/billing-values';
import { appointmentFromDocument } from '@/lib/appointments';
import { loadClinicScanPage } from '@/lib/clinic-pages';
import { initializeFirebase } from '@/lib/firebase';
import { buildDailyBriefing, type BriefingAppointment, type BriefingSection, type DailyBriefingOutcome } from '@/lib/daily-briefing';
import { readAssistantRole } from '@/lib/workspace-assistant-access';

const APPOINTMENT_READ_LIMIT = 50;
const STOCK_PAGE_LIMIT = 2;
const STAGING_PROJECT_ID = 'vetcloudpro-staging-6f819b';

class BriefingCanceled extends Error {}

export type DailyBriefingRequest = {
  clinicId: string;
  uid: string;
  /** Role from the live access watch, rechecked against a fresh server read. */
  role: ClinicRole | null;
  signal: AbortSignal;
  /** App-level workspace/account/online guard, rechecked before and after reads. */
  isCurrent: () => boolean;
  now?: number;
};

async function readSection<T>(read: () => Promise<BriefingSection<T>>): Promise<BriefingSection<T>> {
  try {
    return await read();
  } catch {
    return { state: 'unavailable', complete: false, rows: [] };
  }
}

/** Read the signed-in clinic's real staging records and build a local briefing. */
export async function loadDailyBriefing(request: DailyBriefingRequest): Promise<DailyBriefingOutcome> {
  const { clinicId, uid, role, signal } = request;
  const now = request.now ?? Date.now();
  const unavailable = (message = 'Today’s briefing could not be verified. Reopen the assistant and try again.') =>
    ({ kind: 'unavailable' as const, message });
  const denied = () => ({
    kind: 'denied' as const,
    message: 'Your clinic role or AI setting could not be verified for a briefing. No records are shown.',
  });
  const guard = () => {
    if (signal.aborted) throw new BriefingCanceled();
    if (!clinicId || clinicId === 'demo-clinic' || !uid || !request.isCurrent()) throw new Error('Briefing scope changed.');
  };

  try {
    guard();
    if (role !== 'owner' && role !== 'member') return denied();
    // Role and the clinic AI gate are verified from fresh server documents
    // before any collection read.
    const before = await readAssistantRole(clinicId, uid);
    guard();
    if (!before || before !== role) return denied();

    const { app, auth, db, firestore: fs } = await initializeFirebase();
    guard();
    if (app.options.projectId !== STAGING_PROJECT_ID || auth.currentUser?.uid !== uid) return unavailable();

    const dayStart = billingDayStartMs(now);
    const dayEnd = dayStart + BILLING_DAY_MS;
    const appointments = fs.collection(db, 'clinics', clinicId, 'appointments');

    const [scheduled, followUps, stock] = await Promise.all([
      // Both appointment reads are single-field `dueAt` ranges: they do not
      // depend on the Follow-up Queue's composite status/type/orderBy index.
      readSection<BriefingAppointment>(async () => {
        const snapshot = await fs.getDocsFromServer(fs.query(appointments,
          fs.where('dueAt', '>=', fs.Timestamp.fromMillis(dayStart)),
          fs.where('dueAt', '<', fs.Timestamp.fromMillis(dayEnd)),
          fs.orderBy('dueAt'), fs.limit(APPOINTMENT_READ_LIMIT)));
        return { state: 'ready', complete: snapshot.size < APPOINTMENT_READ_LIMIT,
          rows: snapshot.docs.map(doc => appointmentFromDocument(doc.id, doc.data())) };
      }),
      readSection<BriefingAppointment>(async () => {
        const snapshot = await fs.getDocsFromServer(fs.query(appointments,
          fs.where('dueAt', '<', fs.Timestamp.fromMillis(dayEnd)),
          fs.orderBy('dueAt', 'desc'), fs.limit(APPOINTMENT_READ_LIMIT)));
        return { state: 'ready', complete: snapshot.size < APPOINTMENT_READ_LIMIT,
          rows: snapshot.docs.map(doc => appointmentFromDocument(doc.id, doc.data())) };
      }),
      readSection<InventoryItem>(async () => {
        const rows: InventoryItem[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < STOCK_PAGE_LIMIT; page++) {
          guard();
          const result: { rows: InventoryItem[]; next: string | null } = await loadClinicScanPage(clinicId, 'inventory', cursor);
          guard();
          rows.push(...result.rows);
          cursor = result.next;
          if (!cursor) return { state: 'ready', complete: true, rows };
        }
        return { state: 'ready', complete: false, rows };
      }),
    ]);

    guard();
    if (auth.currentUser?.uid !== uid) return unavailable();
    // Role/account are rechecked after the reads; a change mid-read denies the
    // briefing rather than showing records read under the old access.
    const after = await readAssistantRole(clinicId, uid);
    guard();
    if (!after || after !== role) return denied();
    return { kind: 'ok', briefing: buildDailyBriefing({ now, access: 'ok', scheduled, followUps, stock }) };
  } catch (error) {
    return error instanceof BriefingCanceled ? unavailable('Briefing canceled.') : unavailable();
  }
}
