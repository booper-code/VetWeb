// Reusable, scoped, read-only clinic query engine.
//
// This module is deliberately pure: it defines the allowlisted schema, a strict
// plan validator, a row projector and a generic executor. It never imports
// Firebase, the network or the AI provider. The provider is only allowed to
// *plan* a query over the schema below; the plan is executed locally against
// fresh, bounded, clinic-scoped reads and the verified result is rendered in
// the app. No clinic row, clinical note, owner record or financial/payroll
// value is ever placed in a provider request.

import { billingLocalTime } from '@/lib/billing-values';
import { isExpiryDate, isReorderDue, isStockedCategory } from '@/lib/stock-alert-values';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum';
export type RequiredRole = 'member' | 'editor' | 'owner';
export type FieldId = string;
export type Scalar = string | number | boolean;

export type ClinicTable = {
  label: string;
  role: RequiredRole;
  fields: Readonly<Record<FieldId, FieldType>>;
  enums?: Readonly<Record<FieldId, readonly string[]>>;
  /** Fields computed from a stored array rather than read directly. */
  derived?: readonly FieldId[];
};

/**
 * The complete allowlist. Only these collection names and field names may
 * appear in a plan; every other key is rejected. Collection names mirror the
 * clinicId-scoped Firestore subcollections already used by the app. Reads that
 * a role cannot perform are also denied by Firestore rules (defence in depth).
 */
export type TableId = 'patients' | 'inventory' | 'appointments' | 'consultations' | 'staff' |
  'billingEntries' | 'auditEvents' | 'payrollLedger' | 'payrollPeriods' | 'payProfiles';

export const CLINIC_TABLES: Record<TableId, ClinicTable> = {
  patients: {
    label: 'patients', role: 'member',
    fields: {
      id: 'string', name: 'string', species: 'string', breed: 'string',
      gender: 'enum', ownerName: 'string', status: 'enum', balance: 'number',
      weight: 'number', dischargedAt: 'string',
    },
    enums: {
      gender: ['Male', 'Female', 'Unknown'],
      status: ['Waiting', 'In Treatment', 'Confined', 'Ready for Pickup', 'Discharged'],
    },
  },
  inventory: {
    label: 'inventory items', role: 'member',
    fields: {
      itemCode: 'string', itemName: 'string', category: 'enum', stock: 'number',
      buyingPrice: 'number', sellingPrice: 'number', threshold: 'number', expiryDate: 'string',
      reorderDue: 'boolean',
    },
    enums: { category: ['Medicine', 'Supplies', 'Service', 'Grooming'] },
    derived: ['reorderDue'],
  },
  appointments: {
    label: 'appointments', role: 'member',
    fields: {
      id: 'string', patientId: 'string', patientName: 'string', type: 'enum', status: 'enum',
      dueAt: 'date', occurredAt: 'date', createdAt: 'date', durationMinutes: 'number',
      manilaDueTime: 'string', outreachStatus: 'enum',
    },
    enums: {
      type: ['Checkup', 'Vaccination', 'Deworming', 'Grooming', 'Surgery', 'Follow-up'],
      status: ['scheduled', 'completed', 'cancelled', 'no-show'],
      outreachStatus: ['Logged', 'Not logged', 'Could not verify'],
    },
    derived: ['manilaDueTime', 'outreachStatus'],
  },
  consultations: {
    label: 'visits / consultations', role: 'member',
    fields: {
      id: 'string', patientId: 'string', patient: 'string', client: 'string', type: 'string',
      status: 'enum', occurredAt: 'date', recordedAt: 'date', staffUid: 'string', staffName: 'string',
      treatmentCount: 'number',
    },
    enums: { status: ['Draft', 'Completed'] },
    derived: ['treatmentCount'],
  },
  staff: {
    label: 'staff members', role: 'member',
    fields: {
      id: 'string', name: 'string', kind: 'enum', position: 'string', active: 'boolean', hiredAt: 'string',
    },
    enums: { kind: ['veterinarian', 'employee'] },
  },
  billingEntries: {
    label: 'billing entries', role: 'editor',
    fields: {
      id: 'string', kind: 'string', patientId: 'string', amountMinor: 'number',
      balanceBeforeMinor: 'number', balanceAfterMinor: 'number', recordedAt: 'date', reversed: 'boolean',
    },
  },
  auditEvents: {
    label: 'audit events', role: 'owner',
    fields: {
      eventId: 'string', action: 'string', entityType: 'string', entityId: 'string',
      actorUid: 'string', seq: 'number', time: 'date',
    },
  },
  payrollLedger: {
    label: 'payroll ledger entries', role: 'owner',
    fields: {
      id: 'string', seq: 'number', type: 'enum', direction: 'enum', staffId: 'string', staffName: 'string',
      amount: 'number', periodId: 'string', createdAt: 'date',
    },
    enums: { type: ['advance', 'repayment', 'payout', 'adjustment'], direction: ['in', 'out'] },
  },
  payrollPeriods: {
    label: 'payroll periods', role: 'owner',
    fields: {
      id: 'string', startDate: 'string', endDate: 'string', status: 'enum',
      createdAt: 'date', closedAt: 'date',
    },
    enums: { status: ['open', 'closed'] },
  },
  payProfiles: {
    label: 'staff pay profiles', role: 'owner',
    fields: { staffId: 'string', payBasis: 'enum', rate: 'number' },
    enums: { payBasis: ['daily', 'monthly'] },
  },
};

