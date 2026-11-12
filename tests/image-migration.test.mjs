import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = join(root, 'scripts', 'migrate-patient-images.mjs');
const mock = join(root, 'tests', 'fixtures', 'migration-fetch-mock.mjs');
const image = 'data:image/jpeg;base64,/9j/AQ==';
const original = {
  name: 'projects/test-project/databases/(default)/documents/clinics/test-clinic/patients/PAT-1',
  updateTime: '2026-01-01T12:34:56.123456Z',
  fields: {
    name: { stringValue: 'Test patient' },
    profilePicture: { stringValue: image },
    pictures: { arrayValue: { values: [{ stringValue: image }, { stringValue: 'https://example.test/old.jpg' }] } },
    labResults: { arrayValue: { values: [{ mapValue: { fields: {
      imageUrl: { stringValue: image },
      timestamp: { timestampValue: '2025-01-01T00:00:00Z' },
      bigNumber: { integerValue: '9007199254740993' }
    } } }] } }
  }
};

const run = (apply, conflict = false) => {
  const directory = mkdtempSync(join(process.env.TEMP || tmpdir(), 'vet-image-migration-test-'));
  try {
    const statePath = join(directory, 'state.json');
    writeFileSync(statePath, JSON.stringify({ documents: [original], uploads: 0, reads: 0, conflict }));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, script, ...(apply ? ['--apply'] : [])], {
      cwd: directory, encoding: 'utf8',
      env: { ...process.env, MIGRATION_TEST_STATE: statePath, FIREBASE_PROJECT_ID: 'test-project',
        FIREBASE_API_KEY: 'test-key', FIREBASE_EMAIL: 'test@example.test', FIREBASE_PASSWORD: 'not-a-secret',
        CLINIC_ID: 'test-clinic', IMAGE_WORKER_URL: 'https://images.example' }
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const backups = readdirSync(directory).filter(name => name.startsWith('patient-images-backup-'));
    const backup = backups.length ? JSON.parse(readFileSync(join(directory, backups[0]), 'utf8')) : null;
    return { result, state, backups, backup };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('dry run reports images without uploading or writing', () => {
  const { result, state, backups } = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 patient\(s\) with 3 embedded image\(s\)/);
  assert.equal(state.uploads, 0);
  assert.equal(state.patch, undefined);
  assert.deepEqual(backups, []);
});

test('apply backs up first, preserves Firestore values, and verifies rewritten images', () => {
  const { result, state, backup } = run(true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.backupPresentAtUpload, true);
  assert.deepEqual(backup.documents, [original]);
  assert.equal(state.uploads, 3);
  assert.equal(state.reads, 2);
  assert.equal(state.patch.precondition, original.updateTime);
  assert.deepEqual(state.patch.mask, ['profilePicture', 'pictures', 'labResults']);
  assert.deepEqual(state.patch.fields.labResults.arrayValue.values[0].mapValue.fields.timestamp,
    original.fields.labResults.arrayValue.values[0].mapValue.fields.timestamp);
  assert.deepEqual(state.patch.fields.labResults.arrayValue.values[0].mapValue.fields.bigNumber,
    original.fields.labResults.arrayValue.values[0].mapValue.fields.bigNumber);
  assert.equal(state.patch.fields.pictures.arrayValue.values[1].stringValue, 'https://example.test/old.jpg');
  assert.match(result.stdout, /Verification passed/);
});

test('concurrent change rejects patch and leaves original images intact', () => {
  const { result, state, backup } = run(true, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Document changed concurrently/);
  assert.equal(state.patch.precondition, original.updateTime);
  assert.deepEqual(state.documents, [original]);
  assert.deepEqual(backup.documents, [original]);
  assert.match(result.stderr, /still contain data URLs/);
});
