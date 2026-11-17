#!/usr/bin/env node
/**
 * Private backup of R2 images referenced by a clinic JSON export.
 * Not a full-bucket backup: unreferenced/orphaned objects are not enumerated.
 * Defaults to a plan; --apply downloads bytes, --verify verifies offline.
 */
import { readFile, writeFile, mkdir, lstat, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const KEY = /^clinics\/([A-Za-z0-9_-]{1,64})\/patients\/[A-Za-z0-9_-]{1,64}\/[0-9a-f-]{36}\.jpg$/;
const MAX_BYTES = 5 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function referencedKeys(backup) {
  if (backup?.format !== 'vetcloudpro-clinic-backup' || backup.version !== 1 ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(backup.clinicId) ||
      !Array.isArray(backup.collections?.patients)) {
    throw new Error('Expected a version 1 clinic JSON export with a patients collection.');
  }
  const keys = new Set();
  const walk = value => {
    if (typeof value === 'string' && value.startsWith('clinics/')) {
      const match = KEY.exec(value);
      if (!match || match[1] !== backup.clinicId) throw new Error('Invalid or cross-clinic image key.');
      keys.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  backup.collections.patients.forEach(walk);
  return [...keys].sort();
}

async function boundedBytes(response) {
  if (!response.ok || !response.body) throw new Error('Image download failed.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Image exceeds the backup size limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!size) throw new Error('Empty image download.');
  return Buffer.concat(chunks);
}

export async function backupReferencedImages({ backup, directory, workerUrl, token, fetchImpl = fetch }) {
  const keys = referencedKeys(backup);
  const worker = new URL(workerUrl);
  if (worker.protocol !== 'https:' || worker.username || worker.password ||
      worker.pathname !== '/' || worker.search || worker.hash || !token) {
    throw new Error('A trusted HTTPS Worker origin and Firebase ID token are required.');
  }
  // Exclusive directory creation prevents accidental overwrite and symlink reuse.
  await mkdir(directory, { mode: 0o700 });
  const manifest = {
    format: 'vetcloudpro-referenced-images', version: 1, clinicId: backup.clinicId,
    createdAt: new Date().toISOString(), complete: false, images: []
  };
  await writeFile(join(directory, 'INCOMPLETE'), 'Do not use until manifest verification succeeds.\n',
    { flag: 'wx', mode: 0o600 });
  for (let offset = 0; offset < keys.length; offset += 50) {
    const batch = keys.slice(offset, offset + 50);
    const signed = await fetchImpl(new URL('/file-urls', worker), {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: batch })
    });
    if (!signed.ok) throw new Error('Image authorization failed; backup is incomplete.');
    const urls = (await signed.json()).urls;
    for (const key of batch) {
      const url = new URL(urls?.[key]);
      if (url.origin !== worker.origin || url.pathname !== '/file' ||
          url.username || url.password || url.searchParams.get('key') !== key) {
        throw new Error('Image service returned an unexpected download URL.');
      }
      const response = await fetchImpl(url, { redirect: 'error' });
      const bytes = await boundedBytes(response);
      const filename = `${String(manifest.images.length).padStart(6, '0')}.bin`;
      await writeFile(join(directory, filename), bytes, { flag: 'wx', mode: 0o600 });
      manifest.images.push({ key, filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  manifest.complete = true;
  // Write the final manifest only on success and clear the marker after verification.
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2),
    { flag: 'wx', mode: 0o600 });
  await verifyImageBackup(directory);
  await unlink(join(directory, 'INCOMPLETE'));
  return { imageCount: keys.length, byteCount: manifest.images.reduce((n, i) => n + i.bytes, 0) };
}

export async function verifyImageBackup(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Backup directory must not be a symlink.');
  const manifestPath = join(directory, 'manifest.json');
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Manifest must be a regular file.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== 'vetcloudpro-referenced-images' || manifest.version !== 1 ||
      !manifest.complete || !Array.isArray(manifest.images)) throw new Error('Incomplete backup.');
  const seenKeys = new Set();
  const seenFiles = new Set();
  for (const image of manifest.images) {
    const match = KEY.exec(image.key);
    if (!match || match[1] !== manifest.clinicId || !/^\d{6}\.bin$/.test(image.filename) ||
        seenKeys.has(image.key) || seenFiles.has(image.filename)) throw new Error('Invalid backup manifest.');
    seenKeys.add(image.key); seenFiles.add(image.filename);
    const path = join(directory, image.filename);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.size !== image.bytes) throw new Error('Invalid image file.');
    const bytes = await readFile(path);
    if (sha256(bytes) !== image.sha256) throw new Error('Image integrity check failed.');
  }
  return { imageCount: manifest.images.length };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--verify' && args.length === 2) {
    console.log(JSON.stringify(await verifyImageBackup(resolve(args[1]))));
    return;
  }
  const apply = args.includes('--apply');
  const paths = args.filter(arg => arg !== '--apply');
  if (paths.length !== (apply ? 2 : 1)) {
    throw new Error('Usage: node scripts/backup-referenced-images.mjs EXPORT.json [NEW_DIRECTORY --apply] | --verify DIRECTORY');
  }
  const backup = JSON.parse(await readFile(resolve(paths[0]), 'utf8'));
  const keys = referencedKeys(backup);
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, imageCount: keys.length, scope: 'referenced patient images only' }));
    return;
  }
  console.log(JSON.stringify(await backupReferencedImages({
    backup, directory: resolve(paths[1]), workerUrl: process.env.IMAGE_WORKER_URL,
    token: process.env.FIREBASE_ID_TOKEN
  })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Image backup failed. Check inputs, permissions, token expiry and incomplete output; no cloud data was changed.');
    process.exitCode = 1;
  });
}
