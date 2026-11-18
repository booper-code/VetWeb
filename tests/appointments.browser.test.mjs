import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

async function assertReadableText(locator, pseudo = null, minimum = 4.5) {
  const { label, ratio } = await locator.evaluate((element, pseudo) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const pixel = canvas.getContext('2d');
    const luminance = () => {
      const [r, g, b] = [...pixel.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const paint = color => {
      pixel.fillStyle = color;
      pixel.fillRect(0, 0, 1, 1);
    };
    const backgrounds = [];
    for (let node = element; node; node = node.parentElement) {
      backgrounds.unshift(getComputedStyle(node).backgroundColor);
    }
    paint('white'); // Composite the flat panel colors over the browser's white canvas.
    backgrounds.forEach(paint);
    const background = luminance();
    paint(getComputedStyle(element, pseudo).color);
    const text = luminance();
    return { label: element.getAttribute('aria-label') || element.tagName, ratio: (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05) };
  }, pseudo);
  assert.ok(ratio >= minimum, `${label} contrast is ${ratio.toFixed(2)}:1; expected at least ${minimum}:1`);
}

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
    const visitsHeading = page.getByRole('heading', { name: 'Visits needing attention', exact: true });
    const navigation = page.getByRole('navigation', { name: 'Everyday work' });
    const appointments = navigation.getByRole('button', { name: 'Appointments', exact: true });
    const refineSchedule = page.getByRole('button', { name: 'Refine schedule', exact: true });
    const colorSchemes = ['light', 'dark'];
    await visitsHeading.waitFor();
    const header = page.getByRole('banner');
    const search = header.getByRole('searchbox', { name: 'Search records' });
    const recordVisit = header.getByRole('button', { name: 'Record visit', exact: true });
    const toggleNavigation = header.getByRole('button', { name: 'Toggle navigation' });
    const clinicSetup = page.getByRole('button', { name: 'Clinic setup', exact: true });
    const centerY = locator => locator.evaluate(element => {
      const { top, height } = element.getBoundingClientRect();
      return top + height / 2;
    });
    assert.equal(await header.getByRole('group', { name: 'Workspace view' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /More tools/ }).count(), 0);
    assert.equal(await page.getByText('Presentation only', { exact: true }).count(), 0);
    assert.equal(await clinicSetup.isVisible(), true, 'clinic tools should be directly visible');
    assert.equal(await page.getByRole('button', { name: 'My account', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Team & invitations', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Clinical audit', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Laboratory & AI', exact: true }).count(), 0);
    assert.ok(Math.abs(await centerY(search) - await centerY(recordVisit)) <= 1, 'desktop header controls should share a center line');
    await page.getByText('Recent legacy consultations', { exact: true }).click();
    const legacyVisit = page.getByRole('listitem').filter({ hasText: 'SOAP-00010' });
    await legacyVisit.getByText('Draft', { exact: true }).waitFor();
    await legacyVisit.getByRole('button', { name: 'Change state', exact: true }).click();
    await legacyVisit.getByText('Completed', { exact: true }).waitFor();
    await legacyVisit.getByRole('button', { name: 'Change state', exact: true }).click();
    await legacyVisit.getByText('Draft', { exact: true }).waitFor();
    for (const colorScheme of colorSchemes) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, colorScheme);
      await assertReadableText(search, '::placeholder');
      await assertReadableText(visitsHeading);
      await assertReadableText(page.getByRole('button', { name: 'Refresh appointments', exact: true }));
    }
    await appointments.click();
    await page.getByRole('heading', { name: 'Appointments & reminders', exact: true }).waitFor();
    assert.match(await page.locator('main').innerText(), /Asia\/Manila/);
    const statusFilter = page.getByRole('combobox', { name: 'Status', exact: true });
    assert.equal(await statusFilter.count(), 0, 'appointment filters should open on demand');
    await refineSchedule.click();
    await statusFilter.waitFor();
    await page.getByRole('button', { name: 'Hide filters', exact: true }).click();
    await statusFilter.waitFor({ state: 'hidden' });
    await refineSchedule.click();
    await page.getByRole('button', { name: 'New appointment', exact: true }).click();
    const form = page.getByRole('form', { name: 'Appointment details' });
    for (const colorScheme of colorSchemes) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, colorScheme);
      await assertReadableText(page.getByRole('button', { name: 'Apply dates', exact: true }));
      await assertReadableText(page.getByRole('combobox', { name: 'Status', exact: true }));
      await assertReadableText(form.getByRole('combobox', { name: 'Patient', exact: true }).locator('..'));
      await assertReadableText(form.getByLabel('Scheduling notes', { exact: true }));
      await assertReadableText(page.getByText(/^Showing \d+ of \d+ loaded appointments/));
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
    await assertReadableText(card.getByRole('heading', { name: 'Dobby · Vaccination', exact: true }));
    await assertReadableText(card.getByText(/^Recorded:/));
    assert.match(await card.innerText(), /scheduled/);
    assert.ok(await card.getByRole('link', { name: 'Draft email', exact: true }).getAttribute('href'));
    assert.equal(await card.getByRole('link', { name: 'Draft WhatsApp', exact: true }).count(), 0, 'must not guess +63 from a local phone number');
    const downloading = page.waitForEvent('download');
    await card.getByRole('button', { name: 'Download calendar' }).click();
    const calendar = await readFile(await (await downloading).path(), 'utf8');
    assert.match(calendar, /BEGIN:VEVENT/); assert.match(calendar, /SUMMARY:Vaccination: Dobby/);
    assert.ok(!calendar.includes('kiel@example.com'));
    await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
    await visitsHeading.waitFor();
    await page.getByText('1 due or overdue in the loaded schedule', { exact: true }).waitFor();
    await page.getByText('Dobby · Vaccination', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'All appointments', exact: true }).click();
    await card.getByRole('button', { name: 'Open patient Dobby', exact: true }).click();
    await page.getByRole('heading', { name: 'Patient Clinical Dossier', exact: true }).waitFor();
    await assertReadableText(page.getByRole('button', { name: 'Close dossier', exact: true }), null, 3);
    await page.emulateMedia({ media: 'print' });
    const printedCanvas = await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor);
    assert.equal(printedCanvas, 'rgb(246, 248, 251)', 'printing a dossier should not use the dark canvas');
    await page.emulateMedia({ media: 'screen' });
    await page.getByRole('button', { name: 'Close Clinical Dossier', exact: true }).click();
    await appointments.click();
    await refineSchedule.click();
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
    assert.equal(await page.locator('main').evaluate(main => [document.documentElement, main]
      .every(element => element.scrollWidth <= element.clientWidth + 1)), true, 'mobile appointment page must not overflow horizontally');
    await card.getByRole('button', { name: 'Edit appointment for Dobby', exact: true }).click();
    await form.getByRole('combobox', { name: 'Appointment status', exact: true }).selectOption('cancelled');
    page.once('dialog', dialog => dialog.accept());
    await form.getByRole('button', { name: 'Review & save appointment' }).click();
    await form.waitFor({ state: 'hidden' });
    assert.match(await card.innerText(), /cancelled/);
    const [searchBox, visitBox] = await Promise.all([search.boundingBox(), recordVisit.boundingBox()]);
    assert.ok(Math.abs(await centerY(search) - await centerY(recordVisit)) <= 1, 'mobile search and visit controls should share a center line');
    assert.ok(searchBox.x + searchBox.width <= visitBox.x && visitBox.x + visitBox.width <= 390, 'mobile header controls must not overlap or clip');
    await toggleNavigation.focus();
    await page.keyboard.press('Tab');
    assert.equal(await header.getByRole('combobox', { name: 'Appearance' }).evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Tab');
    assert.equal(await search.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Tab');
    assert.equal(await recordVisit.evaluate(element => document.activeElement === element), true);
    await toggleNavigation.click();
    await clinicSetup.click();
    await page.getByRole('heading', { name: 'Clinic Settings & Import Portal', exact: true }).waitFor();
    assert.equal(cloudRequests.length, 0, 'offline demo must never contact Firebase/R2');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
