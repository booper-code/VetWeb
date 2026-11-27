import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  import {applyActionCode, signOut as firebaseSignOut} from 'firebase/auth';
  import * as firebase from './lib/firebase';
  import App from './app/page';
  import OfflineStatus from './components/OfflineStatus';
  createRoot(document.getElementById('root')).render(<><OfflineStatus staticShell={false} /><App /></>);
  window.fixture = {
    ready: true,
    losePaymentResponse() { window.losePaymentResponse = true; },
    loseAcknowledgementResponse() { window.loseAckResponse = true; window.checkoutTransactions = 0; },
    holdPayrollSave() { window.payrollSaveGate = new Promise(resolve => { window.releasePayrollSave = resolve; }); },
    async verifyEmail(code) {
      const { auth } = await firebase.initializeFirebase();
      await applyActionCode(auth, code);
    },
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
              export async function runTransaction(db, update, options) {
                window.checkoutTransactions = (window.checkoutTransactions ?? 0) + 1;
                const number = window.checkoutTransactions;
                const result = await real.runTransaction(db, async tx => {
                  const result = await update(tx);
                  if (window.payrollSaveGate && result?.hash && result?.seq) {
                    window.payrollSaveReady = true;
                    await window.payrollSaveGate;
                    window.payrollSaveGate = null;
                  }
                  return result;
                }, options);
                // The second transaction after arming is the payment
                // acknowledgement. Lose its response only after it committed.
                if (number === 2 && window.loseAckResponse) {
                  window.loseAckResponse = false;
                  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
                  throw new Error('Connection lost after acknowledgement');
                }
                return result;
              }
              export async function getDocFromServer(ref) {
                const snapshot = await real.getDocFromServer(ref);
                if (window.losePaymentResponse && ref.parent.id === 'billingEntries' && snapshot.data()?.kind === 'payment') {
                  window.losePaymentResponse = false;
                  throw new Error('Payment response lost after commit');
                }
                return snapshot;
              }
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
  const open = async (context, errors = [], url = origin) => {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    await page.goto(url);
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

async function financeFixture() {
  const id = `finance-${Date.now()}`;
  const password = 'FinanceFixture123!';
  const accounts = {};
  for (const role of ['owner', 'member']) {
    const email = `${id}-${role}@example.com`;
    const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const account = await response.json();
    assert.equal(response.status, 200, account.error?.message);
    accounts[role] = { uid: account.localId, email };
  }
  const documents = `projects/${projectId}/databases/(default)/documents`;
  const clinics = { first: [id, 'Fictional Finance Clinic'], second: [`${id}-other`, 'Fictional Other Clinic'] };
  const admin = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  const write = (path, data) => ({
    update: {
      name: `${documents}/${path}`,
      fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [
        key, typeof value === 'number' ? { integerValue: String(value) } : { stringValue: value },
      ])),
    },
  });
  const staffId = 'fictional-staff';
  const periodId = 'fictional-period';
  const pastStaffId = 'existing-payout-staff';
  const firstClinic = `clinics/${id}`;
  const periodWrite = write(`${firstClinic}/payrollPeriods/${periodId}`, {
    status: 'open', startDate: '2026-11-23', endDate: '2026-11-27'
  });
  periodWrite.update.fields.createdAt = { timestampValue: '2026-11-23T00:00:00Z' };
  const ledgerEntry = (seq, type, staff, amount, prevHash, entryPeriodId = periodId) => {
    const staffName = staff === staffId ? 'Fictional Staff' : 'Fictional Earlier Staff';
    const actor = accounts.member.uid;
    const hash = createHash('sha256').update(JSON.stringify([
      seq, type, 'out', staff, staffName, amount, entryPeriodId, '', actor, prevHash,
    ])).digest('hex');
    return { seq, type, direction: 'out', staffId: staff, staffName, amount,
      periodId: entryPeriodId, note: '', createdBy: actor, prevHash, hash };
  };
  const advance = ledgerEntry(1, 'advance', staffId, 400, 'GENESIS');
  const priorPayout = ledgerEntry(2, 'payout', pastStaffId, 300, advance.hash);
  const unassignedPayout = ledgerEntry(3, 'payout', pastStaffId, 100, priorPayout.hash, '');
  const seed = await fetch(`http://${host}/v1/${documents}:commit`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ writes: [
      ...Object.values(clinics).flatMap(([clinicId, clinicName]) => [
        write(`clinics/${clinicId}`, { name: clinicName, ownerId: accounts.owner.uid }),
        write(`clinics/${clinicId}/patients/fictional-patient`, { name: 'Fictional Patient', balance: 1500, status: 'Waiting' }),
        ...Object.entries(accounts).flatMap(([role, { uid, email }]) => [
          write(`clinics/${clinicId}/members/${uid}`, { uid, email, role }),
          write(`users/${uid}/clinics/${clinicId}`, { clinicId, clinicName, role }),
        ]),
      ]),
      ...[[staffId, 'Fictional Staff'], [pastStaffId, 'Fictional Earlier Staff']].flatMap(([staff, name]) => [
        write(`${firstClinic}/staff/${staff}`, { name, kind: 'employee', position: 'Assistant' }),
        write(`${firstClinic}/payProfiles/${staff}`, { payBasis: 'daily', rate: 500 }),
      ]),
      periodWrite,
      write(`${firstClinic}/payrollLedger/old-advance`, advance),
      write(`${firstClinic}/payrollLedger/old-payout`, priorPayout),
      write(`${firstClinic}/payrollLedger/unassigned-payout`, unassignedPayout),
      write(`${firstClinic}/payrollMeta/ledger`, { seq: unassignedPayout.seq, hash: unassignedPayout.hash }),
    ] }),
  });
  assert.equal(seed.status, 200, await seed.text());
  const rows = async (collection, clinic = 'first') => {
    const result = await fetch(`http://${host}/v1/${documents}/clinics/${clinics[clinic][0]}/${collection}`, { headers: admin });
    assert.equal(result.status, 200);
    return (await result.json()).documents ?? [];
  };
  const app = await startFixture(inventoryFixture);
  const choose = (page, clinic) => page.getByRole('button', { name: new RegExp(clinics[clinic][1]) }).click();
  const signIn = async (page, role, clinic = 'first') => {
    await page.getByPlaceholder('you@example.com').fill(accounts[role].email);
    await page.getByPlaceholder('Enter your password').fill(password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await choose(page, clinic);
  };
  return { ...app, rows, choose, signIn, staffId, pastStaffId, accounts, clinics };
}

