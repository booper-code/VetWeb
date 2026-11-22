import { reviewClerkDemoNote } from '@/lib/ai-clerk-demo';

export const FICTIONAL_CLINIC = 'phase3-fictional-clinic';
const fixtureAppointment = 'DEMO-APT-201';
const reviewLifetimeMs = 5 * 60 * 1000;

export type FictionalContext = {
  clinicId: string;
  actorId: string;
  role: 'owner' | 'editor' | 'viewer';
  generation: number;
  online: boolean;
  aiEnabled: boolean;
  appointment: { id: string; revision: number; scheduledAtMs: number; status: string } | null;
};

export type Review = Readonly<{
  operationId: string;
  action: 'reschedule';
  appointmentId: string;
  patientName: string;
  beforeMs: number;
  afterMs: number;
  timeZone: 'Asia/Manila';
  issuedAtMs: number;
  expiresAtMs: number;
}>;

type Blocked = { status: 'blocked'; reason: 'access' | 'unsupported' | 'stale-review' | 'record-changed' | 'expired' };
const blocked = (reason: Blocked['reason']): Blocked => ({ status: 'blocked', reason });
export const hasFictionalReviewAccess = (scope: FictionalContext) => scope.clinicId === FICTIONAL_CLINIC &&
  ['fixture-owner', 'fixture-editor'].includes(scope.actorId) &&
  (scope.role === 'owner' || scope.role === 'editor') && scope.online === true && scope.aiEnabled === true &&
  Number.isSafeInteger(scope.generation) && scope.generation >= 0;
export const matchesFictionalAppointment = (row: FictionalContext['appointment'], beforeMs: number) =>
  row?.id === fixtureAppointment && row.status === 'scheduled' &&
  Number.isSafeInteger(row.revision) && row.revision >= 0 && row.scheduledAtMs === beforeMs;

export const isFictionalReviewCurrent = (review: Review, time: number) =>
  Number.isFinite(time) && time >= review.issuedAtMs && time < review.expiresAtMs;

/** Fictional rehearsal only. No storage, provider, clinical account or write callback. */
export function createAppointmentReviewLab(now: () => number = Date.now) {
  let active: {
    review: Review; actorId: string; role: FictionalContext['role']; generation: number; revision: number;
  } | null = null;

  function prepare(note: string, scope: FictionalContext): Blocked | { status: 'review'; review: Review } {
    active = null;
    if (!hasFictionalReviewAccess(scope)) return blocked('access');
    const result = reviewClerkDemoNote(note);
    if (result.kind !== 'proposal' || result.proposal.action !== 'reschedule') return blocked('unsupported');
    const proposal = result.proposal;
    const issuedAt = now();
    if (!Number.isFinite(issuedAt) || proposal.scheduledAtMs <= issuedAt) return blocked('unsupported');
    const row = scope.appointment;
    if (!row || !matchesFictionalAppointment(row, proposal.previousAtMs)) return blocked('record-changed');
    const review: Review = Object.freeze({
      operationId: `fictional-review-${crypto.randomUUID()}`, action: proposal.action, appointmentId: proposal.appointmentId,
      patientName: proposal.patientName, beforeMs: proposal.previousAtMs, afterMs: proposal.scheduledAtMs, timeZone: 'Asia/Manila',
      issuedAtMs: issuedAt, expiresAtMs: Math.min(issuedAt + reviewLifetimeMs, proposal.scheduledAtMs),
    });
    active = { review, actorId: scope.actorId, role: scope.role, generation: scope.generation, revision: row.revision };
    return { status: 'review', review };
  }

  function approve(operationId: string, scope: FictionalContext): Blocked | { status: 'simulated-approval'; review: Review } {
    if (active?.review.operationId !== operationId) return blocked('stale-review');
    const selected = active;
    active = null; // A matching confirmation is one-use, including rejections.
    if (!hasFictionalReviewAccess(scope) || scope.actorId !== selected.actorId || scope.role !== selected.role || scope.generation !== selected.generation) {
      return blocked('access');
    }
    if (!isFictionalReviewCurrent(selected.review, now())) {
      return blocked('expired');
    }
    const row = scope.appointment;
    if (!row || !matchesFictionalAppointment(row, selected.review.beforeMs) || row.revision !== selected.revision) return blocked('record-changed');
    return { status: 'simulated-approval', review: selected.review };
  }

  return { prepare, approve, dismiss: () => { active = null; } };
}
