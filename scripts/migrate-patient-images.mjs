#!/usr/bin/env node
/**
 * Move legacy base64 patient images into the Cloudflare R2 image service.
 *
 * Dry run (default):
 *   FIREBASE_API_KEY=... FIREBASE_EMAIL=... FIREBASE_PASSWORD=... \
 *   CLINIC_ID=... node scripts/migrate-patient-images.mjs
 *
 * Apply:
 *   ... node scripts/migrate-patient-images.mjs --apply
 *
 * Required environment:
 *   FIREBASE_API_KEY   Web API key from lib/firebase.ts (public by design).
 *   FIREBASE_EMAIL     An owner/editor account that can read and write patients.
 *   FIREBASE_PASSWORD  That account's password. Never commit it.
 *   CLINIC_ID          Clinic document id to migrate.
 *   IMAGE_WORKER_URL   Worker URL (required only with --apply).
 *
 * Safety:
 *   - Defaults to a dry run.
 *   - Writes a JSON backup of every patient document before changing anything.
 *   - Patches only profilePicture, pictures, and labResults.
 *   - Uses Firestore updateTime preconditions so concurrent edits are skipped.
 *   - Verifies from a fresh read that no data URLs remain.
 */

import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

const apply = process.argv.includes('--apply');
const projectId = process.env.FIREBASE_PROJECT_ID || 'vetcloudpro';
const apiKey = process.env.FIREBASE_API_KEY || '';
const email = process.env.FIREBASE_EMAIL || '';
const password = process.env.FIREBASE_PASSWORD || '';
const clinicId = process.env.CLINIC_ID || '';
const workerUrl = (process.env.IMAGE_WORKER_URL || '').replace(/\/+$/, '');

const firestoreBase =
  `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
  `/databases/(default)/documents`;

let idToken = '';
let refreshToken = '';
let tokenExpiresAt = 0;

const readJson = async response => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

const signIn = async () => {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error?.message || `Sign-in failed (${response.status}).`);
  }

  idToken = data.idToken;
  refreshToken = data.refreshToken;
  tokenExpiresAt = Date.now() + (Number(data.expiresIn) || 3600) * 1000;
};

const refreshIdToken = async () => {
  const response = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    }
  );
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error?.message || `Token refresh failed (${response.status}).`);
  }

  idToken = data.id_token;
  refreshToken = data.refresh_token || refreshToken;
  tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
};

const ensureToken = async () => {
  if (!idToken) {
    await signIn();
  } else if (Date.now() > tokenExpiresAt - 60_000) {
    await refreshIdToken();
  }
};

const authedFetch = async (url, init = {}) => {
  await ensureToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${idToken}`);
  return fetch(url, { ...init, headers });
};

const fromValue = value => {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) return (value.arrayValue?.values ?? []).map(fromValue);
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue?.fields ?? {}).map(([key, nested]) => [key, fromValue(nested)])
    );
  }
  return undefined;
};

const documentToRecord = doc => fromValue({ mapValue: { fields: doc.fields ?? {} } });

const recordId = doc => doc.name.split('/').pop();

const isDataImage = value => typeof value === 'string' && /^data:image\//i.test(value);

const countDataImages = record => {
  let count = 0;
  if (isDataImage(record.profilePicture)) count += 1;
  if (Array.isArray(record.pictures)) count += record.pictures.filter(isDataImage).length;
  if (Array.isArray(record.labResults)) {
    count += record.labResults.filter(lab => isDataImage(lab?.imageUrl)).length;
  }
  return count;
};

const findDataImages = record => {
  const updates = {};
  if (isDataImage(record.profilePicture)) updates.profilePicture = record.profilePicture;
  if (Array.isArray(record.pictures) && record.pictures.some(isDataImage)) {
    updates.pictures = record.pictures;
  }
  if (Array.isArray(record.labResults) && record.labResults.some(lab => isDataImage(lab?.imageUrl))) {
    updates.labResults = record.labResults;
  }
  return updates;
};

const listPatients = async () => {
  const patients = [];
  let pageToken = '';

  do {
    const url = new URL(`${firestoreBase}/clinics/${encodeURIComponent(clinicId)}/patients`);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await authedFetch(url);
    const data = await readJson(response);
    if (!response.ok) {
      throw new Error(data.error?.message || `Could not list patients (${response.status}).`);
    }

    patients.push(...(data.documents ?? []));
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);

  return patients;
};

const uploadDataUrl = async (dataUrl, patientId) => {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) {
    throw new Error('Unsupported data URL; only base64 image data URLs are migrated.');
  }

  const [, mime, base64] = match;
  const blob = new Blob([Buffer.from(base64, 'base64')], { type: mime });
  const form = new FormData();
  form.set('clinicId', clinicId);
  form.set('patientId', patientId);
  form.set('file', blob, `${patientId}.jpg`);

  const response = await authedFetch(`${workerUrl}/upload`, { method: 'POST', body: form });
  const data = await readJson(response);
  if (!response.ok || typeof data.key !== 'string') {
    throw new Error(data.error || `Upload failed (${response.status}).`);
  }

  return data.key;
};

