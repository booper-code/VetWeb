import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { referencedKeys, backupReferencedImages, verifyImageBackup } from '../scripts/backup-referenced-images.mjs';

const key = 'clinics/test-clinic/patients/test-patient/12345678-1234-1234-1234-123456789abc.jpg';
const backup = {
  format: 'vetcloudpro-clinic-backup', version: 1, clinicId: 'test-clinic',
  collections: { patients: [{ profilePicture: key, pictures: [key, 'data:image/png;base64,AA=='] }] }
};
const workerUrl = 'https://images.example';
const bytes = Buffer.from([137, 80, 78, 71]);
const MAX_BYTES = 5 * 1024 * 1024;
const newDirectory = async () => join(await mkdtemp(join(tmpdir(), 'vetweb-image-backup-')), 'backup');
const imageKey = index =>
  `clinics/test-clinic/patients/test-patient/12345678-1234-1234-1234-${index.toString(16).padStart(12, '0')}.jpg`;
const imageBytes = index => Buffer.from([137, 80, 78, 71, index & 0xff]);
function multiFetch(byteSets) {
  const calls = { signed: [], downloads: [] };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/file-urls') {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      const requested = JSON.parse(options.body).keys;
      calls.signed.push(requested);
      return Response.json({
        urls: Object.fromEntries(requested.map(source => [
          source, `${workerUrl}/file?key=${encodeURIComponent(source)}&sig=example`
        ]))
      });
    }
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined, 'never forward bearer token to signed URL');
    const requested = parsed.searchParams.get('key');
    calls.downloads.push(requested);
    return new Response(byteSets[requested]);
  };
  return { fetchImpl, calls };
}
function mockFetch(url, options) {
  if (String(url).endsWith('/file-urls')) {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    return Promise.resolve(Response.json({ urls: { [key]: `${workerUrl}/file?key=${encodeURIComponent(key)}&sig=example` } }));
  }
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers, undefined, 'never forward bearer token to signed URL');
  return Promise.resolve(new Response(bytes));
}

