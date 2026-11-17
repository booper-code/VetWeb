// Regression tests for the bounded upload body reader.
//
// `handleUpload` now buffers the multipart body itself with a hard ceiling
// instead of handing the raw request to `formData()`. These tests cover the two
// failure modes that motivated it (missing and understated Content-Length), the
// legitimate near-limit upload that must keep working, and the unchanged
// authorization-before-body order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createSigner } from './fixtures/image-service-harness.mjs';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BODY_BYTES
} from '../workers/image-service/src/index.ts';

const UPLOAD_URL = 'https://images.example/upload';
const CHUNK_BYTES = 16 * 1024;

const jpegOfSize = size => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};

const ownerSession = async t => {
  const harness = await createHarness();
  t.after(harness.restore);
  const signer = await createSigner('test-key');
  harness.state.jwks = [signer.jwk];
  const token = await signer.token('owner');
  return { harness, authorization: `Bearer ${token}` };
};

/**
 * A finite, chunked body that exceeds the whole-body cap but still ends, so a
 * regression fails an assertion instead of hanging the test runner. The
 * `highWaterMark: 0` strategy means `pull` only runs when something actually
 * reads the stream, which lets these tests prove the Worker rejected the request
 * without touching the body.
 */
const oversizedStream = (headroomBytes = 2 * CHUNK_BYTES) => {
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x61);
  const chunkCount = Math.ceil((MAX_UPLOAD_BODY_BYTES + headroomBytes) / CHUNK_BYTES);
  const stats = { pulled: 0, sent: 0 };
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (stats.sent >= chunkCount) {
          controller.close();
          return;
        }
        stats.sent += 1;
        stats.pulled += 1;
        controller.enqueue(chunk);
      }
    },
    { highWaterMark: 0 }
  );
  return { stream, stats, total: chunkCount * CHUNK_BYTES };
};

const multipartHeaders = (authorization, extra = {}) => ({
  Authorization: authorization,
  'content-type': 'multipart/form-data; boundary=test-boundary',
  ...extra
});

test('accepts a legitimate multipart upload of exactly the 5 MB file limit', async t => {
  const { harness, authorization } = await ownerSession(t);

  const body = new FormData();
  body.set('clinicId', 'clinic-a');
  body.set('patientId', 'PAT-1');
  body.set('file', new Blob([jpegOfSize(MAX_UPLOAD_BYTES)], { type: 'image/jpeg' }), 'photo.jpg');

  const request = new Request(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: authorization },
    body
  });

  // The serialized multipart container is larger than the file ceiling because
  // of framing, which is exactly why the body cap has headroom.
  const serialized = new Uint8Array(await request.clone().arrayBuffer());
  assert.ok(serialized.byteLength > MAX_UPLOAD_BYTES);
  assert.ok(serialized.byteLength <= MAX_UPLOAD_BODY_BYTES);

  const response = await harness.send(request);
  assert.equal(response.status, 200);
  const { key } = await response.json();
  assert.equal(harness.objects.get(key).bytes.byteLength, MAX_UPLOAD_BYTES);
});

test('rejects a file one byte over the per-file limit while the body still fits', async t => {
  const { harness, authorization } = await ownerSession(t);

  const body = new FormData();
  body.set('clinicId', 'clinic-a');
  body.set('patientId', 'PAT-1');
  body.set(
    'file',
    new Blob([jpegOfSize(MAX_UPLOAD_BYTES + 1)], { type: 'image/jpeg' }),
    'photo.jpg'
  );

  const response = await harness.request('/upload', {
    method: 'POST',
    headers: { Authorization: authorization },
    body
  });

  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /5 MB/);
  assert.equal(harness.objects.size, 0);
});

test('rejects an oversized streamed body that has no Content-Length', async t => {
  const { harness, authorization } = await ownerSession(t);
  const { stream, total } = oversizedStream();
  assert.ok(total > MAX_UPLOAD_BODY_BYTES);

  const request = new Request(UPLOAD_URL, {
    method: 'POST',
    headers: multipartHeaders(authorization),
    body: stream,
    duplex: 'half'
  });
  assert.equal(request.headers.get('content-length'), null, 'test must not send a length');

  const response = await harness.send(request);
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /5 MB/);
  assert.equal(harness.objects.size, 0);
});

test('rejects an oversized streamed body when Content-Length understates it', async t => {
  const { harness, authorization } = await ownerSession(t);
  const { stream, total } = oversizedStream();
  assert.ok(total > MAX_UPLOAD_BODY_BYTES);

  const request = new Request(UPLOAD_URL, {
    method: 'POST',
    headers: multipartHeaders(authorization, { 'content-length': '128' }),
    body: stream,
    duplex: 'half'
  });
  assert.equal(request.headers.get('content-length'), '128');

  const response = await harness.send(request);
  assert.equal(response.status, 413);
  assert.equal(harness.objects.size, 0);
});

test('rejects an over-limit Content-Length without reading the body', async t => {
  const { harness, authorization } = await ownerSession(t);
  const { stream, stats } = oversizedStream();

  const request = new Request(UPLOAD_URL, {
    method: 'POST',
    headers: multipartHeaders(authorization, {
      'content-length': String(MAX_UPLOAD_BODY_BYTES + 1)
    }),
    body: stream,
    duplex: 'half'
  });

  const response = await harness.send(request);
  assert.equal(response.status, 413);
  assert.equal(stats.pulled, 0, 'the body must not be read when Content-Length already exceeds the cap');
});

test('authorization is checked before the body is read', async t => {
  const { harness } = await ownerSession(t);
  const { stream, stats } = oversizedStream();

  const request = new Request(UPLOAD_URL, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=test-boundary' },
    body: stream,
    duplex: 'half'
  });

  const response = await harness.send(request);
  assert.equal(response.status, 401);
  assert.equal(stats.pulled, 0, 'an unauthenticated request must be rejected before the body is touched');
  assert.equal(harness.objects.size, 0);
});
