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
  import {signOut as firebaseSignOut} from 'firebase/auth';
  import * as firebase from './lib/firebase';
  import App from './app/page';
  import OfflineStatus from './components/OfflineStatus';
  createRoot(document.getElementById('root')).render(<><OfflineStatus staticShell={false} /><App /></>);
  window.fixture = {
    ready: true,
    async signOut() {
      const { auth } = await firebase.initializeFirebase();
      await firebaseSignOut(auth);
    },
  };
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

test('signed-in CSV upload saves audited inventory for an owner but not a viewer', { timeout: 180000 }, async () => {
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

  // A separate fictional clinic and account in the same emulator, with no
  // membership in the CSV clinic. It gets its own browser context below.
  const otherClinicId = `csv-isolated-${Date.now()}`;
  const otherClinicName = 'Fictional unrelated clinic';
  const otherEmail = `${otherClinicId}-owner@example.com`;
  const otherSignup = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: otherEmail, password, returnSecureToken: true }),
  });
  const otherResult = await otherSignup.json();
  assert.equal(otherSignup.status, 200, otherResult.error?.message);
  assert.ok(otherResult.localId);
  const otherClinic = `${documents}/clinics/${otherClinicId}`;
  const otherSeed = await fetch(`http://${host}/v1/${documents}:commit`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ writes: [
      write(otherClinic, { name: otherClinicName, ownerId: otherResult.localId, aiEnabled: false }),
      write(`${otherClinic}/members/${otherResult.localId}`, { uid: otherResult.localId, email: otherEmail, role: 'owner' }),
      write(`${documents}/users/${otherResult.localId}/clinics/${otherClinicId}`, {
        clinicId: otherClinicId, clinicName: otherClinicName, role: 'owner',
      }),
    ] }),
  });
  assert.equal(otherSeed.status, 200, await otherSeed.text());

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
  const offlineBanner = page => page.getByRole('status').filter({ hasText: 'No internet connection' });
  const file = resolve('docs/sample-inventory.csv');
  const signIn = async (role, targetClinicName = clinicName, email = accounts[role].email) => {
    const context = await app.newContext();
    const errors = [];
    const page = await app.open(context, errors);
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.getByPlaceholder('Enter your password').fill(password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(`${targetClinicName}.*${role}`, 'i') }).click();
    return { context, page, errors };
  };
  const inSettings = async (role, run) => {
    const { context, page, errors } = await signIn(role);
    try {
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
  let viewer, other, remote;
  try {
    await inSettings('viewer', page => upload(page, /stopped after 0 saved item.*online owner or editor/));
    for (const collection of ['inventory', 'auditHeads', 'auditEvents', 'inventoryImportReceipts']) assert.deepEqual(await list(collection), []);

    // An authorized viewer that already has Inventory open must see the owner's
    // confirmed rows without refreshing. This is the stale-view regression.
    viewer = await signIn('viewer');
    await viewer.page.getByRole('navigation').getByRole('button', { name: 'Inventory', exact: true }).click();
    await viewer.page.getByText('All available records loaded.').waitFor();
    assert.deepEqual(viewer.errors, []);

    // A member of a different clinic has the same Inventory view open in an
    // independent context before the owner imports anything.
    other = await signIn('owner', otherClinicName, otherEmail);
    await other.page.getByRole('navigation').getByRole('button', { name: 'Inventory', exact: true }).click();
    await other.page.getByText('All available records loaded.').waitFor();
    assert.deepEqual(other.errors, []);

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
    await viewer.page.getByRole('row').filter({ hasText: 'Full groom (bath, haircut, nails)' }).waitFor();
    assert.deepEqual(viewer.errors, []);
    assert.equal(await other.page.getByRole('row').filter({ hasText: 'Full groom (bath, haircut, nails)' }).count(), 0);
    const otherRows = await fetch(`http://${host}/v1/${otherClinic}/inventory?pageSize=100`, { headers: admin });
    assert.deepEqual((await otherRows.json()).documents ?? [], []);

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

    // A real owner edit and delete must reach the viewer's already-open view,
    // while the unrelated clinic's open view stays untouched.
    remote = await signIn('owner');
    await remote.page.getByRole('navigation').getByRole('button', { name: 'Inventory', exact: true }).click();
    await remote.page.getByRole('row').filter({ hasText: 'MED-ENR50' }).waitFor();
    const renamed = 'Full groom - remote update';
    await remote.page.getByRole('row').filter({ hasText: 'Full groom (bath, haircut, nails)' }).click();
    const details = remote.page.getByRole('dialog', { name: 'Inventory item details' });
    await details.getByRole('button', { name: 'Edit Item Details' }).click();
    await details.locator('input[type="text"]').first().fill(renamed);
    await details.getByRole('button', { name: 'Save Changes' }).click();
    await remote.page.getByRole('row').filter({ hasText: renamed }).waitFor();
    await details.getByRole('button', { name: 'Close inventory item' }).click();
    await viewer.page.getByRole('row').filter({ hasText: renamed }).waitFor();
    assert.equal(await viewer.page.getByRole('row').filter({ hasText: 'Full groom (bath, haircut, nails)' }).count(), 0);
    assert.equal(await other.page.getByRole('row').filter({ hasText: renamed }).count(), 0);

    await remote.page.getByRole('row').filter({ hasText: 'MED-ENR50' }).click();
    await details.getByRole('button', { name: 'Edit Item Details' }).click();
    await details.getByRole('button', { name: 'Delete Catalog Item' }).click();
    await details.getByRole('button', { name: 'Yes, Confirm Delete' }).click();
    await viewer.page.getByRole('row').filter({ hasText: 'MED-ENR50' }).waitFor({ state: 'detached' });
    assert.deepEqual(remote.errors, []);
    assert.deepEqual(viewer.errors, []);
    assert.deepEqual(other.errors, []);
    const afterRemote = await list('inventory');
    assert.equal(afterRemote.length, 24); // 24 + partial import - one deletion
    const updated = afterRemote.find(row => row.name.endsWith('/GRM-FULL'));
    assert.equal(updated.fields.itemName.stringValue, renamed);
    assert.equal(updated.fields.revision.integerValue, '2');
    assert.equal(afterRemote.some(row => row.name.endsWith('/MED-ENR50')), false);
    assert.equal((await list('auditHeads')).length, 25);
    assert.equal((await list('auditEvents')).length, 27);

    // Keep this Owner session's in-memory role, but downgrade the canonical
    // membership behind it. The UI still offers an Owner import; the emulator
    // rules must reject the transaction independently of the front-end guard.
    const demote = await fetch(`http://${host}/v1/${documents}:commit`, {
      method: 'POST', headers: admin,
      body: JSON.stringify({ writes: [
        write(`${clinic}/members/${accounts.owner.uid}`, { role: 'viewer' }),
        write(`${documents}/users/${accounts.owner.uid}/clinics/${clinicId}`, { role: 'viewer' }),
      ] }),
    });
    assert.equal(demote.status, 200, await demote.text());
    await remote.page.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'Clinic setup' }).click();
    await remote.page.locator('#inventoryCsvUpload').setInputFiles({
      name: 'fictional-denied.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Item Code,Item Name,Category,Stock\nCSV-DENIED,Denied by rules,Supplies,1\n'),
    });
    const denied = remote.page.getByRole('status', { name: 'Inventory CSV import result' });
    await denied.filter({ hasText: /CSV import stopped after 0 saved item/ }).waitFor();
    const deniedText = await denied.innerText();
    // The emulator reports a real rules denial (viewer cannot point-read the
    // audited head inside the transaction), not the client-side role guard.
    assert.match(deniedText, /permission-denied|insufficient permissions|evaluation error|false for '(get|create|update)'/i, deniedText);
    assert.doesNotMatch(deniedText, /online owner or editor/i);
    assert.doesNotMatch(deniedText, /Imported \d+ inventory item/i);
    assert.equal(await remote.page.evaluate(() => navigator.onLine), true);
    assert.equal(await offlineBanner(remote.page).count(), 0);
    assert.equal(await remote.page.getByText(/saved to cloud database/i).count(), 0);
    assert.deepEqual(remote.errors, []);
    assert.equal((await list('inventory')).some(row => row.name.endsWith('/CSV-DENIED')), false);

    // The unrelated clinic's owner is still write-capable in the UI. While the
    // browser context is offline, the signed-in gate must refuse to start a
    // clinical write, and no document may appear in Firestore on reconnect.
    await other.page.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'Clinic setup' }).click();
    await other.context.setOffline(true);
    await offlineBanner(other.page).waitFor();
    assert.equal(await other.page.evaluate(() => navigator.onLine), false);
    await other.page.locator('#inventoryCsvUpload').setInputFiles({
      name: 'fictional-offline.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Item Code,Item Name,Category,Stock\nCSV-OFFLINE,Offline attempt,Supplies,1\n'),
    });
    const offlineResult = other.page.getByRole('status', { name: 'Inventory CSV import result' });
    await offlineResult.filter({ hasText: /CSV import stopped after 0 saved item/ }).waitFor();
    assert.match(await offlineResult.innerText(), /online owner or editor/i);
    assert.doesNotMatch(await offlineResult.innerText(), /Imported \d+ inventory item/i);
    assert.equal(await other.page.getByText(/saved to cloud database/i).count(), 0);
    const offlineRows = await fetch(`http://${host}/v1/${otherClinic}/inventory?pageSize=100`, { headers: admin });
    assert.deepEqual((await offlineRows.json()).documents ?? [], []);
    await other.context.setOffline(false);
    await offlineBanner(other.page).waitFor({ state: 'detached' });
    const reconnectedRows = await fetch(`http://${host}/v1/${otherClinic}/inventory?pageSize=100`, { headers: admin });
    assert.deepEqual((await reconnectedRows.json()).documents ?? [], []);
    assert.deepEqual(other.errors, []);
  } finally {
    await other?.context.close();
    await remote?.context.close();
    await viewer?.context.close();
    await app.close();
  }
});

