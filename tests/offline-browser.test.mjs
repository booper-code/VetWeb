import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('A local Firestore/Auth emulator is required.');
const projectId = 'demo-vetcloud-rules';
const sdk = name => JSON.stringify(resolve(`node_modules/firebase/${name}/dist/esm/index.esm.js`));
const fixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import * as firebase from './lib/firebase';
  import * as device from './lib/offline-device';
  import Settings from './components/OfflineDeviceSettings';
  import {createUserWithEmailAndPassword, onAuthStateChanged} from 'firebase/auth';
  import {doc, getDoc} from 'firebase/firestore';
  let root = createRoot(document.getElementById('root'));
  let connection;
  function Screen({signedIn}) {
    return <><div id="records">{signedIn ? 'Synthetic cached record' : ''}</div>
      <Settings key={signedIn ? 'session' : 'login'} beforeClear={() => render(false)} /></>;
  }
  function render(signedIn = false) { root.render(<Screen signedIn={signedIn} />); }
  render();
  window.fixture = {
    ...firebase, ...device,
    async start() {
      connection = await firebase.initializeFirebase();
      const credential = await createUserWithEmailAndPassword(connection.auth, crypto.randomUUID() + '@example.com', 'OfflineFixture123!');
      onAuthStateChanged(connection.auth, user => render(Boolean(user)));
      return credential.user.uid;
    },
    async read(uid) {
      return (await getDoc(doc(connection.db, 'clinics', 'browser-' + uid, 'patients', 'synthetic'))).data();
    },
    async remount() { root.unmount(); root = createRoot(document.getElementById('root')); render(); },
    holdAuth() { window.authGate = new Promise(resolve => { window.releaseAuth = resolve; }); },
    async holdDatabase(name) {
      window.blocker = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      window.blocker.onversionchange = () => {};
    },
    closeDatabase() { window.blocker?.close(); },
    uid() { return connection?.auth.currentUser?.uid ?? null; },
  };
