import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

test('standalone Claude design HTML works from file with no external requests or persistence', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const requests = [], errors = [];
    await context.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(resolve('docs/prototypes/vetcloudpro-ui-demo.html')).href);
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    const nav = page.locator('#navigation');
    for (const [label, heading] of [
      ['Admission & Medical', 'Admission & Medical'], ['Inventory Control', 'Inventory Control'],
      ['Clinic Setup', 'Clinic Settings & Import Portal'], ['Account Settings', 'Account Settings'],
      ['Staff & Payroll', 'Staff & Payroll'], ['Team & Invitations', 'Team & Invitations'],
      ['Clinical Audit', 'Clinical audit trail'],
    ]) {
      await nav.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    }
    await nav.getByRole('button', { name: 'Clinic Setup', exact: true }).click();
    await page.locator('#ai-toggle').check();
    await nav.getByRole('button', { name: 'Laboratory & AI', exact: true }).click();
    await page.getByRole('heading', { name: 'Laboratory & AI', exact: true }).waitFor();
    assert.match(await page.locator('main').innerText(), /DEMO OUTPUT ONLY/);
    await nav.getByRole('button', { name: 'Appointments & Reminders', exact: true }).click();
    await page.getByRole('button', { name: 'New appointment', exact: true }).click();
    const form = page.locator('#appointment-form');
    await form.getByRole('combobox', { name: 'Type', exact: true }).selectOption('Deworming');
    await form.getByLabel('Scheduling notes', { exact: true }).fill('Disposable prototype test note');
    await form.getByRole('button', { name: 'Apply to mockup only' }).click();
    await page.locator('#dialog').waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: 'Mochi · Deworming', exact: true }).waitFor();
    await page.getByRole('searchbox', { name: 'Search this demo screen' }).fill('Biscuit');
    assert.equal(await page.locator('article').count(), 1);
    await page.getByRole('searchbox', { name: 'Search this demo screen' }).fill('');
    await page.getByRole('combobox', { name: 'Preview role' }).selectOption('viewer');
    assert.equal(await page.getByRole('button', { name: 'New appointment', exact: true }).isDisabled(), true);
    assert.equal(await nav.getByRole('button', { name: 'Team & Invitations', exact: true }).count(), 0);
    await page.getByRole('combobox', { name: 'Preview role' }).selectOption('editor');
    assert.equal(await nav.getByRole('button', { name: 'Team & Invitations', exact: true }).count(), 0);
    await nav.getByRole('button', { name: 'Clinic Setup', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Preview upload pause', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('#ai-toggle').isDisabled(), true);
    await page.getByRole('combobox', { name: 'Preview role' }).selectOption('owner');
    assert.equal(await page.getByRole('button', { name: 'Preview upload pause', exact: true }).isDisabled(), false);
    assert.equal(await page.locator('#ai-toggle').isDisabled(), false);
    await nav.getByRole('button', { name: 'Admission & Medical', exact: true }).click();
    await page.getByRole('button', { name: 'View dossier', exact: true }).first().click();
    await page.getByRole('heading', { name: 'Patient Clinical Dossier', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Billing', exact: true }).click();
    assert.match(await page.locator('#dialog-content').innerText(), /not a complete payment ledger/);
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
    await nav.getByRole('button', { name: 'Appointments & Reminders', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    assert.equal(await page.getByRole('heading', { name: 'Appointments & reminders', exact: true }).evaluate(element => getComputedStyle(element).color), 'rgb(0, 0, 0)');
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    await page.reload();
    await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
    await nav.getByRole('button', { name: 'Appointments & Reminders', exact: true }).click();
    assert.equal(await page.getByText('Disposable prototype test note').count(), 0);
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