test('a real Firebase identity change clears an open inventory view without an offline banner', { timeout: 180000 }, async () => {
  const clinicId = `identity-${Date.now()}`;
  const clinicName = 'Fictional identity clinic';
  const password = 'SyntheticIdentityFixture123!';
  const email = `${clinicId}-viewer@example.com`;
  const signup = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const result = await signup.json();
  assert.equal(signup.status, 200, result.error?.message);
  const uid = result.localId;
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
      write(clinic, { name: clinicName, ownerId: uid, aiEnabled: false }),
      write(`${clinic}/members/${uid}`, { uid, email, role: 'viewer' }),
      write(`${documents}/users/${uid}/clinics/${clinicId}`, { clinicId, clinicName, role: 'viewer' }),
      write(`${clinic}/inventory/AUTH-ITEM`, { itemCode: 'AUTH-ITEM', itemName: 'Identity cached item',
        category: 'Supplies', stock: '3', buyingPrice: '1', sellingPrice: '2', threshold: '0' }),
    ] }),
  });
  assert.equal(seed.status, 200, await seed.text());

  const app = await startFixture(inventoryFixture);
  let context;
  try {
    context = await app.newContext();
    const errors = [];
    const page = await app.open(context, errors);
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.getByPlaceholder('Enter your password').fill(password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(`${clinicName}.*viewer`, 'i') }).click();
    await page.getByRole('navigation').getByRole('button', { name: 'Inventory', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'Identity cached item' });
    const banner = () => page.getByRole('status').filter({ hasText: 'No internet connection' });
    await row.waitFor();
    assert.equal(await banner().count(), 0);

    // Ordinary connection loss keeps the trusted-device cache readable.
    await context.setOffline(true);
    await banner().waitFor();
    assert.equal(await row.count(), 1);
    await context.setOffline(false);
    await banner().waitFor({ state: 'detached' });

    // A real Firebase auth change must not leave cached or listener data visible.
    await page.evaluate(() => window.fixture.signOut());
    await row.waitFor({ state: 'detached' });
    assert.equal(await banner().count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await app.close();
  }
});
