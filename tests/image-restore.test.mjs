import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { restoreReferencedImages } from '../scripts/restore-referenced-images.mjs';

const key = 'clinics/source/patients/patient/12345678-1234-1234-1234-123456789abc.jpg';
const restored = 'clinics/target/patients/restore-test/12345678-1234-1234-1234-123456789abc.jpg';
const bytes = Buffer.from([255, 216, 255, 1]);
const workerUrl = 'https://images.example';
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = index => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const sourceKey = index => `clinics/source/patients/patient/${uuid(index)}.jpg`;
const restoredKey = index => `clinics/target/patients/restore-test/${uuid(index)}.jpg`;
async function fixture(images = [{ key, bytes }]) {
  const directory = await mkdtemp(join(tmpdir(), 'vetweb-image-restore-'));
  const manifest = {
    format: 'vetcloudpro-referenced-images', version: 1, complete: true, clinicId: 'source',
    images: images.map((image, index) => ({
      key: image.key, filename: `${String(index).padStart(6, '0')}.bin`,
      bytes: image.bytes.length, sha256: hash(image.bytes)
    }))
  };
  for (const [index, image] of images.entries()) {
    await writeFile(join(directory, `${String(index).padStart(6, '0')}.bin`), image.bytes);
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, mappingPath: join(directory, 'restore.jsonl'), targetClinicId: 'target',
    workerUrl, token: 'synthetic-token' };
}
async function journalEntries(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
}
function multiFetch({ imageBytes, failUploadAt = -1, uploadStatus = 503,
  failSignedAt = -1, signedStatus = 429, failDownloadAt = -1 }) {
  const calls = [];
  let uploads = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    assert.equal(options.redirect, 'error');
    if (parsed.pathname === '/upload') {
      const index = uploads++;
      assert.equal(options.body.get('patientId'), 'restore-test');
      assert.equal(options.body.get('clinicId'), 'target');
      if (index === failUploadAt) return new Response('failed', { status: uploadStatus });
      return Response.json({ key: restoredKey(index) });
    }
    if (parsed.pathname === '/file-urls') {
      const requested = JSON.parse(options.body).keys;
      if (failSignedAt >= 0 && requested.includes(restoredKey(failSignedAt))) {
        return new Response('failed', { status: signedStatus });
      }
      return Response.json({
        urls: Object.fromEntries(requested.map(source => [
          source, `${workerUrl}/file?key=${encodeURIComponent(source)}&sig=synthetic`
        ]))
      });
    }
    assert.equal(options.headers, undefined);
    const requested = parsed.searchParams.get('key');
    const match = /00000000-0000-0000-0000-(\d{12})\.jpg$/.exec(requested ?? '');
    assert.ok(match, 'download must target a restored key');
    const index = Number(match[1]);
    if (index === failDownloadAt) return new Response('failed', { status: 429 });
    return new Response(imageBytes[index]);
  };
  return { fetchImpl, calls };
}
function mockFetch(calls, badBytes = false) {
  return async (url, options) => {
    calls.push(new URL(url).pathname);
    assert.equal(options.redirect, 'error');
    if (new URL(url).pathname === '/upload') {
      assert.equal(options.body.get('patientId'), 'restore-test');
      assert.equal(options.body.get('clinicId'), 'target');
      return Response.json({ key: restored });
    }
    if (new URL(url).pathname === '/file-urls') {
      return Response.json({ urls: { [restored]: `https://images.example/file?key=${encodeURIComponent(restored)}&sig=synthetic` } });
    }
    assert.equal(options.headers, undefined);
    return new Response(badBytes ? Buffer.alloc(bytes.length) : bytes);
  };
}
test('restore uses new test prefix, journals mapping and verifies exact bytes', async () => {
  const options = await fixture();
  const calls = [];
  assert.deepEqual(await restoreReferencedImages({ ...options, fetchImpl: mockFetch(calls) }), { imageCount: 1 });
  assert.deepEqual(calls, ['/upload', '/file-urls', '/file']);
  const journal = await readFile(options.mappingPath, 'utf8');
  assert.ok(!journal.includes('synthetic-token') && !journal.includes('sig='));
  const entries = journal.trim().split('\n').map(JSON.parse);
  assert.equal(entries[1].sourceKey, key);
  assert.equal(entries[1].restoredKey, restored);
  assert.equal(entries[2].verified, true);
  assert.equal(entries[3].complete, true);
});
test('corrupted backup is rejected before any cloud call or journal creation', async () => {
  const options = await fixture();
  await writeFile(join(options.directory, '000000.bin'), Buffer.alloc(bytes.length));
  await assert.rejects(restoreReferencedImages({
    ...options, fetchImpl: () => { throw new Error('must not fetch'); }
  }), /integrity/);
  await assert.rejects(readFile(options.mappingPath), { code: 'ENOENT' });
});
test('failed verification retains new key in private partial journal', async () => {
  const options = await fixture();
  await assert.rejects(restoreReferencedImages({ ...options, fetchImpl: mockFetch([], true) }), /checksum/);
  const journal = await readFile(options.mappingPath, 'utf8');
  assert.ok(journal.includes(restored));
  assert.ok(!journal.includes('"complete":true'));
});
test('existing journal is never overwritten and no upload occurs', async () => {
  const options = await fixture();
  await writeFile(options.mappingPath, 'existing');
  await assert.rejects(restoreReferencedImages({
    ...options, fetchImpl: () => { throw new Error('must not fetch'); }
  }), { code: 'EEXIST' });
  assert.equal(await readFile(options.mappingPath, 'utf8'), 'existing');
});
test('restores multiple objects with distinct mappings and one completion record', async () => {
  const images = [0, 1, 2].map(index => ({
    key: sourceKey(index), bytes: Buffer.from([255, 216, 255, index])
  }));
  const options = await fixture(images);
  const { fetchImpl, calls } = multiFetch({ imageBytes: images.map(image => image.bytes) });
  assert.deepEqual(await restoreReferencedImages({ ...options, fetchImpl }), { imageCount: 3 });
  assert.deepEqual(calls, [
    '/upload', '/file-urls', '/file',
    '/upload', '/file-urls', '/file',
    '/upload', '/file-urls', '/file'
  ]);
  const entries = await journalEntries(options.mappingPath);
  assert.equal(entries[0].format, 'vetcloudpro-image-restore-journal');
  assert.equal(entries[0].sourceClinicId, 'source');
  assert.equal(entries[0].targetClinicId, 'target');
  const mappings = entries.filter(entry => entry.sourceKey);
  assert.deepEqual(mappings.map(entry => [entry.sourceKey, entry.restoredKey]), [
    [sourceKey(0), restoredKey(0)],
    [sourceKey(1), restoredKey(1)],
    [sourceKey(2), restoredKey(2)]
  ]);
  assert.ok(mappings.every(entry => entry.verified === false));
  assert.equal(new Set(mappings.map(entry => entry.restoredKey)).size, 3);
  assert.equal(entries.filter(entry => entry.verified === true).length, 3);
  assert.deepEqual(entries.at(-1), { complete: true, imageCount: 3 });
  const journal = await readFile(options.mappingPath, 'utf8');
  assert.ok(!journal.includes('synthetic-token') && !journal.includes('sig='));
});
test('partial upload failure preserves completed mappings and never marks completion', async () => {
  const images = [0, 1, 2].map(index => ({
    key: sourceKey(index), bytes: Buffer.from([255, 216, 255, index])
  }));
  const options = await fixture(images);
  const { fetchImpl, calls } = multiFetch({
    imageBytes: images.map(image => image.bytes), failUploadAt: 1, uploadStatus: 503
  });
  await assert.rejects(restoreReferencedImages({ ...options, fetchImpl }), /Restore upload failed/);
  assert.deepEqual(calls, ['/upload', '/file-urls', '/file', '/upload']);
  const entries = await journalEntries(options.mappingPath);
  const mappings = entries.filter(entry => entry.sourceKey);
  assert.deepEqual(mappings.map(entry => [entry.sourceKey, entry.restoredKey, entry.verified]),
    [[sourceKey(0), restoredKey(0), false]]);
  assert.equal(entries.filter(entry => entry.verified === true).length, 1);
  assert.ok(!entries.some(entry => entry.complete));
  assert.ok(!entries.some(entry => entry.sourceKey === sourceKey(1)));
  assert.ok(!entries.some(entry => entry.sourceKey === sourceKey(2)));
});
test('429 responses leave incomplete journals without completion records', async () => {
  const images = [0, 1].map(index => ({
    key: sourceKey(index), bytes: Buffer.from([255, 216, 255, index])
  }));
  const imageBytes = images.map(image => image.bytes);
  const uploadLimited = await fixture(images);
  await assert.rejects(restoreReferencedImages({
    ...uploadLimited,
    fetchImpl: multiFetch({ imageBytes, failUploadAt: 1, uploadStatus: 429 }).fetchImpl
  }), /Restore upload failed/);
  const uploadEntries = await journalEntries(uploadLimited.mappingPath);
  assert.deepEqual(uploadEntries.filter(entry => entry.sourceKey).map(entry => entry.restoredKey),
    [restoredKey(0)]);
  assert.equal(uploadEntries.filter(entry => entry.verified === true).length, 1);
  assert.ok(!uploadEntries.some(entry => entry.complete));

  const verifyLimited = await fixture(images);
  await assert.rejects(restoreReferencedImages({
    ...verifyLimited,
    fetchImpl: multiFetch({ imageBytes, failSignedAt: 0, signedStatus: 429 }).fetchImpl
  }), /Restore verification authorization failed/);
  const verifyEntries = await journalEntries(verifyLimited.mappingPath);
  assert.deepEqual(verifyEntries[1], {
    sourceKey: sourceKey(0), restoredKey: restoredKey(0),
    sha256: hash(images[0].bytes), verified: false
  });
  assert.ok(!verifyEntries.some(entry => entry.verified === true));
  assert.ok(!verifyEntries.some(entry => entry.complete));
});
test('malicious manifest paths and clinic mismatches are rejected before journal or upload', async () => {
  const mutations = [
    manifest => { manifest.images[0].filename = '../../escaped.bin'; },
    manifest => { manifest.images[0].filename = '/tmp/escaped.bin'; },
    manifest => { manifest.images[0].filename = 'nested/000000.bin'; },
    manifest => { manifest.clinicId = 'other-clinic'; },
    manifest => { manifest.images[0].key = sourceKey(0).replace('/source/', '/other/'); },
    manifest => { manifest.images[0].key = 'clinics/source/patients/../../00000000-0000-0000-0000-000000000000.jpg'; }
  ];
  for (const mutate of mutations) {
    const options = await fixture();
    const manifestPath = join(options.directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    mutate(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(restoreReferencedImages({
      ...options, fetchImpl: () => { throw new Error('must not fetch'); }
    }), /Invalid backup manifest/);
    await assert.rejects(readFile(options.mappingPath), { code: 'ENOENT' });
  }
});