test('collects unique keys and rejects cross-clinic keys', () => {
  assert.deepEqual(referencedKeys(backup), [key]);
  assert.throws(() => referencedKeys({
    ...backup, collections: { patients: [{ profilePicture: key.replace('test-clinic', 'foreign') }] }
  }), /cross-clinic/);
});
test('private backup round-trips offline and detects tampering', async () => {
  const directory = await newDirectory();
  assert.deepEqual(await backupReferencedImages({
    backup, directory, workerUrl, token: 'synthetic-token', fetchImpl: mockFetch
  }), { imageCount: 1, byteCount: bytes.length });
  assert.deepEqual(await verifyImageBackup(directory), { imageCount: 1 });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, '000000.bin'))).mode & 0o777, 0o600);
  const manifest = await readFile(join(directory, 'manifest.json'), 'utf8');
  assert.ok(!manifest.includes('synthetic-token') && !manifest.includes('sig='));
  await assert.rejects(readFile(join(directory, 'INCOMPLETE')), { code: 'ENOENT' });
  await writeFile(join(directory, '000000.bin'), Buffer.alloc(bytes.length));
  await assert.rejects(verifyImageBackup(directory), /integrity/);
});
test('never overwrites a backup directory', async () => {
  const directory = await newDirectory();
  await backupReferencedImages({ backup, directory, workerUrl, token: 'synthetic-token', fetchImpl: mockFetch });
  await assert.rejects(backupReferencedImages({ backup, directory, workerUrl, token: 'synthetic-token', fetchImpl: mockFetch }), { code: 'EEXIST' });
});
test('rejects foreign signed URLs and leaves an incomplete marker', async () => {
  const directory = await newDirectory();
  await assert.rejects(backupReferencedImages({
    backup, directory, workerUrl, token: 'synthetic-token',
    fetchImpl: async () => Response.json({ urls: { [key]: `https://foreign.example/file?key=${encodeURIComponent(key)}` } })
  }), /unexpected/);
  await assert.rejects(readFile(join(directory, 'manifest.json')), { code: 'ENOENT' });
  assert.ok(await readFile(join(directory, 'INCOMPLETE'), 'utf8'));
});
test('rejects symlink image entries during offline verification', async () => {
  const directory = await newDirectory();
  await backupReferencedImages({ backup, directory, workerUrl, token: 'synthetic-token', fetchImpl: mockFetch });
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  manifest.images[0].filename = '000001.bin';
  await symlink(join(directory, '000000.bin'), join(directory, '000001.bin'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyImageBackup(directory), /Invalid image file/);
});
test('backs up multiple referenced objects in one verified set', async () => {
  const imageKeys = [imageKey(1), imageKey(2), imageKey(3)];
  const byteSets = Object.fromEntries(imageKeys.map((image, index) => [image, imageBytes(index)]));
  const multiBackup = {
    ...backup, collections: { patients: [{ profilePicture: imageKeys[0], pictures: imageKeys.slice(1) }] }
  };
  const directory = await newDirectory();
  const { fetchImpl, calls } = multiFetch(byteSets);
  assert.deepEqual(await backupReferencedImages({
    backup: multiBackup, directory, workerUrl, token: 'synthetic-token', fetchImpl
  }), { imageCount: 3, byteCount: 15 });
  assert.deepEqual(calls.signed, [imageKeys]);
  assert.deepEqual(calls.downloads, imageKeys);
  assert.deepEqual(await verifyImageBackup(directory), { imageCount: 3 });
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.images.map(image => image.key), imageKeys);
  assert.deepEqual(manifest.images.map(image => image.filename),
    ['000000.bin', '000001.bin', '000002.bin']);
  for (const image of manifest.images) {
    assert.equal(image.bytes, byteSets[image.key].length);
    assert.deepEqual(await readFile(join(directory, image.filename)), byteSets[image.key]);
  }
  await assert.rejects(readFile(join(directory, 'INCOMPLETE')), { code: 'ENOENT' });
  const exportJson = await readFile(join(directory, 'manifest.json'), 'utf8');
  assert.ok(!exportJson.includes('synthetic-token') && !exportJson.includes('sig='));
});
test('rate-limited authorization batches 50 objects and leaves an incomplete backup', async () => {
  const imageKeys = Array.from({ length: 51 }, (_, index) => imageKey(index));
  const byteSets = Object.fromEntries(imageKeys.map((image, index) => [image, imageBytes(index)]));
  const multiBackup = { ...backup, collections: { patients: [{ pictures: imageKeys }] } };
  const directory = await newDirectory();
  const signedBatches = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/file-urls') {
      const requested = JSON.parse(options.body).keys;
      signedBatches.push(requested);
      if (signedBatches.length === 2) return new Response('rate limited', { status: 429 });
      return Response.json({
        urls: Object.fromEntries(requested.map(source => [
          source, `${workerUrl}/file?key=${encodeURIComponent(source)}&sig=example`
        ]))
      });
    }
    return new Response(byteSets[parsed.searchParams.get('key')]);
  };
  await assert.rejects(backupReferencedImages({
    backup: multiBackup, directory, workerUrl, token: 'synthetic-token', fetchImpl
  }), /authorization failed/);
  assert.equal(signedBatches.length, 2);
  assert.equal(signedBatches[0].length, 50);
  assert.deepEqual(signedBatches[1], imageKeys.slice(50));
  assert.deepEqual(await readFile(join(directory, '000049.bin')), byteSets[imageKeys[49]]);
  await assert.rejects(readFile(join(directory, '000050.bin')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'manifest.json')), { code: 'ENOENT' });
  assert.ok(await readFile(join(directory, 'INCOMPLETE'), 'utf8'));
});
test('rate-limited image download leaves no final manifest', async () => {
  const imageKeys = [imageKey(1), imageKey(2)];
  const byteSets = Object.fromEntries(imageKeys.map((image, index) => [image, imageBytes(index)]));
  const multiBackup = { ...backup, collections: { patients: [{ pictures: imageKeys }] } };
  const directory = await newDirectory();
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/file-urls') {
      const requested = JSON.parse(options.body).keys;
      return Response.json({
        urls: Object.fromEntries(requested.map(source => [
          source, `${workerUrl}/file?key=${encodeURIComponent(source)}&sig=example`
        ]))
      });
    }
    if (parsed.searchParams.get('key') === imageKeys[1]) {
      return new Response('rate limited', { status: 429 });
    }
    return new Response(byteSets[parsed.searchParams.get('key')]);
  };
  await assert.rejects(backupReferencedImages({
    backup: multiBackup, directory, workerUrl, token: 'synthetic-token', fetchImpl
  }), /Image download failed/);
  assert.deepEqual(await readFile(join(directory, '000000.bin')), byteSets[imageKeys[0]]);
  await assert.rejects(readFile(join(directory, '000001.bin')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'manifest.json')), { code: 'ENOENT' });
  assert.ok(await readFile(join(directory, 'INCOMPLETE'), 'utf8'));
});
test('rejects an oversized image download without writing bytes or a manifest', async () => {
  const directory = await newDirectory();
  await assert.rejects(backupReferencedImages({
    backup, directory, workerUrl, token: 'synthetic-token',
    fetchImpl: async url => {
      if (String(url).endsWith('/file-urls')) {
        return Response.json({
          urls: { [key]: `${workerUrl}/file?key=${encodeURIComponent(key)}&sig=example` }
        });
      }
      return new Response(Buffer.alloc(MAX_BYTES + 1));
    }
  }), /exceeds the backup size limit/);
  await assert.rejects(readFile(join(directory, '000000.bin')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'manifest.json')), { code: 'ENOENT' });
  assert.ok(await readFile(join(directory, 'INCOMPLETE'), 'utf8'));
});
test('offline verification rejects manifest path traversal and clinic mismatches', async () => {
  const directory = await newDirectory();
  await backupReferencedImages({
    backup, directory, workerUrl, token: 'synthetic-token', fetchImpl: mockFetch
  });
  const manifestPath = join(directory, 'manifest.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const filename of ['../000000.bin', '/etc/passwd', '000000.bin/..', 'sub/000000.bin']) {
    await writeFile(manifestPath, JSON.stringify({
      ...original, images: [{ ...original.images[0], filename }]
    }));
    await assert.rejects(verifyImageBackup(directory), /Invalid backup manifest/);
  }
  await writeFile(manifestPath, JSON.stringify({ ...original, clinicId: 'other-clinic' }));
  await assert.rejects(verifyImageBackup(directory), /Invalid backup manifest/);
  await writeFile(manifestPath, JSON.stringify(original));
  assert.deepEqual(await verifyImageBackup(directory), { imageCount: 1 });
});
