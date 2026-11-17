import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createSigner } from './fixtures/image-service-harness.mjs';

test('verified users are limited before upload parsing or Firestore work', async () => {
  const harness = await createHarness();
  try {
    const signer = await createSigner('rate-key');
    harness.state.jwks = [signer.jwk];
    const keys = [];
    harness.env.USER_REQUEST_LIMITER.limit = async ({ key }) => {
      keys.push(key); return { success: false };
    };
    const response = await harness.request('/upload', {
      method: 'POST', headers: { Authorization: `Bearer ${await signer.token('owner')}` },
      body: 'not even multipart'
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(keys, ['owner']);
    assert.equal(harness.objects.size, 0);
    assert.equal((await harness.request('/upload', { method: 'POST' })).status, 401);
    assert.equal(keys.length, 1, 'unverified callers cannot consume another user counter');
  } finally { harness.restore(); }
});
test('missing limiter fails closed and signing uses verified user key', async () => {
  const harness = await createHarness();
  try {
    const signer = await createSigner('rate-key');
    harness.state.jwks = [signer.jwk];
    delete harness.env.USER_REQUEST_LIMITER;
    const response = await harness.request('/file-urls', {
      method: 'POST', headers: { Authorization: `Bearer ${await signer.token('viewer')}` },
      body: '{}'
    });
    assert.equal(response.status, 503);
  } finally { harness.restore(); }
});
test('clinic upload limit blocks R2 writes after membership authorization', async () => {
  const harness = await createHarness();
  try {
    const signer = await createSigner('rate-key');
    harness.state.jwks = [signer.jwk];
    const keys = [];
    harness.env.CLINIC_UPLOAD_LIMITER.limit = async ({ key }) => {
      keys.push(key); return { success: false };
    };
    const form = new FormData();
    form.set('clinicId', 'clinic-a');
    form.set('file', new Blob([new Uint8Array([255, 216, 255, 1])]), 'test.jpg');
    const response = await harness.request('/upload', {
      method: 'POST', headers: { Authorization: `Bearer ${await signer.token('owner')}` }, body: form
    });
    assert.equal(response.status, 429);
    assert.deepEqual(keys, ['clinic-a']);
    assert.equal(harness.objects.size, 0);
  } finally { harness.restore(); }
});

test('per-user upload limit blocks before parsing while unrelated users retain allowance', async () => {
  const harness = await createHarness();
  try {
    const signer = await createSigner('upload-rate-key');
    harness.state.jwks = [signer.jwk];
    harness.env.USER_UPLOAD_LIMITER.limit = async ({ key }) => ({ success: key !== 'owner' });
    const response = await harness.request('/upload', {
      method: 'POST', headers: { Authorization: `Bearer ${await signer.token('owner')}` },
      body: 'not multipart'
    });
    assert.equal(response.status, 429);
    const unrelated = await harness.request('/upload', {
      method: 'POST', headers: { Authorization: `Bearer ${await signer.token('editor')}` },
      body: 'not multipart'
    });
    assert.equal(unrelated.status, 400);
  } finally { harness.restore(); }
});

test('signing JSON bodies are bounded before parsing', async () => {
  const harness = await createHarness();
  try {
    const signer = await createSigner('sign-body-key');
    harness.state.jwks = [signer.jwk];
    const response = await harness.request('/file-urls', {
      method: 'POST', headers: { Authorization: `Bearer ${await signer.token('viewer')}` },
      body: 'x'.repeat(64 * 1024 + 1)
    });
    assert.equal(response.status, 413);
  } finally { harness.restore(); }
});
