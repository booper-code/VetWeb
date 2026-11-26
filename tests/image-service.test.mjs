import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../workers/image-service/src/index.ts';

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

test('image service enforces authentication, membership, roles and signed URLs', async () => {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'test-key' };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = async (uid, overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({
      aud: 'test-project', iss: 'https://securetoken.google.com/test-project',
      sub: uid, iat: now, exp: now + 3600, ...overrides
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
  };
  const roles = { owner: 'owner', member: 'member', viewer: 'viewer' };
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('googleapis.com/service_accounts/')) return Response.json({ keys: [jwk] });
    if (url.includes('firestore.googleapis.com/')) {
      if (url.endsWith('/clinics/clinic-a')) return Response.json({ fields: {} });
      const uid = decodeURIComponent(url.split('/').pop());
      const clinic = url.includes('/clinics/clinic-a/');
      return clinic && roles[uid]
        ? Response.json({ fields: { role: { stringValue: roles[uid] } } })
        : new Response(null, { status: 403 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const objects = new Map();
  let deletes = 0;
  const env = {
    USER_REQUEST_LIMITER: { limit: async () => ({ success: true }) },
    USER_UPLOAD_LIMITER: { limit: async () => ({ success: true }) },
    CLINIC_UPLOAD_LIMITER: { limit: async () => ({ success: true }) },
    FIREBASE_PROJECT_ID: 'test-project', IMAGE_TOKEN_SECRET: 'x'.repeat(48),
    ALLOWED_ORIGINS: 'https://app.example',
    IMAGES: {
      async put(key, bytes, options) { objects.set(key, { bytes, options }); },
      async get(key) {
        const item = objects.get(key);
        return item ? { body: new Blob([item.bytes]).stream(), httpMetadata: item.options.httpMetadata } : null;
      },
      async delete(key) { deletes += 1; objects.delete(key); }
    }
  };
  const request = (path, init = {}) => worker.fetch(new Request(`https://images.example${path}`, init), env);
  const auth = value => ({ Authorization: `Bearer ${value}` });
  const owner = await token('owner');
  const member = await token('member');
  const viewer = await token('viewer');
  const outsider = await token('outsider');
  const expired = await token('owner', { exp: 1 });
  const wrongAudience = await token('owner', { aud: 'other-project' });
  const upload = async (identity, clinic = 'clinic-a', bytes = [0xff, 0xd8, 0xff, 0x01]) => {
    const body = new FormData();
    body.set('clinicId', clinic);
    body.set('patientId', 'PAT-1');
    body.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'photo.jpg');
    return request('/upload', { method: 'POST', headers: auth(identity), body });
  };
  assert.equal((await upload(expired)).status, 401);
  assert.equal((await upload(wrongAudience)).status, 401);
  assert.equal((await upload(`${owner.slice(0, owner.lastIndexOf('.') + 1)}!`)).status, 401);
  assert.equal((await upload(viewer)).status, 200);
  assert.equal((await upload(member)).status, 200);
  assert.equal((await upload(outsider)).status, 403);
  assert.equal((await upload(owner, 'clinic-b')).status, 403);
  assert.equal((await upload(owner, 'clinic-a', [0, 1, 2])).status, 415);
  const response = await upload(owner);
  assert.equal(response.status, 200);
  const { key } = await response.json();
  assert.match(key, /^clinics\/clinic-a\/patients\/PAT-1\//);

  const sign = (identity, requested = key) => request('/file-urls', {
    method: 'POST', headers: { ...auth(identity), 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: [requested] })
  });
  assert.equal((await sign(outsider)).status, 403);
  const otherClinicKey = key.replace('clinic-a', 'clinic-b');
  assert.equal((await sign(owner, otherClinicKey)).status, 403);
  const signed = await sign(viewer);
  assert.equal(signed.status, 200);
  const { urls } = await signed.json();
  const file = await worker.fetch(new Request(urls[key]), env);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0xff, 0xd8, 0xff, 1]);
  const tampered = new URL(urls[key]);
  tampered.searchParams.set('exp', '1');
  assert.equal((await worker.fetch(new Request(tampered), env)).status, 403);
  // Deletion is disabled in this version of the Worker: every role gets 405,
  // R2 is never touched, and the signed URL keeps working.
  const remove = identity => request('/file', {
    method: 'DELETE', headers: { ...auth(identity), 'Content-Type': 'application/json' }, body: JSON.stringify({ key })
  });
  const viewerDelete = await remove(viewer);
  assert.equal(viewerDelete.status, 405);
  assert.match((await viewerDelete.json()).error, /disabled/i);
  const ownerDelete = await remove(owner);
  assert.equal(ownerDelete.status, 405);
  assert.equal(ownerDelete.headers.get('allow'), 'GET, POST, OPTIONS');
  assert.equal(ownerDelete.headers.get('cache-control'), 'no-store');
  assert.equal(deletes, 0, 'R2 delete must not be called while deletion is disabled');
  const afterDelete = await worker.fetch(new Request(urls[key]), env);
  assert.equal(afterDelete.status, 200);
  assert.deepEqual([...new Uint8Array(await afterDelete.arrayBuffer())], [0xff, 0xd8, 0xff, 1]);

  const preflight = await request('/file', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET,POST,OPTIONS');
});
