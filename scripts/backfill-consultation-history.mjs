import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { legacyConsultationSortDate } from '../lib/consultation-values.ts';

const pageSize = 50;
const canonicalTimestamp = value => value.replace(/(?:\.(\d+))?Z$/, (_, fraction) => `.${(fraction ?? '').padEnd(9, '0')}Z`);

export async function backfillConsultationHistory({ host, projectId, clinicId, apply = false, request = fetch }) {
  const port = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(host ?? '')?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535) throw new Error('A loopback Firestore emulator is required.');
  if (!/^demo-[a-z0-9-]+$/.test(projectId ?? '')) throw new Error('An explicit demo project is required.');
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(clinicId ?? '')) throw new Error('An explicit fixture clinic ID is required.');

  const root = `projects/${projectId}/databases/(default)/documents`;
  const endpoint = `http://127.0.0.1:${port}/v1/${root}`;
  const clinic = `clinics/${clinicId}`;
  const marker = `${clinic}/workspaceConfig/consultationHistory`;
  const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  const fetchLocal = (path, options) => request(`${endpoint}${path}`, { ...options, headers, redirect: 'error' });
  const read = async (path, optional = false) => {
    const response = await fetchLocal(`/${path}`);
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`Emulator read failed (${response.status}).`);
    return response.json();
  };
  const commit = async writes => {
    const response = await fetchLocal(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
    if (!response.ok) throw new Error(`Emulator commit failed (${response.status}).`);
  };
  const writeMarker = (state, previous) => commit([{
    update: { name: `${root}/${marker}`, fields: { state: { stringValue: state } } },
    currentDocument: previous ? { updateTime: previous.updateTime } : { exists: false }
  }]);

  await read(clinic);
  let configuration = await read(marker, true);
  const state = configuration?.fields?.state?.stringValue;
  if (configuration && !['preparing', 'ready'].includes(state)) throw new Error('Unrecognized consultation history state.');
  if (apply && !configuration) {
    await writeMarker('preparing', null);
    configuration = await read(marker);
  }

  async function scan(writeChanges) {
    const counts = { dated: 0, unknown: 0, needsWrite: 0 };
    let pageToken;
    do {
      // listDocuments defaults to ascending document name; the emulator does
      // not accept an explicit orderBy together with its next-page token.
      const query = new URLSearchParams({ pageSize: String(pageSize) });
      for (const field of ['date', 'occurredAt', 'historySortAt']) query.append('mask.fieldPaths', field);
      if (pageToken) query.set('pageToken', pageToken);
      const page = await read(`${clinic}/consultations?${query}`);
      pageToken = page.nextPageToken;
      const writes = [];
      for (const document of page.documents ?? []) {
        const fields = document.fields ?? {};
        const timestamp = fields.occurredAt?.timestampValue
          ?? legacyConsultationSortDate(fields.date?.stringValue ?? '')?.toISOString();
        const expected = timestamp ? { timestampValue: timestamp } : { nullValue: null };
        const actual = fields.historySortAt;
        if (timestamp) counts.dated++;
        else counts.unknown++;
        const matches = timestamp
          ? typeof actual?.timestampValue === 'string' && canonicalTimestamp(actual.timestampValue) === canonicalTimestamp(timestamp)
          : actual !== undefined && actual.nullValue === null;
        if (matches) continue;
        counts.needsWrite++;
        if (writeChanges) writes.push({
          update: { name: document.name, fields: { historySortAt: expected } },
          updateMask: { fieldPaths: ['historySortAt'] },
          currentDocument: { updateTime: document.updateTime }
        });
      }
      if (writes.length) await commit(writes);
    } while (pageToken);
    return counts;
  }

  const counts = await scan(apply && state !== 'ready');
  if (!apply) return counts;
  if (state === 'ready') {
    if (counts.needsWrite) throw new Error('A ready clinic has inconsistent history sort keys.');
  } else {
    if ((await scan(false)).needsWrite) throw new Error('Sort keys changed during backfill; rerun to verify.');
    await writeMarker('ready', configuration);
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      project: { type: 'string' },
      clinic: { type: 'string' },
      apply: { type: 'boolean', default: false }
    } });
    const counts = await backfillConsultationHistory({
      host: process.env.FIRESTORE_EMULATOR_HOST, projectId: values.project, clinicId: values.clinic, apply: values.apply
    });
    console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'dry-run', ...counts }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The consultation history backfill failed.');
    process.exitCode = 1;
  }
}
