// Shared harness for Worker hardening tests.
//
// `tests/image-service.test.mjs` keeps its own inline setup; this fixture exists
// so newer tests can share key/token plumbing without rewriting that file. The
// Worker is imported with a cache-busting query so each harness gets a fresh
// module instance (and therefore a cold JWKS cache), which keeps assertions
// independent of test order.

const WORKER_URL = new URL('../../workers/image-service/src/index.ts', import.meta.url).href;

let workerInstance = 0;

const JWKS_PATH = 'googleapis.com/service_accounts/';
const FIRESTORE_PATH = 'firestore.googleapis.com/';

const encodePart = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Creates an RS256 signer and a `token(uid, overrides)` helper. Each signer has
 * its own `kid`, so tests can forge tokens with kids the Worker cannot find.
 */
export const createSigner = async (kid, projectId = 'test-project') => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };

  const token = async (uid, overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${encodePart({ alg: 'RS256', kid })}.${encodePart({
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      sub: uid,
      iat: now,
      exp: now + 3600,
      ...overrides
    })}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(input)
    );
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
  };

  return { kid, jwk, token };
};

/**
 * Builds an in-memory Worker environment. `state.jwks` is the key set the mocked
 * JWKS endpoint serves and `state.jwksFetches` counts how many times it was
 * fetched, which is what the refetch-throttle test asserts on.
 */
export const createHarness = async ({
  projectId = 'test-project',
  allowedOrigins = 'https://app.example',
  roles = { owner: 'owner', editor: 'editor', viewer: 'viewer' }
} = {}) => {
  workerInstance += 1;
  const { default: worker } = await import(`${WORKER_URL}?test=${workerInstance}`);

  const objects = new Map();
  const state = { jwks: [], jwksFetches: 0, roles, uploadsEnabled: true };
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes(JWKS_PATH)) {
      state.jwksFetches += 1;
      return Response.json({ keys: state.jwks });
    }
    if (url.includes(FIRESTORE_PATH)) {
      if (url.endsWith('/clinics/clinic-a')) return Response.json({ fields: { imageUploadsEnabled: { booleanValue: state.uploadsEnabled } } });
      const uid = decodeURIComponent(url.split('/').pop());
      const inClinic = url.includes('/clinics/clinic-a/');
      return inClinic && roles[uid]
        ? Response.json({ fields: { role: { stringValue: roles[uid] } } })
        : new Response(null, { status: 403 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const env = {
    USER_REQUEST_LIMITER: { limit: async () => ({ success: true }) },
    USER_UPLOAD_LIMITER: { limit: async () => ({ success: true }) },
    CLINIC_UPLOAD_LIMITER: { limit: async () => ({ success: true }) },
    FIREBASE_PROJECT_ID: projectId,
    IMAGE_TOKEN_SECRET: 'x'.repeat(48),
    ALLOWED_ORIGINS: allowedOrigins,
    IMAGES: {
      async put(key, bytes, options) {
        objects.set(key, { bytes, options });
      },
      async get(key) {
        const item = objects.get(key);
        return item
          ? { body: new Blob([item.bytes]).stream(), httpMetadata: item.options.httpMetadata }
          : null;
      },
      async delete(key) {
        objects.delete(key);
      }
    }
  };

  const request = (path, init = {}) =>
    worker.fetch(new Request(`https://images.example${path}`, init), env);

  return {
    env,
    objects,
    request,
    /** Dispatches an already-built Request, for streamed or custom bodies. */
    send: built => worker.fetch(built, env),
    state,
    restore: () => {
      globalThis.fetch = previousFetch;
    }
  };
};
