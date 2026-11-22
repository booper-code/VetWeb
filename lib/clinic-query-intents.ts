import { BILLING_DAY_MS, billingDayStartMs, billingLocalTime } from '@/lib/billing-values';
import { MAX_LIMIT, type Filter, type QueryPlan } from '@/lib/clinic-query';

const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function positiveCount(text: string, limit: number): number | null {
  const count = /^\d+$/.test(text) ? Number(text) : NUMBER_WORDS.indexOf(text) + 1;
  return Number.isSafeInteger(count) && count >= 1 && count <= limit ? count : null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const scheduled: Filter = { field: 'status', op: 'eq', value: 'scheduled' };
const appointmentFields = ['patientName', 'type', 'manilaDueTime', 'status'];
const byDueDate = [{ field: 'dueAt', direction: 'asc' as const }];

function dailyAppointments(start: number, earlier?: QueryPlan): QueryPlan {
  return {
    table: 'appointments', op: 'list', fields: earlier?.fields ?? appointmentFields, sort: earlier?.sort ?? byDueDate,
    ...(earlier?.limit !== undefined ? { limit: earlier.limit } : {}),
    filter: [
      ...(earlier?.filter ?? []).filter(filter => filter.field !== 'dueAt' && filter.field !== 'status'),
      scheduled,
      { field: 'dueAt', op: 'gte', value: iso(start) },
      { field: 'dueAt', op: 'lt', value: iso(start + BILLING_DAY_MS) },
    ],
  };
}

/** Unambiguous reads with parameters the app can resolve without a provider. */
export function localClinicReadPlans(prompt: string, last: QueryPlan | null, now: number): QueryPlan[] | null {
  const text = prompt.toLowerCase().trim().replace(/[?.!]+$/, '').replace(/\s+/g, ' ');
  const start = billingDayStartMs(now);
  const day = /^(?:(?:list|show(?: me)?) (?:the )?scheduled appointments(?: for)?|(?:what|which) appointments are scheduled) (today|tomorrow)(?:,? (?:asia\/)?manila(?: time)?)?$/.exec(text)?.[1];
  const followUpDay = /^(?:what about |and )(today|tomorrow)(?:,? (?:asia\/)?manila(?: time)?)?$/.exec(text)?.[1];
  const hasScheduledWindow = last?.table === 'appointments' && last.op === 'list' &&
    last.filter?.some(filter => filter.field === 'status' && filter.op === 'eq' && filter.value === 'scheduled') &&
    last.filter.some(filter => filter.field === 'dueAt');
  if (day || (followUpDay && hasScheduledWindow)) {
    return [dailyAppointments(start + ((day ?? followUpDay) === 'tomorrow' ? BILLING_DAY_MS : 0),
      !day && last ? last : undefined)];
  }

  const rank = /^(?:(?:which|show(?: me)?|list) (?:the )?)(\w+) (?:stocked )?(?:inventory )?items (?:have|with) the (lowest|highest) (?:quantity|stock|units)(?: on hand)?$/.exec(text);
  const limit = rank ? positiveCount(rank[1], MAX_LIMIT) : null;
  if (rank && limit !== null) return [{ table: 'inventory', op: 'rank', limit, includeTies: true,
    fields: ['itemName', 'stock'], sort: [{ field: 'stock', direction: rank[2] === 'lowest' ? 'asc' : 'desc' }] }];

  const expiry = /^(?:do we have (?:anything|any (?:items?|stock))|(?:show(?: me)?|list)(?: any)?) expired or expiring within (\w+) days?$/.exec(text);
  const days = expiry ? positiveCount(expiry[1], 365) : null;
  if (days !== null) {
    const today = billingLocalTime(now).slice(0, 10);
    const end = billingLocalTime(start + days * BILLING_DAY_MS).slice(0, 10);
    const base = { table: 'inventory', op: 'list', fields: ['itemName', 'stock', 'expiryDate'],
      sort: [{ field: 'expiryDate', direction: 'asc' }] } satisfies QueryPlan;
    const onHand: Filter = { field: 'stock', op: 'gt', value: 0 };
    return [
      { ...base, filter: [onHand, { field: 'expiryDate', op: 'lt', value: today }] },
      { ...base, filter: [onHand, { field: 'expiryDate', op: 'gte', value: today }, { field: 'expiryDate', op: 'lte', value: end }] },
    ];
  }

  if (/^(?:(?:which|what) follow[ -]?ups are overdue|(?:show(?: me)?|list)(?: the)? overdue follow[ -]?ups)(?:,? and (?:has outreach been logged|(?:show )?outreach status)| with outreach status)?$/.test(text)) {
    return [{ table: 'appointments', op: 'list', fields: ['patientName', 'manilaDueTime', 'outreachStatus'], sort: byDueDate,
      filter: [scheduled, { field: 'type', op: 'eq', value: 'Follow-up' }, { field: 'dueAt', op: 'lt', value: iso(start) }] }];
  }
  if (/^(?:are there any|how many|(?:show(?: me)?|list)(?: the)?) open payroll periods(?: are there)?$/.test(text)) {
    const filter: Filter[] = [{ field: 'status', op: 'eq', value: 'open' }];
    return [text.startsWith('how many') ? { table: 'payrollPeriods', op: 'count', filter }
      : { table: 'payrollPeriods', op: 'list', fields: ['startDate', 'endDate', 'status'], filter }];
  }
  const billing = /^how many (charge|payment) and (charge|payment) entries (?:are (?:recorded )?in|does) the billing ledger(?: have)?$/.exec(text);
  if (billing && billing[1] !== billing[2]) return billing.slice(1).map(kind => ({
    table: 'billingEntries', op: 'count', filter: [{ field: 'kind', op: 'eq', value: kind }],
  }));
  if (/^how many (?:consultations|visits) (?:have|include|contain) treatment (?:entries|lines)$/.test(text)) {
    return [{ table: 'consultations', op: 'count', filter: [{ field: 'treatmentCount', op: 'gt', value: 0 }] }];
  }
  return null;
}
