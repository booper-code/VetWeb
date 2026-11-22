import type { BillingState } from '@/lib/billing-values';

export const BILLING_RECONCILIATION_LIMIT = 250;
export type LedgerRow = {
  id: string;
  seq: number;
  kind: string;
  amountMinor: number;
  balanceBeforeMinor: number;
  balanceAfterMinor: number;
  originalEntryId?: string;
};

export type BillingReconciliation =
  | { status: 'match'; balanceMinor: number; count: number }
  | { status: 'balance-mismatch'; storedMinor: number; computedMinor: number }
  | { status: 'history-mismatch' | 'unverified' | 'limit' | 'changed' };

export const billingLedgerKey = (state: BillingState | null) => state === null ? 'unverified' : JSON.stringify([
  state.seq, state.lastEntryId, state.balanceMinor, state.openingMinor, state.cutoffKind, state.cutoffMs,
]);

const validMinor = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Rebuild the balance in sequence order from entry kinds and minor-unit amounts, not saved balances. */
export function reconcileBillingLedger(state: BillingState | null, rows: readonly LedgerRow[]): BillingReconciliation {
  if (rows.length > BILLING_RECONCILIATION_LIMIT || (state && state.seq > BILLING_RECONCILIATION_LIMIT)) return { status: 'limit' };
  const invalid = { status: 'history-mismatch' } as const;
  if (!state) return rows.length ? invalid : { status: 'unverified' };
  if (state.seq < 1 || state.seq !== rows.length || !validMinor(state.openingMinor) || !validMinor(state.balanceMinor)
    || !['reviewed', 'implicit-zero'].includes(state.cutoffKind)) return invalid;
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  if (ordered.at(-1)?.id !== state.lastEntryId || ordered[0]?.kind !== (state.cutoffKind === 'reviewed' ? 'opening' : 'charge')) return invalid;
  const prior = new Map<string, LedgerRow>();
  const reversed = new Set<string>();
  let opening = 0;
  let balance = 0;
  for (const [index, row] of ordered.entries()) {
    if (!row.id || prior.has(row.id) || row.seq !== index + 1 || row.balanceBeforeMinor !== balance || !validMinor(row.amountMinor)) return invalid;
    const amount = row.amountMinor;
    switch (row.kind) {
      case 'opening':
        if (index !== 0) return invalid;
        opening = amount;
        balance = amount;
        break;
      case 'opening-correction':
        if (state.cutoffKind !== 'reviewed') return invalid;
        balance = balance - opening + amount;
        opening = amount;
        break;
      case 'charge':
        balance += amount;
        break;
      case 'payment':
      case 'unitemized-settlement':
        if (!amount || (row.kind === 'unitemized-settlement' && amount !== balance)) return invalid;
        balance -= amount;
        break;
      case 'reversal': {
        const original = row.originalEntryId && prior.get(row.originalEntryId);
        if (!original || reversed.has(original.id) || row.id !== `reverse_${original.id}` || amount !== original.amountMinor) return invalid;
        if (original.kind === 'charge') balance -= amount;
        else if (original.kind === 'payment' || original.kind === 'unitemized-settlement') balance += amount;
        else return invalid;
        reversed.add(original.id);
        break;
      }
      default: return invalid;
    }
    if (!validMinor(balance) || row.balanceAfterMinor !== balance) return invalid;
    prior.set(row.id, row);
  }
  if (opening !== state.openingMinor) return invalid;
  return balance === state.balanceMinor ? { status: 'match', count: rows.length, balanceMinor: balance }
    : { status: 'balance-mismatch', storedMinor: state.balanceMinor, computedMinor: balance };
}

/** Do not treat concurrent appends between server reads as ledger drift. */
export async function reviewBillingLedger(
  readState: () => Promise<BillingState | null>,
  readEntries: () => Promise<readonly LedgerRow[]>,
): Promise<BillingReconciliation> {
  const before = await readState();
  if (before && before.seq > BILLING_RECONCILIATION_LIMIT) return { status: 'limit' };
  const rows = await readEntries();
  const after = await readState();
  if (billingLedgerKey(before) !== billingLedgerKey(after)) return { status: 'changed' };
  return reconcileBillingLedger(after, rows);
}
