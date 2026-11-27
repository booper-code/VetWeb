// Provider-neutral workspace chat transport.
//
// The localhost/staging assistant uses the saved provider to plan queries
// without sending clinic rows. The earlier sample transport below remains for
// fixture tests only and is not used by the workspace popup.

import { getProvider, loadAIConfig, type AIConfig, type AIProvider } from '@/lib/ai';
import { billingDayStartMs } from '@/lib/billing-values';
import { localClinicReadPlans } from '@/lib/clinic-query-intents';
import { currentFollowUpContact, isDueFollowUp } from '@/lib/follow-up-values';
import {
  buildClinicQuerySchema, CLINIC_TABLE_IDS, FILTER_OPS, MAX_LIMIT, MAX_PLAN_CHARS, parseClinicQueryPlan,
  QUERY_OPS, type QueryOp, type QueryPlan,
} from '@/lib/clinic-query';
import type { Appointment } from '@/types';

const sample = [
  ['QA-MED-001', 'Sample tablet pack', 'Medicine', 24],
  ['QA-MED-002', 'Sample ear rinse', 'Medicine', 3],
  ['QA-SUP-001', 'Sample gauze, 10-pack', 'Supplies', 40],
  ['QA-SUP-002', 'Sample exam gloves', 'Supplies', 0],
  ['QA-SUP-003', 'Sample bandage roll', 'Supplies', 12],
  ['QA-SRV-001', 'Sample wellness exam', 'Service', null],
  ['QA-SRV-002', 'Sample follow-up visit', 'Service', null],
  ['QA-GRM-001', 'Sample bath and brush', 'Grooming', null],
  ['QA-GRM-002', 'Sample nail trim', 'Grooming', null],
] as const;

export type WorkspaceAIChatTurn = { question: string; answer: string };
export const workspaceAIHistoryLimit = 4;
export const workspaceAISampleReadLimit = sample.length + 1;
export const workspaceAIPreviewAvailable = () => process.env.NODE_ENV === 'development' &&
  typeof window !== 'undefined' && window.location.origin === 'http://localhost:3000';

export function matchesWorkspaceAISample(rows: readonly { id: string; itemName: unknown; category: unknown; stock: unknown }[]) {
  if (rows.length !== sample.length) return false;
  const byId = new Map(rows.map(row => [row.id, row]));
  return sample.every(([id, name, category, stock]) => {
    const row = byId.get(id);
    // The CSV importer stores 999 for services and grooming; their stock is not evidence.
    return row?.itemName === name && row.category === category && (stock === null || row.stock === stock);
  });
}

const sampleEvidence = sample.map(([, name, category, stock]) => ({ name, category, stock }));

// These are the four fictional patient records created in the localhost staging clinic.
const samplePatients = new Map([
  ['PAT-5a027277-172c-467b-8b58-d05bae1a0a19', 'QA Mango'],
  ['PAT-abd0a187-2917-47b0-a849-889cd386790b', 'QA Mochi'],
  ['PAT-7211d15c-fa7d-487d-9d0e-d29649ffaaa4', 'QA Pepper'],
  ['PAT-4d9ae6c2-6023-4f8c-bf2a-a18aef52e02c', 'QA Luna'],
]);
export const workspaceAISamplePatientIds = Object.freeze([...samplePatients.keys()]);
export const workspaceAISampleAppointmentReadLimit = 31;
const manilaDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
});

type SampleAppointment = Pick<Appointment, 'patientId' | 'patientName' | 'status' | 'type' | 'dueAt' | 'followUpContact'>;
type SampleSchedule = { partial: boolean; due: {
  patient: string; date: string; timing: 'overdue' | 'due today'; outreach: 'logged' | 'not logged';
}[] };

