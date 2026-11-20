import {
  ASSISTANT_IMPORT_PREVIEW_LIMIT, ASSISTANT_PERSON_LIMIT, assistantRangeBounds, assistantResourceId,
  assistantToolRegistry, exactAssistantObject, isAssistantToolId, parseAssistantToolInput, parseAssistantToolResult,
  type AssistantToolError, type ImportRange, type PersonQuery,
} from '../../../lib/assistant-tools';

type Env = { FIREBASE_PROJECT_ID: string; ALLOWED_ORIGINS: string };
type Value = { stringValue?: string; booleanValue?: boolean; integerValue?: string; timestampValue?: string };
type Document = { name: string; fields?: Record<string, Value> };
type QueryRow = { document?: Document; readTime?: string };
type Transport = (url: string, init: RequestInit) => Promise<Response>;
const projectId = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const CLOUD = 'https://firestore.googleapis.com/v1';
const BODY_LIMIT = 1024;
const TIMEOUT_MS = 6500;

class GatewayError extends Error {
  constructor(readonly status: number, readonly code: AssistantToolError) { super(code); }
}
const bad = () => new GatewayError(400, 'invalid-request');
const deny = () => new GatewayError(403, 'access-denied');
const unavailable = () => new GatewayError(503, 'unavailable');

async function readBody(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader();
  if (!reader) throw bad();
  let length = 0, body = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stop = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) { stop(); throw bad(); }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BODY_LIMIT) { stop(); throw bad(); }
      body += decoder.decode(value, { stream: true });
    }
    if (signal.aborted) throw bad();
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch { throw bad(); }
  finally { signal.removeEventListener('abort', stop); reader.releaseLock(); }
}

/** Claims are used only to build the path. Firebase must authenticate the same
 * token on every subsequent REST read before any claim influences a response. */
function bearerSubject(token: string, project: string) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw deny();
  try {
    const { sub, aud, iss } = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof sub === 'string' && assistantResourceId.test(sub) && aud === project && iss === `https://securetoken.google.com/${project}`) return sub;
  } catch { /* Invalid credentials. */ }
  throw deny();
}