test('a disconnect after acknowledgement keeps a posted payment confirmed and recoverable', { timeout: 120000 }, async () => {
  const app = await financeFixture();
  try {
    const page = await app.open(await app.newContext());
    const dossier = async () => {
      await page.getByRole('button', { name: 'Patients', exact: true }).click();
      await page.getByRole('row').filter({ hasText: 'Fictional Patient' }).click();
      return page.getByRole('region', { name: 'Patient billing' });
    };
    const date = offset => new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Manila', dateStyle: 'short', timeStyle: 'short',
    }).format(Date.now() - offset * 60_000).replace(' ', 'T');
    const payments = async () => (await app.rows('billingEntries')).filter(row => row.fields.kind.stringValue === 'payment');
    await app.signIn(page, 'member');
    let billing = await dossier();
    await billing.getByRole('button', { name: 'Verify opening balance' }).click();
    const opening = page.getByRole('dialog', { name: 'Verify opening balance' });
    await opening.getByLabel('Checked against').selectOption('Paper ledger');
    await opening.getByLabel('Balance as of (Asia/Manila)').fill(date(120));
    await opening.getByRole('button', { name: 'Review update' }).click();
    await opening.getByRole('button', { name: 'Confirm PHP 1,500.00' }).click();
    await opening.waitFor({ state: 'hidden' });
    await billing.getByRole('button', { name: 'Record payment', exact: true }).click();
    const payment = page.getByRole('dialog', { name: 'Record payment' });
    await payment.getByLabel('Amount received (PHP)').fill('500');
    await payment.getByLabel('Received at (Asia/Manila)').fill(date(60));
    await payment.getByRole('button', { name: 'Review update' }).click();
    await page.evaluate(() => window.fixture.loseAcknowledgementResponse());
    await payment.getByRole('button', { name: 'Confirm payment' }).click();
    // The result is accepted before acknowledgement; a lost acknowledgement
    // response must not leave an uncertain checkout or duplicate the payment.
    await payment.waitFor({ state: 'hidden' });
    const finish = billing.getByRole('button', { name: 'Finish payment confirmation' });
    await finish.waitFor();
    assert.equal(await billing.getByRole('button', { name: 'Retry unconfirmed save' }).count(), 0);
    assert.equal((await payments()).length, 1);
    await page.evaluate(() => {
      delete navigator.onLine;
      window.dispatchEvent(new Event('online'));
    });
    await finish.waitFor({ state: 'hidden' });

    await page.reload();
    await app.signIn(page, 'member');
    billing = await dossier();
    await billing.getByText('PHP 1,000.00', { exact: true }).waitFor();
    assert.equal(await billing.getByRole('button', { name: 'Retry unconfirmed save' }).count(), 0);
    assert.equal((await payments()).length, 1);

    // A separate later payment is still a legitimate new entry.
    await billing.getByRole('button', { name: 'Record payment', exact: true }).click();
    const later = page.getByRole('dialog', { name: 'Record payment' });
    await later.getByLabel('Amount received (PHP)').fill('250');
    await later.getByLabel('Received at (Asia/Manila)').fill(date(30));
    await later.getByRole('button', { name: 'Review update' }).click();
    await later.getByRole('button', { name: 'Confirm payment' }).click();
    await later.waitFor({ state: 'hidden' });
    assert.equal((await payments()).length, 2);
    assert.equal(await billing.getByRole('button', { name: 'Retry unconfirmed save' }).count(), 0);
  } finally { await app.close(); }
});

