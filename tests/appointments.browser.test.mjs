import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

test('static-export demo appointment workflow works without Firebase/R2, including mobile', { timeout: 120000 }, async () => {
  const root = resolve('out');
  await readFile(resolve(root, 'index.html')); // Refuse to silently test a dev/live site.
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(`${root}${sep}`)) { response.writeHead(403); response.end(); return; }
      const data = await readFile(path);
      response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }); response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Manila', colorScheme: 'dark', serviceWorkers: 'block' });
    const cloudRequests = [], pageErrors = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') {
        if (/firebase|firestore|googleapis|workers\.dev/.test(url.hostname)) cloudRequests.push(url.origin);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    // These are the public fictional offline-demo credentials, not live accounts.
    await page.getByPlaceholder('you@example.com').fill('admin@binanvet.com');
    await page.getByPlaceholder('Enter your password').fill('admin123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    const assertBlack = async locator => assert.equal(await locator.evaluate(element => getComputedStyle(element).color), 'rgb(0, 0, 0)');
    await assertBlack(page.getByRole('heading', { name: 'Appointments & reminders', exact: true }));
    await assertBlack(page.getByRole('button', { name: 'Refresh appointments', exact: true }));
    await page.getByRole('button', { name: 'Appointments & Reminders', exact: true }).click();
    await page.getByRole('heading', { name: 'Appointments & reminders', exact: true }).waitFor();
    assert.match(await page.locator('main').innerText(), /Asia\/Manila/);
    await page.getByRole('button', { name: 'New appointment', exact: true }).click();
    const form = page.getByRole('form', { name: 'Appointment details' });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await assertBlack(page.getByRole('button', { name: 'Apply dates', exact: true }));
      await assertBlack(page.getByRole('combobox', { name: 'Status', exact: true }));
      await assertBlack(form.getByRole('combobox', { name: 'Patient', exact: true }).locator('..'));
      await assertBlack(form.getByLabel('Scheduling notes', { exact: true }));
      await assertBlack(page.getByText(/^Showing \d+ of \d+ loaded appointments/));
    }
    await form.getByRole('combobox', { name: 'Patient', exact: true }).selectOption('PAT-00101');
    await form.getByRole('combobox', { name: 'Type', exact: true }).selectOption('Vaccination');
    const times = await page.evaluate(() => {
      const format = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      return { scheduled: format(new Date()), actual: format(new Date(Date.now() - 2 * 3600000)) };
    });
    await form.getByLabel('Scheduled date & time', { exact: true }).fill(times.scheduled);
    await form.getByLabel('Scheduling notes', { exact: true }).fill('Fictional end-of-day scheduling test');
    page.once('dialog', dialog => dialog.accept());
    await form.getByRole('button', { name: 'Review & save appointment' }).click();
    await form.waitFor({ state: 'hidden' });
    const card = page.locator('article').filter({ hasText: 'Dobby · Vaccination' });
    await card.waitFor();
    await assertBlack(card.getByRole('heading', { name: 'Dobby · Vaccination', exact: true }));
    await assertBlack(card.getByText(/^Recorded:/));
    assert.match(await card.innerText(), /scheduled/);
    assert.ok(await card.getByRole('link', { name: 'Draft email', exact: true }).getAttribute('href'));
    assert.equal(await card.getByRole('link', { name: 'Draft WhatsApp', exact: true }).count(), 0, 'must not guess +63 from a local phone number');
    const downloading = page.waitForEvent('download');
    await card.getByRole('button', { name: 'Download calendar' }).click();
    const calendar = await readFile(await (await downloading).path(), 'utf8');
    assert.match(calendar, /BEGIN:VEVENT/); assert.match(calendar, /SUMMARY:Vaccination: Dobby/);
    assert.ok(!calendar.includes('kiel@example.com'));
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.getByText('Due today: 1 loaded', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open appointments', exact: true }).click();
    await card.getByRole('button', { name: 'Open patient Dobby', exact: true }).click();
    await page.getByRole('heading', { name: 'Patient Clinical Dossier', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close Clinical Dossier', exact: true }).click();
    await page.getByRole('button', { name: 'Appointments & Reminders', exact: true }).click();
    await card.getByRole('button', { name: 'Edit appointment for Dobby', exact: true }).click();
    await form.getByRole('combobox', { name: 'Appointment status', exact: true }).selectOption('completed');
    await form.getByLabel('Actual visit date & time', { exact: true }).fill(times.actual);
    page.once('dialog', dialog => dialog.accept());
    await form.getByRole('button', { name: 'Review & save appointment' }).click();
    await form.waitFor({ state: 'hidden' });
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('all');
    await card.waitFor();
    assert.match(await card.innerText(), /Actual visit:/);
    assert.match(await card.innerText(), /completed/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, 'mobile appointment page must not overflow horizontally');
    await card.getByRole('button', { name: 'Edit appointment for Dobby', exact: true }).click();
    await form.getByRole('combobox', { name: 'Appointment status', exact: true }).selectOption('cancelled');
    page.once('dialog', dialog => dialog.accept());
    await form.getByRole('button', { name: 'Review & save appointment' }).click();
    await form.waitFor({ state: 'hidden' });
    assert.match(await card.innerText(), /cancelled/);
    assert.equal(cloudRequests.length, 0, 'offline demo must never contact Firebase/R2');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
