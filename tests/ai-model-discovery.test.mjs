import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../lib/ai-model-discovery.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', logLevel: 'silent',
});
const { discoverAIModels } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const fakeKey = 'fictional-provider-key';
const json = (data, status = 200) => Response.json(data, { status });
const config = (provider, overrides = {}) => ({ provider, baseUrl: '', apiKey: fakeKey, ...overrides });
const model = (name, supportedGenerationMethods = ['generateContent']) => ({ name: `models/${name}`, supportedGenerationMethods });

function intercept(t, respond) {
  const routes = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const request = new Request(input, options);
    assert.equal(request.method, 'GET');
    assert.equal(request.body, null);
    assert.equal(request.credentials, 'omit');
    assert.equal(request.redirect, 'error');
    assert.equal(request.cache, 'no-store');
    assert.ok(!request.url.includes(fakeKey));
    routes.push(new URL(request.url).pathname);
    return respond(request, routes.length);
  });
  return routes;
}

test('Gemini reads all authenticated pages, strips resource prefixes and excludes non-generation models', async t => {
  const routes = intercept(t, (request, number) => {
    assert.equal(request.headers.get('x-goog-api-key'), fakeKey);
    assert.equal(new URL(request.url).origin, 'https://generativelanguage.googleapis.com');
    if (number === 1) {
      assert.equal(new URL(request.url).searchParams.has('pageToken'), false);
      return json({ models: [{ ...model('gemini-test-one'), displayName: 'Gemini Test One' }, model('embed', ['embedContent'])], nextPageToken: 'page 2' });
    }
    assert.equal(new URL(request.url).searchParams.get('pageToken'), 'page 2');
    return json({ models: [model('gemini-test-one'), model('gemini-test-two')] });
  });
  assert.deepEqual(await discoverAIModels(config('gemini')), {
    keyStatus: 'accepted', source: 'authenticated',
    models: [{ id: 'gemini-test-one', name: 'Gemini Test One' }, { id: 'gemini-test-two', name: 'gemini-test-two' }],
  });
  assert.deepEqual(routes, ['/v1beta/models', '/v1beta/models']);
});

test('a repeated Gemini page token fails instead of showing partial results', async t => {
  const routes = intercept(t, () => json({ models: [model('fixture')], nextPageToken: 'same' }));
  await assert.rejects(discoverAIModels(config('gemini')), /pagination/i);
  assert.equal(routes.length, 2);
});

test('Gemini unique tokens still stop at the page limit', async t => {
  const routes = intercept(t, (_request, number) => json({ models: [model('fixture')], nextPageToken: `page-${number}` }));
  await assert.rejects(discoverAIModels(config('gemini')), /pagination/i);
  assert.equal(routes.length, 20);
});

test('OpenRouter never falls back to a public catalog for a rejected key', async t => {
  const routes = intercept(t, () => json({ error: { message: `Invalid ${fakeKey}` } }, 401));
  await assert.rejects(discoverAIModels(config('openrouter')), error => {
    assert.match(error.message, /rejected.*key/i);
    assert.ok(!error.message.includes(fakeKey));
    return true;
  });
  assert.deepEqual(routes, ['/api/v1/key']);
});

test('OpenRouter prefers the authenticated user list', async t => {
  const routes = intercept(t, (request, number) => {
    assert.equal(request.headers.get('Authorization'), `Bearer ${fakeKey}`);
    return number === 1 ? json({ data: { is_management_key: false } }) :
      json({ data: [{ id: 'fixture/chat', name: 'Fixture Chat' }] });
  });
  assert.deepEqual(await discoverAIModels(config('openrouter')), {
    keyStatus: 'accepted', source: 'authenticated', models: [{ id: 'fixture/chat', name: 'Fixture Chat' }],
  });
  assert.deepEqual(routes, ['/api/v1/key', '/api/v1/models/user']);
});

test('OpenRouter catalog fallback sends no key and does not claim model access', async t => {
  const routes = intercept(t, (request, number) => {
    assert.equal(request.headers.get('Authorization'), number === 3 ? null : `Bearer ${fakeKey}`);
    if (number === 1) return json({ data: { is_management_key: false } });
    if (number === 2) return json({ error: { message: 'Restricted' } }, 403);
    return json({ data: [{ id: 'fixture/public' }] });
  });
  assert.deepEqual(await discoverAIModels(config('openrouter')), {
    keyStatus: 'accepted', source: 'catalog', models: [{ id: 'fixture/public', name: 'fixture/public' }],
  });
  assert.deepEqual(routes, ['/api/v1/key', '/api/v1/models/user', '/api/v1/models']);
});

test('OpenRouter does not fall back after rate limiting or accept a management key', async t => {
  const routes = intercept(t, (_request, number) => {
    if (number === 1) return json({ data: { is_management_key: true } });
    if (number === 2) return json({ data: { is_management_key: false } });
    return json({}, 429);
  });
  await assert.rejects(discoverAIModels(config('openrouter')), /regular API key/i);
  await assert.rejects(discoverAIModels(config('openrouter')), /rate limit/i);
  assert.deepEqual(routes, ['/api/v1/key', '/api/v1/key', '/api/v1/models/user']);
});

