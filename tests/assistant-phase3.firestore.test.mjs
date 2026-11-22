import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import * as fs from 'firebase/firestore';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host ?? '')) throw new Error('Phase 3 requires its loopback Firestore emulator.');
const projectId = 'demo-vetcloud-phase3';
const clock = Date.parse('2026-11-21T06:00:00Z');
const beforeMs = Date.parse('2026-11-24T10:30:00+08:00');
const afterMs = Date.parse('2026-11-25T14:30:00+08:00');
const owner = 'fixture-owner';

async function setup(t) {
  const fixture = randomUUID();
  const root = `phase3Fixtures/${fixture}`;
  async function seed(rows) {
    const prefix = `projects/${projectId}/databases/(default)/documents/${root}`;
    const writes = Object.entries(rows).map(([path, data]) => ({
      update: {
        name: path === '' ? prefix : `${prefix}/${path}`,
        fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
          typeof value === 'string' ? { stringValue: value } : { integerValue: String(value) }])),
      },
    }));
    const response = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
    });
    if (!response.ok) assert.fail(`Fixture seed failed: ${response.status} ${await response.text()}`);
  }
  const clients = [];
  t.after(() => Promise.all(clients.map(deleteApp)));
  function connect(actorId = owner) {
    const app = initializeApp({ projectId, apiKey: 'fixture-key' }, randomUUID());
    clients.push(app);
    const db = fs.getFirestore(app);
    fs.connectFirestoreEmulator(db, '127.0.0.1', Number(host.split(':')[1]), { mockUserToken: { sub: actorId } });
    const ref = path => fs.doc(db, path ? `${root}/${path}` : root);
    const get = async path => (await fs.getDocFromServer(ref(path))).data();
    return {
      // Test-only stand-in for a trusted executor. The caller sends a key, not a patch.
      apply: (operationId, { failAudit = false, now = clock } = {}) => fs.runTransaction(db, async tx => {
        const scope = (await tx.get(ref(''))).data();
        const approval = (await tx.get(ref(`approvals/${operationId}`))).data();
        if (!scope || !approval || scope.actorId !== actorId || scope.role !== 'owner'
          || approval.actorId !== actorId || approval.generation !== scope.generation) return 'access';
        const receiptRef = ref(`receipts/${operationId}`);
        const existing = (await tx.get(receiptRef)).data();
        if (existing) {
          assert.equal(existing.beforeRevision, approval.revision);
          assert.equal(existing.afterMs, approval.afterMs);
          assert.equal(existing.actorId, actorId);
          return 'already-applied';
        }
        if (now >= approval.expiresAtMs) return 'expired';
        const appointmentRef = ref('appointments/visit');
        const appointment = (await tx.get(appointmentRef)).data();
        if (!appointment || appointment.revision !== approval.revision || appointment.scheduledAtMs !== approval.beforeMs
          || appointment.status !== 'scheduled') return 'stale';
        const afterRevision = approval.revision + 1;
        tx.update(appointmentRef, { revision: afterRevision, scheduledAtMs: approval.afterMs });
        tx.set(receiptRef, {
          actorId, operationId, beforeRevision: approval.revision, afterRevision, beforeMs: approval.beforeMs, afterMs: approval.afterMs,
          auditedAt: failAudit ? null : fs.serverTimestamp(),
        });
        return 'applied';
      }),
      appointment: () => get('appointments/visit'),
      receipt: operationId => get(`receipts/${operationId}`),
    };
  }
  const approval = { actorId: owner, generation: 1, revision: 1, beforeMs, afterMs, expiresAtMs: clock + 300_000 };
  await seed({
    '': { actorId: owner, role: 'owner', generation: 1 },
    'appointments/visit': { status: 'scheduled', revision: 1, scheduledAtMs: beforeMs },
    'approvals/first': approval,
    'approvals/second': { ...approval, afterMs: afterMs + 60_000 },
  });
  return { connect, seed };
}

const denied = error => error.code === 'permission-denied';

test('Firestore rejects a faulty audit write and rolls back the appointment', async t => {
  const { connect } = await setup(t);
  const client = connect();
  await assert.rejects(client.apply('first', { failAudit: true }), denied);
  assert.equal((await client.appointment()).revision, 1);
  assert.equal((await client.appointment()).scheduledAtMs, beforeMs);
  assert.equal(await client.receipt('first'), undefined);
});

test('Firestore serializes competing operations based on the same revision', async t => {
  const { connect } = await setup(t);
  const first = connect(), second = connect();
  const results = await Promise.all([first.apply('first'), second.apply('second')]);
  assert.deepEqual([...results].sort(), ['applied', 'stale']);
  const winner = results[0] === 'applied' ? 'first' : 'second';
  const loser = winner === 'first' ? 'second' : 'first';
  const receipt = await second.receipt(winner);
  const appointment = await second.appointment();
  assert.equal(receipt.operationId, winner);
  assert.equal(receipt.beforeRevision, 1);
  assert.equal(receipt.afterRevision, 2);
  assert.equal(appointment.revision, 2);
  assert.equal(appointment.scheduledAtMs, receipt.afterMs);
  assert.equal(await second.receipt(loser), undefined);
});

test('concurrent delivery of one operation key commits once and returns the recorded outcome', async t => {
  const { connect } = await setup(t);
  const first = connect(), second = connect();
  const results = await Promise.all([first.apply('first'), second.apply('first')]);
  assert.deepEqual([...results].sort(), ['already-applied', 'applied']);
  assert.equal((await second.appointment()).revision, 2);
  assert.equal((await second.receipt('first')).afterRevision, 2);
});

test('a new SDK client reads a receipt after a simulated lost reply; duplicate delivery does not write again', async t => {
  const { connect } = await setup(t);
  const first = connect();
  const dispatchAndDropReply = async () => {
    assert.equal(await first.apply('first'), 'applied');
    throw new Error('Simulated loss of the caller-facing response after commit');
  };
  await assert.rejects(dispatchAndDropReply(), /Simulated loss/);
  const retryClient = connect();
  const receipt = await retryClient.receipt('first');
  assert.equal(receipt.afterMs, afterMs);
  assert.ok(receipt.auditedAt.toMillis() > 0);
  assert.equal(await retryClient.apply('first'), 'already-applied');
  assert.deepEqual(await retryClient.receipt('first'), receipt);
  assert.equal((await retryClient.appointment()).revision, 2);
  await assert.rejects(connect('fixture-outsider').receipt('first'), denied);
});

test('the transaction rechecks the stored access binding and approval expiry', async t => {
  const { connect, seed } = await setup(t);
  const client = connect();
  assert.equal(await client.apply('first', { now: clock + 300_000 }), 'expired');
  await seed({ '': { actorId: owner, role: 'owner', generation: 2 } });
  assert.equal(await client.apply('first'), 'access');
  assert.equal((await client.appointment()).revision, 1);
  assert.equal(await client.receipt('first'), undefined);
});
