// Deterministic, local front-desk daily briefing.
//
// This module is pure: it never calls a provider, never forwards data, never
// writes and never imports Firebase. All clinic facts come from the caller's
// fresh, bounded, clinic-scoped reads. Each section keeps an explicit state so
// an unavailable read is never reported as "no results" and a partial read is
// never reported as a clinic-wide all-clear.

import type { Appointment, InventoryItem } from '@/types';
import { BILLING_DAY_MS, billingDayStartMs, billingLocalTime } from '@/lib/billing-values';
import { currentFollowUpContact, isDueFollowUp } from '@/lib/follow-up-values';
import { manilaStockDay, stockAlertFor, type StockAlert } from '@/lib/stock-alert-values';

type StockAlertReason = StockAlert['reasons'][number];

export const DAILY_BRIEFING_MAX_CHARS = 1600;
export const DAILY_BRIEFING_SECTION_LIMIT = 5;

export type BriefingState = 'ready' | 'unavailable' | 'denied';
export type BriefingSection<T> = {
  state: BriefingState;
  /** false means the bounded read hit its limit; more matching rows may exist. */
  complete: boolean;
  rows: readonly T[];
};

export type BriefingAppointment = Pick<Appointment, 'patientName' | 'type' | 'status' | 'dueAt' | 'followUpContact'>;

export type DailyBriefingInput = {
  now: number;
  access: 'ok' | 'denied';
  scheduled: BriefingSection<BriefingAppointment>;
  followUps: BriefingSection<BriefingAppointment>;
  stock: BriefingSection<InventoryItem>;
};

export type ScheduledEntry = { patient: string; type: string; time: string };
export type FollowUpEntry = {
  patient: string;
  date: string;
  timing: 'overdue' | 'due today';
  outreach: 'logged' | 'not logged';
};
export type StockEntry = {
  item: string;
  stock: number;
  threshold: number;
  reasons: StockAlertReason[];
  expiryDate?: string;
};

export type DailyBriefing = {
  today: string;
  states: { scheduled: BriefingState; followUps: BriefingState; stock: BriefingState };
  /** Independent per-section read completeness; false means a partial read. */
  complete: { scheduled: boolean; followUps: boolean; stock: boolean };
  allComplete: boolean;
  /** Matching rows beyond the display cap, per section. */
  hidden: { scheduled: number; followUps: number; stock: number };
  scheduled: ScheduledEntry[];
  followUps: FollowUpEntry[];
  stock: StockEntry[];
  text: string;
};

export type DailyBriefingOutcome =
  | { kind: 'ok'; briefing: DailyBriefing }
  | { kind: 'denied'; message: string }
  | { kind: 'unavailable'; message: string };

const clean = (value: unknown, max = 60): string => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || '(unnamed)';
};

const stockLabel = (entry: StockEntry): string => {
  const labels = entry.reasons.map(reason => {
    if (reason === 'reorder') return entry.stock === 0 ? 'out of stock' : `low stock: ${entry.stock} left`;
    if (reason === 'expired') return `expired${entry.expiryDate ? ` ${entry.expiryDate}` : ''}`;
    if (reason === 'expires-today') return 'expires today';
    return `expiring soon${entry.expiryDate ? ` ${entry.expiryDate}` : ''}`;
  });
  return `${entry.item} (${labels.join(', ')})`;
};

type RenderInput = Omit<DailyBriefing, 'text'>;

function renderSection(view: {
  label: string;
  state: BriefingState;
  present: string;
  hidden: number;
  complete: boolean;
  unavailable: string;
}): string {
  if (view.state === 'denied') return `${view.label}: access could not be verified.`;
  if (view.state === 'unavailable') return `${view.label}: ${view.unavailable}`;
  if (!view.present) {
    return `${view.label}: none found in the checked records${view.complete ? '' : '; the read was partial'}. This is not a clinic-wide all-clear.`;
  }
  const hidden = view.hidden > 0 ? `; ${view.hidden} more not shown` : '';
  const partial = view.complete ? '' : '; partial read, more may exist';
  return `${view.label}: ${view.present}${hidden}${partial}.`;
}

