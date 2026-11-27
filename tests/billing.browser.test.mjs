import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

test('exported demo verifies a balance and records, receipts and reverses a payment', { timeout: 120000 }, async () => {
  const root = resolve('out');
  await readFile(resolve(root, 'index.html'));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
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
    const unexpected = [];
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (!(url.hostname === 'images.unsplash.com' && request.resourceType() === 'image')) unexpected.push(`${request.resourceType()} ${url.origin}`);
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-11-19T12:00:00Z'));
    await page.goto(origin);
    const signIn = async () => {
      await page.getByPlaceholder('you@example.com').fill('admin@binanvet.com');
      await page.getByPlaceholder('Enter your password').fill('admin123');
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    };
    const dossier = async () => {
      await page.getByRole('button', { name: 'Patients', exact: true }).click();
      await page.getByRole('row').filter({ hasText: 'Dobby' }).click();
      return page.getByRole('region', { name: 'Patient billing' });
    };
    await signIn();
    const section = await dossier();
    const opener = section.getByRole('button', { name: 'Verify opening balance' });
    const opening = page.getByRole('dialog', { name: 'Verify opening balance' });
    await opener.click();
    await opening.getByRole('button', { name: 'Not now' }).click();
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
    await section.getByText('PHP 1,500.00', { exact: true }).waitFor();
    await opener.click();
    await opening.getByRole('button', { name: 'No, it differs' }).click();
    await opening.getByLabel('Verified amount').fill('1200');
    await opening.getByLabel('Checked against').selectOption('Paper ledger');
    await opening.getByLabel('Balance as of (Asia/Manila)').fill('2026-11-18T18:00');
    await opening.getByLabel('Reason for correction').fill('Duplicate legacy entry');
    await opening.getByRole('button', { name: 'Review update' }).click();
    await opening.getByText('PHP 1,500.00 → PHP 1,200.00', { exact: true }).waitFor();
    await opening.getByRole('button', { name: 'Confirm PHP 1,200.00' }).click();
    await opening.waitFor({ state: 'hidden' });
    assert.equal(await section.getByRole('button', { name: 'Print receipt' }).count(), 0);

    const recordPayment = section.getByRole('button', { name: 'Record payment', exact: true });
    await recordPayment.click();
    const payment = page.getByRole('dialog', { name: 'Record payment' });
    await payment.waitFor();
    await page.keyboard.press('Escape');
    await payment.waitFor({ state: 'hidden' });
    assert.equal(await section.isVisible(), true);
    assert.equal(await recordPayment.evaluate(element => document.activeElement === element), true);
    await recordPayment.click();
    await payment.getByLabel('Amount received (PHP)').fill('500');
    await payment.getByLabel('Received at (Asia/Manila)').fill('2026-11-18T18:00');
    await payment.getByRole('button', { name: 'Review update' }).click();
    await payment.getByRole('alert').getByText(/old balance period/).waitFor();
    await payment.getByLabel('Received at (Asia/Manila)').fill('2026-11-19T10:00');
    await payment.getByRole('button', { name: 'Review update' }).click();
    await payment.getByText('PHP 1,200.00 → PHP 700.00', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await payment.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    assert.equal(await payment.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await payment.getByRole('button', { name: 'Confirm payment' }).evaluate(button => {
      button.click();
      button.click();
    });
    await section.getByText('PHP 700.00', { exact: true }).waitFor();
    assert.equal(await section.getByRole('button', { name: 'Print receipt' }).count(), 1);
    const downloading = page.waitForEvent('download');
    await section.getByRole('button', { name: 'Print receipt' }).click();
    const download = await downloading;
    assert.match(download.suggestedFilename(), /^payment-[a-f0-9-]+\.pdf$/);
    const pdf = (await readFile(await download.path())).toString('latin1');
    assert.match(pdf, /^%PDF-/);
    assert.match(pdf, /Payment acknowledgment/);
    assert.match(pdf, /Amount paid: PHP 500\.00/);

    await section.getByRole('button', { name: 'Reverse entry', exact: true }).click();
    const reversal = page.getByRole('dialog', { name: 'Reverse entry' });
    await reversal.getByLabel('Reason for reversal').fill('Sample entry was recorded twice');
    await reversal.getByRole('button', { name: 'Review update' }).click();
    await reversal.getByRole('button', { name: 'Confirm reversal' }).click();
    await section.getByText('PHP 1,200.00', { exact: true }).waitFor();
    await section.getByText(/Reversed/).waitFor();
    const reprint = page.waitForEvent('download');
    await section.getByRole('button', { name: 'Print receipt' }).click();
    const reversedPdf = await reprint;
    assert.equal(reversedPdf.suggestedFilename(), download.suggestedFilename());
    assert.match((await readFile(await reversedPdf.path())).toString('latin1'), /REVERSED/);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'Close dossier', exact: true }).click();
    await page.getByRole('button', { name: 'Logout', exact: true }).click();
    await signIn();
    const after = await dossier();
    await after.getByRole('button', { name: 'Verify opening balance' }).waitFor();
    await after.getByText('PHP 1,500.00', { exact: true }).waitFor();
    assert.equal(await after.getByRole('button', { name: 'Print receipt' }).count(), 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
