// Regression tests for two image-service hardening fixes:
//   1. JSON responses (including signed URLs) are sent with `Cache-Control: no-store`.
//   2. A forged/unknown `kid` no longer forces a JWKS fetch on every request,
//      while a genuine key rotation is still picked up after the throttle window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createSigner } from './fixtures/image-service-harness.mjs';

const JPEG = [0xff, 0xd8, 0xff, 0x01];

const uploadAs = (request, token, clinicId = 'clinic-a') => {
  const body = new FormData();
  body.set('clinicId', clinicId);
  body.set('patientId', 'PAT-1');
  body.set('file', new Blob([new Uint8Array(JPEG)], { type: 'image/jpeg' }), 'photo.jpg');
  return request('/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
};

const jsonHeaders = token => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json'
});

test('JSON responses are not cacheable', async t => {
  const harness = await createHarness();
  t.after(harness.restore);

  const signer = await createSigner('test-key');
  harness.state.jwks = [signer.jwk];
  const owner = await signer.token('owner');
  const viewer = await signer.token('viewer');

  const uploaded = await uploadAs(harness.request, owner);
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.headers.get('cache-control'), 'no-store');
  const { key } = await uploaded.json();

  const signed = await harness.request('/file-urls', {
    method: 'POST',
    headers: jsonHeaders(owner),
    body: JSON.stringify({ keys: [key] })
  });
  assert.equal(signed.status, 200);
  assert.equal(signed.headers.get('cache-control'), 'no-store');
  assert.ok((await signed.json()).urls[key]);

  // Error bodies are JSON as well, so they must not be cached either.
  const denied = await uploadAs(harness.request, viewer);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('cache-control'), 'no-store');

  // Deletion is disabled, but its JSON error body must not be cached either.
  const deleteAttempt = await harness.request('/file', {
    method: 'DELETE',
    headers: jsonHeaders(owner),
    body: JSON.stringify({ key })
  });
  assert.equal(deleteAttempt.status, 405);
  assert.equal(deleteAttempt.headers.get('cache-control'), 'no-store');
});

test('unknown kid values are throttled instead of refetching JWKS per request', async t => {
  const harness = await createHarness();
  t.after(harness.restore);

  const base = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: base });

  const current = await createSigner('key-a');
  harness.state.jwks = [current.jwk];

  // First request has no cached key set, so exactly one fetch is expected.
  assert.equal((await uploadAs(harness.request, await current.token('owner'))).status, 200);
  assert.equal(harness.state.jwksFetches, 1);

  // Forged tokens with unknown kids are rejected using the cached key set; they
  // must not turn into one outbound JWKS fetch per request.
  for (let index = 0; index < 5; index += 1) {
    const forged = await createSigner(`unknown-${index}`);
    assert.equal((await uploadAs(harness.request, await forged.token('owner'))).status, 401);
  }
  assert.equal(harness.state.jwksFetches, 1);

  // After the throttle window, a real rotation is still picked up and usable.
  t.mock.timers.tick(61_000);
  const rotated = await createSigner('key-b');
  harness.state.jwks = [current.jwk, rotated.jwk];

  assert.equal((await uploadAs(harness.request, await rotated.token('owner'))).status, 200);
  assert.equal(harness.state.jwksFetches, 2);
});

test('a genuinely signed bearer URL expires without changing its signature', async t => {
  const harness = await createHarness();
  t.after(harness.restore);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const signer = await createSigner('expiry-key');
  harness.state.jwks = [signer.jwk];
  const owner = await signer.token('owner');
  const { key } = await (await uploadAs(harness.request, owner)).json();
  const signed = await harness.request('/file-urls', {
    method: 'POST', headers: jsonHeaders(owner), body: JSON.stringify({ keys: [key] })
  });
  const url = new URL((await signed.json()).urls[key]);
  assert.equal((await harness.request(url.pathname + url.search)).status, 200);
  t.mock.timers.tick(15 * 60 * 1000 + 1000);
  assert.equal((await harness.request(url.pathname + url.search)).status, 403);
});

test('owner-paused uploads cannot write objects but existing image links remain readable', async t => {
  const harness = await createHarness();
  t.after(harness.restore);
  const signer = await createSigner('pause-key');
  harness.state.jwks = [signer.jwk];
  const owner = await signer.token('owner');
  const { key } = await (await uploadAs(harness.request, owner)).json();
  harness.state.uploadsEnabled = false;
  const denied = await uploadAs(harness.request, owner);
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /paused/);
  assert.equal(harness.objects.size, 1);
  const signed = await harness.request('/file-urls', {
    method: 'POST', headers: jsonHeaders(owner), body: JSON.stringify({ keys: [key] })
  });
  assert.equal(signed.status, 200);
  const url = new URL((await signed.json()).urls[key]);
  assert.equal((await harness.request(url.pathname + url.search)).status, 200);
});
