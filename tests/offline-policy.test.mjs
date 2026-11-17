import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const origin = 'https://vet.example';
const handlers = {};
const context = vm.createContext({
  URL,
  self: { location: { origin, href: `${origin}/sw.js?build=${'a'.repeat(64)}` }, addEventListener: (name, callback) => { handlers[name] = callback; } },
});
vm.runInContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
const allows = (path, options = {}) => {
  context.request = {
    url: new URL(path, origin).href, method: 'GET', mode: 'cors',
    headers: new Headers(), ...options,
  };
  return vm.runInContext(`canHandle(request, '${origin}')`, context);
};

test('only exact shell navigation and public build assets are intercepted', () => {
  assert.equal(allows('/', { mode: 'navigate' }), true);
  assert.equal(allows('/_next/static/chunks/abc.js'), true);
  assert.equal(allows('/_next/static/css/abc.css'), true);
  assert.equal(allows('/_next/static/media/font.woff2'), true);
  assert.equal(allows('/manifest.webmanifest'), true);
});

test('sensitive requests bypass the worker entirely', () => {
  for (const path of [
    'https://firestore.googleapis.com/v1/projects/example',
    'https://securetoken.googleapis.com/v1/token',
    'https://images.example/record.jpg?signature=secret',
    '/api/images/patient', '/api/ai', '/__/auth/handler', '/patient/123',
    '/?token=secret', '/?_rsc=123', '/_next/image?url=secret',
    '/_next/static/chunks/abc.js?signature=secret',
    '/_next/static/media/patient.jpg', '/_next/static/chunks/data.json',
  ]) assert.equal(allows(path, { mode: 'navigate' }), false, path);
  assert.equal(allows('/'), false, 'RSC/fetch root is not navigation');
  assert.equal(allows('/_next/static/chunks/abc.js', { method: 'POST' }), false);
  assert.equal(allows('/_next/static/chunks/abc.js', { headers: new Headers({ Authorization: 'Bearer secret' }) }), false);
});

test('bypassed fetch events are not given a response handler', () => {
  handlers.fetch({
    request: { url: `${origin}/api/ai`, method: 'POST', headers: new Headers() },
    respondWith() { assert.fail('private request intercepted'); },
  });
});

test('private, redirected, opaque, and failed responses cannot enter cache', () => {
  for (const overrides of [
    { ok: false }, { type: 'opaque' }, { redirected: true },
    { headers: new Headers({ 'cache-control': 'private, max-age=3600' }) },
    { headers: new Headers({ 'cache-control': 'no-store' }) },
  ]) {
    context.response = { ok: true, type: 'basic', redirected: false, headers: new Headers(), ...overrides };
    assert.equal(vm.runInContext('cacheable(response)', context), false);
  }
});

const policySource = ts.transpileModule(
  readFileSync(new URL('../lib/offline-device.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;

test('device consent defaults to memory on SSR, missing, invalid, or inaccessible storage', () => {
  for (const window of [
    undefined,
    { localStorage: { getItem: () => null } },
    { localStorage: { getItem: () => 'true' } },
    { localStorage: { getItem: () => { throw new Error('blocked'); } } },
  ]) {
    const sandbox = { exports: {}, window };
    vm.runInNewContext(policySource, sandbox);
    assert.equal(sandbox.exports.getDevicePreference(), 'memory');
  }
});

test('explicit device opt-in stores only a consent marker and disabling removes it', () => {
  const stored = new Map();
  const sandbox = {
    exports: {}, Event,
    window: {
      localStorage: {
        getItem: key => stored.get(key),
        setItem: (key, value) => stored.set(key, value),
        removeItem: key => stored.delete(key),
      },
      dispatchEvent: () => {},
    },
  };
  vm.runInNewContext(policySource, sandbox);
  sandbox.exports.requestTrustedDevice(true);
  assert.equal(sandbox.exports.getDevicePreference(), 'trusted');
  assert.deepEqual([...stored.values()], ['trusted']);
  sandbox.exports.requestTrustedDevice(false);
  assert.equal(stored.size, 0);
  assert.equal(sandbox.exports.getDevicePreference(), 'memory');
});
