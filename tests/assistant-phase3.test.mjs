import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers/tsx-harness.mjs';

const { createAppointmentReviewLab, FICTIONAL_CLINIC } = loadSource('../../scripts/assistant-phase3/appointment-review.ts');
const { createFictionalRescheduleRehearsal } = loadSource('../../scripts/assistant-phase3/reschedule-transaction.ts');
const example = 'Reschedule DEMO-APT-201 to 2026-11-25 at 14:30';
const now = Date.parse('2026-11-21T06:00:00Z');
const scope = {
  clinicId: FICTIONAL_CLINIC, actorId: 'fixture-owner', role: 'owner', generation: 3, online: true, aiEnabled: true,
  appointment: { id: 'DEMO-APT-201', revision: 2, status: 'scheduled', scheduledAtMs: Date.parse('2026-11-24T10:30:00+08:00') },
};

test('only an exact fictional reschedule can be reviewed and approval cannot change its payload', () => {
  const lab = createAppointmentReviewLab(() => now);
  for (const note of ['Cancel DEMO-APT-201', 'Reschedule DEMO-APT-201 to tomorrow', example + '; then change billing']) {
    assert.equal(lab.prepare(note, scope).status, 'blocked');
  }
  const prepared = lab.prepare(example, scope);
  assert.equal(prepared.status, 'review');
  assert.ok(Object.isFrozen(prepared.review));
  assert.equal(prepared.review.afterMs, Date.parse('2026-11-25T14:30:00+08:00'));
  const accepted = lab.approve(prepared.review.operationId, scope);
  assert.equal(accepted.status, 'simulated-approval');
  assert.equal(accepted.review, prepared.review);
  assert.equal(scope.appointment.scheduledAtMs, prepared.review.beforeMs, 'simulation does not mutate the appointment');
  assert.equal(lab.approve(prepared.review.operationId, scope).reason, 'stale-review');
});

test('approval rejects changed role, actor, clinic, generation, AI enablement and target revisions', () => {
  for (const [changes, reason] of [
    [{ role: 'viewer' }, 'access'], [{ role: 'editor' }, 'access'], [{ actorId: 'fixture-editor' }, 'access'],
    [{ clinicId: 'unrecognized-clinic' }, 'access'], [{ generation: 4 }, 'access'], [{ online: false }, 'access'],
    [{ aiEnabled: false }, 'access'], [{ appointment: { ...scope.appointment, revision: 3 } }, 'record-changed'],
    [{ appointment: { ...scope.appointment, status: 'cancelled' } }, 'record-changed'],
    [{ appointment: { ...scope.appointment, scheduledAtMs: scope.appointment.scheduledAtMs + 60000 } }, 'record-changed'],
  ]) {
    const lab = createAppointmentReviewLab(() => now);
    const { review } = lab.prepare(example, scope);
    assert.equal(lab.approve(review.operationId, { ...scope, ...changes }).reason, reason);
    assert.equal(lab.approve(review.operationId, scope).reason, 'stale-review');
  }
});

test('dismissed, replaced, and expired operations cannot be approved', () => {
  let clock = now;
  const lab = createAppointmentReviewLab(() => clock);
  const first = lab.prepare(example, scope).review;
  const latest = lab.prepare(example, scope).review;
  assert.notEqual(first.operationId, latest.operationId);
  assert.equal(lab.approve(first.operationId, scope).reason, 'stale-review');
  const otherLab = createAppointmentReviewLab(() => clock);
  const other = otherLab.prepare(example, scope).review;
  assert.equal(otherLab.approve(latest.operationId, scope).reason, 'stale-review');
  assert.equal(otherLab.approve(other.operationId, scope).status, 'simulated-approval');
  lab.dismiss();
  assert.equal(lab.approve(latest.operationId, scope).reason, 'stale-review');
  const expiring = lab.prepare(example, scope).review;
  clock += 5 * 60 * 1000;
  assert.equal(lab.approve(expiring.operationId, scope).reason, 'expired');
});

function confirmFixture(session, note = example) {
  const prepared = session.prepare(note);
  assert.equal(prepared.status, 'review');
  const confirmed = session.confirm(prepared.review.operationId);
  assert.equal(confirmed.status, 'simulated-approval');
  return confirmed.review;
}

