/**
 * VetCloudPro patient-image service.
 *
 * A Cloudflare Worker in front of a private R2 bucket:
 *   POST   /upload      verify Firebase ID token + clinic membership, store JPEG/PNG/WebP
 *   POST   /file-urls   return short-lived signed URLs for a batch of object keys
 *   GET    /file        serve an object when the signed URL is valid
 *   DELETE /file        disabled (405) until reference-aware cleanup exists
 *   GET    /health      liveness probe
 *
 * Membership is checked by reading `clinics/{clinicId}/members/{uid}` through the
 * Firestore REST API with the caller's own ID token, so Firestore rules remain
 * the source of truth. The bucket itself is never public.
 *
 * Deploy instructions live in README.md next to this file.
 */

type R2ObjectBodyLike = {
  body: ReadableStream;
  httpMetadata?: { contentType?: string; cacheControl?: string };
};

type R2BucketLike = {
  put: (
    key: string,
    value: ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    }
  ) => Promise<unknown>;
  get: (key: string) => Promise<R2ObjectBodyLike | null>;
};

type Env = {
  IMAGES: R2BucketLike;
  FIREBASE_PROJECT_ID: string;
  IMAGE_TOKEN_SECRET: string;
  ALLOWED_ORIGINS?: string;
  USER_REQUEST_LIMITER?: { limit: (input: { key: string }) => Promise<{ success: boolean }> };
  USER_UPLOAD_LIMITER?: { limit: (input: { key: string }) => Promise<{ success: boolean }> };
  CLINIC_UPLOAD_LIMITER?: { limit: (input: { key: string }) => Promise<{ success: boolean }> };
};

type FirebaseToken = { uid: string };
type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string };
type MemberRole = 'owner' | 'member';

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
/**
 * Minimum interval between JWKS fetches. Without it, every request carrying an
 * unknown `kid` forces an outbound fetch, so forged tokens would amplify into
 * one Google subrequest per call.
 */
const JWKS_MIN_REFRESH_INTERVAL_MS = 60 * 1000;
/** Exported for tests; the upload ceiling for the file part. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/**
 * Ceiling for the whole multipart container, not just the file part. Multipart
 * framing for `clinicId`, `patientId`, and a filename is a few hundred bytes, so
 * 64 KiB of headroom still accepts a legitimate 5 MB image while keeping the
 * buffer bounded.
 */
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;
const UPLOAD_TOO_LARGE = 'Images must be smaller than 5 MB.';
const MAX_BATCH_KEYS = 100;
const SIGNED_URL_TTL_SECONDS = 15 * 60;
const CLINIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PATIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_PATTERN =
  /^clinics\/([A-Za-z0-9_-]{1,64})\/patients\/([A-Za-z0-9_-]{1,64})\/([0-9a-f-]{36})\.jpg$/;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const enforceRateLimit = async (
  limiter: Env['USER_REQUEST_LIMITER'],
  key: string
) => {
  // Missing infrastructure must not silently remove the abuse safeguard.
  if (!limiter) throw new HttpError(503, 'Image rate limiting is not configured.');
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, 'Too many image requests. Try again in a minute.');
};

const json = (
  data: unknown,
  status: number,
  cors: Record<string, string>,
  extraHeaders: Record<string, string> = {}
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Signed URLs and object keys are short-lived credentials; never let a
      // browser or intermediary cache them.
      'Cache-Control': 'no-store',
      ...cors,
      ...extraHeaders
    }
  });

