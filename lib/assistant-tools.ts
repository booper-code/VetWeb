export type ImportRange = { from: string; through: string };
export type ImportHistory = ImportRange & { count: number; recent: { batchId: string; at: string }[] };
export type PersonQuery = { name: string };
export type PersonMatch = { reference: string; name: string; patientName: string };
export type PersonMatches = { matches: PersonMatch[]; more: boolean };
export type AssistantToolMap = {
  inventory_import_history: { input: ImportRange; result: ImportHistory };
  find_person_by_name: { input: PersonQuery; result: PersonMatches };
};
export type AssistantToolId = keyof AssistantToolMap;
export type AssistantToolCall<K extends AssistantToolId = AssistantToolId> = {
  [T in K]: { kind: 'tool'; tool: T; input: AssistantToolMap[T]['input'] };
}[K];
export type AssistantToolReply = {
  [T in AssistantToolId]: { tool: T; result: AssistantToolMap[T]['result'] };
}[AssistantToolId];
export type AssistantToolError = 'invalid-request' | 'access-denied' | 'unavailable' | 'timeout';

export const ASSISTANT_IMPORT_PREVIEW_LIMIT = 10;
export const ASSISTANT_PERSON_LIMIT = 5;
const DAY = 86_400_000;
const MANILA_OFFSET_MS = 8 * 3_600_000;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const personName = /^[\p{L}\p{M}][\p{L}\p{M} .'\u2019-]{0,99}$/u;
const displayName = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'\u2019-]{0,99}$/u;
export const assistantResourceId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const assistantBatchId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const daySchema = { type: 'string', format: 'date' } as const;
const importDatesSchema = { from: daySchema, through: daySchema };

export function exactAssistantObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function dayStart(value: unknown) {
  if (typeof value !== 'string' || !isoDay.test(value) || value < '2000-01-01' || value > '2100-12-31') return NaN;
  const utc = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === value ? utc - MANILA_OFFSET_MS : NaN;
}

function validRange(from: unknown, through: unknown, now?: number): boolean {
  const start = dayStart(from), end = dayStart(through);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start < 31 * DAY &&
    (now === undefined || end <= now);
}

export function assistantRangeBounds(range: ImportRange) {
  return { start: new Date(dayStart(range.from)).toISOString(), end: new Date(dayStart(range.through) + DAY).toISOString() };
}

function recentRange(now: number): ImportRange {
  const local = now + MANILA_OFFSET_MS;
  return { from: new Date(local - 6 * DAY).toISOString().slice(0, 10), through: new Date(local).toISOString().slice(0, 10) };
}

export const assistantToolRegistry = {
  inventory_import_history: {
    access: 'owner', modelVisibility: 'summary-only', mutates: false,
    description: 'Count tracked CSV inventory creates within a Manila calendar range.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['from', 'through'],
      properties: importDatesSchema,
    },
    resultSchema: {
      type: 'object', additionalProperties: false, required: ['from', 'through', 'count', 'recent'],
      properties: { ...importDatesSchema, count: { type: 'integer', minimum: 0 }, recent: {
        type: 'array', maxItems: ASSISTANT_IMPORT_PREVIEW_LIMIT, items: {
          type: 'object', additionalProperties: false, required: ['batchId', 'at'],
          properties: { batchId: { type: 'string', format: 'uuid' }, at: { type: 'string', format: 'date-time' } },
        },
      } },
    },
    validateInput(value: unknown, now: number): value is ImportRange {
      return exactAssistantObject(value, ['from', 'through']) && validRange(value.from, value.through, now);
    },
    validateResult(value: unknown): value is ImportHistory {
      if (!exactAssistantObject(value, ['from', 'through', 'count', 'recent']) || !validRange(value.from, value.through) ||
        typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0 ||
        !Array.isArray(value.recent) || value.recent.length !== Math.min(value.count, ASSISTANT_IMPORT_PREVIEW_LIMIT)) return false;
      const start = dayStart(value.from), end = dayStart(value.through) + DAY;
      return value.recent.every(row => exactAssistantObject(row, ['batchId', 'at']) &&
        typeof row.batchId === 'string' && assistantBatchId.test(row.batchId) && typeof row.at === 'string' &&
        stamp.test(row.at) && Date.parse(row.at) >= start && Date.parse(row.at) < end);
    },
  },
  find_person_by_name: {
    access: 'member', modelVisibility: 'private', mutates: false,
    description: 'Find at most five patient records by an exact recorded owner name; UI only.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['name'],
      properties: { name: { type: 'string', minLength: 2, maxLength: 100 } },
    },
    resultSchema: {
      type: 'object', additionalProperties: false, required: ['matches', 'more'],
      properties: { more: { type: 'boolean' }, matches: {
        type: 'array', maxItems: ASSISTANT_PERSON_LIMIT, items: {
          type: 'object', additionalProperties: false, required: ['reference', 'name', 'patientName'],
          properties: { reference: { type: 'string', pattern: assistantResourceId.source },
            name: { type: 'string', maxLength: 100 }, patientName: { type: 'string', maxLength: 100 } },
        },
      } },
    },
    validateInput(value: unknown): value is PersonQuery {
      return exactAssistantObject(value, ['name']) && typeof value.name === 'string' && value.name.trim() === value.name &&
        value.name.length >= 2 && personName.test(value.name) &&
        !/\b(?:and|then|ignore|show|contact|phone|email|address|number|instructions|lab|payroll)\b/i.test(value.name);
    },
    validateResult(value: unknown): value is PersonMatches {
      if (!exactAssistantObject(value, ['matches', 'more']) || typeof value.more !== 'boolean' || !Array.isArray(value.matches) ||
        value.matches.length > ASSISTANT_PERSON_LIMIT || (value.more && value.matches.length !== ASSISTANT_PERSON_LIMIT)) return false;
      return new Set(value.matches.map(row => row?.reference)).size === value.matches.length &&
        value.matches.every(row => exactAssistantObject(row, ['reference', 'name', 'patientName']) &&
          typeof row.reference === 'string' && assistantResourceId.test(row.reference) &&
          typeof row.name === 'string' && personName.test(row.name) &&
          typeof row.patientName === 'string' && displayName.test(row.patientName));
    },
  },
} as const;

