import type { InventoryItem } from '@/types';

export const BILLING_TIME_ZONE = 'Asia/Manila';
export const BILLING_OFFSET_MS = 8 * 60 * 60 * 1000;
export const BILLING_DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_BILLING_TIME_MS = Date.UTC(1991, 0, 1) - BILLING_OFFSET_MS;
export const PAYMENT_METHODS = ['cash', 'e-wallet', 'bank-transfer', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type BillingState = {
  lastEntryId: string;
  seq: number;
  openingMinor: number;
  balanceMinor: number;
  cutoffMs: number;
  cutoffKind: 'reviewed' | 'implicit-zero';
};

type ChargeLine = {
  itemCode: string;
  quantity: number;
  expectedRevision: number;
  unitPriceMinor: number;
};

export type BillingStockMove = { itemCode: string; quantityDelta: number };

export type BillingDraft =
  | { kind: 'opening'; verifiedMinor: number; source: string; cutoffMs: number; reason?: string }
  | { kind: 'opening-correction'; verifiedMinor: number; source: string; reason: string }
  | { kind: 'payment'; amountMinor: number; method: PaymentMethod; occurredAtMs: number; reference?: string; note?: string }
  | { kind: 'unitemized-settlement'; amountMinor: number; businessDayMs: number }
  | { kind: 'charge'; lines: ChargeLine[] }
  | { kind: 'reversal'; originalEntryId: string; reason: string; returnStock: boolean; expectedStockRevisions: Record<string, number> };

export type ResolvedChargeLine = ChargeLine & Pick<InventoryItem, 'itemName' | 'category' | 'stock'>;
export type ResolvedBillingDraft =
  | Exclude<BillingDraft, { kind: 'charge' | 'reversal' }>
  | { kind: 'charge'; lines: ResolvedChargeLine[] }
  | (Extract<BillingDraft, { kind: 'reversal' }> & {
    original: { kind: 'payment' | 'charge' | 'unitemized-settlement'; amountMinor: number; stockMoves: BillingStockMove[] };
  });

export type BillingTransition = {
  next: Omit<BillingState, 'lastEntryId'>;
  deltaMinor: number;
  stockMoves: BillingStockMove[];
};

export function parsePhpMinor(value: string): number {
  const match = /^(\d{1,14})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error('Enter a non-negative PHP amount with up to two decimal places.');
  const minor = Number(`${match[1]}${(match[2] ?? '').padEnd(2, '0')}`);
  if (!Number.isSafeInteger(minor)) throw new Error('This PHP amount is too large.');
  return minor;
}

export function readLegacyBalance(raw: unknown): { kind: 'valid'; minor: number } | { kind: 'invalid' } {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { kind: 'invalid' };
  try {
    return { kind: 'valid', minor: parsePhpMinor(String(raw)) };
  } catch {
    return { kind: 'invalid' };
  }
}

const validTime = (ms: number) => Number.isSafeInteger(ms) && ms >= MIN_BILLING_TIME_MS && ms < Date.UTC(10000, 0, 1) - BILLING_OFFSET_MS;

export function parseBillingLocalTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Enter a clinic date and time.');
  // Current Philippine standard time is UTC+08:00; historical daylight-saving dates are out of scope.
  const wallTime = new Date(`${value}:00.000Z`);
  const epoch = wallTime.getTime() - BILLING_OFFSET_MS;
  if (!validTime(epoch) || wallTime.toISOString().slice(0, 16) !== value) throw new Error('Enter a valid clinic date and time.');
  return epoch;
}

export function billingDayStartMs(value: number): number {
  if (!validTime(value)) throw new Error('Invalid clinic time.');
  return Math.floor((value + BILLING_OFFSET_MS) / BILLING_DAY_MS) * BILLING_DAY_MS - BILLING_OFFSET_MS;
}

export const parseBillingDay = (value: string) => parseBillingLocalTime(`${value}T00:00`);

export const billingLocalTime = (ms: number) => new Date(ms + BILLING_OFFSET_MS).toISOString().slice(0, 16);
export const formatBillingAmount = (minor: number) =>
  `PHP ${Math.floor(minor / 100).toLocaleString('en-PH')}.${String(minor % 100).padStart(2, '0')}`;