export const CLINIC_TABLE_IDS = Object.freeze(Object.keys(CLINIC_TABLES) as TableId[]);

export const MAX_FILTERS = 8;
export const MAX_SORTS = 3;
export const MAX_FIELDS = 20;
export const MAX_IN_VALUES = 20;
export const MAX_RESULT_ROWS = 100;
export const MAX_LIMIT = 100;
export const MAX_PLAN_CHARS = 2400;

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notNull' | 'contains';
export const FILTER_OPS: readonly FilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notNull', 'contains'];
export type QueryOp = 'count' | 'list' | 'rank' | 'sum' | 'group';
export const QUERY_OPS: readonly QueryOp[] = ['count', 'list', 'rank', 'sum', 'group'];

export type Filter = { field: FieldId; op: FilterOp; value?: Scalar | Scalar[] };
export type SortKey = { field: FieldId; transform?: 'length'; direction: 'asc' | 'desc' };
export type QueryPlan = {
  table: TableId;
  op: QueryOp;
  fields?: FieldId[];
  filter?: Filter[];
  sort?: SortKey[];
  limit?: number;
  groupBy?: FieldId;
  sumField?: FieldId;
  includeTies?: boolean;
};
export type QueryRow = Record<string, string | number | boolean>;

export type QuerySource =
  | { status: 'ok'; rows: QueryRow[]; complete: boolean }
  | { status: 'denied' }
  | { status: 'unavailable' };

export type QueryOutcome = {
  status: 'ok' | 'partial' | 'denied' | 'unavailable';
  table: TableId;
  op: QueryOp;
  rows: QueryRow[];
  count: number;
  groups?: { key: string; count: number; sum?: number }[];
  scanned: number;
  complete: boolean;
  truncated: boolean;
  sum?: number;
  message: string;
};

/** Local replies. Only the plans, never outcomes, are used as planner context. */
export type ClinicQueryReply =
  | { kind: 'result'; outcome: QueryOutcome; plan: QueryPlan | null; notice?: string }
  | { kind: 'results'; results: { outcome: QueryOutcome; plan: QueryPlan }[] }
  | { kind: 'decline'; message: string; plan: null };

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key));
const hasAll = (value: Record<string, unknown>, keys: readonly string[]) =>
  keys.every(key => Object.hasOwn(value, key));
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const isTableId = (value: unknown): value is TableId =>
  typeof value === 'string' && Object.hasOwn(CLINIC_TABLES, value);

const fieldType = (table: TableId, field: FieldId): FieldType | null => {
  const fields = CLINIC_TABLES[table].fields;
  return Object.hasOwn(fields, field) ? fields[field] : null;
};

function validScalar(table: TableId, field: FieldId, value: unknown): value is Scalar {
  const type = fieldType(table, field);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'string' || value.length > 160 || /[\r\n]/.test(value)) return false;
  if (table === 'inventory' && field === 'expiryDate') return isExpiryDate(value);
  if (type === 'date') return Number.isFinite(Date.parse(value));
  if (type === 'enum') return (CLINIC_TABLES[table].enums?.[field] ?? []).includes(value);
  return true;
}

