import type { BillingEntry } from '@/lib/billing';
import { readLegacyBalance, type PaymentMethod } from '@/lib/billing-values';

export type CloseOriginal = Extract<BillingEntry, { kind: 'payment' | 'unitemized-settlement' | 'charge' }>;
export type CloseDayEntry = { entry: Exclude<CloseOriginal, { kind: 'charge' }>; reversed: boolean };
export type CloseCorrection = { entry: Extract<BillingEntry, { kind: 'reversal' }>; original: CloseOriginal };
export type CloseBalance = { id: string; ledgerMinor: unknown; legacyBalance: unknown };
export type CloseVisit = { id: string; patientId: string; patientName: string; occurredAtMs: number; linkedTreatment: boolean };
export type CloseRows = { entries: CloseDayEntry; corrections: CloseCorrection; balances: CloseBalance; visits: CloseVisit };
export type CloseKind = keyof CloseRows;

const zero = BigInt(0);
const centavosPerPeso = BigInt(100);

export function summarizeCollections(rows: readonly CloseDayEntry[]): Record<PaymentMethod, bigint> {
  const totals = { cash: zero, 'e-wallet': zero, 'bank-transfer': zero, card: zero, other: zero };
  for (const { entry, reversed } of rows) {
    if (entry.kind === 'payment' && !reversed) totals[entry.method] += BigInt(entry.amountMinor);
  }
  return totals;
}

export function summarizeBalances(rows: readonly CloseBalance[]) {
  const totals = { ledgerMinor: zero, unverifiedMinor: zero, unverifiedCount: 0, unknownCount: 0 };
  for (const { ledgerMinor, legacyBalance } of rows) {
    if (typeof ledgerMinor === 'number' && Number.isSafeInteger(ledgerMinor) && ledgerMinor >= 0) {
      totals.ledgerMinor += BigInt(ledgerMinor);
    } else {
      const legacy = readLegacyBalance(legacyBalance);
      if (legacy.kind === 'valid') {
        totals.unverifiedMinor += BigInt(legacy.minor);
        totals.unverifiedCount++;
      } else totals.unknownCount++;
    }
  }
  return totals;
}

export const formatCloseMinor = (minor: bigint) =>
  `PHP ${(minor / centavosPerPeso).toLocaleString('en-PH')}.${String(minor % centavosPerPeso).padStart(2, '0')}`;