test('authenticated compatible providers use their official model-list routes', async t => {
  const endpoints = [
    ['openai', 'https://api.openai.com/v1/models'],
    ['groq', 'https://api.groq.com/openai/v1/models'],
    ['deepseek', 'https://api.deepseek.com/v1/models'],
    ['mistral', 'https://api.mistral.ai/v1/models'],
  ];
  intercept(t, (request, number) => {
    assert.equal(request.url, endpoints[number - 1][1]);
    assert.equal(request.headers.get('Authorization'), `Bearer ${fakeKey}`);
    return json({ data: [{ id: 'chat-model' }, { id: 'chat-model' }] });
  });
  for (const [provider] of endpoints) {
    assert.deepEqual(await discoverAIModels(config(provider)), {
      keyStatus: 'accepted', source: 'authenticated', models: [{ id: 'chat-model', name: 'chat-model' }],
    });
  }
});

test('local Ollama stays keyless while custom catalogs do not imply authentication', async t => {
  intercept(t, (request, number) => {
    assert.equal(request.url, ['http://localhost:11434/v1/models', 'https://models.example.test/tenant/v1/models'][number - 1]);
    assert.equal(request.headers.get('Authorization'), number === 1 ? null : `Bearer ${fakeKey}`);
    return json({ data: [{ id: 'local-chat' }] });
  });
  assert.deepEqual(await discoverAIModels(config('ollama', { apiKey: '' })), {
    keyStatus: 'not-required', source: 'local', models: [{ id: 'local-chat', name: 'local-chat' }],
  });
  assert.deepEqual(await discoverAIModels(config('custom', { baseUrl: 'https://models.example.test/tenant/v1/' })), {
    keyStatus: 'not-verified', source: 'catalog', models: [{ id: 'local-chat', name: 'local-chat' }],
  });
});

test('unsafe endpoints and missing keys cannot send requests', async t => {
  const routes = intercept(t, () => json({ data: [] }));
  const cases = [
    config('openai', { baseUrl: 'https://api.openai.com.example.test/v1' }),
    config('openai', { baseUrl: 'https://api.openai.com/v1/other' }),
    config('openai', { apiKey: ' ' }),
    config('openai', { apiKey: 'invalid\nheader' }),
    config('custom', { baseUrl: 'http://localhost:1234/v1' }),
    config('custom', { baseUrl: 'http://example.test/v1', apiKey: '' }),
    config('custom', { baseUrl: 'file:///v1' }),
    config('custom', { baseUrl: 'https://user:pass@example.test/v1' }),
    config('custom', { baseUrl: 'https://example.test/v1?token=value' }),
    config('custom', { baseUrl: 'https://example.test/v1#fragment' }),
    config('ollama', { baseUrl: 'https://example.test/v1', apiKey: '' }),
  ];
  for (const value of cases) await assert.rejects(discoverAIModels(value), /endpoint|API key/i);
  assert.deepEqual(routes, []);
});

test('a key cannot be sent inside a custom endpoint path, including encoded keys', async t => {
  const routes = intercept(t, () => json({ data: [] }));
  const key = 'fictional+key/with=syntax';
  for (const path of [key, encodeURIComponent(key), encodeURIComponent(encodeURIComponent(key))]) {
    await assert.rejects(
      discoverAIModels(config('custom', { baseUrl: `https://example.test/${path}/v1`, apiKey: key })),
      /key field.*not.*endpoint URL/i,
    );
  }
  assert.deepEqual(routes, []);
});

test('discovery never sends the page URL as the referrer', async t => {
  let referrerPolicy;
  intercept(t, request => {
    referrerPolicy = request.referrerPolicy;
    return json({ data: [] });
  });
  await discoverAIModels(config('openai'));
  assert.equal(referrerPolicy, 'no-referrer');
});

test('valid empty or incompatible results are distinct from lists of malformed entries', async t => {
  intercept(t, (_request, number) => [
    json({ data: [{}] }),
    json({ models: [{ name: 'models/missing-actions' }] }),
    json({ models: [model('embed', ['embedContent'])] }),
  ][number - 1]);
  await assert.rejects(discoverAIModels(config('openai')), /unexpected model list/i);
  await assert.rejects(discoverAIModels(config('gemini')), /unexpected model list/i);
  assert.deepEqual((await discoverAIModels(config('gemini'))).models, []);
});

test('empty catalogs are distinct from malformed responses; redirects and reflected keys are not exposed', async t => {
  const routes = intercept(t, (_request, number) => [
    json({ data: [] }),
    json({ data: 'unexpected' }),
    new Response(null, { status: 302, headers: { location: 'https://untrusted.example.test/' } }),
    json({ data: [{ id: fakeKey }, { id: 'fixture', name: `Echo: ${fakeKey}` }] }),
  ][number - 1]);
  assert.deepEqual((await discoverAIModels(config('openai'))).models, []);
  await assert.rejects(discoverAIModels(config('openai')), /unexpected model list/i);
  await assert.rejects(discoverAIModels(config('openai')), /redirect/i);
  assert.deepEqual((await discoverAIModels(config('openai'))).models, [{ id: 'fixture', name: 'fixture' }]);
  assert.equal(routes.length, 4);
});

test('aborting discovery suppresses a late response', async t => {
  const controller = new AbortController();
  const routes = intercept(t, request => {
    controller.abort();
    assert.ok(request.signal.aborted);
    return json({ data: [{ id: 'late-model' }] });
  });
  await assert.rejects(discoverAIModels(config('openai'), controller.signal), { name: 'AbortError' });
  assert.equal(routes.length, 1);
});