test('application requires confirmation; duplicate delivery posts exactly one fixture change and audit receipt', () => {
  const store = createFictionalRescheduleRehearsal(() => now);
  const session = store.openSession();
  const before = store.snapshot().appointment;
  const { review } = session.prepare(example);
  const id = review.operationId;
  assert.equal(session.apply(id).reason, 'no-approval');
  assert.equal(session.confirm(id).status, 'simulated-approval');
  assert.equal(store.snapshot().auditCount, 0);
  assert.equal(store.snapshot().appointment, before);

  const outcome = session.apply(id, 'duplicate-delivery');
  assert.equal(outcome.status, 'applied');
  const { receipt } = outcome;
  assert.ok(Object.isFrozen(receipt));
  assert.equal(receipt.operationId, id);
  assert.equal(receipt.actorId, scope.actorId);
  assert.equal(receipt.clinicId, FICTIONAL_CLINIC);
  assert.equal(receipt.beforeMs, before.scheduledAtMs);
  assert.equal(receipt.afterMs, review.afterMs);
  assert.equal(receipt.beforeRevision, before.revision);
  assert.equal(receipt.afterRevision, before.revision + 1);
  assert.equal(store.snapshot().appointment.revision, receipt.afterRevision);
  assert.equal(store.snapshot().appointment.scheduledAtMs, receipt.afterMs);
  assert.equal(store.snapshot().auditCount, 1);
  assert.equal(session.reconcile(id).receipt, receipt);
  assert.equal(session.apply(id).reason, 'no-approval');
});

test('a simulated audit failure rolls back both records and requires fresh review', () => {
  const store = createFictionalRescheduleRehearsal(() => now);
  const session = store.openSession();
  const before = store.snapshot().appointment;
  const { operationId } = confirmFixture(session);
  assert.equal(session.apply(operationId, 'audit-failure').reason, 'audit-failed');
  assert.equal(store.snapshot().appointment, before);
  assert.equal(store.snapshot().auditCount, 0);
  assert.equal(session.reconcile(operationId).status, 'not-found');
  assert.equal(session.apply(operationId).reason, 'no-approval');
  const fresh = confirmFixture(session);
  assert.notEqual(fresh.operationId, operationId);
  assert.equal(session.apply(fresh.operationId).status, 'applied');
});

test('after a lost response, a fresh session can reconcile without making another change', () => {
  const store = createFictionalRescheduleRehearsal(() => now);
  const session = store.openSession();
  const review = confirmFixture(session);
  const outcome = session.apply(review.operationId, 'lost-response');
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.operationId, review.operationId);
  const newSession = store.openSession();
  store.setFixtureAccess({ online: false });
  assert.equal(newSession.reconcile(outcome.operationId).status, 'unavailable');
  store.setFixtureAccess({ online: true, actorId: 'fixture-editor', role: 'editor' });
  assert.equal(newSession.reconcile(outcome.operationId).status, 'not-found');
  assert.equal(newSession.reconcile('unknown-id').status, 'not-found');
  store.setFixtureAccess({ actorId: 'fixture-owner', role: 'owner' });
  assert.equal(newSession.apply(outcome.operationId).reason, 'no-approval');
  const reconciled = newSession.reconcile(outcome.operationId);
  assert.equal(reconciled.status, 'applied');
  assert.equal(reconciled.receipt.afterMs, review.afterMs);
  assert.equal(store.snapshot().auditCount, 1);
});

test('competing approvals cannot both change the original appointment', () => {
  const store = createFictionalRescheduleRehearsal(() => now);
  const first = store.openSession();
  const second = store.openSession();
  const winner = confirmFixture(first);
  const loser = confirmFixture(second, 'Reschedule DEMO-APT-201 to 2026-11-26 at 09:00');
  assert.equal(first.apply(winner.operationId).status, 'applied');
  assert.equal(second.apply(loser.operationId).reason, 'record-changed');
  assert.equal(second.reconcile(loser.operationId).status, 'not-found');
  assert.equal(store.snapshot().appointment.scheduledAtMs, winner.afterMs);
  assert.equal(store.snapshot().auditCount, 1);
});

test('application rechecks access and expiry after confirmation, and dismissal discards approval', () => {
  for (const changes of [
    { generation: 2 }, { role: 'editor' }, { actorId: 'fixture-editor' },
    { clinicId: 'another-clinic' }, { aiEnabled: false }, { online: false },
  ]) {
    const store = createFictionalRescheduleRehearsal(() => now);
    const session = store.openSession();
    const { operationId } = confirmFixture(session);
    store.setFixtureAccess(changes);
    assert.equal(session.apply(operationId).reason, 'access');
    assert.equal(store.snapshot().auditCount, 0);
    assert.equal(store.snapshot().appointment.revision, 1);
  }
  let clock = now;
  const store = createFictionalRescheduleRehearsal(() => clock);
  const session = store.openSession();
  const first = confirmFixture(session);
  session.dismiss();
  assert.equal(session.apply(first.operationId).reason, 'no-approval');
  const second = confirmFixture(session);
  clock = second.expiresAtMs;
  assert.equal(session.apply(second.operationId).reason, 'expired');
  assert.equal(store.snapshot().auditCount, 0);
  assert.equal(store.snapshot().appointment.revision, 1);
});