`;

async function startFixture() {
  const output = await build({
    stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'emulator-only-sdk',
      setup(build) {
        build.onResolve({ filter: /^firebase\/(app|auth|firestore)$/ }, args => ({
          path: args.path.split('/')[1], namespace: 'emulator-sdk',
        }));
        build.onLoad({ filter: /.*/, namespace: 'emulator-sdk' }, args => {
          const original = sdk(args.path);
          const wrappers = {
            app: `export function initializeApp(config) { return real.initializeApp({...config, apiKey:'fake-key', projectId:'${projectId}'}); }`,
            auth: `const connected = new WeakSet();
              export function getAuth(app) {
                const auth = real.getAuth(app);
                if (!connected.has(auth)) {
                  real.connectAuthEmulator(auth, 'http://127.0.0.1:9099', {disableWarnings:true});
                  const ready = auth.authStateReady.bind(auth);
                  auth.authStateReady = async () => { await window.authGate; return ready(); };
                  connected.add(auth);
                }
                return auth;
              }`,
            firestore: `const connected = new WeakSet();
              export function getFirestore(app) {
                const db = real.getFirestore(app);
                if (!connected.has(db)) {
                  real.connectFirestoreEmulator(db, '${host.split(':')[0]}', ${Number(host.split(':')[1])});
                  connected.add(db);
                }
                return db;
              }`,
          };
          return { contents: `import * as real from ${original}; export * from ${original}; ${wrappers[args.path]}`,
            loader: 'js', resolveDir: process.cwd() };
        });
      },
    }],
  });
  const script = output.outputFiles[0].text;
  const server = createServer((request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(script);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<div id="root"></div><script type="module" src="/fixture.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox'],
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const newContext = async () => {
    const context = await browser.newContext();
    // Fail closed: this fixture cannot send requests to a live Firebase backend.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    return context;
  };
  const open = async context => {
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.fixture));
    return page;
  };
  const seedAndRead = async page => {
    const uid = await page.evaluate(() => window.fixture.start());
    const root = `projects/${projectId}/databases/(default)/documents/clinics/browser-${uid}`;
    const response = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: [
        { update: { name: `${root}/members/${uid}`, fields: { role: { stringValue: 'owner' } } } },
        { update: { name: `${root}/patients/synthetic`, fields: { name: { stringValue: 'Synthetic cached record' } } } },
      ] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await page.evaluate(uid => window.fixture.read(uid), uid)).name, 'Synthetic cached record');
    await page.locator('#records').getByText('Synthetic cached record').waitFor();
  };
  return { newContext, open, seedAndRead, async close() {
    await browser.close(); await new Promise(resolve => server.close(resolve));
  } };
}

test('real browser device cleanup uses only emulators', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  try {
    await t.test('two memory-only tabs both sign out on wipe without a consent key', async () => {
      const context = await fixture.newContext();
      try {
        const a = await fixture.open(context), b = await fixture.open(context);
        await fixture.seedAndRead(a); await fixture.seedAndRead(b);
        assert.equal(await a.evaluate(() => localStorage.getItem('vetcloud.trusted-device.v1')), null);
        await a.evaluate(() => window.fixture.clearOfflineDeviceData());
        await b.waitForFunction(() => window.fixture.getDeviceClearState().phase === 'cleared');
        for (const page of [a, b]) {
          await page.waitForFunction(() => window.fixture.uid() === null && document.getElementById('records').textContent === '');
          assert.equal(await page.evaluate(() => window.fixture.getFirebaseDeviceState().restartRequired), true);
        }
      } finally { await context.close(); }
    });
    await t.test('a trusted tab initializing during a wipe fails closed', async () => {
      const context = await fixture.newContext();
      try {
        const a = await fixture.open(context), b = await fixture.open(context);
        await fixture.seedAndRead(a);
        await b.evaluate(() => {
          window.fixture.requestTrustedDevice(true); window.fixture.holdAuth();
          window.initializing = window.fixture.initializeFirebase().then(() => 'connected', () => 'stopped');
        });
        await a.evaluate(() => { window.clearing = window.fixture.clearOfflineDeviceData(); });
        await b.waitForFunction(() => window.fixture.getFirebaseDeviceState().restartRequired);
        await b.evaluate(() => window.releaseAuth());
        assert.equal(await b.evaluate(() => window.initializing), 'stopped');
        await a.evaluate(() => window.clearing);
        await b.waitForFunction(() => window.fixture.getDeviceClearState().phase === 'cleared');
        assert.equal(await b.evaluate(() => window.fixture.getDevicePreference()), 'memory');
      } finally { await context.close(); }
    });
    await t.test('blocked IndexedDB clear shows a persistent failure after settings remount, then retries', async () => {
      const context = await fixture.newContext();
      try {
        const a = await fixture.open(context);
        await a.evaluate(() => window.fixture.requestTrustedDevice(true));
        await fixture.seedAndRead(a);
        assert.equal(await a.evaluate(() => window.fixture.getFirebaseDeviceState().cacheMode), 'persistent');
        const databases = await a.evaluate(() => indexedDB.databases());
        const name = databases.find(entry => entry.name.startsWith('firestore/'))?.name;
        assert.ok(name, 'real Firestore persistence must be open');
        const blocker = await fixture.open(context);
        await blocker.evaluate(name => window.fixture.holdDatabase(name), name);
        a.once('dialog', dialog => dialog.accept());
        await a.getByRole('button', { name: 'Disable, sign out & clear device data' }).click();
        await a.waitForFunction(() => window.fixture.getDeviceClearState().phase === 'failed');
        await a.evaluate(() => window.fixture.remount());
        await a.getByRole('status').filter({ hasText: 'Could not confirm device cleanup' }).waitFor();
        assert.equal(await a.evaluate(() => window.fixture.getDeviceClearState().phase), 'failed');
        await blocker.evaluate(() => window.fixture.closeDatabase());
        await a.evaluate(() => window.fixture.clearOfflineDeviceData());
        await a.evaluate(() => window.fixture.remount());
        await a.getByRole('status').filter({ hasText: 'Cached clinical data was cleared' }).waitFor();
        await a.getByRole('button', { name: 'Dismiss status' }).click();
        await a.waitForFunction(() => !document.body.textContent?.includes('Cached clinical data was cleared'));
        assert.equal(await a.evaluate(() => window.fixture.getDeviceClearState().phase), 'idle');
      } finally { await context.close(); }
    });
  } finally { await fixture.close(); }
});
