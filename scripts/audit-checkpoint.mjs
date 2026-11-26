import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const collections = ['auditEvents', 'billingEntries', 'payrollLedger'];
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && value.length > 0 && !value.includes('/') && value !== '.' && value !== '..';
const isTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function sortFields(value) {
  if (Array.isArray(value)) return value.map(sortFields);
  if (!isMap(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortFields(value[key])]));
}

const bytes = value => Buffer.from(JSON.stringify(sortFields(value)));
const digest = value => createHash('sha256').update(bytes(value)).digest('hex');

function readEntries(snapshot) {
  if (!isMap(snapshot) || !isId(snapshot.projectId) || !isId(snapshot.clinicId) || !isTime(snapshot.capturedAt)) {
    throw new Error('Audit snapshot needs a project, clinic and ISO UTC capture time.');
  }
  if (!isMap(snapshot.collections)) throw new Error('Audit snapshot collections are missing.');
  const entries = new Map();
  for (const collection of collections) {
    const rows = snapshot.collections[collection];
    if (!Array.isArray(rows)) throw new Error(`Audit snapshot collection ${collection} is missing.`);
    for (const row of rows) {
      if (!isMap(row) || !isId(row.id) || !isMap(row.fields)) throw new Error('Invalid audit snapshot entry.');
      const locator = digest([snapshot.projectId, snapshot.clinicId, collection, row.id]);
      if (entries.has(locator)) throw new Error('Audit snapshot contains a duplicate entry.');
      entries.set(locator, digest([locator, row.fields]));
    }
  }
  return entries;
}

function ed25519(key, mode) {
  const handle = key instanceof KeyObject ? key : mode === 'private' ? createPrivateKey(key) : createPublicKey(key);
  if (handle.type !== mode || handle.asymmetricKeyType !== 'ed25519') {
    throw new Error(`An Ed25519 ${mode} key is required.`);
  }
  return handle;
}

export function createAuditCheckpoint(snapshot, privateKey) {
  const entries = readEntries(snapshot);
  const { projectId, clinicId, capturedAt } = snapshot;
  const payload = {
    version: 1, projectId, clinicId, capturedAt,
    entries: [...entries].sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
  };
  return { payload, signature: sign(null, bytes(payload), ed25519(privateKey, 'private')).toString('base64url') };
}

export function verifyAuditCheckpoint(checkpoint, snapshot, publicKey) {
  const { payload, signature } = checkpoint ?? {};
  if (!isMap(payload) || typeof signature !== 'string' || !/^[a-zA-Z0-9_-]{86}$/.test(signature)
    || !verify(null, bytes(payload), ed25519(publicKey, 'public'), Buffer.from(signature, 'base64url'))) {
    throw new Error('Audit checkpoint signature is invalid.');
  }
  if (payload.version !== 1 || !isTime(payload.capturedAt) || !Array.isArray(payload.entries)) {
    throw new Error('Unsupported audit checkpoint format.');
  }
  const current = readEntries(snapshot);
  if (payload.projectId !== snapshot.projectId || payload.clinicId !== snapshot.clinicId) {
    throw new Error('Audit checkpoint and snapshot scopes differ.');
  }
  if (Date.parse(snapshot.capturedAt) <= Date.parse(payload.capturedAt)) throw new Error('Use a newer comparison snapshot than the checkpoint.');
  const checked = new Set();
  let missing = 0;
  let changed = 0;
  for (const entry of payload.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || entry.some(value => !validDigest(value)) || checked.has(entry[0])) {
      throw new Error('Invalid signed audit entry.');
    }
    const [locator, expected] = entry;
    checked.add(locator);
    if (!current.has(locator)) missing++;
    else if (current.get(locator) !== expected) changed++;
  }
  return { ok: !missing && !changed, checked: checked.size, missing, changed, appended: current.size - checked.size + missing };
}

/** Rehearses acquisition on fiction-only emulators; offline signing also accepts an independently captured snapshot. */
export async function captureAuditSnapshot({ host, projectId, clinicId }) {
  const port = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(host ?? '')?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535) throw new Error('A loopback Firestore emulator is required.');
  if (!/^demo-[a-z0-9-]+$/.test(projectId ?? '')) throw new Error('An explicit demo project is required.');
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(clinicId ?? '')) throw new Error('An explicit fixture clinic ID is required.');
  const endpoint = `http://127.0.0.1:${port}/v1/projects/${projectId}/databases/(default)/documents`;
  const clinic = `/clinics/${clinicId}`;
  const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  const request = async (path, body) => {
    const step = path.endsWith(':runQuery') ? 'collection query' : 'clinic read';
    try {
      const response = await fetch(`${endpoint}${path}`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      throw new Error(`Audit snapshot ${step} failed.`, { cause: error });
    }
  };
  await request(clinic);
  const query = (structuredQuery, readTime) => request(`${clinic}:runQuery`, {
    structuredQuery, ...(readTime ? { readTime } : {})
  });
  const probe = await query({ from: [{ collectionId: 'auditEvents' }], limit: 1 });
  const readTime = probe.find(row => row.readTime)?.readTime;
  if (!readTime) throw new Error('The emulator did not return a snapshot timestamp.');
  const captured = {};
  for (const collectionId of collections) {
    const records = [];
    let after;
    for (;;) {
      const rows = await query({
        from: [{ collectionId }],
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        ...(after ? { startAt: { values: [{ referenceValue: after }], before: false } } : {}),
        limit: 100
      }, readTime);
      const documents = rows.flatMap(row => row.document ? [row.document] : []);
      records.push(...documents.map(document => ({ id: document.name.split('/').at(-1), fields: document.fields ?? {} })));
      if (documents.length < 100) break;
      after = documents.at(-1).name;
    }
    captured[collectionId] = records;
  }
  return { projectId, clinicId, capturedAt: new Date(readTime).toISOString(), collections: captured };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      snapshot: { type: 'string' }, checkpoint: { type: 'string' }, key: { type: 'string' },
      project: { type: 'string' }, clinic: { type: 'string' }
    } });
    const [command] = positionals;
    if (positionals.length !== 1 || !values.snapshot) throw new Error('Use capture, create or verify and supply --snapshot.');
    if (command === 'capture') {
      const snapshot = await captureAuditSnapshot({
        host: process.env.FIRESTORE_EMULATOR_HOST, projectId: values.project, clinicId: values.clinic
      });
      await writeFile(values.snapshot, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ captured: collections.length }));
    } else {
      if (!['create', 'verify'].includes(command) || !values.checkpoint || !values.key) {
        throw new Error('Use create or verify with --snapshot, --checkpoint and --key.');
      }
      const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
      const [snapshot, key] = await Promise.all([readJson(values.snapshot), readFile(values.key)]);
      if (command === 'create') {
        const checkpoint = createAuditCheckpoint(snapshot, key);
        await writeFile(values.checkpoint, `${JSON.stringify(checkpoint)}\n`, { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ signed: checkpoint.payload.entries.length }));
      } else {
        const result = verifyAuditCheckpoint(await readJson(values.checkpoint), snapshot, key);
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error && !error.code ? error.message : 'Could not read or write the audit checkpoint files.');
    process.exitCode = 1;
  }
}