export function summarizeWorkspaceAIFollowUps(rows: readonly SampleAppointment[], now: number): SampleSchedule | null {
  const verified = rows.filter(row => samplePatients.get(row.patientId) === row.patientName && samplePatients.has(row.patientId));
  if (!verified.length) return null;
  return {
    partial: verified.length !== rows.length || rows.length >= workspaceAISampleAppointmentReadLimit ||
      verified.some(row => !Number.isFinite(Date.parse(row.dueAt))),
    due: verified.filter(row => isDueFollowUp(row, now))
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      .slice(0, workspaceAISampleAppointmentReadLimit - 1)
      .map(row => ({
        patient: samplePatients.get(row.patientId)!,
        date: manilaDay.format(Date.parse(row.dueAt)),
        timing: Date.parse(row.dueAt) < billingDayStartMs(now) ? 'overdue' : 'due today',
        outreach: currentFollowUpContact(row) ? 'logged' : 'not logged',
      })),
  };
}

// ---------------------------------------------------------------------------
// Saved-config resolution. No key guessing, no env fallback, no raw secrets in
// logs. The provider registry in lib/ai.ts is the single source of truth for
// the exact built-in endpoints and wire protocols.
// ---------------------------------------------------------------------------

const SETUP_MESSAGE = 'AI chat is not set up. Choose a provider and model, then save your key in Clinic setup.';
const ENDPOINT_MESSAGE = 'AI chat only sends to the exact built-in provider endpoint saved in Clinic setup. Check the endpoint there.';

const normalizeBase = (value: string) => value.replace(/\/+$/, '');

type ResolvedSetup = { config: AIConfig; provider: AIProvider; identity: string };
let currentConfig: AIConfig | null = null;
let configGeneration = 0;

function identifyConfig(config: AIConfig): string {
  if (!currentConfig || config.provider !== currentConfig.provider || config.model !== currentConfig.model ||
      config.baseUrl !== currentConfig.baseUrl || config.apiKey !== currentConfig.apiKey) {
    currentConfig = config;
    configGeneration++;
  }
  return `${config.provider}:${configGeneration}`;
}

function resolveSetup(): ResolvedSetup {
  const config = loadAIConfig();
  if (!config) throw new Error(SETUP_MESSAGE);
  const provider = getProvider(config.provider);
  if (provider.id !== config.provider) throw new Error(ENDPOINT_MESSAGE);
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  // 'custom' and any edited/unverified base URL must fail closed: no arbitrary
  // automatic outbound sends. Built-in providers (including Ollama's registered
  // loopback endpoint) are compared against their exact registered endpoint.
  if (config.provider === 'custom' ||
    normalizeBase(baseUrl) !== normalizeBase(provider.baseUrl)) {
    throw new Error(ENDPOINT_MESSAGE);
  }
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!model || !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(model) ||
    (provider.keyRequired && !apiKey) || /[\r\n]/.test(apiKey)) {
    throw new Error(SETUP_MESSAGE);
  }
  // The identity covers provider, model, exact endpoint and the saved key. A
  // change to any of them yields a new identity so old history is not reused.
  const resolved = { provider: config.provider, model, baseUrl: normalizeBase(provider.baseUrl), apiKey };
  return { config: resolved, provider, identity: identifyConfig(resolved) };
}

/** Non-throwing identity for the saved setup; '' when no valid setup is saved. */
export function workspaceAIConfigIdentity(): string {
  try {
    return resolveSetup().identity;
  } catch {
    currentConfig = null;
    return '';
  }
}

let lastConfigIdentity: string | null = null;
let lastPlanIdentity: string | null = null;
/** Call when the workspace/account scope changes so the next turn starts fresh. */
export function resetWorkspaceAIContext(): void {
  lastConfigIdentity = null;
  lastPlanIdentity = null;
}