const patchPatient = async (doc, fields) => {
  const patientId = recordId(doc);
  const params = new URLSearchParams();
  for (const field of Object.keys(fields)) {
    params.append('updateMask.fieldPaths', field);
  }
  if (!doc.updateTime) throw new Error('Missing updateTime; refusing an unsafe write.');
  params.set('currentDocument.updateTime', doc.updateTime);

  const body = {
    fields: Object.fromEntries(
      Object.entries(fields)
    )
  };

  const response = await authedFetch(
    `${firestoreBase}/clinics/${encodeURIComponent(clinicId)}/patients/${encodeURIComponent(patientId)}?${params}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error?.message || `Patch failed (${response.status}).`);
  }
};

const processPatient = async doc => {
  const patientId = recordId(doc);
  const record = documentToRecord(doc);
  const updates = findDataImages(record);
  const fields = Object.keys(updates);
  const counts = countDataImages(record);

  if (!fields.length) return { patientId, status: 'clean', counts: 0 };
  if (!apply) return { patientId, status: 'dry-run', counts };

  const patchFields = {};
  if (updates.profilePicture) {
    patchFields.profilePicture = { stringValue: await uploadDataUrl(updates.profilePicture, patientId) };
  }
  if (updates.pictures) {
    const values = [];
    for (const value of doc.fields.pictures.arrayValue.values ?? []) {
      values.push(isDataImage(value.stringValue)
        ? { stringValue: await uploadDataUrl(value.stringValue, patientId) }
        : value);
    }
    patchFields.pictures = { arrayValue: { values } };
  }
  if (updates.labResults) {
    const values = [];
    for (const value of doc.fields.labResults.arrayValue.values ?? []) {
      const fields = value.mapValue?.fields;
      const image = fields?.imageUrl?.stringValue;
      values.push(isDataImage(image)
        ? { ...value, mapValue: { ...value.mapValue, fields: { ...fields, imageUrl: { stringValue: await uploadDataUrl(image, patientId) } } } }
        : value);
    }
    patchFields.labResults = { arrayValue: { values } };
  }

  await patchPatient(doc, patchFields);
  return { patientId, status: 'migrated', counts };
};

const main = async () => {
  if (!clinicId) throw new Error('CLINIC_ID is required.');
  if (!apiKey || !email || !password) {
    throw new Error('FIREBASE_API_KEY, FIREBASE_EMAIL, and FIREBASE_PASSWORD are required.');
  }
  if (apply && !workerUrl) throw new Error('IMAGE_WORKER_URL is required with --apply.');

  console.log(
    `[migrate] ${apply ? 'APPLY' : 'DRY RUN'} - project ${projectId} - clinic ${clinicId}`
  );

  await signIn();
  const docs = await listPatients();
  console.log(`[migrate] ${docs.length} patient document(s) found.`);

  const dirty = docs.filter(doc => Object.keys(findDataImages(documentToRecord(doc))).length > 0);
  const totalImages = dirty.reduce(
    (total, doc) => total + countDataImages(documentToRecord(doc)),
    0
  );
  console.log(
    `[migrate] ${dirty.length} patient(s) with ${totalImages} embedded image(s).`
  );

  if (!apply) {
    for (const doc of dirty) {
      const record = documentToRecord(doc);
      console.log(`  - ${recordId(doc)}: ${countDataImages(record)} image(s)`);
    }
    console.log('[migrate] Dry run only. Re-run with --apply to upload and rewrite.');
    return;
  }

  const backupPath = `patient-images-backup-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
  await writeFile(
    backupPath,
    JSON.stringify(
      {
        format: 'vetcloudpro-image-migration-backup',
        exportedAt: new Date().toISOString(),
        projectId,
        clinicId,
        documents: docs
      },
      null,
      2
    ),
    { flag: 'wx', mode: 0o600 }
  );
  console.log(`[migrate] Backup written to ${backupPath}.`);

  let migrated = 0;
  let failed = 0;
  for (const doc of dirty) {
    try {
      const result = await processPatient(doc);
      migrated += 1;
      console.log(`  [ok] ${result.patientId}: ${result.counts} image(s)`);
    } catch (error) {
      failed += 1;
      console.error(`  [fail] ${recordId(doc)}: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`[migrate] Uploaded and patched ${migrated} patient(s); ${failed} failed.`);

  // Verify from a fresh read so the result is not based on local state.
  const after = await listPatients();
  const remaining = after.filter(
    doc => Object.keys(findDataImages(documentToRecord(doc))).length > 0
  );
  if (remaining.length) {
    console.error(`[migrate] ${remaining.length} patient(s) still contain data URLs:`);
    remaining.forEach(doc => console.error(`  - ${recordId(doc)}`));
    process.exitCode = 1;
  } else {
    console.log('[migrate] Verification passed: no data URLs remain in patient documents.');
  }

  if (failed) process.exitCode = 1;
};

main().catch(error => {
  console.error('[migrate] Fatal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
