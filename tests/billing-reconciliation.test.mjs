import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers/tsx-harness.mjs';

const { reconcileBillingLedger, reviewBillingLedger, BILLING_RECONCILIATION_LIMIT } = loadSource('../../lib/billing-reconciliation.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const entry = (seq, id, kind, amountMinor, balanceBeforeMinor, balanceAfterMinor, extra = {}) =>
  ({ seq, id, kind, amountMinor, balanceBeforeMinor, balanceAfterMinor, ...extra });
const ledger = [
  entry(1, 'opening', 'opening', 10000, 0, 10000),
  entry(2, 'charge', 'charge', 2000, 10000, 12000),
  entry(3, 'payment', 'payment', 5000, 12000, 7000),
  entry(4, 'correction', 'opening-correction', 11000, 7000, 8000),
  entry(5, 'reverse_charge', 'reversal', 2000, 8000, 6000, { originalEntryId: 'charge' }),
  entry(6, 'settlement', 'unitemized-settlement', 6000, 6000, 0),
  entry(7, 'reverse_settlement', 'reversal', 6000, 0, 6000, { originalEntryId: 'settlement' }),
  entry(8, 'reverse_payment', 'reversal', 5000, 6000, 11000, { originalEntryId: 'payment' }),
];
const state = { seq: 8, lastEntryId: 'reverse_payment', openingMinor: 11000, balanceMinor: 11000, cutoffKind: 'reviewed', cutoffMs: 1000 };

test('rebuilds a complete ledger from amounts, including reviewed corrections and reverse signs', () => {
  assert.deepEqual(plain(reconcileBillingLedger(state, ledger.toReversed())), { status: 'match', count: 8, balanceMinor: 11000 });
  assert.deepEqual(plain(reconcileBillingLedger({ ...state, balanceMinor: 12000 }, ledger)), {
    status: 'balance-mismatch', storedMinor: 12000, computedMinor: 11000,
  });
  assert.deepEqual(plain(reconcileBillingLedger({ ...state, seq: 1, openingMinor: 0, balanceMinor: 2000, lastEntryId: 'charge', cutoffKind: 'implicit-zero' }, [
    entry(1, 'charge', 'charge', 2000, 0, 2000),
  ])), { status: 'match', count: 1, balanceMinor: 2000 });
});

test('missing, altered, and duplicated entries never look reconciled', () => {
  for (const rows of [
    ledger.slice(1),
    ledger.map(row => row.seq === 3 ? { ...row, seq: 2 } : row),
    ledger.map(row => row.seq === 3 ? { ...row, amountMinor: 4900 } : row),
    ledger.map(row => row.seq === 5 ? { ...row, originalEntryId: 'opening' } : row),
    ledger.map(row => row.seq === 8 ? { ...row, originalEntryId: 'settlement' } : row),
  ]) assert.equal(reconcileBillingLedger(state, rows).status, 'history-mismatch');
  assert.equal(reconcileBillingLedger({ ...state, openingMinor: 9000 }, ledger).status, 'history-mismatch');
  assert.equal(reconcileBillingLedger(null, []).status, 'unverified');
  assert.equal(reconcileBillingLedger(null, ledger).status, 'history-mismatch');
});

test('a changing head requires a retry, and oversized ledgers are explicitly unverified', async () => {
  let reads = 0;
  assert.equal((await reviewBillingLedger(async () => ++reads === 1 ? state : { ...state, seq: 9 }, async () => ledger)).status, 'changed');
  assert.equal((await reviewBillingLedger(async () => ({ ...state, seq: BILLING_RECONCILIATION_LIMIT + 1 }), async () => assert.fail('oversized scan'))).status, 'limit');
  assert.equal(reconcileBillingLedger(state, Array(BILLING_RECONCILIATION_LIMIT + 1).fill(ledger[0])).status, 'limit');
});

test('online check reads the server within the active scope and never writes', async () => {
  const reads = [];
  let inScope = true;
  const auth = { currentUser: { uid: 'fictional-owner' } };
  const metadata = { fromCache: false, hasPendingWrites: false };
  const firestore = {
    doc: (...parts) => parts, collection: (...parts) => parts,
    query: (...parts) => parts, where: (...parts) => parts, limit: max => max,
    async getDocFromServer(...args) {
      reads.push(args);
      return { exists: () => true, data: () => ({ billing: state }), metadata };
    },
    async getDocsFromServer(...args) {
      reads.push(args);
      return { docs: ledger.map(row => ({ id: row.id, data: () => row })), metadata };
    },
  };
  const { checkBillingReconciliation } = loadSource('../../lib/billing.ts', {
    '@/lib/firebase': { initializeFirebase: async () => ({ auth, firestore, db: 'mock' }) },
  });
  const check = () => checkBillingReconciliation('fictional', 'patient', () => { if (!inScope) throw new Error('Changed workspace'); });
  assert.equal((await check()).status, 'match');
  assert.deepEqual(reads, [
    [['mock', 'clinics', 'fictional', 'patients', 'patient']],
    [[['mock', 'clinics', 'fictional', 'billingEntries'], ['patientId', '==', 'patient'], BILLING_RECONCILIATION_LIMIT + 1]],
    [['mock', 'clinics', 'fictional', 'patients', 'patient']],
  ]);
  firestore.getDocsFromServer = async () => {
    inScope = false;
    return { docs: [], metadata };
  };
  await assert.rejects(check(), /Changed workspace/);
  inScope = true;
  firestore.getDocsFromServer = async () => {
    auth.currentUser = { uid: 'another-fictional-user' };
    return { docs: [], metadata };
  };
  await assert.rejects(check(), /Billing access changed/);
  firestore.getDocsFromServer = async () => ({ docs: [], metadata: { ...metadata, hasPendingWrites: true } });
  await assert.rejects(check(), /Could not verify the posted billing entries/);
});
