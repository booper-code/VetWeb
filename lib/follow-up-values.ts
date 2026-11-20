import type { Appointment, FollowUpContact } from '@/types';
import { BILLING_DAY_MS, billingDayStartMs } from '@/lib/billing-values';

export const FOLLOW_UP_PAGE_SIZE = 25;
export const followUpDayEndMs = (nowMs: number) => billingDayStartMs(nowMs) + BILLING_DAY_MS;

export function isDueFollowUp(row: Pick<Appointment, 'status' | 'type' | 'dueAt'>, nowMs: number) {
  return row.status === 'scheduled' && row.type === 'Follow-up' && Date.parse(row.dueAt) < followUpDayEndMs(nowMs);
}

export function currentFollowUpContact(row: Pick<Appointment, 'dueAt' | 'followUpContact'>): FollowUpContact | null {
  return row.followUpContact?.dueAt === row.dueAt ? row.followUpContact : null;
}