function firestoreClient(clinicPath: string, token: string, signal: AbortSignal, fetcher: Transport) {
  return async <T>(suffix: string, body?: object): Promise<T> => {
    const response = await fetcher(`${CLOUD}/${clinicPath}${suffix}`, {
      method: body ? 'POST' : 'GET', signal, redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 || response.status === 403 || (!body && response.status === 404)) throw deny();
    if (!response.ok) throw unavailable();
    return response.json() as Promise<T>;
  };
}
type ReadFirestore = ReturnType<typeof firestoreClient>;
const field = (fieldPath: string) => ({ fieldPath });

async function findPerson(read: ReadFirestore, clinicPath: string, input: PersonQuery) {
  const rows = await read<QueryRow[]>(':runQuery', { structuredQuery: {
    select: { fields: [field('ownerName'), field('name')] },
    from: [{ collectionId: 'patients' }],
    where: { fieldFilter: { field: field('ownerName'), op: 'EQUAL', value: { stringValue: input.name } } },
    limit: ASSISTANT_PERSON_LIMIT + 1,
  } });
  if (!Array.isArray(rows) || rows.length > ASSISTANT_PERSON_LIMIT + 2) throw unavailable();
  const prefix = `${clinicPath}/patients/`;
  const matches = rows.flatMap(row => {
    if (!row?.document) {
      if (!row?.readTime) throw unavailable();
      return [];
    }
    const { name, fields } = row.document;
    if (typeof name !== 'string' || !name.startsWith(prefix) ||
      !exactAssistantObject(fields, ['ownerName', 'name']) || row.document.fields?.ownerName?.stringValue !== input.name) throw unavailable();
    return [{ reference: name.slice(prefix.length), name: input.name, patientName: row.document.fields?.name?.stringValue }];
  });
  if (!matches.every(match => assistantResourceId.test(match.reference)) || matches.length > ASSISTANT_PERSON_LIMIT + 1) throw unavailable();
  return { matches: matches.slice(0, ASSISTANT_PERSON_LIMIT), more: matches.length > ASSISTANT_PERSON_LIMIT };
}

async function importHistory(read: ReadFirestore, clinicPath: string, input: ImportRange) {
  const { start, end } = assistantRangeBounds(input);
  const filter = (op: string, timestampValue: string) => ({ fieldFilter: {
    field: field('at'), op, value: { timestampValue },
  } });
  const query = { from: [{ collectionId: 'inventoryImportReceipts' }], where: { compositeFilter: {
    op: 'AND', filters: [filter('GREATER_THAN_OR_EQUAL', start), filter('LESS_THAN', end)],
  } } };
  const grouped = await read<{ result?: { aggregateFields?: Record<string, Value> }; readTime?: string }[]>(':runAggregationQuery', {
    structuredAggregationQuery: { structuredQuery: query, aggregations: [{ alias: 'tracked', count: {} }] },
  });
  if (!Array.isArray(grouped) || grouped.length !== 1) throw unavailable();
  const raw = grouped[0]?.result?.aggregateFields?.tracked?.integerValue;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw unavailable();
  const count = Number(raw);
  if (!count) return { ...input, count, recent: [] };
  const readTime = grouped[0]?.readTime;
  if (typeof readTime !== 'string' || !Number.isFinite(Date.parse(readTime))) throw unavailable();
  const rows = await read<QueryRow[]>(':runQuery', { readTime, structuredQuery: {
    ...query, select: { fields: [field('batchId'), field('at')] },
    orderBy: [{ field: field('at'), direction: 'DESCENDING' }], limit: ASSISTANT_IMPORT_PREVIEW_LIMIT,
  } });
  if (!Array.isArray(rows) || rows.length > ASSISTANT_IMPORT_PREVIEW_LIMIT + 1) throw unavailable();
  const prefix = `${clinicPath}/inventoryImportReceipts/`;
  const seen = new Set<string>();
  const recent = rows.flatMap(row => {
    if (!row?.document) {
      if (!row?.readTime) throw unavailable();
      return [];
    }
    const { name, fields } = row.document;
    if (typeof name !== 'string' || !name.startsWith(prefix) || name.slice(prefix.length).includes('/') ||
      seen.has(name) || !exactAssistantObject(fields, ['batchId', 'at'])) throw unavailable();
    seen.add(name);
    return [{ batchId: row.document.fields?.batchId?.stringValue, at: row.document.fields?.at?.timestampValue }];
  });
  return { ...input, count, recent };
}

export async function handleAssistantTools(request: Request, env: Env, fetcher: Transport = fetch, now = Date.now): Promise<Response> {
  const origin = request.headers.get('Origin');
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
  const send = (payload: object, status: number) => Response.json(payload, { status, headers });
  if (!origin || !env.ALLOWED_ORIGINS?.split(',').map(item => item.trim()).includes(origin)) return send({ error: 'access-denied' }, 403);
  headers.set('Access-Control-Allow-Origin', origin);
  if (new URL(request.url).pathname !== '/v1/lookup') return send({ error: 'invalid-request' }, 404);
  if (request.method === 'OPTIONS') {
    headers.set('Access-Control-Allow-Methods', 'POST');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') return send({ error: 'invalid-request' }, 405);
  if (typeof env.FIREBASE_PROJECT_ID !== 'string' || !projectId.test(env.FIREBASE_PROJECT_ID)) return send({ error: 'unavailable' }, 503);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  try {
    const header = request.headers.get('Authorization') ?? '';
    if (!header.startsWith('Bearer ') || header.length > 8192) throw deny();
    const token = header.slice(7), uid = bearerSubject(token, env.FIREBASE_PROJECT_ID);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw bad();
    const body = await readBody(request, signal);
    if (!exactAssistantObject(body, ['tool', 'clinicId', 'input']) || !isAssistantToolId(body.tool) ||
      typeof body.clinicId !== 'string' || !assistantResourceId.test(body.clinicId)) throw bad();
    const input = parseAssistantToolInput(body.tool, body.input, now());
    if (!input) throw bad();
    const path = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/clinics/${body.clinicId}`;
    const read = firestoreClient(path, token, signal, fetcher);
    const [member, clinic] = await Promise.all([
      read<Document>(`/members/${uid}?mask.fieldPaths=role`),
      read<Document>('?mask.fieldPaths=aiEnabled&mask.fieldPaths=ownerId'),
    ]);
    const role = member.fields?.role?.stringValue;
    if (clinic.fields?.aiEnabled?.booleanValue !== true || !role || !['owner', 'editor', 'viewer'].includes(role) ||
      (assistantToolRegistry[body.tool].access === 'owner' && (role !== 'owner' || clinic.fields.ownerId?.stringValue !== uid))) throw deny();
    const result = body.tool === 'find_person_by_name' ? await findPerson(read, path, input as PersonQuery)
      : await importHistory(read, path, input as ImportRange);
    if (!parseAssistantToolResult(body.tool, result)) throw unavailable();
    return send({ tool: body.tool, result }, 200);
  } catch (error) {
    if (signal.aborted) return send({ error: 'timeout' }, 504);
    if (error instanceof GatewayError) return send({ error: error.code }, error.status);
    return send({ error: 'unavailable' }, 503);
  }
}

const worker = { fetch: (request: Request, env: Env) => handleAssistantTools(request, env) };
export default worker;