function validFilter(table: TableId, value: unknown): value is Filter {
  if (!isObject(value) || !hasOnly(value, ['field', 'op', 'value']) || !hasAll(value, ['field', 'op'])) return false;
  const { field, op } = value;
  if (typeof field !== 'string' || !fieldType(table, field)) return false;
  if (typeof op !== 'string' || !FILTER_OPS.includes(op as FilterOp)) return false;
  const hasValue = Object.hasOwn(value, 'value');
  if (op === 'notNull') return !hasValue;
  if (!hasValue) return false;
  const raw = value.value;
  if (op === 'in') {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_IN_VALUES) return false;
    return raw.every(item => validScalar(table, field, item));
  }
  return validScalar(table, field, raw);
}

function validSort(table: TableId, value: unknown): value is SortKey {
  if (!isObject(value) || !hasOnly(value, ['field', 'transform', 'direction']) || !hasAll(value, ['field', 'direction'])) return false;
  const { field, transform, direction } = value;
  if (typeof field !== 'string' || !fieldType(table, field)) return false;
  if (direction !== 'asc' && direction !== 'desc') return false;
  if (transform !== undefined && transform !== 'length') return false;
  if (transform === 'length' && fieldType(table, field) !== 'string') return false;
  return true;
}

/**
 * Validate an untrusted plan with exact keys and allowlisted identifiers.
 * Returns null for anything unknown; it never throws and never normalises.
 */
export function parseClinicQueryPlan(value: unknown): QueryPlan | null {
  if (!isObject(value) || !hasOnly(value, [
    'table', 'op', 'fields', 'filter', 'sort', 'limit', 'groupBy', 'sumField', 'includeTies',
  ]) || !hasAll(value, ['table', 'op'])) return null;
  const { table, op, fields, filter, sort, limit, groupBy, sumField, includeTies } = value;
  if (!isTableId(table) || typeof op !== 'string' || !QUERY_OPS.includes(op as QueryOp)) return null;

  if (fields !== undefined) {
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_FIELDS ||
      fields.some(field => typeof field !== 'string' || !fieldType(table, field)) ||
      new Set(fields).size !== fields.length) return null;
  }
  if (filter !== undefined) {
    if (!Array.isArray(filter) || filter.length > MAX_FILTERS || filter.some(item => !validFilter(table, item))) return null;
  }
  if (sort !== undefined) {
    if (!Array.isArray(sort) || sort.length > MAX_SORTS || sort.some(item => !validSort(table, item))) return null;
  }
  if (limit !== undefined && !(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) return null;
  if (groupBy !== undefined && (typeof groupBy !== 'string' || !fieldType(table, groupBy))) return null;
  if (sumField !== undefined && (typeof sumField !== 'string' || fieldType(table, sumField) !== 'number')) return null;
  if (includeTies !== undefined && typeof includeTies !== 'boolean') return null;
  if (op !== 'group' && groupBy !== undefined) return null;
  if (op !== 'sum' && op !== 'group' && sumField !== undefined) return null;
  if (op !== 'rank' && includeTies !== undefined) return null;
  if (op === 'rank' && (!sort || sort.length === 0)) return null;
  if (op === 'sum' && sumField === undefined) return null;
  if (op === 'group' && groupBy === undefined) return null;
  return {
    table, op: op as QueryOp,
    ...(fields ? { fields: fields as FieldId[] } : {}),
    ...(filter ? { filter: filter as Filter[] } : {}),
    ...(sort ? { sort: sort as SortKey[] } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(groupBy !== undefined ? { groupBy } : {}),
    ...(sumField !== undefined ? { sumField } : {}),
    ...(includeTies !== undefined ? { includeTies } : {}),
  };
}

const fieldLabel = (field: FieldId) => field
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/^./, letter => letter.toUpperCase())
  .toLowerCase();

/** Label independent results, including different filters on the same table. */
export function clinicQueryLabel(plan: QueryPlan): string {
  const operators: Record<FilterOp, string> = {
    eq: 'is', neq: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'is one of',
    notNull: 'is present', contains: 'contains',
  };
  const filters = plan.filter?.map(({ field, op, value }) =>
    `${fieldLabel(field)} ${operators[op]}${value === undefined ? '' : ` ${Array.isArray(value) ? value.join(', ') : String(value)}`}`,
  ).join('; ');
  return `${CLINIC_TABLES[plan.table].label} — ${plan.op}${filters ? ` (${filters})` : ''}`;
}

