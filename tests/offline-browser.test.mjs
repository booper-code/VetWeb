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

const inventoryFixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import App from './app/page';
  createRoot(document.getElementById('root')).render(<App />);
  window.fixture = true;
`;
const gatewayOrigin = 'http://127.0.0.1:8787';

async function startFixture(contents = fixture, handleTools) {
  const output = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NEXT_PUBLIC_FIREBASE_STAGING_CONFIG': 'undefined',
      'process.env.NEXT_PUBLIC_IMAGE_WORKER_URL': 'undefined',
      'process.env.NEXT_PUBLIC_ASSISTANT_TOOLS_URL': handleTools ? JSON.stringify(gatewayOrigin) : 'undefined',
      'process.env.NEXT_PUBLIC_CSV_IMPORT_RECEIPTS': contents === inventoryFixture ? '"1"' : 'undefined',
    },
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
    if (handleTools) await context.route(`${gatewayOrigin}/**`, async route => {
      const browserRequest = route.request();
      const headers = await browserRequest.allHeaders();
      const original = headers.authorization;
      if (original?.endsWith('.')) headers.authorization = `${original}emulator`;
      const originHeader = headers.origin ?? origin;
      const result = await handleTools(new Request(browserRequest.url(), {
        method: browserRequest.method(), headers: { ...headers, origin: originHeader },
        body: browserRequest.postData() ?? undefined,
      }), { FIREBASE_PROJECT_ID: projectId, ALLOWED_ORIGINS: origin },
      (url, options) => fetch(url.replace('https://firestore.googleapis.com', `http://${host}`), {
        ...options, headers: { ...options.headers, Authorization: original },
      }));
      await route.fulfill({ status: result.status, headers: Object.fromEntries(result.headers), body: await result.text() });
    });
    return context;
  };
  const open = async (context, errors = []) => {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    await page.goto(origin);
    try {
      await page.waitForFunction(() => Boolean(window.fixture));
    } catch (error) {
      if (errors.length) throw new Error(`Browser fixture failed: ${errors.join('; ')}`, { cause: error });
      throw error;
    }
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

test('signed-in CSV upload saves audited inventory for an owner but not a viewer', { timeout: 120000 }, async () => {
  const clinicId = `csv-release-${Date.now()}`;
  const clinicName = 'Fictional CSV release clinic';
  const password = 'SyntheticCsvFixture123!';
  const accounts = {};
  for (const role of ['owner', 'viewer']) {
    const email = `${clinicId}-${role}@example.com`;
    const signup = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const result = await signup.json();
    assert.equal(signup.status, 200, result.error?.message);
    assert.ok(result.localId);
    accounts[role] = { email, uid: result.localId };
  }
  const documents = `projects/${projectId}/databases/(default)/documents`;
  const clinic = `${documents}/clinics/${clinicId}`;
  const admin = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  const write = (name, data) => ({
    update: { name, fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [
      key, typeof value === 'boolean' ? { booleanValue: value } : { stringValue: value },
    ])) },
  });
  const seed = await fetch(`http://${host}/v1/${documents}:commit`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ writes: [
      write(clinic, { name: clinicName, ownerId: accounts.owner.uid, aiEnabled: true }),
      write(`${clinic}/patients/synthetic-milo`, {
        name: 'Fictional Milo', ownerName: 'Alex Reyes', ownerContact: '5550001111',
        ownerEmail: 'private@example.com', ownerAddress: 'Synthetic private address', status: 'Waiting',
      }),
      ...Object.entries(accounts).flatMap(([role, { uid, email }]) => [
        write(`${clinic}/members/${uid}`, { uid, email, role }),
        write(`${documents}/users/${uid}/clinics/${clinicId}`, { clinicId, clinicName, role }),
      ]),
    ] }),
  });
  assert.equal(seed.status, 200, await seed.text());
  const list = async collection => {
    const response = await fetch(`http://${host}/v1/${clinic}/${collection}?pageSize=100`, { headers: admin });
    const result = await response.json();
    assert.equal(response.status, 200, result.error?.message);
    assert.equal(result.nextPageToken, undefined);
    return result.documents ?? [];
  };
  const gateway = await build({ entryPoints: ['workers/assistant-tools/src/index.ts'], bundle: true,
    platform: 'node', format: 'esm', write: false });
  const { handleAssistantTools } = await import(`data:text/javascript;base64,${Buffer.from(gateway.outputFiles[0].text).toString('base64')}`);
  const app = await startFixture(inventoryFixture, handleAssistantTools);
  const file = resolve('docs/sample-inventory.csv');
  const inSettings = async (role, run) => {
    const context = await app.newContext();
    try {
      const errors = [];
      const page = await app.open(context, errors);
      await page.getByPlaceholder('you@example.com').fill(accounts[role].email);
      await page.getByPlaceholder('Enter your password').fill(password);
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await page.getByRole('button', { name: new RegExp(`${clinicName}.*${role}`, 'i') }).click();
      await page.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'Clinic setup' }).click();
      await run(page);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  };
  const upload = async (page, report) => {
    await page.locator('#inventoryCsvUpload').setInputFiles(file);
    const status = page.getByRole('status', { name: 'Inventory CSV import result' }).filter({ hasText: report });
    await status.waitFor();
    assert.match(await status.innerText(), report);
  };
  const ask = async (page, text) => {
    const popup = page.getByRole('dialog', { name: 'AI Assistant' });
    if (!(await popup.isVisible())) await page.getByRole('button', { name: 'AI Assistant', exact: true }).click();
    await popup.getByRole('textbox', { name: 'Ask the assistant' }).fill(text);
    await popup.getByRole('button', { name: 'Ask', exact: true }).click();
    return popup;
  };
  try {
    await inSettings('viewer', page => upload(page, /stopped after 0 saved item.*online owner or editor/));
    for (const collection of ['inventory', 'auditHeads', 'auditEvents', 'inventoryImportReceipts']) assert.deepEqual(await list(collection), []);

    await inSettings('owner', page => upload(page, /Imported 24 inventory item\/s from CSV/));
    const rows = await list('inventory');
    const heads = await list('auditHeads');
    const events = await list('auditEvents');
    const receipts = await list('inventoryImportReceipts');
    assert.equal(rows.length, 24);
    assert.equal(heads.length, 24);
    assert.equal(events.length, 24);
    assert.equal(receipts.length, 24);
    assert.equal(new Set(receipts.map(doc => doc.fields.batchId.stringValue)).size, 1);
    for (const row of rows) {
      const code = row.fields.itemCode.stringValue;
      const head = heads.find(doc => doc.name.endsWith(`/inventory_${code}`));
      assert.ok(head, `missing audit head for ${code}`);
      const event = events.find(doc => doc.name.endsWith(`/${head.fields.eventId.stringValue}`));
      assert.ok(event, `missing audit event for ${code}`);
      assert.deepEqual(event.fields, head.fields);
      assert.equal(event.fields.actorUid.stringValue, accounts.owner.uid);
      assert.equal(event.fields.action.stringValue, 'create');
      assert.equal(row.fields.revision.integerValue, '1');
    }
    assert.equal(rows.find(row => row.name.endsWith('/MED-ENR50')).fields.stock.integerValue, '0');
    assert.equal(rows.find(row => row.name.endsWith('/GRM-FULL')).fields.itemName.stringValue, 'Full groom (bath, haircut, nails)');

    // A clean login exercises the real inventory read and detects existing codes.
    await inSettings('owner', async page => {
      const navigation = page.getByRole('navigation');
      await navigation.getByRole('button', { name: 'Inventory', exact: true }).click();
      await page.getByRole('row').filter({ hasText: 'Full groom (bath, haircut, nails)' }).waitFor();
      await navigation.getByRole('button', { name: 'Clinic setup' }).click();
      await upload(page, /No new valid inventory items/);
      const popup = await ask(page, 'How many CSV items were imported?');
      await popup.getByText(/24 catalog items were imported/).waitFor();
      await popup.getByText('View import history').click();
      await popup.getByText(/Showing the latest 10 item saves/).waitFor();
    });
    assert.deepEqual(await list('inventory'), rows);
    assert.deepEqual(await list('auditHeads'), heads);
    assert.deepEqual(await list('auditEvents'), events);
    assert.deepEqual(await list('inventoryImportReceipts'), receipts);

    await inSettings('viewer', async page => {
      const popup = await ask(page, 'Ilang items ang na-import?');
      await popup.getByText(/does not allow this lookup/).waitFor();
      await ask(page, 'Hanapin si Alex Reyes');
      const link = popup.getByRole('link', { name: /Alex Reyes.*Fictional Milo/ });
      await link.waitFor();
      assert.doesNotMatch(await popup.innerText(), /5550001111|private@example|private address/i);
      await link.click();
      await popup.waitFor({ state: 'hidden' });
      await page.getByText('Synthetic private address', { exact: true }).waitFor();
    });

    await inSettings('owner', async page => {
      await page.locator('#inventoryCsvUpload').setInputFiles({
        name: 'fictional-partial.csv', mimeType: 'text/csv',
        buffer: Buffer.from(`Item Code,Item Name,Category,Stock\nCSV-PARTIAL,Tracked supply,Supplies,9\nCSV-REJECT,${'X'.repeat(201)},Supplies,1\nCSV-NEVER,Never committed,Supplies,3`),
      });
      await page.getByRole('status').filter({ hasText: /CSV import stopped after 1 saved item/ }).waitFor();
      const popup = await ask(page, 'How many CSV items were imported?');
      await popup.getByText(/25 catalog items were imported/).waitFor();
    });
    const afterPartial = await list('inventoryImportReceipts');
    assert.equal(afterPartial.length, 25);
    assert.deepEqual(afterPartial.filter(doc => doc.name.includes('CSV-')).map(doc => doc.name.split('/').at(-1)), ['CSV-PARTIAL']);
  } finally { await app.close(); }
});