test('payroll enforces the same remaining balance for calculated and manual payouts', { timeout: 90000 }, async () => {
  const app = await financeFixture();
  try {
    const [member, owner] = await Promise.all(['member', 'owner'].map(async role => {
      const page = await app.open(await app.newContext());
      await app.signIn(page, role);
      await page.getByRole('button', { name: 'Staff & Payroll' }).click();
      return page;
    }));
    const payrollRow = (page, name) => page.getByRole('table')
      .filter({ has: page.getByRole('columnheader', { name: 'Remaining payable' }) })
      .getByRole('row', { name: new RegExp(name) });
    const payout = (page, name) => payrollRow(page, name).getByRole('button', { name: 'Record payout' });
    const confirmLimit = (page, name) => payrollRow(page, name).getByRole('button', { name: 'Confirm payout limit' });
    const prepareManual = async (page, staffId, amount) => {
      const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Cash in / out' }) });
      await form.getByLabel('Staff').selectOption(staffId);
      await form.getByLabel('Entry type').selectOption('payout');
      await form.getByLabel('Amount (PHP)').fill(String(amount));
      return form.getByRole('button', { name: 'Record entry' });
    };
    const memberPayout = payout(member, 'Fictional Staff');
    const ownerPayout = payout(owner, 'Fictional Staff');
    const dialogs = [];
    member.on('dialog', dialog => {
      dialogs.push(dialog.message());
      return dialog.type() === 'prompt' ? dialog.accept('100') : dialog.accept();
    });
    await (await prepareManual(owner, app.staffId, 2100)).click();
    await owner.getByText(/confirm the payout limit for this staff member first/i).waitFor();
    await confirmLimit(member, 'Fictional Staff').click();
    await Promise.all([memberPayout.waitFor(), ownerPayout.waitFor()]);
    assert.match(dialogs.at(-1), /PHP 2,100\.00 total pay.*Already paid: PHP 0\.00/s);
    assert.equal((await app.rows('payrollLedger')).length, 3);
    await memberPayout.click();
    await member.getByText('Payout recorded for Fictional Staff.').waitFor();
    await (await prepareManual(owner, app.staffId, 2100)).click();
    await owner.getByText(/no pay remains/i).waitFor({ timeout: 5000 });
    assert.equal(await memberPayout.isDisabled(), true);
    assert.equal(await payrollRow(member, 'Fictional Staff').getByRole('cell').nth(5).innerText(), 'PHP 0.00');
    assert.equal((await app.rows('payrollLedger')).filter(row =>
      row.fields.staffId.stringValue === app.staffId && row.fields.type.stringValue === 'payout').length, 1);

    await confirmLimit(member, 'Fictional Earlier Staff').click();
    await Promise.all([member, owner].map(page => payout(page, 'Fictional Earlier Staff').waitFor()));
    assert.match(dialogs.at(-1), /PHP 2,500\.00 total pay.*Already paid: PHP 400\.00.*Remaining: PHP 2,100\.00/s);
    const closePeriod = member.getByRole('button', { name: 'Close period', exact: true });
    assert.equal(await closePeriod.isDisabled(), true, 'do not close a period with a confirmed amount still payable');
    await (await prepareManual(owner, app.pastStaffId, 2101)).click();
    await owner.getByText(/only.*2,100\.00.*remains/i).waitFor();
    await (await prepareManual(member, app.pastStaffId, 1000)).click();
    await member.getByText('Ledger entry recorded.').waitFor();
    await payrollRow(member, 'Fictional Earlier Staff').getByRole('cell', { name: 'PHP 1,100.00', exact: true }).waitFor();
    const ownerSave = await prepareManual(owner, app.pastStaffId, 1100);
    await Promise.all([member, owner].map(page => page.evaluate(() => window.fixture.holdPayrollSave())));
    await Promise.all([
      payout(member, 'Fictional Earlier Staff').click(),
      ownerSave.click(),
    ]);
    await Promise.all([member, owner].map(page => page.waitForFunction(() => window.payrollSaveReady)));
    await Promise.all([member, owner].map(page => page.evaluate(() => window.releasePayrollSave())));
    await member.getByText(/payout recorded for Fictional Earlier Staff|no pay remains/i).waitFor();
    await owner.getByText(/ledger entry recorded|no pay remains/i).waitFor({ timeout: 5000 }).catch(async error => {
      const alert = await owner.getByRole('alert').allTextContents();
      throw new Error(`Concurrent manual payout did not report a result: ${alert.join(' ')}`, { cause: error });
    });
    const paid = (await app.rows('payrollLedger')).filter(row =>
      row.fields.staffId.stringValue === app.pastStaffId && row.fields.type.stringValue === 'payout');
    assert.deepEqual(paid.map(row => Number(row.fields.amount.integerValue ?? row.fields.amount.doubleValue)).sort((a, b) => a - b),
      [100, 300, 1000, 1100]);
    await closePeriod.click();
    await member.getByText('Payroll period closed.').waitFor({ timeout: 5000 }).catch(async error => {
      const alert = await member.getByRole('alert').allTextContents();
      throw new Error(`Payroll period did not close: ${alert.join(' ')}`, { cause: error });
    });
    assert.equal(await (await prepareManual(member, app.pastStaffId, 1)).isDisabled(), true);

    await member.getByRole('button', { name: 'New period', exact: true }).click();
    await member.getByLabel('Start', { exact: true }).fill('2026-11-30');
    await member.getByLabel('End', { exact: true }).fill('2026-12-04');
    await member.getByRole('button', { name: 'Create period', exact: true }).click();
    const dialogCount = dialogs.length;
    await confirmLimit(member, 'Fictional Earlier Staff').click();
    await payout(member, 'Fictional Earlier Staff').waitFor();
    assert.equal(dialogs.length, dialogCount + 1, 'the legacy payout must not be offered again');
    assert.match(dialogs.at(-1), /Already paid: PHP 0\.00/);
  } finally { await app.close(); }
});