const systemInstructions = [
  'Act like a helpful front-desk secretary for a fictional veterinary clinic. Speak naturally and answer follow-up questions in context.',
  'For a general “anything I should be mindful of?” question, mention actionable schedule follow-ups and low or out-of-stock items when present. For “who needs checking?”, lead with the relevant patient names and due dates. If outreach is not logged, just say “there’s no outreach logged yet.” Suggest one manual next step, such as reviewing the appointment or confirming whether outreach is still needed. Never infer medical urgency, diagnose, or claim a patient is fine. This is a scheduling check, not a chart review.',
  'Use only the current evidence for clinic facts; earlier chat may be outdated. The schedule covers only fictional sample appointments in Asia/Manila. A null schedule means the sample follow-ups could not be verified; partial means the check is incomplete. Do not turn either into “nobody needs checking.” An empty complete list means no due follow-ups were found in the checked sample appointments, not a clinic-wide all-clear.',
  'For inventory, count all sample catalog entries unless asked about stock. Compare numeric quantities; null means not stocked. You cannot read other records, send messages or change appointments. Keep replies concise and use plain text.',
];

// The schedule is rebuilt per send from the fictional sample appointments.
const buildSystemText = (appointments: readonly SampleAppointment[], now: number) => [
  ...systemInstructions,
  'Sample inventory: ' + JSON.stringify(sampleEvidence),
  'Sample schedule follow-ups: ' + JSON.stringify(summarizeWorkspaceAIFollowUps(appointments, now)),
].join('\n');

