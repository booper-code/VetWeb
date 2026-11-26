import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createAuditCheckpoint, verifyAuditCheckpoint } from '../scripts/audit-checkpoint.mjs';

const keys = generateKeyPairSync('ed25519');
const snapshot = () => ({
  projectId: 'demo-vetcloud-rules',
  clinicId: 'fictional-clinic',
  capturedAt: '2026-11-26T12:00:00.000Z',
  collections: {
    auditEvents: [{ id: 'clinical-entry', fields: { actorUid: { stringValue: 'synthetic-user' }, seq: { integerValue: '1' } } }],
    billingEntries: [{ id: 'billing-entry', fields: { amountMinor: { integerValue: '1200' } } }],
    payrollLedger: [{ id: 'payroll-entry', fields: { note: { stringValue: 'Synthetic private note' } } }],
  }
});

test('retained evidence detects changed and deleted events and allows later appends', () => {
  const checkpoint = createAuditCheckpoint(snapshot(), keys.privateKey);
  const fresh = snapshot();
  fresh.capturedAt = '2026-11-27T12:00:00.000Z';
  fresh.collections.auditEvents[0].fields = { seq: { integerValue: '1' }, actorUid: { stringValue: 'synthetic-user' } };
  fresh.collections.billingEntries.push({ id: 'new-billing', fields: { seq: { integerValue: '2' } } });
  assert.deepEqual(verifyAuditCheckpoint(checkpoint, fresh, keys.publicKey), {
    ok: true, checked: 3, missing: 0, changed: 0, appended: 1
  });
  fresh.collections.auditEvents[0].fields.seq.integerValue = '2';
  fresh.collections.payrollLedger.pop();
  assert.deepEqual(verifyAuditCheckpoint(checkpoint, fresh, keys.publicKey), {
    ok: false, checked: 3, missing: 1, changed: 1, appended: 1
  });
  const serialized = JSON.stringify(checkpoint);
  assert.doesNotMatch(serialized, /Synthetic private note|synthetic-user|clinical-entry|payroll-entry|1200/);
});

test('verification rejects changed signed contents, an untrusted key, or the wrong snapshot', () => {
  const checkpoint = createAuditCheckpoint(snapshot(), keys.privateKey);
  const fresh = snapshot();
  assert.throws(() => verifyAuditCheckpoint({ ...checkpoint, payload: { ...checkpoint.payload, entries: [] } },
    fresh, keys.publicKey), /signature/i);
  assert.throws(() => verifyAuditCheckpoint(checkpoint, fresh, generateKeyPairSync('ed25519').publicKey), /signature/i);
  assert.throws(() => verifyAuditCheckpoint(checkpoint, { ...fresh, clinicId: 'other-clinic' }, keys.publicKey), /scope/i);
  assert.throws(() => verifyAuditCheckpoint(checkpoint, fresh, keys.publicKey), /newer/i);
  assert.throws(() => verifyAuditCheckpoint(checkpoint, { ...fresh, capturedAt: '2026-11-25T12:00:00.000Z' }, keys.publicKey), /newer/i);
  assert.throws(() => createAuditCheckpoint({ ...fresh, collections: { auditEvents: [] } }, keys.privateKey), /collection/i);
});