test('a payment with a lost commit response recovers after reload and sign-out in its original workspace', { timeout: 120000 }, async () => {
  const app = await financeFixture();
  try {
    const page = await app.open(await app.newContext());
    const dossier = async () => {
      await page.getByRole('button', { name: 'Patients', exact: true }).click();
      await page.getByRole('row').filter({ hasText: 'Fictional Patient' }).click();
      return page.getByRole('region', { name: 'Patient billing' });
    };
    const date = offset => new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Manila', dateStyle: 'short', timeStyle: 'short',
    }).format(Date.now() - offset * 60_000).replace(' ', 'T');
    await app.signIn(page, 'member');
    let billing = await dossier();
    await billing.getByRole('button', { name: 'Verify opening balance' }).click();
    const opening = page.getByRole('dialog', { name: 'Verify opening balance' });
    await opening.getByLabel('Checked against').selectOption('Paper ledger');
    await opening.getByLabel('Balance as of (Asia/Manila)').fill(date(120));
    await opening.getByRole('button', { name: 'Review update' }).click();
    await opening.getByRole('button', { name: 'Confirm PHP 1,500.00' }).click();
    await opening.waitFor({ state: 'hidden' });
    await billing.getByRole('button', { name: 'Record payment', exact: true }).click();
    const payment = page.getByRole('dialog', { name: 'Record payment' });
    await payment.getByLabel('Amount received (PHP)').fill('500');
    await payment.getByLabel('Received at (Asia/Manila)').fill(date(60));
    await payment.getByRole('button', { name: 'Review update' }).click();
    await page.evaluate(() => window.fixture.losePaymentResponse());
    await payment.getByRole('button', { name: 'Confirm payment' }).click();
    await payment.getByText(/payment response lost after commit/i).waitFor();
    const payments = async (clinic = 'first') => (await app.rows('billingEntries', clinic)).filter(row => row.fields.kind.stringValue === 'payment');
    const before = await payments();
    assert.equal(before.length, 1);
    const entryId = before[0].name.split('/').at(-1);

    await page.reload();
    await app.signIn(page, 'member');
    billing = await dossier();
    const retry = () => billing.getByRole('button', { name: 'Retry unconfirmed save' });
    await retry().waitFor({ timeout: 5000 });
    assert.equal(await billing.getByRole('button', { name: 'Record payment', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Close dossier' }).click();
    await page.getByRole('button', { name: /current clinic.*switch/i }).click();
    await app.choose(page, 'second');
    billing = await dossier();
    await billing.getByRole('button', { name: 'Verify opening balance' }).waitFor();
    assert.equal(await retry().count(), 0);
    assert.deepEqual(await payments('second'), []);

    const logout = async () => {
      await page.getByRole('button', { name: 'Close dossier' }).click();
      await page.getByRole('button', { name: 'Logout', exact: true }).click();
    };
    await logout();
    await app.signIn(page, 'owner');
    billing = await dossier();
    await billing.getByRole('button', { name: 'Print receipt' }).waitFor();
    assert.equal(await retry().count(), 0);
    await logout();
    await app.signIn(page, 'member');
    billing = await dossier();
    await retry().click();
    await retry().waitFor({ state: 'hidden' });
    assert.deepEqual(await payments(), before);
    const downloading = page.waitForEvent('download');
    await billing.getByRole('button', { name: 'Print receipt' }).click();
    assert.equal((await downloading).suggestedFilename(), `payment-${entryId}.pdf`);
    await billing.getByText('PHP 1,000.00', { exact: true }).waitFor();
  } finally { await app.close(); }
});

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

test('clinic work is audited, scoped, and fresh across open Owner and Member views', { timeout: 180000 }, async () => {
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
    await page.getByRole('button', { name: new RegExp(`${targetClinicName}.*${role === 'viewer' ? 'member' : role}`, 'i') }).click();
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
    for (const collection of ['inventory', 'auditHeads', 'auditEvents', 'inventoryImportReceipts']) assert.deepEqual(await list(collection), []);

    // An authorized viewer that already has Inventory open must see the owner's
    // confirmed rows without refreshing. This is the stale-view regression.
    viewer = await signIn('viewer');
    assert.equal(await viewer.page.getByRole('button', { name: 'Team & invitations' }).count(), 0);
    assert.equal(await viewer.page.getByRole('button', { name: 'Clinical audit' }).count(), 1);
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
      await popup.getByText(/24 catalog items were imported/).waitFor();
      await ask(page, 'Hanapin si Alex Reyes');
      const link = popup.getByRole('link', { name: /Alex Reyes.*Fictional Milo/ });
      await link.waitFor();
      assert.doesNotMatch(await popup.innerText(), /5550001111|private@example|private address/i);
      await link.click();
      await popup.waitFor({ state: 'hidden' });
      await page.getByText('Synthetic private address', { exact: true }).waitFor();
    });

    await inSettings('viewer', async page => {
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

    const inviteeEmail = `${clinicId}-invitee@example.com`;
    const invitee = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteeEmail, password, returnSecureToken: true }),
    });
    assert.equal(invitee.status, 200);
    const { localId: inviteeUid } = await invitee.json();
    let inviteUrl;
    await inSettings('owner', async page => {
      await page.getByRole('button', { name: 'Team & invitations' }).click();
      await page.getByPlaceholder('person@example.com').fill(inviteeEmail);
      await page.getByRole('button', { name: 'Create invite' }).click();
      inviteUrl = await page.getByRole('textbox', { name: 'New invitation link' }).inputValue();
    });
    const inviteeContext = await app.newContext();
    try {
      const errors = [];
      const page = await app.open(inviteeContext, errors, inviteUrl);
      await page.getByPlaceholder('you@example.com').fill(inviteeEmail);
      await page.getByPlaceholder('Enter your password').fill(password);
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await page.getByRole('button', { name: 'Send / resend email' }).click();
      await page.getByRole('status').filter({ hasText: /verification email sent/i }).waitFor();
      const codes = await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${projectId}/oobCodes`);
      assert.equal(codes.ok, true);
      const { oobCodes } = await codes.json();
      const code = oobCodes.filter(item => item.email === inviteeEmail && item.requestType === 'VERIFY_EMAIL').at(-1);
      assert.ok(code);
      await page.evaluate(value => window.fixture.verifyEmail(value), code.oobCode);
      await page.getByRole('button', { name: /verified/i }).click();
      await page.getByText(/Invited as a Member/i).waitFor();
      await page.getByRole('button', { name: 'Accept invitation' }).click();
      await page.getByRole('button', { name: 'Clinical audit' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Team & invitations' }).count(), 0);
      const member = (await list('members')).find(item => item.name.endsWith(`/${inviteeUid}`));
      assert.equal(member?.fields.role.stringValue, 'member');
      assert.deepEqual(errors, []);
    } finally {
      await inviteeContext.close();
    }

    const consultationHistory = async page => {
      await page.getByRole('navigation').getByRole('button', { name: 'Overview', exact: true }).click();
      const panel = page.locator('details').filter({ has: page.getByText('Consultation history', { exact: true }) });
      await panel.getByText('Consultation history', { exact: true }).click();
      return panel;
    };
    const watchingHistory = await consultationHistory(viewer.page);
    const unrelatedHistory = await consultationHistory(other.page);
    await watchingHistory.getByText('No consultations recorded.').waitFor();
    const visitId = index => `history-visit-${String(index).padStart(2, '0')}`;
    const historyWrites = Array.from({ length: 52 }, (_, index) => write(`${clinic}/consultations/${visitId(index)}`, {
      id: visitId(index), patient: 'Fictional Milo', client: '', type: 'Consultation',
      notes: '', status: 'Draft', date: '2024-02-29'
    }));
    historyWrites.push(write(`${clinic}/consultations/history-unknown`, {
      id: 'history-unknown', patient: 'Fictional Milo', client: '', type: 'Consultation',
      notes: '', status: 'Draft', date: '2/3/2024'
    }));
    const commitFixtures = async writes => {
      const reply = await fetch(`http://${host}/v1/${documents}:commit`, {
        method: 'POST', headers: admin, body: JSON.stringify({ writes })
      });
      assert.equal(reply.status, 200, await reply.text());
    };
    await commitFixtures(historyWrites);
    await watchingHistory.getByText(visitId(0), { exact: false }).waitFor();
    const { backfillConsultationHistory } = await import('../scripts/backfill-consultation-history.mjs');
    await backfillConsultationHistory({ host, projectId, clinicId, apply: true });
    await watchingHistory.getByText(visitId(51), { exact: false }).waitFor();
    assert.equal(await watchingHistory.getByRole('listitem').count(), 50);
    assert.match(await watchingHistory.getByRole('listitem').first().innerText(), /history-visit-51/);
    assert.match(await watchingHistory.getByRole('listitem').last().innerText(), /history-visit-02/);
    await watchingHistory.getByRole('button', { name: 'Load more consultations' }).click();
    await watchingHistory.getByRole('heading', { name: 'Unknown date' }).waitFor();
    assert.equal(await watchingHistory.getByRole('listitem').count(), 53);
    assert.match(await watchingHistory.getByRole('listitem').last().innerText(), /2\/3\/2024.*history-unknown/);
    const editingHistory = await consultationHistory(remote.page);
    const topVisit = panel => panel.getByRole('listitem').filter({ hasText: visitId(51) });
    await topVisit(editingHistory).getByRole('button', { name: 'Change state' }).click();
    await topVisit(watchingHistory).getByText('Completed', { exact: true }).waitFor();
    await commitFixtures([{ delete: `${clinic}/consultations/${visitId(50)}` }]);
    await watchingHistory.getByText(visitId(50), { exact: false }).waitFor({ state: 'detached' });
    assert.equal(await watchingHistory.getByRole('listitem').count(), 52);
    assert.equal(await unrelatedHistory.getByRole('listitem').count(), 0);

    await viewer.page.getByRole('navigation').getByRole('button', { name: 'Patients', exact: true }).click();
    const patientRow = viewer.page.getByRole('row').filter({ hasText: 'Fictional Milo' });
    await commitFixtures([{
      update: { name: `${clinic}/patients/synthetic-milo`, fields: { balance: { integerValue: '1500' } } },
      updateMask: { fieldPaths: ['balance'] }
    }]);
    await patientRow.click();
    const dossier = viewer.page.getByRole('heading', { name: 'Patient Clinical Dossier' });
    await dossier.waitFor();
    const watchingBilling = viewer.page.getByRole('region', { name: 'Patient billing' });
    await watchingBilling.getByText('PHP 1,500.00', { exact: true }).waitFor();
    await remote.page.getByRole('navigation').getByRole('button', { name: 'Patients', exact: true }).click();
    await remote.page.getByRole('row').filter({ hasText: 'Fictional Milo' }).click();
    await remote.page.getByRole('button', { name: 'Verify opening balance' }).click();
    const opening = remote.page.getByRole('dialog', { name: 'Verify opening balance' });
    await opening.getByRole('button', { name: 'No, it differs' }).click();
    await opening.getByLabel('Verified amount').fill('1200');
    await opening.getByLabel('Checked against').selectOption('Paper ledger');
    await opening.getByLabel('Balance as of (Asia/Manila)').fill('2026-11-18T18:00');
    await opening.getByLabel('Reason for correction').fill('Synthetic balance verified in another session');
    await opening.getByRole('button', { name: 'Review update' }).click();
    await opening.getByRole('button', { name: 'Confirm PHP 1,200.00' }).click();
    await opening.waitFor({ state: 'hidden' });
    await watchingBilling.getByText('PHP 1,200.00', { exact: true }).first().waitFor();
    await watchingBilling.getByText('Synthetic balance verified in another session').waitFor();
    await remote.page.getByRole('button', { name: 'Record treatment', exact: true }).click();
    await remote.page.getByLabel('Actual visit time').fill('2025-05-03T09:30');
    const treatmentItem = remote.page.getByLabel('Treatment item');
    await treatmentItem.selectOption('SRV-VACC');
    await remote.page.getByLabel('Line note').fill('Synthetic service detail');
    await remote.page.getByRole('button', { name: 'Add line', exact: true }).click();
    await treatmentItem.selectOption('MED-AMX500');
    await remote.page.getByRole('button', { name: 'Add line', exact: true }).click();
    await remote.page.getByLabel('Clinical notes').fill('Synthetic treatment saved in another session');
    await remote.page.getByRole('button', { name: 'Save treatment', exact: true }).click();
    const savedVisit = viewer.page.locator('article').filter({ hasText: 'Synthetic treatment saved in another session' });
    await savedVisit.getByRole('heading', { name: /Vaccination service/ }).waitFor();
    await savedVisit.getByText(/Synthetic service detail/).waitFor();
    await savedVisit.getByText(/Amoxicillin 500 mg capsule × 1/).waitFor();
    assert.equal((await list('inventory')).find(row => row.name.endsWith('/MED-AMX500')).fields.stock.integerValue, '119');
    await remote.page.getByRole('button', { name: 'Edit Dossier Details' }).click();
    await remote.page.getByRole('button', { name: '+ Add Lab Printout', exact: true }).click();
    const labPixels = await remote.page.evaluate(() => document.createElement('canvas').toDataURL().split(',')[1]);
    await remote.page.getByText('Upload Lab Printout', { exact: true }).locator('..').locator('input[type=file]')
      .setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(labPixels, 'base64') });
    await remote.page.getByRole('img', { name: 'Lab Printout', exact: true }).waitFor();
    assert.equal(await remote.page.getByRole('button', { name: 'Demo extraction (example data)' }).count(), 0);
    await remote.page.getByRole('button', { name: 'Cancel Editing' }).click();
    await remote.page.getByRole('button', { name: 'Close dossier', exact: true }).click();
    await commitFixtures([{
      ...write(`${clinic}/patients/synthetic-milo`, { name: 'Fictional Milo updated', status: 'Discharged' }),
      updateMask: { fieldPaths: ['name', 'status'] }
    }]);
    await viewer.page.getByRole('heading', { name: 'Fictional Milo updated' }).waitFor();
    await patientRow.waitFor({ state: 'detached' });
    await commitFixtures([{ delete: `${clinic}/patients/synthetic-milo` }]);
    await dossier.waitFor({ state: 'detached' });
    await viewer.page.getByText('This patient is no longer available in the clinic.').waitFor();

    await viewer.page.getByRole('navigation').getByRole('button', { name: 'Appointments', exact: true }).click();
    await remote.page.getByRole('navigation').getByRole('button', { name: 'Overview', exact: true }).click();
    await remote.page.getByRole('button', { name: 'Follow-up queue', exact: true }).click();
    await remote.page.getByText('No scheduled follow-ups are due.').waitFor();
    const followUpId = 'live-follow-up';
    const dueAt = new Date().toISOString();
    const followUpFixture = write(`${clinic}/appointments/${followUpId}`, {
      id: followUpId, patientId: 'live-schedule-patient', patientName: 'Fictional live follow-up',
      ownerName: 'Synthetic owner', ownerContact: '', ownerEmail: '',
      type: 'Follow-up', status: 'scheduled', notes: '', createdBy: accounts.owner.uid, updatedBy: accounts.owner.uid
    });
    Object.assign(followUpFixture.update.fields, {
      dueAt: { timestampValue: dueAt }, createdAt: { timestampValue: dueAt }, updatedAt: { timestampValue: dueAt },
      occurredAt: { nullValue: null }, revision: { integerValue: '0' }, durationMinutes: { integerValue: '30' }
    });
    await commitFixtures([write(`${clinic}/patients/live-schedule-patient`, {
      name: 'Fictional live follow-up', status: 'Waiting'
    }), followUpFixture]);
    await viewer.page.getByRole('heading', { name: 'Fictional live follow-up · Follow-up' }).waitFor();
    await remote.page.getByRole('heading', { name: 'Fictional live follow-up' }).waitFor();
    await remote.page.getByRole('button', { name: 'Mark contacted' }).click();
    await remote.page.getByText(/Contact recorded/).waitFor();
    await viewer.page.getByRole('navigation').getByRole('button', { name: 'Overview', exact: true }).click();
    await viewer.page.getByRole('button', { name: 'Follow-up queue', exact: true }).click();
    await viewer.page.getByText(/Contact recorded/).waitFor();
    await remote.page.getByRole('button', { name: 'Undo contact' }).click();
    await viewer.page.getByText('Needs contact', { exact: true }).waitFor();
    await commitFixtures([{
      update: { name: `${clinic}/appointments/${followUpId}`, fields: { status: { stringValue: 'cancelled' } } },
      updateMask: { fieldPaths: ['status'] }
    }]);
    await viewer.page.getByText('No scheduled follow-ups are due.').waitFor();

    // Keep this session's in-memory role, but remove the canonical membership
    // behind it. The UI still offers an import; the emulator
    // rules must reject the transaction independently of the front-end guard.
    const revokeAccess = await fetch(`http://${host}/v1/${documents}:commit`, {
      method: 'POST', headers: admin,
      body: JSON.stringify({ writes: [
        { delete: `${clinic}/members/${accounts.owner.uid}` },
        { delete: `${documents}/users/${accounts.owner.uid}/clinics/${clinicId}` },
      ] }),
    });
    assert.equal(revokeAccess.status, 200, await revokeAccess.text());
    await remote.page.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'Clinic setup' }).click();
    await remote.page.locator('#inventoryCsvUpload').setInputFiles({
      name: 'fictional-denied.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Item Code,Item Name,Category,Stock\nCSV-DENIED,Denied by rules,Supplies,1\n'),
    });
    const denied = remote.page.getByRole('status', { name: 'Inventory CSV import result' });
    await denied.filter({ hasText: /CSV import stopped after 0 saved item/ }).waitFor();
    const deniedText = await denied.innerText();
    // The emulator reports a real rules denial (non-members cannot point-read the
    // audited head inside the transaction), not the client-side role guard.
    assert.match(deniedText, /permission-denied|insufficient permissions|evaluation error|false for '(get|create|update)'/i, deniedText);
    assert.doesNotMatch(deniedText, /online clinic session/i);
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
    assert.match(await offlineResult.innerText(), /online clinic session/i);
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
    await page.getByRole('button', { name: new RegExp(`${clinicName}.*member`, 'i') }).click();
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

    await row.getByText('Identity cached item', { exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Inventory item details' });
    await drawer.waitFor();
    // A real Firebase auth change clears both the table and the open drawer.
    await page.evaluate(() => window.fixture.signOut());
    await row.waitFor({ state: 'detached' });
    assert.equal(await drawer.count(), 0, 'the drawer must not retain clinical data after access changes');
    assert.equal(await page.getByRole('button', { name: 'Retry inventory', exact: true }).count(), 0);
    assert.equal(await banner().count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await app.close();
  }
});