/** Send one provider-neutral chat request. Never retries, follows no redirect. */
export async function askWorkspaceAI(
  prompt: string,
  history: readonly WorkspaceAIChatTurn[],
  signal: AbortSignal,
  appointments: readonly SampleAppointment[] = [],
  now = Date.now(),
): Promise<string> {
  const { config, provider, identity } = resolveSetup();
  // Turns recorded under a different saved setup are never forwarded.
  const turns = lastConfigIdentity === null || lastConfigIdentity === identity ? history : [];
  lastConfigIdentity = identity;
  if (!prompt.trim() || prompt.length > 400) throw new Error('Enter a message of up to 400 characters.');

  const system = buildSystemText(appointments, now);
  const endpoint = normalizeBase(provider.baseUrl);
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  if (provider.wire === 'gemini') {
    const message = (role: 'user' | 'model', text: string) => ({ role, parts: [{ text }] });
    const contents = turns.slice(-workspaceAIHistoryLimit).flatMap(turn => [
      message('user', turn.question.slice(0, 400)), message('model', turn.answer.slice(0, 1600)),
    ]);
    contents.push(message('user', prompt));
    url = `${endpoint}/models/${encodeURIComponent(config.model)}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey };
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 512 },
    };
  } else {
    const messages = [
      { role: 'system', content: system },
      ...turns.slice(-workspaceAIHistoryLimit).flatMap(turn => [
        { role: 'user', content: turn.question.slice(0, 400) },
        { role: 'assistant', content: turn.answer.slice(0, 1600) },
      ]),
      { role: 'user', content: prompt },
    ];
    url = `${endpoint}/chat/completions`;
    headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    };
    body = { model: config.model, messages };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the AI provider. Check your connection and try again.');
  }
  if (!response.ok) {
    if (response.status === 429) throw new Error('The AI provider hit a rate or quota limit. Try again later.');
    if ([400, 401, 403, 404].includes(response.status)) {
      throw new Error('The AI provider rejected the request. Check the saved provider, model and key in Clinic setup.');
    }
    throw new Error('The AI provider could not answer right now. Try again later.');
  }
  const data = await response.json().catch(() => null);
  let answer = '';
  if (provider.wire === 'gemini') {
    const parts = data?.candidates?.[0]?.content?.parts;
    answer = Array.isArray(parts)
      ? parts.flatMap(part => !part?.thought && typeof part?.text === 'string' ? [part.text] : []).join('').trim()
      : '';
  } else {
    const text = data?.choices?.[0]?.message?.content;
    answer = typeof text === 'string' ? text.trim() : '';
  }
  answer = answer.slice(0, 1600);
  if (!answer) throw new Error('The AI provider returned no reply. Try rephrasing your message.');
  return answer;
}

// ---------------------------------------------------------------------------
// Clinic query planner.
//
// The provider returns *plans*, never clinic evidence. The
// request contains only the user's prompt, the allowlisted schema, and earlier
// plans (nonsensitive). The answer is computed locally from a fresh, bounded,
// clinic-scoped read and rendered in the app, so private rows are never sent to
// the provider and earlier private answers never enter later context.
// ---------------------------------------------------------------------------

/** Only nonsensitive plan metadata is retained between turns. */
export type ClinicPlanTurn = { prompt: string } & ({ plan: QueryPlan | null } | { plans: QueryPlan[] });
export type PlannedClinicAction =
  | { kind: 'query'; plan: QueryPlan; notice?: string }
  | { kind: 'query'; plans: QueryPlan[] }
  | { kind: 'conversation'; message: string }
  | { kind: 'decline'; message: string };

const MAX_QUERY_PLANS = 3;

function planLocalClinicRequest(prompt: string, previous: readonly ClinicPlanTurn[]): PlannedClinicAction | null {
  const text = prompt.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
  const last = previous.at(-1);
  const reads = localClinicReadPlans(text, last && 'plan' in last ? last.plan : null, Date.now());
  if (reads) {
    const plans = reads.map(parseClinicQueryPlan);
    if (plans.every(plan => plan !== null)) return plans.length === 1
      ? { kind: 'query', plan: plans[0] } : { kind: 'query', plans };
  }
  // The protected clause is never sent to the provider or treated as a query.
  if (/^how many patients (?:do we have|are there),? and (?:can you tell me |what is )?(?:the )?[\p{L}\p{N} .'-]{1,80}(?:'s)? owner(?:'s)? (?:phone(?: number)?|contact details|email(?: address)?)\??$/u.test(text)) {
    return { kind: 'query', plan: { table: 'patients', op: 'count' },
      notice: 'I can’t access owner contact details from the assistant.' };
  }
  const species = /^(?:and |what about )?(dogs?|canines?|cats?|felines?) only[?.!]*$/.exec(text)?.[1];
  if (!species || !last || !('plans' in last) ||
      !last.plans.some(plan => plan.table === 'inventory' && plan.op === 'count') ||
      !last.plans.some(plan => plan.table === 'patients' && plan.op === 'count')) return null;
  const value = /^(?:dog|canine)/.test(species) ? 'Canine' : 'Feline';
  const plans = last.plans.map(plan => plan.table === 'patients' && plan.op === 'count'
    ? parseClinicQueryPlan({ ...plan, filter: [
      ...(plan.filter ?? []).filter(filter => filter.field !== 'species'),
      { field: 'species', op: 'eq', value },
    ] }) : plan);
  return plans.every(plan => plan !== null) ? { kind: 'query', plans } : null;
}

// Gemini's OpenAPI Schema subset describes the three action shapes. The local
// parser still enforces exact keys and table/operation-dependent rules.
const schemaString = { type: 'STRING' };
const schemaEnum = (values: readonly string[]) => ({ ...schemaString, enum: values });
const scalarShapes = [schemaString, { type: 'NUMBER' }, { type: 'BOOLEAN' }];
const queryPlanSchema = {
  type: 'OBJECT',
  required: ['table', 'op'],
  properties: {
    table: schemaEnum(CLINIC_TABLE_IDS),
    op: schemaEnum(QUERY_OPS),
    fields: { type: 'ARRAY', items: schemaString },
    filter: { type: 'ARRAY', items: {
      type: 'OBJECT', required: ['field', 'op'],
      properties: { field: schemaString, op: schemaEnum(FILTER_OPS),
        value: { anyOf: [...scalarShapes, { type: 'ARRAY', items: { anyOf: scalarShapes } }] } },
    } },
    sort: { type: 'ARRAY', items: {
      type: 'OBJECT', required: ['field', 'direction'],
      properties: { field: schemaString, direction: schemaEnum(['asc', 'desc']), transform: schemaEnum(['length']) },
    } },
    limit: { type: 'INTEGER', minimum: 1, maximum: MAX_LIMIT },
    groupBy: schemaString,
    sumField: schemaString,
    includeTies: { type: 'BOOLEAN' },
  },
};
const responseSchema = {
  anyOf: [
    { type: 'OBJECT', required: ['kind', 'plan'],
      properties: { kind: schemaEnum(['query']), plan: queryPlanSchema } },
    { type: 'OBJECT', required: ['kind', 'plans'],
      properties: { kind: schemaEnum(['query']),
        plans: { type: 'ARRAY', minItems: 1, maxItems: MAX_QUERY_PLANS, items: queryPlanSchema } } },
    { type: 'OBJECT', required: ['kind', 'message'],
      properties: { kind: schemaEnum(['conversation', 'decline']), message: schemaString } },
  ],
};

const PLAN_INSTRUCTIONS = [
  'You are a read-only front-desk assistant and query planner. You cannot see clinic records, and you must never invent facts, say you checked records, or use an appointment or follow-up list as a substitute for the patient directory.',
  'Reply with ONE JSON object and nothing else: no prose, no markdown, no code fences.',
  'For one query, reply {"kind":"query","plan":{"table":"patients","op":"count"}} using only exact schema identifiers and literals the user supplied. Every plan must have "table" and "op".',
  `For multiple independent queries, use {"kind":"query","plans":[...]} with 1-${MAX_QUERY_PLANS} complete plans in the order asked. Do not drop an answerable clause or ask the user to split it. Use separate plans even on the same table if filters or rankings differ.`,
  'Example: “How many patients and inventory items?” → {"kind":"query","plans":[{"table":"patients","op":"count"},{"table":"inventory","op":"count"}]}. Inventory count means catalog entries, not stock units.',
  'For inventory units on hand, use inventory sum with sumField "stock", never a price, threshold, or count. The executor excludes non-stock categories from stock sums, filters and rankings.',
  'For items at or below their own reorder threshold, use inventory list filtered by {"field":"reorderDue","op":"eq","value":true}. Do not substitute a fixed stock cutoff.',
  'For species filters, use recorded labels (dog → Canine, cat → Feline). A species-only follow-up to patient and inventory counts changes the patient plan only; keep the inventory count unchanged.',
  'Treat named patients, patient details, current patient lists, and follow-up name corrections as clinic data requests even when the wording is informal or omits a query keyword. To look up a patient by a partial name, list from "patients" using a case-insensitive "contains" filter on "name" with the name as typed, and request useful directory fields (name, species, breed, status, weight). Use all matches, not limit 1. For a name correction, reuse the previous table and replace the name filter.',
  'For patients currently here, use a list from "patients" with status in ["Waiting","In Treatment","Confined","Ready for Pickup"], returning name, status, and species. That is recorded active status, not verified physical presence. Do not apply that filter to a request for the entire directory.',
  'For separate active and discharged patient counts, use two count plans: one with the active status filter above and one with status eq "Discharged". This lets the app report zero for a status with no matches.',
  'For social chat or non-clinic general advice only, reply {"kind":"conversation","message":"<brief answer with no claims about clinic records>"}. For ambiguous/unsupported record questions or requests to write, contact someone, or act, reply {"kind":"decline","message":"<brief clarification with no clinic facts>"}; do not guess an answer.',
  'For longest/shortest name use op "rank" on "patients" with sort [{"field":"name","transform":"length","direction":"desc"}] (or "asc"), limit 1 and includeTies true.',
  'Keep plans minimal. A filter literal may come from the user’s question or a previous plan, never from a guessed or observed record.',
  buildClinicQuerySchema(),
].join('\n');

function normalizePlan(value: unknown): QueryPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const plan = { ...value } as Record<string, unknown>;
  const aliases = [
    ['from', 'table'], ['member', 'table'], ['entity', 'table'], ['collection', 'table'],
    ['operation', 'op'], ['type', 'op'],
  ] as const;
  for (const [alias, key] of aliases) {
    if (!Object.hasOwn(plan, alias) || (alias === 'type' && !QUERY_OPS.includes(plan.type as QueryOp))) continue;
    if (Object.hasOwn(plan, key) && plan[key] !== plan[alias]) return null;
    plan[key] = plan[alias];
    delete plan[alias];
  }
  // Structured output can include known optional fields that this op doesn't use.
  if (plan.op !== 'sum' && plan.op !== 'group') delete plan.sumField;
  if (plan.op !== 'group') delete plan.groupBy;
  if (plan.op !== 'rank') delete plan.includeTies;
  return parseClinicQueryPlan(plan);
}

// Repair hints are fixed text (plus the plan index), never raw provider output.
function parsePlannedAction(text: string): { action: PlannedClinicAction } | { problem: string } {
  if (text.length > MAX_QUERY_PLANS * MAX_PLAN_CHARS + 64) return { problem: 'the JSON response was too long' };
  // Some OpenAI-compatible models wrap otherwise valid JSON in a fence.
  const json = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)?.[1] ?? text;
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { return { problem: 'the response was not valid JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { problem: 'the response was not a JSON object' };
  const object = parsed as Record<string, unknown>;
  const keys = Object.keys(object);
  if (object.kind === 'decline' || object.kind === 'conversation') {
    const message = object.message;
    if (keys.length === 2 && typeof message === 'string' && message.trim().length > 0 &&
        message.length <= 300 && !/[\r\n]/.test(message)) {
      return { action: { kind: object.kind, message: message.trim() } };
    }
    return { problem: 'a conversation or decline must contain only kind and a brief message' };
  }
  if (object.kind === 'query') {
    const hasPlan = Object.hasOwn(object, 'plan');
    if (keys.length !== 2 || (!hasPlan && !Object.hasOwn(object, 'plans'))) {
      return { problem: 'a query must contain only kind and either plan or plans' };
    }
    const input = hasPlan ? [object.plan] : object.plans;
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_QUERY_PLANS) {
      return { problem: `plans must be an array of 1-${MAX_QUERY_PLANS} plans` };
    }
    const plans: QueryPlan[] = [];
    for (const raw of input) {
      const plan = normalizePlan(raw);
      if (!plan) return { problem: `plan ${plans.length + 1} did not match the schema for table, op, and allowed fields` };
      plans.push(plan);
    }
    return { action: hasPlan ? { kind: 'query', plan: plans[0] } : { kind: 'query', plans } };
  }
  return { problem: 'kind must be query, conversation, or decline' };
}

/**
 * Plan up to three read-only clinic queries, with one repair attempt only for
 * invalid output. Both requests share the timeout and contain no clinic
 * evidence; only earlier plans (not answers) are included as context.
 */
export async function planWorkspaceClinicQuery(
  prompt: string,
  history: readonly ClinicPlanTurn[],
  signal: AbortSignal,
): Promise<PlannedClinicAction> {
  const identity = workspaceAIConfigIdentity();
  // The first plan turn after a reset or a saved-setup change starts with no
  // context; a later turn reuses only the plans recorded under this identity.
  const turns = lastPlanIdentity === identity ? history : [];
  lastPlanIdentity = identity;
  if (!prompt.trim() || prompt.length > 400) throw new Error('Enter a message of up to 400 characters.');

  const previous = turns.slice(-workspaceAIHistoryLimit).map(turn => ({
    prompt: turn.prompt.slice(0, 400),
    ...('plans' in turn
      ? { plans: turn.plans.slice(0, MAX_QUERY_PLANS).map(parseClinicQueryPlan).filter(plan => plan !== null) }
      : { plan: parseClinicQueryPlan(turn.plan) }),
  }));
  if (!signal.aborted) {
    const local = planLocalClinicRequest(prompt, previous);
    if (local) return local;
  }
  const { config, provider } = resolveSetup();
  const system = PLAN_INSTRUCTIONS + '\nPrevious plans (nonsensitive; do not repeat any answer): ' + JSON.stringify(previous);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const request = (problem?: string) => sendClinicPlanRequest(
    config, provider, prompt, previous, requestSignal,
    problem ? `${system}\nRepair the previous response: ${problem}. Return one corrected JSON action for the original question.` : system,
  );
  const first = parsePlannedAction(await request());
  if ('action' in first) return first.action;
  if (workspaceAIConfigIdentity() !== identity) throw new Error('AI setup changed. Ask again to use the saved configuration.');
  const repaired = parsePlannedAction(await request(first.problem));
  if ('action' in repaired) return repaired.action;
  throw new Error('The AI provider returned an invalid query plan. Try rephrasing the question.');
}

async function sendClinicPlanRequest(
  config: AIConfig, provider: AIProvider, prompt: string, previous: readonly ClinicPlanTurn[], signal: AbortSignal, system: string,
): Promise<string> {
  const endpoint = config.baseUrl;
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  if (provider.wire === 'gemini') {
    const contents = previous.flatMap(turn => [
      { role: 'user', parts: [{ text: turn.prompt }] },
      { role: 'model', parts: [{ text: JSON.stringify('plans' in turn ? turn.plans : turn.plan) }] },
    ]);
    contents.push({ role: 'user', parts: [{ text: prompt }] });
    url = `${endpoint}/models/${encodeURIComponent(config.model)}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey };
    body = { systemInstruction: { parts: [{ text: system }] }, contents,
      generationConfig: { maxOutputTokens: 2048, responseMimeType: 'application/json', responseSchema } };
  } else {
    const messages = [
      { role: 'system', content: system },
      ...previous.flatMap(turn => [
        { role: 'user', content: turn.prompt },
        { role: 'assistant', content: JSON.stringify('plans' in turn ? turn.plans : turn.plan) },
      ]),
      { role: 'user', content: prompt },
    ];
    url = `${endpoint}/chat/completions`;
    headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    };
    body = { model: config.model, messages };
  }

  const networkError = () => new Error('Could not reach the AI provider. Check your connection and try again.');
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetch(url, {
      method: 'POST', headers, credentials: 'omit', redirect: 'error',
      signal, body: JSON.stringify(body),
    });
  } catch {
    throw networkError();
  }
  if (!response.ok) {
    if (response.status === 429) throw new Error('The AI provider hit a rate or quota limit. Try again later.');
    if ([400, 401, 403, 404].includes(response.status)) {
      throw new Error('The AI provider rejected the request. Check the saved provider, model and key in Clinic setup.');
    }
    throw new Error('The AI provider could not answer right now. Try again later.');
  }
  const data: unknown = await response.json().catch(error => {
    if (error instanceof SyntaxError) return null;
    throw networkError();
  });
  if (signal.aborted) throw networkError();
  let text = '';
  if (provider.wire === 'gemini') {
    const parts = (data as { candidates?: { content?: { parts?: unknown[] } }[] } | null)?.candidates?.[0]?.content?.parts;
    text = Array.isArray(parts)
      ? parts.flatMap(part => !part || typeof part !== 'object' ? [] :
        !(part as { thought?: unknown }).thought && typeof (part as { text?: unknown }).text === 'string'
          ? [(part as { text: string }).text] : []).join('').trim()
      : '';
  } else {
    const content = (data as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
    text = typeof content === 'string' ? content.trim() : '';
  }
  return text;
}