/** Human-readable schema handed to the planner. Contains no clinic data. */
export function buildClinicQuerySchema(): string {
  const tables = CLINIC_TABLE_IDS.map(id => {
    const table = CLINIC_TABLES[id];
    const fields = Object.entries(table.fields).map(([field, type]) => {
      const options = table.enums?.[field];
      return `${field}: ${type}${options ? ` (one of ${options.join(', ')})` : ''}`;
    }).join('; ');
    return `- ${id} [${table.role}] ${fields}${table.derived?.length ? ` (derived: ${table.derived.join(', ')})` : ''}`;
  }).join('\n');
  return [
    'Read-only clinic query schema. Identifiers are exact; unknown keys or fields are rejected.',
    tables,
    `Operations (op): ${QUERY_OPS.join(', ')}.`,
    'filter: {field, op, value}; ops: ' + FILTER_OPS.join(', ') + '; "in" takes an array, "notNull" omits value. Filters combine with AND.',
    'sort: {field, direction: asc|desc, transform?: length}; "length" measures a string field (use patients.name for longest/shortest name).',
    `limit: integer 1-${MAX_LIMIT} (default: 1 for rank, 20 otherwise). includeTies: boolean (rank only).`,
    'sumField: numeric field for sum/group. groupBy: field for group. fields: projection for list.',
    'Never include patient names, owner details, notes, financial values or any observed data in a plan. Only identifiers and literals from the question.',
  ].join('\n');
}

function timestampMs(raw: unknown): number {
  const stamped = raw as { toMillis?: () => number; toDate?: () => Date } | null;
  if (stamped && typeof stamped.toMillis === 'function') return stamped.toMillis();
  if (stamped && typeof stamped.toDate === 'function') return stamped.toDate().getTime();
  return typeof raw === 'string' ? Date.parse(raw) : NaN;
}

/** Convert one Firestore-like document into a projected, allowlisted row. */
export function projectQueryRow(table: TableId, id: string, data: Record<string, unknown>): QueryRow {
  const spec = CLINIC_TABLES[table];
  const row: QueryRow = {};
  for (const [field, type] of Object.entries(spec.fields)) {
    if (field === 'id') continue;
    const raw = data[field];
    switch (type) {
      case 'number':
        // Mirror patientFromDocument: modern balances live in billing.balanceMinor.
        if (table === 'patients' && field === 'balance') {
          const billing = data.billing as { balanceMinor?: unknown } | undefined;
          const minor = billing?.balanceMinor;
          row.balance = typeof minor === 'number' && Number.isSafeInteger(minor) && minor >= 0
            ? minor / 100 : typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
        } else row[field] = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        break;
      case 'boolean': row[field] = raw === true; break;
      case 'date': {
        const ms = timestampMs(raw);
        row[field] = Number.isFinite(ms) ? new Date(ms).toISOString() : '';
        break;
      }
      case 'enum': {
        const options = spec.enums?.[field] ?? [];
        const valid = typeof raw === 'string' && options.includes(raw) ? raw : '';
        // Match the app's fallbacks so group-by is not skewed by legacy rows.
        row[field] = valid || (table === 'patients' && field === 'status' ? 'Waiting'
          : table === 'patients' && field === 'gender' ? 'Unknown' : '');
        break;
      }
      default: row[field] = typeof raw === 'string' ? raw.slice(0, 200) : '';
    }
  }
  if (Object.hasOwn(spec.fields, 'id')) row.id = id;
  if (spec.derived?.includes('treatmentCount')) {
    row.treatmentCount = Array.isArray(data.treatments) ? data.treatments.length : 0;
  }
  if (table === 'inventory') {
    if (!isExpiryDate(row.expiryDate)) row.expiryDate = '';
    row.reorderDue = isStockedCategory(row.category) && typeof row.stock === 'number' &&
      typeof row.threshold === 'number' && isReorderDue(row.stock, row.threshold);
  }
  if (table === 'appointments') {
    const due = timestampMs(row.dueAt);
    row.manilaDueTime = Number.isFinite(due) ? billingLocalTime(due).replace('T', ' ') : '';
    if (row.type === 'Follow-up') {
      const contact = data.followUpContact as { dueAt?: unknown; contactedAt?: unknown; contactedBy?: unknown } | null | undefined;
      const contactDue = timestampMs(contact?.dueAt);
      row.outreachStatus = !Number.isFinite(due) ? 'Could not verify'
        : contact == null || (Number.isFinite(contactDue) && contactDue !== due) ? 'Not logged'
        : contactDue === due && Number.isFinite(timestampMs(contact.contactedAt)) && typeof contact.contactedBy === 'string'
          ? 'Logged' : 'Could not verify';
    }
  }
  return row;
}

