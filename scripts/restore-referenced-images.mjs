#!/usr/bin/env node
/**
 * Non-destructive rehearsal: upload verified backup bytes under restore-test.
 * Does not overwrite original objects or update any patient document.
 */
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyImageBackup } from './backup-referenced-images.mjs';

const workerOrigin = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Trusted HTTPS Worker origin required.');
  return url;
};

export async function restoreReferencedImages({
  directory, targetClinicId, mappingPath, workerUrl, token, fetchImpl = fetch
}) {
  await verifyImageBackup(directory); // Verify the entire set before any cloud write.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(targetClinicId) || !token) throw new Error('Target clinic and ID token required.');
  const worker = workerOrigin(workerUrl);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  // Exclusive append-only journal survives partial failures and never contains credentials.
  await writeFile(mappingPath, JSON.stringify({
    format: 'vetcloudpro-image-restore-journal', version: 1,
    createdAt: new Date().toISOString(), sourceClinicId: manifest.clinicId,
    targetClinicId, patientPrefix: 'restore-test'
  }) + '\n', { flag: 'wx', mode: 0o600 });
  const record = entry => appendFile(mappingPath, JSON.stringify(entry) + '\n');
  let count = 0;
  for (const image of manifest.images) {
    const bytes = await readFile(join(directory, image.filename));
    if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('Backup changed after verification.');
    const form = new FormData();
    form.set('clinicId', targetClinicId);
    form.set('patientId', 'restore-test');
    form.set('file', new Blob([bytes]), 'restored-image.jpg');
    const uploaded = await fetchImpl(new URL('/upload', worker), {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}` }, body: form
    });
    if (!uploaded.ok) throw new Error('Restore upload failed; inspect the private partial journal.');
    const key = (await uploaded.json()).key;
    const prefix = `clinics/${targetClinicId}/patients/restore-test/`;
    if (typeof key !== 'string' || !key.startsWith(prefix) ||
        !/^[0-9a-f-]{36}\.jpg$/.test(key.slice(prefix.length))) throw new Error('Unexpected restored image key.');
    await record({ sourceKey: image.key, restoredKey: key, sha256: image.sha256, verified: false });
    const signed = await fetchImpl(new URL('/file-urls', worker), {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [key] })
    });
    if (!signed.ok) throw new Error('Restore verification authorization failed.');
    const url = new URL((await signed.json()).urls?.[key]);
    if (url.origin !== worker.origin || url.pathname !== '/file' || url.username ||
        url.password || url.searchParams.get('key') !== key) throw new Error('Unexpected verification URL.');
    const downloaded = await fetchImpl(url, { redirect: 'error' });
    if (!downloaded.ok || !downloaded.body) throw new Error('Restore verification download failed.');
    const reader = downloaded.body.getReader();
    const hash = createHash('sha256');
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > image.bytes) throw new Error('Restored image size mismatch.');
        hash.update(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (size !== image.bytes || hash.digest('hex') !== image.sha256) throw new Error('Restore checksum mismatch.');
    await record({ restoredKey: key, verified: true });
    count += 1;
  }
  await record({ complete: true, imageCount: count });
  return { imageCount: count };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || !args.includes('--apply')) {
    throw new Error('Usage: restore-referenced-images.mjs BACKUP_DIRECTORY NEW_JOURNAL_PATH --apply');
  }
  const paths = args.filter(arg => arg !== '--apply');
  console.log(JSON.stringify(await restoreReferencedImages({
    directory: resolve(paths[0]), mappingPath: resolve(paths[1]),
    targetClinicId: process.env.RESTORE_CLINIC_ID,
    workerUrl: process.env.IMAGE_WORKER_URL, token: process.env.FIREBASE_ID_TOKEN
  })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Restore stopped; inspect the private journal. No original objects or patient references were changed.');
    process.exitCode = 1;
  });
}
