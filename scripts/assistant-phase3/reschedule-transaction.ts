import {
  createAppointmentReviewLab, FICTIONAL_CLINIC, hasFictionalReviewAccess, isFictionalReviewCurrent,
  matchesFictionalAppointment, type FictionalContext, type Review,
} from '@/scripts/assistant-phase3/appointment-review';

type Access = Omit<FictionalContext, 'appointment'>;
type Binding = Readonly<Pick<Access, 'clinicId' | 'actorId' | 'role' | 'generation'>>;
type Approval = { review: Review; binding: Binding; revision: number };
type AuditReceipt = Readonly<Binding & {
  operationId: string;
  action: Review['action'];
  appointmentId: string;
  beforeMs: number;
  afterMs: number;
  beforeRevision: number;
  afterRevision: number;
  appliedAtMs: number;
}>;
type DispatchResult =
  | { status: 'applied'; receipt: AuditReceipt }
  | { status: 'unknown'; operationId: string }
  | { status: 'not-applied'; reason: 'no-approval' | 'access' | 'expired' | 'record-changed' | 'audit-failed' | 'operation-conflict' };
type Fault = 'audit-failure' | 'lost-response' | 'duplicate-delivery';
type Reconciliation =
  | { status: 'applied'; receipt: AuditReceipt }
  | { status: 'not-found' | 'unavailable' };

const bindingOf = ({ clinicId, actorId, role, generation }: Access): Binding => ({ clinicId, actorId, role, generation });
const sameBinding = (a: Binding, b: Binding) =>
  a.clinicId === b.clinicId && a.actorId === b.actorId && a.role === b.role && a.generation === b.generation;

/** Local reference model only. No adapter, durable storage, or live side effects. */
export function createFictionalRescheduleRehearsal(now: () => number) {
  let access: Access = {
    clinicId: FICTIONAL_CLINIC, actorId: 'fixture-owner', role: 'owner', generation: 1, online: true, aiEnabled: true,
  };
  let state: {
    appointment: Readonly<NonNullable<FictionalContext['appointment']>>;
    receipts: Map<string, AuditReceipt>;
  } = {
    appointment: Object.freeze({
      id: 'DEMO-APT-201', revision: 1, scheduledAtMs: Date.parse('2026-11-24T10:30:00+08:00'), status: 'scheduled',
    }),
    receipts: new Map<string, AuditReceipt>(),
  };
  const context = (): FictionalContext => ({ ...access, appointment: state.appointment });

  function dispatch({ review, binding, revision }: Approval, fault?: Exclude<Fault, 'duplicate-delivery'>): DispatchResult {
    const scope = context();
    if (!hasFictionalReviewAccess(scope) || !sameBinding(scope, binding)) return { status: 'not-applied', reason: 'access' };

    // An already committed operation resolves to its original receipt, not a new mutation.
    const existing = state.receipts.get(review.operationId);
    if (existing) {
      if (!sameBinding(existing, binding)) return { status: 'not-applied', reason: 'access' };
      return existing.action === review.action && existing.appointmentId === review.appointmentId
        && existing.beforeMs === review.beforeMs && existing.afterMs === review.afterMs && existing.beforeRevision === revision
        ? { status: 'applied', receipt: existing } : { status: 'not-applied', reason: 'operation-conflict' };
    }

    const time = now();
    if (!isFictionalReviewCurrent(review, time)) return { status: 'not-applied', reason: 'expired' };
    const row = state.appointment;
    if (!matchesFictionalAppointment(row, review.beforeMs) || row.id !== review.appointmentId || row.revision !== revision) {
      return { status: 'not-applied', reason: 'record-changed' };
    }

    const receipt: AuditReceipt = Object.freeze({
      ...binding, operationId: review.operationId, action: review.action, appointmentId: row.id,
      beforeMs: row.scheduledAtMs, afterMs: review.afterMs, beforeRevision: revision, afterRevision: revision + 1, appliedAtMs: time,
    });
    const appointment = Object.freeze({ ...row, scheduledAtMs: review.afterMs, revision: receipt.afterRevision });
    if (fault === 'audit-failure') return { status: 'not-applied', reason: 'audit-failed' };
    const receipts = new Map(state.receipts).set(receipt.operationId, receipt);
    state = { appointment, receipts }; // Publish both together; nothing awaits inside this boundary.

    return fault === 'lost-response' ? { status: 'unknown', operationId: review.operationId } : { status: 'applied', receipt };
  }

  function openSession() {
    const lab = createAppointmentReviewLab(now);
    let approved: Approval | null = null;
    return {
      prepare(note: string) {
        approved = null;
        return lab.prepare(note, context());
      },
      confirm(operationId: string) {
        const scope = context();
        const result = lab.approve(operationId, scope);
        if (result.status === 'simulated-approval' && scope.appointment) {
          approved = { review: result.review, binding: bindingOf(scope), revision: scope.appointment.revision };
        }
        return result;
      },
      apply(operationId: string, fault?: Fault): DispatchResult {
        if (approved?.review.operationId !== operationId) return { status: 'not-applied', reason: 'no-approval' };
        const command = approved;
        approved = null;
        if (fault !== 'duplicate-delivery') return dispatch(command, fault);
        const first = dispatch(command);
        return first.status === 'applied' ? dispatch(command) : first;
      },
      dismiss() {
        approved = null;
        lab.dismiss();
      },
      reconcile(operationId: string): Reconciliation {
        const scope = context();
        if (!hasFictionalReviewAccess(scope)) return { status: 'unavailable' };
        const receipt = state.receipts.get(operationId);
        // Do not reveal a receipt (or whether there is one) across access bindings.
        return receipt && sameBinding(receipt, scope) ? { status: 'applied', receipt } : { status: 'not-found' };
      },
    };
  }

  return {
    openSession,
    setFixtureAccess(changes: Partial<Access>) { access = { ...access, ...changes }; },
    snapshot: () => ({ appointment: state.appointment, auditCount: state.receipts.size }),
  };
}