function metric(row: QueryRow, sort: SortKey | undefined): string | number | boolean {
  if (!sort) return row.id ?? '';
  const value = row[sort.field] ?? '';
  if (sort.transform === 'length') return typeof value === 'string' ? value.length : 0;
  return value;
}

function compare(a: QueryRow, b: QueryRow, sort: SortKey): number {
  const av = metric(a, sort), bv = metric(b, sort);
  let result = 0;
  if (typeof av === 'number' && typeof bv === 'number') result = av - bv;
  else if (typeof av === 'boolean' && typeof bv === 'boolean') result = Number(av) - Number(bv);
  else {
    const as = String(av), bs = String(bv);
    if (sort.field.endsWith('At') || sort.field.endsWith('Date')) result = Date.parse(as) - Date.parse(bs);
    else result = as.localeCompare(bs);
  }
  // Deterministic ascending id tie-break; direction applies to the metric only.
  if (result === 0) return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  return sort.direction === 'asc' ? result : -result;
}

function speciesKey(value: Scalar): Scalar {
  if (typeof value !== 'string') return value;
  const key = value.trim().toLowerCase();
  if (['dog', 'dogs', 'canines'].includes(key)) return 'canine';
  if (['cat', 'cats', 'felines'].includes(key)) return 'feline';
  return key;
}

function matches(table: TableId, row: QueryRow, filter: Filter): boolean {
  const value = row[filter.field] ?? '';
  const same = (candidate: Scalar | undefined) => candidate !== undefined &&
    (table === 'patients' && filter.field === 'species'
      ? speciesKey(value) === speciesKey(candidate) : value === candidate);
  switch (filter.op) {
    case 'eq': return !Array.isArray(filter.value) && same(filter.value);
    case 'neq': return !Array.isArray(filter.value) && !same(filter.value);
    case 'in': return Array.isArray(filter.value) && filter.value.some(same);
    case 'notNull': return value !== '' && value !== null && value !== undefined;
    case 'contains': return typeof value === 'string' && typeof filter.value === 'string' &&
      value.toLowerCase().includes(filter.value.toLowerCase());
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if (typeof value === 'number' && typeof filter.value === 'number') {
        return filter.op === 'gt' ? value > filter.value : filter.op === 'gte' ? value >= filter.value
          : filter.op === 'lt' ? value < filter.value : value <= filter.value;
      }
      const dateField = fieldEndsInDate(filter.field);
      const left = dateField ? Date.parse(String(value)) : String(value);
      const right = dateField ? Date.parse(String(filter.value)) : String(filter.value);
      const ordering = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
      if (!Number.isFinite(ordering)) return false;
      return filter.op === 'gt' ? ordering > 0 : filter.op === 'gte' ? ordering >= 0
        : filter.op === 'lt' ? ordering < 0 : ordering <= 0;
    }
    default: return false;
  }
}
const fieldEndsInDate = (field: FieldId) => field.endsWith('At') || field.endsWith('Date');

const incompleteNote = ' The read limit was reached, so this is not a clinic-wide total.';

