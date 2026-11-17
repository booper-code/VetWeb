// Loaded only by the migration integration test's child process.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const statePath = process.env.MIGRATION_TEST_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  if (url.hostname === 'identitytoolkit.googleapis.com') {
    return Response.json({ idToken: 'test-token', localId: 'test-user', refreshToken: 'test-refresh', expiresIn: '3600' });
  }
  if (url.hostname === 'images.example' && url.pathname === '/upload') {
    state.backupPresentAtUpload = readdirSync(process.cwd()).some(name => name.startsWith('patient-images-backup-'));
    state.uploads += 1;
    return Response.json({ key: `clinics/test-clinic/patients/PAT-1/${String(state.uploads).padStart(36, '0')}.jpg` });
  }
  if (url.hostname === 'firestore.googleapis.com' && method === 'GET') {
    if (url.pathname.includes('/auditHeads/')) return Response.json({}, { status: 404 });
    state.reads += 1;
    return Response.json({ documents: state.documents });
  }
  if (url.hostname === 'firestore.googleapis.com' && method === 'POST' && url.pathname.endsWith(':commit')) {
    const writes = JSON.parse(init.body).writes;
    state.auditWrites = writes.slice(1);
    const fields = writes[0].update.fields;
    state.patch = {
      precondition: writes[0].currentDocument.updateTime,
      mask: writes[0].updateMask.fieldPaths,
      fields
    };
    if (state.conflict || state.patch.precondition !== state.documents[0].updateTime) {
      return Response.json({ error: { message: 'Document changed concurrently' } }, { status: 400 });
    }
    Object.assign(state.documents[0].fields, fields);
    return Response.json({ writeResults: writes.map(() => ({ updateTime: state.documents[0].updateTime })) });
  }
  throw new Error(`Unexpected request: ${method} ${url}`);
};

process.on('exit', () => writeFileSync(statePath, JSON.stringify(state)));
