import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { buildThemeWorkspaceFixture } from './fixtures/theme-workspace.mjs';

const STORAGE_KEY = 'vetcloud.appearance.v1';
const canvasByTheme = { dark: 'rgb(17, 24, 39)', light: 'rgb(246, 248, 251)' };

async function assertDarkSurface(locator) {
  const { background, contrast } = await locator.evaluate(element => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const paint = color => { context.fillStyle = color; context.fillRect(0, 0, 1, 1); };
    const luminance = () => {
      const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ancestors = [];
    for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
    paint('white');
    ancestors.forEach(node => paint(getComputedStyle(node).backgroundColor));
    const background = luminance();
    paint(getComputedStyle(element).color);
    const text = luminance();
    return { background, contrast: (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05) };
  });
  assert.ok(background < 0.18, `${locator} has a bright dark-mode surface (luminance ${background.toFixed(2)})`);
  assert.ok(contrast >= 4.5, `${locator} dark-mode contrast is ${contrast.toFixed(2)}:1`);
}

test('the static export applies the saved or system theme before hydration', { timeout: 60000 }, async t => {
  const root = resolve('out');
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  const styles = html.match(/<link\b(?=[^>]*\brel="stylesheet")[^>]*>/g) ?? [];
  const initializer = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [])
    .find(script => !script.includes(' src=') && script.includes(STORAGE_KEY));
  let fixtureScript = '';
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/theme-fixture') {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(
          `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">${initializer ?? ''}${styles.join('')}</head><body><div id="theme-fixture"></div><script src="/theme-fixture.js"></script></body></html>`,
        );
        return;
      }
      if (url.pathname === '/theme-fixture.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(fixtureScript);
        return;
      }
      const path = resolve(root, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
      if (!path.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
      const data = await readFile(path);
      response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
    for (const [name, system, saved, expected] of [
      ['saved Dark wins over light OS', 'light', 'dark', 'dark'],
      ['saved Light wins over dark OS', 'dark', 'light', 'light'],
      ['first visits follow the OS', 'dark', null, 'dark'],
      ['unknown saved values are ignored', 'dark', 'unknown', 'dark'],
      ['blocked storage still follows OS', 'dark', 'blocked', 'dark'],
    ]) {
      await t.test(name, async () => {
        const context = await browser.newContext({ colorScheme: system, serviceWorkers: 'block' });
        let resume;
        const hydration = new Promise(resolve => { resume = resolve; });
        try {
          await context.addInitScript(({ key, value }) => {
            if (value === 'blocked') {
              Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
            } else if (value) {
              localStorage.setItem(key, value);
            }
          }, { key: STORAGE_KEY, value: saved });
          await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            if (url.pathname.startsWith('/_next/static/') && url.pathname.endsWith('.js')) await hydration;
            return route.continue();
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(origin, { waitUntil: 'commit' });
          await page.getByRole('heading', { name: 'Secure Staff Login', exact: true }).waitFor();
          const state = () => page.locator('html').evaluate(element => ({
            theme: element.dataset.theme,
            scheme: getComputedStyle(element).colorScheme,
            canvas: getComputedStyle(element).backgroundColor,
          }));
          const expectedState = { theme: expected, scheme: expected, canvas: canvasByTheme[expected] };
          assert.deepEqual(await state(), expectedState);
          if (expected === 'dark') await assertDarkSurface(page.getByRole('heading', { name: 'Secure Staff Login' }));
          resume();
          await page.waitForLoadState('load');
          await page.getByRole('button', { name: 'Create an account', exact: true }).click();
          await page.getByRole('heading', { name: 'Create your account', exact: true }).waitFor();
          assert.deepEqual(await state(), expectedState, 'hydration should not reset the appearance');
          assert.deepEqual(errors, []);
        } finally {
          resume();
          await context.close();
        }
      });
    }
    await t.test('switching theme survives reload, demo sign-in and sign-out', async () => {
      const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 320, height: 720 }, serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const select = page.getByRole('combobox', { name: 'Appearance' });
        const waitForTheme = expected => page.waitForFunction(theme => document.documentElement.dataset.theme === theme, expected);
        await page.goto(origin);
        await waitForTheme('light');
        await select.selectOption('dark');
        await waitForTheme('dark');
        await page.reload();
        await waitForTheme('dark');
        assert.equal(await select.inputValue(), 'dark');
        await assertDarkSurface(page.getByRole('heading', { name: 'Secure Staff Login' }));
        await assertDarkSurface(page.getByPlaceholder('you@example.com'));
        await page.getByPlaceholder('you@example.com').fill('admin@binanvet.com');
        await page.getByPlaceholder('Enter your password').fill('admin123');
        await page.getByRole('button', { name: 'Sign In', exact: true }).click();
        await page.getByRole('heading', { name: 'Visits needing attention' }).waitFor();
        assert.equal(await select.inputValue(), 'dark');
        await assertDarkSurface(page.getByRole('heading', { name: 'Visits needing attention' }));
        for (const width of [320, 390, 767, 768, 1280]) {
          await page.setViewportSize({ width, height: 720 });
          const controlsFit = await page.getByRole('banner').evaluate(header => {
            const controls = [...header.querySelectorAll('button, select, input')].filter(node => node.getClientRects().length);
            const bounds = controls.map(node => node.getBoundingClientRect());
            return bounds.every(({ left, right, width }) => left >= 0 && right <= document.documentElement.clientWidth && width > 0) &&
              bounds.every((a, i) => bounds.slice(i + 1).every(b =>
                a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
          });
          assert.ok(controlsFit, `header controls should fit without overlapping at ${width}px`);
        }
        await page.setViewportSize({ width: 320, height: 720 });
        for (const [tab, heading] of [
          ['Appointments', 'Appointments & reminders'],
          ['Patients', 'Admission & Patient Records'],
          ['Inventory', 'Inventory & Service Control'],
          ['Staff & Payroll', 'Staff & Payroll'],
          ['Clinic setup', 'Clinic Settings & Import Portal'],
          ['My account', 'Account Settings'],
        ]) {
          await page.getByRole('button', { name: 'Toggle navigation' }).click();
          await page.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name: tab, exact: true }).click();
          await assertDarkSurface(page.getByRole('heading', { name: heading, exact: true }));
          if (tab === 'Appointments') {
            await page.getByRole('button', { name: 'New appointment' }).click();
            const form = page.getByRole('form', { name: 'Appointment details' });
            await assertDarkSurface(form.getByLabel('Scheduled date & time'));
            await form.getByRole('button', { name: 'Discard form' }).click();
          }
          if (tab === 'Patients') await assertDarkSurface(page.getByPlaceholder('e.g. Buster'));
          if (tab === 'Inventory') await assertDarkSurface(page.getByRole('heading', { name: 'Unified Catalog List' }));
          if (tab === 'Staff & Payroll') await assertDarkSurface(page.getByRole('heading', { name: 'Clinic roster' }));
          if (tab === 'Clinic setup') await assertDarkSurface(page.getByRole('heading', { name: 'Offline device privacy' }));
        }
        await select.selectOption('system');
        await waitForTheme('light');
        await page.emulateMedia({ colorScheme: 'dark' });
        await waitForTheme('dark');
        await select.selectOption('light');
        await waitForTheme('light');
        await page.emulateMedia({ colorScheme: 'light' });
        await page.emulateMedia({ colorScheme: 'dark' });
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
        await page.getByRole('button', { name: 'Toggle navigation' }).click();
        await page.getByRole('button', { name: 'Logout', exact: true }).click();
        await page.getByRole('heading', { name: 'Secure Staff Login' }).waitFor();
        assert.equal(await select.inputValue(), 'light');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test('clinic selection and gated components use the real themed styles with local adapters', async () => {
      assert.ok(initializer && styles.length, 'the fixture requires the built shell initializer and stylesheet');
      fixtureScript = await buildThemeWorkspaceFixture();
      const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const select = page.getByRole('combobox', { name: 'Appearance' });
        await page.goto(`${origin}/theme-fixture?load-error`);
        await assertDarkSurface(page.getByRole('alert'));
        await page.goto(`${origin}/theme-fixture?loading&long-email`);
        await assertDarkSurface(page.getByText('Loading clinics…'));
        await page.evaluate(() => window.releaseFixtureLoad());
        await assertDarkSurface(page.getByRole('heading', { name: 'Verify your email to open and accept this invitation' }));
        await assertDarkSurface(page.getByPlaceholder('Clinic name'));
        await select.selectOption('light');
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
        await select.selectOption('dark');
        await page.getByRole('button', { name: /Owner clinic/ }).click();
        await assertDarkSurface(page.getByRole('heading', { name: 'Team & Invitations', exact: true }));
        assert.equal(await select.inputValue(), 'dark');
        const navigation = page.getByRole('complementary', { name: 'Main navigation' });
        await navigation.getByRole('button', { name: 'Clinical audit', exact: true }).click();
        await assertDarkSurface(page.getByRole('cell', { name: 'patients/fixture-patient' }));
        await navigation.getByRole('button', { name: 'Clinic setup', exact: true }).click();
        await assertDarkSurface(page.getByRole('heading', { name: 'Image storage safeguards' }));
        await navigation.getByRole('button', { name: 'Laboratory & AI', exact: true }).click();
        const labExample = page.getByRole('button', { name: 'Show fictional example' });
        await assertDarkSurface(labExample);
        await labExample.click();
        await assertDarkSurface(page.getByText(/Example report status: no results available/));
        await navigation.getByRole('button', { name: /Current clinic/ }).click();
        await page.setViewportSize({ width: 320, height: 720 });
        await assertDarkSurface(page.getByRole('heading', { name: 'Your clinic workspace' }));
        const layout = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
        assert.ok(layout, 'clinic chooser should fit a narrow mobile viewport');
        const cardBounds = await page.getByRole('heading', { name: 'Your clinic workspace' }).locator('../..').boundingBox();
        for (const control of [select, page.getByRole('button', { name: 'Sign out' })]) {
          const box = await control.boundingBox();
          assert.ok(box && box.x >= cardBounds.x && box.x + box.width <= cardBounds.x + cardBounds.width,
            `${control} must not be clipped by the clinic card`);
        }
        await page.getByRole('button', { name: /Viewer clinic/ }).click();
        await assertDarkSurface(page.getByRole('status').filter({ hasText: 'Viewer workspace' }));
        assert.equal(await navigation.getByRole('button', { name: 'Clinical audit', exact: true }).count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