function rankMessage(plan: QueryPlan, rows: QueryRow[], complete: boolean): string {
  const sort = plan.sort?.[0];
  const field = sort?.field ?? 'id';
  const isLength = sort?.transform === 'length';
  const top = rows[0];
  if (!top) return `No ${CLINIC_TABLES[plan.table].label} matched${complete ? '' : ' among the records checked'}.`;
  if (plan.table === 'inventory' && field === 'stock') {
    const limit = plan.limit ?? 1;
    return `${rows.length} stocked items with the ${sort?.direction === 'asc' ? 'lowest' : 'highest'} stock` +
      (complete ? '.' : ' among the records checked.') +
      (rows.length < limit ? ` Fewer than ${limit} matched.` : rows.length > limit ? ' Ties at the cutoff are included.' : '');
  }
  const value = top[field];
  let statement: string;
  if (isLength) {
    const length = String(value).length;
    const adjective = sort?.direction === 'asc' ? 'shortest' : 'longest';
    statement = `The ${adjective} ${fieldLabel(field)} is "${String(value)}" (${length} characters).`;
    if (rows.length > 1) statement += ` ${rows.length} ${fieldLabel(field)}s share this length.`;
  } else {
    const adjective = sort?.direction === 'asc' ? 'lowest' : 'highest';
    statement = `The ${adjective} ${fieldLabel(field)} is ${String(value)}.`;
    if (rows.length > 1) statement += ` ${rows.length} records share it.`;
  }
  return statement + (complete ? '' : ' Only the first records were checked, so this is not necessarily the clinic-wide extreme.');
}

function resultMessage(plan: QueryPlan, outcome: Omit<QueryOutcome, 'message'>, matched: number): string {
  const hasFilter = (field: FieldId, op: FilterOp, value?: Scalar) => plan.filter?.some(filter =>
    filter.field === field && filter.op === op && (value === undefined || filter.value === value));
  const label = plan.table === 'payrollPeriods' && hasFilter('status', 'eq', 'open') ? 'open payroll periods'
    : plan.table === 'consultations' && hasFilter('treatmentCount', 'gt', 0) ? 'consultations with treatment entries'
    : plan.table === 'appointments' && hasFilter('type', 'eq', 'Follow-up') && plan.fields?.includes('outreachStatus') ? 'overdue follow-ups'
    : plan.table === 'appointments' && plan.fields?.includes('manilaDueTime') ? 'scheduled appointments (Manila time)'
    : plan.table === 'inventory' && hasFilter('expiryDate', 'lt') ? 'expired stocked items with recorded expiry dates'
    : plan.table === 'inventory' && hasFilter('expiryDate', 'gte') ? 'stocked items expiring in the requested Manila date window with recorded expiry dates'
    : CLINIC_TABLES[plan.table].label;
  const scope = outcome.complete ? '' : ' among the records checked';
  switch (plan.op) {
    case 'count':
      return `There ${outcome.count === 1 ? 'is' : 'are'} ${outcome.count.toLocaleString('en-PH')} ${label}${scope}.` +
        (outcome.complete ? '' : incompleteNote);
    case 'rank': return rankMessage(plan, outcome.rows, outcome.complete);
    case 'list':
      return (outcome.rows.length ? `Here are the matching ${label} (${outcome.rows.length} shown${scope}).`
        : `No matching ${label} found${scope}.`) + (outcome.complete ? '' : incompleteNote);
    case 'sum':
      if (plan.table === 'inventory' && plan.sumField === 'stock') {
        return `${(outcome.sum ?? 0).toLocaleString('en-PH')} stock units across ${matched} stocked entries${scope}; non-stock services and grooming are excluded.` +
          (outcome.complete ? '' : incompleteNote);
      }
      return `The total ${fieldLabel(plan.sumField ?? '')} across ${matched} ${label}${scope} is ${(outcome.sum ?? 0).toLocaleString('en-PH')}.` +
        (outcome.complete ? '' : incompleteNote);
    case 'group': {
      const groups = outcome.groups ?? [];
      const text = groups.map(group => `${String(group.key) || '(none)'} — ${group.count}` +
        (group.sum !== undefined ? ` (total ${group.sum.toLocaleString('en-PH')})` : '')).join('; ');
      return `By ${fieldLabel(plan.groupBy ?? '')}: ${text || 'no records'}${scope}.` + (outcome.complete ? '' : incompleteNote);
    }
  }
}

