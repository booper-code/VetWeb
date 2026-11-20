import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

test('exported demo records follow-up contact without completing or sending a visit', { timeout: 120000 }, async () => {
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
    const unexpected = [], errors = [];
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (!(url.hostname === 'images.unsplash.com' && request.resourceType() === 'image')) unexpected.push(url.hostname);
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-11-19T17:00:00Z')); // Manila Nov 20, Los Angeles Nov 19.
    await page.goto(origin);
    await page.getByPlaceholder('you@example.com').fill('admin@binanvet.com');
    await page.getByPlaceholder('Enter your password').fill('admin123');
    const button = (scope, name) => scope.getByRole('button', { name, exact: true });
    await button(page, 'Sign In').click();
    const nav = page.getByRole('navigation', { name: 'Everyday work' });
    async function go(label) {
      const toggle = button(page, 'Toggle navigation');
      if (await toggle.isVisible()) await toggle.click();
      await button(nav, label).click();
    }
    await button(page, 'Follow-up queue').waitFor();
    await go('Appointments');
    for (const [id, status] of [['PAT-00101', 'scheduled'], ['PAT-00102', 'no-show']]) {
      await button(page, 'New appointment').click();
      const form = page.getByRole('form', { name: 'Appointment details' });
      await form.getByRole('combobox', { name: 'Patient', exact: true }).selectOption(id);
      await form.getByRole('combobox', { name: 'Type', exact: true }).selectOption('Follow-up');
      await form.getByLabel('Scheduled date & time').fill('2026-11-19T06:00');
      await form.getByRole('combobox', { name: 'Appointment status' }).selectOption(status);
      page.once('dialog', dialog => dialog.accept());
      await button(form, 'Review & save appointment').click();
      await form.waitFor({ state: 'hidden' });
    }
    await go('Overview');
    await button(page, 'Follow-up queue').click();
    await page.getByRole('heading', { name: 'Follow-up queue', exact: true }).waitFor();
    await page.getByText('As of 2026-11-20 Manila', { exact: false }).waitFor();
    const row = page.getByRole('listitem').filter({ hasText: 'Dobby' });
    await row.getByText('Overdue', { exact: true }).waitFor();
    assert.equal(await page.getByRole('listitem').filter({ hasText: 'Max' }).count(), 0);
    await button(row, 'Mark contacted').click();
    await row.getByText(/Contact recorded/).waitFor();
    await go('Appointments');
    const appointment = page.getByRole('article').filter({ hasText: 'Dobby · Follow-up' });
    await appointment.getByText(/\bscheduled\b/).waitFor();
    await go('Overview');
    await button(page, 'Follow-up queue').click();
    await row.getByText(/Contact recorded/).waitFor();
    await button(row, 'Undo contact').click();
    await row.getByText('Needs contact', { exact: true }).waitFor();
    assert.equal(await page.locator('main').evaluate(main => [document.documentElement, main].every(el => el.scrollWidth <= el.clientWidth + 1)), true);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