export function isAssistantToolId(value: unknown): value is AssistantToolId {
  return typeof value === 'string' && Object.hasOwn(assistantToolRegistry, value);
}

export function parseAssistantToolInput<K extends AssistantToolId>(tool: K, value: unknown, now = Date.now()): AssistantToolMap[K]['input'] | null {
  return assistantToolRegistry[tool].validateInput(value, now) ? value as AssistantToolMap[K]['input'] : null;
}

export function parseAssistantToolResult<K extends AssistantToolId>(tool: K, value: unknown): AssistantToolMap[K]['result'] | null {
  return assistantToolRegistry[tool].validateResult(value) ? value as AssistantToolMap[K]['result'] : null;
}

export function routeAssistantTool(prompt: string, now = Date.now()): AssistantToolCall | { kind: 'clarify'; message: string } | { kind: 'other' } {
  if (prompt.length > 400 || /[\r\n]/.test(prompt.trim())) return { kind: 'other' };
  const text = prompt.trim().replace(/[?.!]$/, '').trim();
  const name = /^(?:find (?:person )?|look up (?:person )?|hanapin si )(.+)$/i.exec(text);
  if (name) {
    const input = parseAssistantToolInput('find_person_by_name', { name: name[1].trim() }, now);
    return input ? { kind: 'tool', tool: 'find_person_by_name', input }
      : { kind: 'clarify', message: 'Enter the exact recorded owner name only. Contact details are not available to the assistant.' };
  }
  if (!/\b(?:how many|ilang)\b/i.test(text) || !/\b(?:imported|imports?|received|na-import)\b/i.test(text)) return { kind: 'other' };
  const explicit = /^(?:how many (?:csv )?(?:inventory )?items? (?:were )?imported|ilang (?:csv )?(?:inventory )?items? ang na-import) (?:from|mula) (\d{4}-\d{2}-\d{2}) (?:to|hanggang) (\d{4}-\d{2}-\d{2})$/i.exec(text);
  const recent = /^(?:how many (?:csv )?(?:inventory )?items? (?:were )?(?:recently )?imported(?: into inventory)?(?: recently| in the last 7 days)?|ilang (?:csv )?(?:inventory )?items? ang na-import(?: kamakailan)?)$/i.test(text);
  const input = explicit ? parseAssistantToolInput('inventory_import_history', { from: explicit[1], through: explicit[2] }, now)
    : recent ? recentRange(now) : null;
  return input ? { kind: 'tool', tool: 'inventory_import_history', input } : {
    kind: 'clarify', message: 'Do you mean CSV catalog items imported, rather than stock units received? Ask for recent imports or give two Manila dates (YYYY-MM-DD), at most 31 days apart.',
  };
}