/** Render a bounded, plain-text briefing from already-normalized entries. */
export function renderDailyBriefing(value: RenderInput): string {
  const scheduled = value.scheduled.map(row => `${row.patient} · ${row.type} ${row.time}`).join('; ');
  const followUps = value.followUps.map(row =>
    `${row.patient} (${row.timing}${row.timing === 'overdue' ? ` since ${row.date}` : ''}, ${row.outreach === 'logged' ? 'outreach logged' : 'no outreach logged yet'})`,
  ).join('; ');
  const stock = value.stock.map(stockLabel).join('; ');
  const lines = [
    `Daily front-desk briefing for ${value.today} (Asia/Manila).`,
    renderSection({
      label: 'Scheduled today', state: value.states.scheduled, present: scheduled,
      hidden: value.hidden.scheduled, complete: value.complete.scheduled,
      unavailable: 'could not be verified. This does not mean there were no results.',
    }),
    renderSection({
      label: 'Follow-ups', state: value.states.followUps, present: followUps,
      hidden: value.hidden.followUps, complete: value.complete.followUps,
      unavailable: 'could not be verified. This does not mean nobody needs checking.',
    }),
    renderSection({
      label: 'Stock alerts', state: value.states.stock, present: stock,
      hidden: value.hidden.stock, complete: value.complete.stock,
      unavailable: 'could not be verified. This does not mean there were no alerts.',
    }),
    'Scheduling and stock check only, not a chart review. No messages sent or records changed. Open the normal screens to review or act on any item.',
  ];
  let text = lines.join('\n');
  if (text.length > DAILY_BRIEFING_MAX_CHARS) {
    const suffix = '\nBriefing shortened; open the normal screens for the full list.';
    const head = text.slice(0, DAILY_BRIEFING_MAX_CHARS - suffix.length).replace(/\s+\S*$/, '');
    text = `${head}${suffix}`;
  }
  return text;
}

/** Normalize fresh reads into a deterministic briefing with explicit states. */
export function buildDailyBriefing(input: DailyBriefingInput): DailyBriefing {
  const denied = input.access === 'denied';
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const today = manilaStockDay(new Date(now));
  const dayStart = billingDayStartMs(now);
  const dayEnd = dayStart + BILLING_DAY_MS;

  const states = {
    scheduled: denied ? 'denied' as const : input.scheduled.state,
    followUps: denied ? 'denied' as const : input.followUps.state,
    stock: denied ? 'denied' as const : input.stock.state,
  };
  const scheduledRows = states.scheduled !== 'ready' ? [] : input.scheduled.rows
    .filter(row => row.status === 'scheduled' && Number.isFinite(Date.parse(row.dueAt)) &&
      Date.parse(row.dueAt) >= dayStart && Date.parse(row.dueAt) < dayEnd)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.patientName.localeCompare(b.patientName));
  const followUpRows = states.followUps !== 'ready' ? [] : input.followUps.rows
    .filter(row => isDueFollowUp(row, now) && Number.isFinite(Date.parse(row.dueAt)))
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.patientName.localeCompare(b.patientName));
  const stockRows = states.stock !== 'ready' ? [] : input.stock.rows
    .map(item => ({ item, alert: stockAlertFor(item, today) }))
    .filter(entry => entry.alert !== null)
    .sort((a, b) => a.item.itemName.localeCompare(b.item.itemName));

  const hidden = {
    scheduled: Math.max(0, scheduledRows.length - DAILY_BRIEFING_SECTION_LIMIT),
    followUps: Math.max(0, followUpRows.length - DAILY_BRIEFING_SECTION_LIMIT),
    stock: Math.max(0, stockRows.length - DAILY_BRIEFING_SECTION_LIMIT),
  };
  const complete = {
    scheduled: states.scheduled === 'ready' && input.scheduled.complete,
    followUps: states.followUps === 'ready' && input.followUps.complete,
    stock: states.stock === 'ready' && input.stock.complete,
  };
  const allComplete = Object.values(complete).every(Boolean);

  const sections = {
    today,
    states,
    complete,
    allComplete,
    hidden,
    scheduled: scheduledRows.slice(0, DAILY_BRIEFING_SECTION_LIMIT).map(row => ({
      patient: clean(row.patientName), type: clean(row.type, 30),
      time: billingLocalTime(Date.parse(row.dueAt)).replace('T', ' '),
    })),
    followUps: followUpRows.slice(0, DAILY_BRIEFING_SECTION_LIMIT).map(row => ({
      patient: clean(row.patientName),
      date: billingLocalTime(Date.parse(row.dueAt)).slice(0, 10),
      timing: Date.parse(row.dueAt) < dayStart ? 'overdue' as const : 'due today' as const,
      outreach: currentFollowUpContact(row) ? 'logged' as const : 'not logged' as const,
    })),
    stock: stockRows.slice(0, DAILY_BRIEFING_SECTION_LIMIT).map(({ item, alert }) => ({
      item: clean(item.itemName),
      stock: item.stock,
      threshold: item.threshold,
      reasons: alert!.reasons,
      ...(alert!.expiryDate ? { expiryDate: alert!.expiryDate } : {}),
    })),
  };
  return { ...sections, text: renderDailyBriefing(sections) };
}