const corsHeaders = (request: Request, env: Env): Record<string, string> => {
  const origin = request.headers.get('Origin');
  if (!origin) return {};

  const allowed = (env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (!allowed.includes('*') && !allowed.includes(origin.replace(/\/+$/, ''))) {
    return {};
  }

  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
};

const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

const loadJwks = async (force = false): Promise<Jwk[]> => {
  const now = Date.now();
  if (!force && jwksCache && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  // Throttle refreshes: an unknown `kid` is not proof that Google rotated keys,
  // so reuse the cached set until the interval has elapsed.
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_MIN_REFRESH_INTERVAL_MS) {
    return jwksCache.keys;
  }

  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new HttpError(503, 'Could not verify the sign-in token.');

  const data = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(data.keys) ? data.keys : [];
  jwksCache = { keys, fetchedAt: now };
  return keys;
};

type JwtPayload = {
  aud?: unknown;
  iss?: unknown;
  exp?: unknown;
  iat?: unknown;
  sub?: unknown;
};

const verifyFirebaseToken = async (token: string, projectId: string): Promise<FirebaseToken> => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Invalid sign-in token.');

  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: unknown; kid?: unknown };
  let payload: JwtPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerPart))) as typeof header;
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadPart))) as JwtPayload;
  } catch {
    throw new HttpError(401, 'Invalid sign-in token.');
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new HttpError(401, 'Invalid sign-in token.');
  }

  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new HttpError(401, 'Invalid sign-in token.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw new HttpError(401, 'Your sign-in has expired. Refresh the page and try again.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) {
    throw new HttpError(401, 'Invalid sign-in token.');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new HttpError(401, 'Invalid sign-in token.');
  }

  let keys = await loadJwks();
  let jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) {
    // Google rotates signing keys; refetch once when the kid is unknown.
    keys = await loadJwks(true);
    jwk = keys.find(key => key.kid === header.kid);
  }

  if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new HttpError(401, 'Invalid sign-in token.');
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
  } catch {
    throw new HttpError(401, 'Invalid sign-in token.');
  }

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      base64UrlToBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`)
    );
  } catch {
    throw new HttpError(401, 'Invalid sign-in token.');
  }

  if (!valid) throw new HttpError(401, 'Invalid sign-in token.');

  return { uid: payload.sub };
};

const readMembership = async (
  projectId: string,
  clinicId: string,
  uid: string,
  token: string
): Promise<MemberRole | null> => {
  const url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
    `/databases/(default)/documents/clinics/${encodeURIComponent(clinicId)}` +
    `/members/${encodeURIComponent(uid)}`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (response.status === 404) return null;
  if (response.status === 401) {
    throw new HttpError(401, 'Your sign-in has expired. Refresh the page and try again.');
  }
  if (response.status === 403) {
    throw new HttpError(403, 'You do not have access to this clinic.');
  }
  if (!response.ok) {
    throw new HttpError(502, 'Could not verify clinic membership.');
  }

  const data = (await response.json()) as {
    fields?: { role?: { stringValue?: string } };
  };
  const role = data.fields?.role?.stringValue;

  if (role === 'owner') return 'owner';
  return role === 'member' || role === 'editor' || role === 'viewer' ? 'member' : null;
};

const authenticate = async (
  request: Request,
  env: Env
): Promise<{ token: string; user: FirebaseToken }> => {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) throw new HttpError(401, 'Sign in to continue.');

  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new HttpError(401, 'Sign in to continue.');

  return { token, user: await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID) };
};

const requireUploadsEnabled = async (projectId: string, clinicId: string, token: string) => {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/clinics/${encodeURIComponent(clinicId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new HttpError(response.status === 403 ? 403 : 502, 'Could not verify clinic upload settings.');
  const data = (await response.json()) as { fields?: { imageUploadsEnabled?: { booleanValue?: boolean } } };
  if (data.fields?.imageUploadsEnabled?.booleanValue === false) {
     throw new HttpError(403, 'New image uploads are paused for this clinic. Existing images remain available.');
  }
};

const requireConfiguration = (env: Env) => {
  if (!env.FIREBASE_PROJECT_ID) throw new HttpError(500, 'Image service is not configured.');
  if (!env.IMAGE_TOKEN_SECRET || env.IMAGE_TOKEN_SECRET.length < 32) {
    throw new HttpError(500, 'Image service is not configured.');
  }
  if (!env.IMAGES) throw new HttpError(500, 'Image bucket is not configured.');
};

const makeKey = (clinicId: string, patientId: string) =>
  `clinics/${clinicId}/patients/${patientId}/${crypto.randomUUID()}.jpg`;

const parseKey = (key: string) => {
  const match = KEY_PATTERN.exec(key);
  if (!match) throw new HttpError(400, 'Invalid image key.');
  return { clinicId: match[1], patientId: match[2] };
};

const importHmacKey = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  );

const signedImageUrl = async (origin: string, key: string, secret: string) => {
  const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;
  const hmacKey = await importHmacKey(secret, 'sign');
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(`${key}\n${exp}`)
  );

  const url = new URL('/file', origin);
  url.searchParams.set('key', key);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', bytesToBase64Url(new Uint8Array(signature)));
  return url.toString();
};

const hasValidSignature = async (
  key: string,
  exp: number,
  signature: string,
  secret: string
) => {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = base64UrlToBytes(signature);
  } catch {
    return false;
  }

  const hmacKey = await importHmacKey(secret, 'verify');
  return crypto.subtle.verify(
    'HMAC',
    hmacKey,
    signatureBytes,
    new TextEncoder().encode(`${key}\n${exp}`)
  );
};

const sniffImageType = (bytes: Uint8Array): string | null => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
};

/**
 * Buffers the request body while enforcing a hard byte ceiling.
 *
 * `request.formData()` parses only after the whole body has arrived, so a caller
 * could make the Worker hold an arbitrarily large upload in memory before the
 * 5 MB file check runs. This reads incrementally and aborts as soon as the limit
 * is crossed. `Content-Length` is a fast-path hint only: it may be absent (chunked
 * or streamed bodies) or wrong, so the stream counter is authoritative.
 */
const readBodyWithLimit = async (
  request: Request,
  limit: number,
  message = 'Request body is too large.'
): Promise<Uint8Array<ArrayBuffer>> => {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, message);
  }

  if (!request.body) throw new HttpError(400, 'Invalid upload body.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limit) throw new HttpError(413, message);
      chunks.push(value);
    }
  } finally {
    // Stops an over-limit upload instead of draining it to completion.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const handleUpload = async (request: Request, env: Env, cors: Record<string, string>) => {
  requireConfiguration(env);
  const { token, user } = await authenticate(request, env);
  await enforceRateLimit(env.USER_REQUEST_LIMITER, user.uid);
  await enforceRateLimit(env.USER_UPLOAD_LIMITER, user.uid);

  const requestContentType = request.headers.get('content-type') ?? '';
  const body = await readBodyWithLimit(request, MAX_UPLOAD_BODY_BYTES, UPLOAD_TOO_LARGE);

  let form: FormData;
  try {
    form = await new Response(
      body,
      requestContentType ? { headers: { 'content-type': requestContentType } } : undefined
    ).formData();
  } catch {
    throw new HttpError(400, 'Invalid upload body.');
  }

  const clinicId = String(form.get('clinicId') ?? '').trim();
  const patientId = String(form.get('patientId') ?? 'unassigned').trim() || 'unassigned';
  if (!CLINIC_ID_PATTERN.test(clinicId)) throw new HttpError(400, 'Invalid clinic.');
  if (!PATIENT_ID_PATTERN.test(patientId)) throw new HttpError(400, 'Invalid patient.');

  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Attach an image file.');
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, UPLOAD_TOO_LARGE);
  }

  const buffer = await file.arrayBuffer();
  const contentType = sniffImageType(new Uint8Array(buffer));
  if (!contentType) throw new HttpError(415, 'Only JPEG, PNG, or WebP images are accepted.');

  const role = await readMembership(env.FIREBASE_PROJECT_ID, clinicId, user.uid, token);
  if (!role) {
    throw new HttpError(403, 'Clinic membership is required to upload patient images.');
  }
  await enforceRateLimit(env.CLINIC_UPLOAD_LIMITER, clinicId);
  await requireUploadsEnabled(env.FIREBASE_PROJECT_ID, clinicId, token);

  const key = makeKey(clinicId, patientId);
  await env.IMAGES.put(key, buffer, {
    httpMetadata: { contentType, cacheControl: 'private, max-age=31536000' },
    customMetadata: { clinicId, uploadedBy: user.uid }
  });

  return json({ key }, 200, cors);
};

const handleSign = async (request: Request, env: Env, cors: Record<string, string>) => {
  requireConfiguration(env);
  const { token, user } = await authenticate(request, env);
  await enforceRateLimit(env.USER_REQUEST_LIMITER, user.uid);

  let body: { key?: unknown; keys?: unknown };
  const requestBody = await readBodyWithLimit(request, 64 * 1024);
  try {
    body = (await new Response(requestBody).json()) as typeof body;
  } catch {
    throw new HttpError(400, 'Invalid request body.');
  }

  const requested: unknown[] = Array.isArray(body.keys)
    ? body.keys
    : typeof body.key === 'string'
      ? [body.key]
      : [];
  const keys = Array.from(new Set(requested.filter((key): key is string => typeof key === 'string')));

  if (keys.length === 0) throw new HttpError(400, 'No image keys requested.');
  if (keys.length > MAX_BATCH_KEYS) {
    throw new HttpError(400, `Request at most ${MAX_BATCH_KEYS} images at once.`);
  }

  const parsed = keys.map(parseKey);
  const clinicIds = new Set(parsed.map(entry => entry.clinicId));
  if (clinicIds.size !== 1) {
    throw new HttpError(400, 'Request images from one clinic at a time.');
  }

  const clinicId = parsed[0].clinicId;
  const role = await readMembership(env.FIREBASE_PROJECT_ID, clinicId, user.uid, token);
  if (!role) throw new HttpError(403, 'You do not have access to this clinic.');

  const origin = new URL(request.url).origin;
  const urls: Record<string, string> = {};
  for (const key of keys) {
    urls[key] = await signedImageUrl(origin, key, env.IMAGE_TOKEN_SECRET);
  }

  return json({ urls }, 200, cors);
};

const handleFile = async (url: URL, env: Env, cors: Record<string, string>) => {
  requireConfiguration(env);

  const key = url.searchParams.get('key') ?? '';
  const exp = Number(url.searchParams.get('exp') ?? '0');
  const signature = url.searchParams.get('sig') ?? '';
  parseKey(key);

  if (!signature || !(await hasValidSignature(key, exp, signature, env.IMAGE_TOKEN_SECRET))) {
    throw new HttpError(403, 'This image link is invalid or has expired.');
  }

  const object = await env.IMAGES.get(key);
  if (!object) throw new HttpError(404, 'Image not found.');

  const headers = new Headers(cors);
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'image/jpeg');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(object.body, { headers });
};

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization,Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true }, 200, cors);
      }
      if (request.method === 'POST' && url.pathname === '/upload') {
        return await handleUpload(request, env, cors);
      }
      if (
        request.method === 'POST' &&
        (url.pathname === '/file-urls' || url.pathname === '/file-url')
      ) {
        return await handleSign(request, env, cors);
      }
      if (request.method === 'GET' && url.pathname === '/file') {
        return await handleFile(url, env, cors);
      }
      if (request.method === 'DELETE' && url.pathname === '/file') {
        // Deletion is intentionally unavailable. The previous handler removed
        // any object in the caller's clinic without checking whether patient
        // documents still referenced it, and a hard delete cannot be undone.
        // Re-enable only together with a reference-aware cleanup process that
        // is verified against a backed-up test clinic (see README.md).
        return json(
          {
            error:
              'Deleting patient images is disabled until a reference-aware cleanup process exists.'
          },
          405,
          cors,
          { Allow: 'GET, POST, OPTIONS' }
        );
      }

      return json({ error: 'Not found.' }, 404, cors);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status, cors,
          error.status === 429 ? { 'Retry-After': '60' } : {});
      }
      console.error('[images] Unhandled error:', error);
      return json({ error: 'Image service error.' }, 500, cors);
    }
  }
};

export default worker;
