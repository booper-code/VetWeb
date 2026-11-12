// Loaded only by the migration integration test's child process.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const statePath = process.env.MIGRATION_TEST_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  if (url.hostname === 'identitytoolkit.googleapis.com') {
    return Response.json({ idToken: 'test-token', refreshToken: 'test-refresh', expiresIn: '3600' });
  }
  if (url.hostname === 'images.example' && url.pathname === '/upload') {
    state.backupPresentAtUpload = readdirSync(process.cwd()).some(name => name.startsWith('patient-images-backup-'));
    state.uploads += 1;
    return Response.json({ key: `clinics/test-clinic/patients/PAT-1/${String(state.uploads).padStart(36, '0')}.jpg` });
  }
  if (url.hostname === 'firestore.googleapis.com' && method === 'GET') {
    state.reads += 1;
    return Response.json({ documents: state.documents });
  }
  if (url.hostname === 'firestore.googleapis.com' && method === 'PATCH') {
    const fields = JSON.parse(init.body).fields;
    state.patch = {
      precondition: url.searchParams.get('currentDocument.updateTime'),
      mask: url.searchParams.getAll('updateMask.fieldPaths'),
      fields
    };
    if (state.conflict || state.patch.precondition !== state.documents[0].updateTime) {
      return Response.json({ error: { message: 'Document changed concurrently' } }, { status: 400 });
    }
    Object.assign(state.documents[0].fields, fields);
    return Response.json(state.documents[0]);
  }
  throw new Error(`Unexpected request: ${method} ${url}`);
};

process.on('exit', () => writeFileSync(statePath, JSON.stringify(state)));
