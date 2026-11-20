import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

export async function withStaticDemoBrowser(run, { timezoneId = 'America/Los_Angeles' } = {}) {
  const root = resolve('out');
  await readFile(resolve(root, 'index.html'));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
      if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, ...(timezoneId ? { timezoneId } : {}), serviceWorkers: 'block',
    });
    const unexpected = [], errors = [];
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (!(url.hostname === 'images.unsplash.com' && request.resourceType() === 'image')) unexpected.push(url.hostname);
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-11-19T17:00:00Z'));
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
    await run({ page, button, go });
    assert.equal(await page.locator('main').evaluate(main => [document.documentElement, main].every(el => el.scrollWidth <= el.clientWidth + 1)), true);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