const minorAmount = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('The resulting balance must be a valid, non-negative PHP amount.');
  return value;
};
const requiredText = (value: string | undefined, label: string, limit: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} is required (up to ${limit} characters).`);
};

export function calculateBillingTransition(
  current: BillingState | null,
  rawLegacy: unknown,
  draft: ResolvedBillingDraft,
  nowMs: number,
): BillingTransition {
  if (!validTime(nowMs)) throw new Error('Invalid clinic clock.');
  const legacy = readLegacyBalance(rawLegacy);
  if (draft.kind === 'opening') {
    if (current) throw new Error('This opening balance has already been verified.');
    if (!validTime(draft.cutoffMs) || draft.cutoffMs > nowMs) throw new Error('The cutoff cannot be in the future.');
    requiredText(draft.source, 'The clinic record checked', 120);
    const openingMinor = minorAmount(draft.verifiedMinor);
    if (legacy.kind !== 'valid' || legacy.minor !== openingMinor || draft.reason !== undefined) {
      requiredText(draft.reason, 'Reason for the correction', 500);
    }
    return {
      next: { seq: 1, openingMinor, balanceMinor: openingMinor, cutoffMs: draft.cutoffMs, cutoffKind: 'reviewed' },
      deltaMinor: openingMinor,
      stockMoves: [],
    };
  }

  if (!current && (draft.kind !== 'charge' || legacy.kind !== 'valid' || legacy.minor !== 0)) {
    throw new Error('Verify the opening balance before recording charges or payments.');
  }
  const before = current?.balanceMinor ?? 0;
  const seq = (current?.seq ?? 0) + 1;
  const cutoffMs = current?.cutoffMs ?? billingDayStartMs(nowMs);
  const cutoffKind = current?.cutoffKind ?? 'implicit-zero';
  let openingMinor = current?.openingMinor ?? 0;
  let deltaMinor = 0;
  const stockMoves: BillingStockMove[] = [];

  switch (draft.kind) {
    case 'opening-correction':
      if (cutoffKind !== 'reviewed') throw new Error('Only a reviewed opening balance can be corrected.');
      requiredText(draft.source, 'The clinic record checked', 120);
      requiredText(draft.reason, 'Reason for the correction', 500);
      openingMinor = minorAmount(draft.verifiedMinor);
      deltaMinor = openingMinor - (current?.openingMinor ?? 0);
      break;
    case 'payment':
      if (!PAYMENT_METHODS.includes(draft.method)) throw new Error('Choose a payment method.');
      if (!validTime(draft.occurredAtMs) || draft.occurredAtMs > nowMs) throw new Error('Enter when the payment was received, not a future time.');
      if (draft.occurredAtMs < cutoffMs || (cutoffKind === 'reviewed' && draft.occurredAtMs === cutoffMs)) {
        throw new Error('That payment falls within the old balance period. Check the opening balance instead.');
      }
      if (!minorAmount(draft.amountMinor) || draft.amountMinor > before) throw new Error('Enter a payment amount between zero and the outstanding balance.');
      if ((draft.reference?.length ?? 0) > 120 || (draft.note?.length ?? 0) > 500) throw new Error('The payment reference or note is too long.');
      deltaMinor = -draft.amountMinor;
      break;
    case 'unitemized-settlement':
      if (before <= 0 || draft.amountMinor !== before) throw new Error('Review the current outstanding balance before marking it paid.');
      if (billingDayStartMs(draft.businessDayMs) !== draft.businessDayMs || draft.businessDayMs > nowMs) {
        throw new Error('Choose a valid Manila date that is not in the future.');
      }
      if (draft.businessDayMs < billingDayStartMs(cutoffMs)) throw new Error('That date falls within the old balance period. Check the opening balance instead.');
      deltaMinor = -before;
      break;
    case 'charge': {
      if (draft.lines.length < 1 || draft.lines.length > 2) throw new Error('Confirm one or two charge lines at a time. Nothing was saved.');
      const selected = new Set<string>();
      for (const line of draft.lines) {
        if (!line.itemCode || selected.has(line.itemCode) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
          throw new Error('Each charge must use a distinct item and a whole positive quantity.');
        }
        selected.add(line.itemCode);
        deltaMinor = minorAmount(deltaMinor + minorAmount(minorAmount(line.unitPriceMinor) * line.quantity));
        if (line.category === 'Medicine' || line.category === 'Supplies') {
          if (!Number.isSafeInteger(line.stock) || line.stock < line.quantity) throw new Error('There is not enough stock for this charge.');
          stockMoves.push({ itemCode: line.itemCode, quantityDelta: -line.quantity });
        } else if (line.category !== 'Service' && line.category !== 'Grooming') {
          throw new Error('That item cannot be billed.');
        }
      }
      break;
    }
    case 'reversal': {
      requiredText(draft.reason, 'Reason for reversal', 500);
      const { original, returnStock } = draft;
      if (returnStock && (original.kind !== 'charge' || !original.stockMoves.length)) {
        throw new Error('The original entry did not dispense stock.');
      }
      deltaMinor = (original.kind === 'charge' ? -1 : 1) * minorAmount(original.amountMinor);
      if (returnStock) {
        for (const move of original.stockMoves) {
          stockMoves.push({ itemCode: move.itemCode, quantityDelta: -move.quantityDelta });
        }
      }
      break;
    }
  }
  return {
    next: { seq, openingMinor, balanceMinor: minorAmount(before + deltaMinor), cutoffMs, cutoffKind },
    deltaMinor,
    stockMoves,
  };
}
