import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

test('exported demo close separates paid-in-full settlements, visit links, and later corrections', { timeout: 120000 }, async () => {
  const root = resolve('out');
  await readFile(resolve(root, 'index.html'));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
    const unexpected = [], errors = [];
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (!(url.hostname === 'images.unsplash.com' && request.resourceType() === 'image')) unexpected.push(`${request.resourceType()} ${url.origin}`);
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-11-19T17:30:00Z')); // Manila Nov 20, device Nov 19.
    await page.goto(origin);
    await page.getByPlaceholder('you@example.com').fill('admin@binanvet.com');
    await page.getByPlaceholder('Enter your password').fill('admin123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    const nav = page.getByRole('navigation', { name: 'Everyday work' });
    const close = page.getByRole('button', { name: 'End-of-Day Close', exact: true });
    const reportDate = page.getByLabel('Business day (Asia/Manila)');
    const region = name => page.getByRole('region', { name, exact: true });
    const collections = region('Recorded collections');
    const settlements = region('Paid in full — not itemized');
    const debt = region('Current outstanding balances');
    const corrections = region('Corrections recorded this day');
    const visits = region('Completed visits');
    const go = name => nav.getByRole('button', { name, exact: true }).click();
    const openClose = async () => { await go('Overview'); await close.click(); };
    const openDobby = async () => {
      await go('Patients');
      await page.getByRole('searchbox', { name: 'Search records' }).fill('');
      await page.getByRole('row').filter({ hasText: 'Dobby' }).click();
      return region('Patient billing');
    };
    const dismissDossier = () => page.getByRole('button', { name: 'Close dossier', exact: true }).click();
    const button = (scope, name) => scope.getByRole('button', { name, exact: true });

    await close.click();
    assert.equal(await reportDate.inputValue(), '2026-11-20');
    await go('Appointments');
    await button(page, 'Refine schedule').click();
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('all');
    for (const [id, name] of [['PAT-00101', 'Dobby'], ['PAT-00102', 'Max']]) {
      await button(page, 'New appointment').click();
      const form = page.getByRole('form', { name: 'Appointment details' });
      await form.getByRole('combobox', { name: 'Patient', exact: true }).selectOption(id);
      await form.getByRole('combobox', { name: 'Type', exact: true }).selectOption('Vaccination');
      await form.getByLabel('Scheduled date & time').fill('2026-11-19T08:00');
      await form.getByRole('combobox', { name: 'Appointment status', exact: true }).selectOption('completed');
      await form.getByLabel('Actual visit date & time').fill('2026-11-18T21:30');
      page.once('dialog', dialog => dialog.accept());
      await button(form, 'Review & save appointment').click();
      await form.waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: `${name} · Vaccination` }).waitFor();
    }
    await button(page.locator('article').filter({ hasText: 'Max · Vaccination' }), 'Record treatment & stock').click();
    await page.getByLabel('Clinical notes', { exact: true }).fill('Fictional completed treatment');
    await button(page, 'Save treatment').click();
    await page.getByText('Fictional completed treatment', { exact: true }).waitFor();
    await dismissDossier();

    const billing = await openDobby();
    await button(billing, 'Verify opening balance').click();
    const opening = page.getByRole('dialog', { name: 'Verify opening balance' });
    await opening.getByLabel('Checked against').selectOption('Paper ledger');
    await opening.getByLabel('Balance as of (Asia/Manila)').fill('2026-11-18T18:00');
    await button(opening, 'Review update').click();
    await button(opening, 'Confirm PHP 1,500.00').click();
    await button(billing, 'Record payment').click();
    const payment = page.getByRole('dialog', { name: 'Record payment' });
    await payment.getByLabel('Amount received (PHP)').fill('500');
    await payment.getByLabel('Received at (Asia/Manila)').fill('2026-11-19T10:00');
    await button(payment, 'Review update').click();
    await button(payment, 'Confirm payment').click();
    await button(billing, 'Mark paid in full').click();
    const full = page.getByRole('dialog', { name: 'Mark paid in full' });
    await full.getByLabel('Fully paid on (Asia/Manila)').fill('2026-11-19');
    await full.getByText(/won’t be counted in daily collections/).waitFor();
    await button(full, 'Confirm paid in full').click();
    await billing.getByText('PHP 0.00', { exact: true }).waitFor();
    await dismissDossier();

    await openClose();
    await reportDate.fill('2026-11-19');
    await collections.getByText('PHP 500.00', { exact: true }).waitFor();
    await settlements.getByText(/PHP 1,000\.00/).waitFor();
    await settlements.getByText(/not included in daily collections/i).waitFor();
    await debt.getByText('PHP 0.00', { exact: true }).waitFor();
    await button(visits, 'Open patient Dobby').waitFor();
    assert.equal(await button(visits, 'Open patient Max').count(), 0);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.locator('main').evaluate(main => [document.documentElement, main]
        .every(el => el.scrollWidth <= el.clientWidth + 1)), true);
    }
    await button(visits, 'Open patient Dobby').click();
    await billing.waitFor();
    const reverse = async row => {
      await button(billing.getByRole('listitem').filter({ hasText: row }), 'Reverse entry').click();
      const dialog = page.getByRole('dialog', { name: 'Reverse entry' });
      await dialog.getByLabel('Reason for reversal').fill('Fictional correction');
      await button(dialog, 'Review update').click();
      await button(dialog, 'Confirm reversal').click();
      await dialog.waitFor({ state: 'hidden' });
    };
    await reverse('Payment · PHP 500.00');
    await reverse('Paid in full — installments not itemized · PHP 1,000.00');
    await dismissDossier();
    await openClose();
    await corrections.getByText(/Payment reversal.*PHP 500\.00/).waitFor();
    await corrections.getByText(/Settlement reversal.*PHP 1,000\.00/).waitFor();
    await debt.getByText('PHP 1,500.00', { exact: true }).waitFor();
    await reportDate.fill('2026-11-19');
    await settlements.getByText(/Reversed/).waitFor();
    assert.equal(await collections.getByText('PHP 500.00', { exact: true }).count(), 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