/** Execute a validated plan against a bounded, local, verified row set. */
export function executeClinicQuery(plan: QueryPlan, source: QuerySource): QueryOutcome {
  const base = { table: plan.table, op: plan.op, rows: [] as QueryRow[], count: 0, scanned: 0, complete: false, truncated: false };
  if (source.status === 'denied') {
    return { ...base, status: 'denied', message: 'That area is not available to your clinic role. No records were read.' };
  }
  if (source.status === 'unavailable') {
    return { ...base, status: 'unavailable', message: 'Clinic records could not be verified right now. This does not mean there were no results.' };
  }

  const stockScoped = plan.table === 'inventory' && (plan.sumField === 'stock' ||
    plan.sort?.some(sort => sort.field === 'stock') || plan.filter?.some(filter => filter.field === 'stock'));
  const filtered = source.rows.filter(row => (!stockScoped || isStockedCategory(row.category)) &&
    (plan.filter ?? []).every(filter => matches(plan.table, row, filter)));
  const sorted = [...filtered];
  for (const key of [...(plan.sort ?? [])].reverse()) sorted.sort((a, b) => compare(a, b, key));
  const complete = source.complete;
  let truncated = !complete;

  let rows: QueryRow[] = [];
  let groups: QueryOutcome['groups'];
  let sumTotal: number | undefined;
  switch (plan.op) {
    case 'count': {
      rows = [];
      break;
    }
    case 'list': {
      const fields = plan.fields ?? Object.keys(CLINIC_TABLES[plan.table].fields);
      rows = sorted.slice(0, plan.limit ?? 20).map(row =>
        Object.fromEntries(fields.map(field => [field, row[field] ?? ''])) as QueryRow);
      break;
    }
    case 'rank': {
      const take = plan.limit ?? 1;
      rows = sorted.slice(0, take);
      if (plan.includeTies !== false && rows.length) {
        const boundary = metric(rows[rows.length - 1], plan.sort?.[0]);
        for (const row of sorted.slice(take)) {
          if (metric(row, plan.sort?.[0]) === boundary) rows.push(row);
          else break;
        }
      }
      truncated ||= rows.length > MAX_RESULT_ROWS;
      rows = rows.slice(0, MAX_RESULT_ROWS);
      break;
    }
    case 'sum':
      sumTotal = sorted.reduce((total, row) => total + Number(row[plan.sumField ?? ''] ?? 0), 0);
      rows = [];
      break;
    case 'group': {
      const buckets = new Map<string, { count: number; sum: number }>();
      for (const row of sorted) {
        const key = String(row[plan.groupBy ?? ''] ?? '');
        const bucket = buckets.get(key) ?? { count: 0, sum: 0 };
        bucket.count++;
        if (plan.sumField) bucket.sum += Number(row[plan.sumField] ?? 0);
        buckets.set(key, bucket);
      }
      groups = [...buckets.entries()]
        .map(([key, value]) => ({ key, count: value.count, ...(plan.sumField ? { sum: value.sum } : {}) }))
        .sort((a, b) => b.count - a.count);
      rows = [];
      break;
    }
  }

  const outcome: Omit<QueryOutcome, 'message'> = {
    ...base,
    status: complete && !truncated ? 'ok' : 'partial',
    rows,
    count: plan.op === 'count' ? filtered.length : plan.op === 'group' ? (groups?.length ?? 0) : rows.length,
    ...(groups ? { groups } : {}),
    scanned: source.rows.length,
    complete,
    truncated,
    ...(sumTotal !== undefined ? { sum: sumTotal } : {}),
  };
  const message = resultMessage(plan, outcome, filtered.length);
  return { ...outcome, rows: plan.op === 'rank' && plan.fields
    ? rows.map(row => Object.fromEntries(plan.fields!.map(field => [field, row[field] ?? ''])))
    : rows, message };
}

/** Share one bounded source read per table without reordering the answers. */
export async function executeClinicQueries(
  plans: readonly QueryPlan[], readSource: (table: TableId) => Promise<QuerySource>,
): Promise<QueryOutcome[]> {
  const reads = new Map<TableId, Promise<QuerySource>>();
  return Promise.all(plans.map(async plan => {
    const source = reads.get(plan.table) ?? readSource(plan.table);
    reads.set(plan.table, source);
    return executeClinicQuery(plan, await source);
  }));
}

export function roleAllowed(role: 'owner' | 'editor' | 'viewer' | null, need: RequiredRole): boolean {
  if (!role) return false;
  if (need === 'member') return role === 'owner' || role === 'editor' || role === 'viewer';
  if (need === 'editor') return role === 'owner' || role === 'editor';
  return role === 'owner';
}
