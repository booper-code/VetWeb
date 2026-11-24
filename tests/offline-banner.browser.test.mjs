import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import OfflineStatus from '@/components/OfflineStatus';
      const staticShell = new URLSearchParams(location.search).has('shell');
      createRoot(document.getElementById('root')).render(
        <>
          <OfflineStatus staticShell={staticShell} />
          <main id="workspace" style={{ minHeight: '2400px' }}>Clinic workspace</main>
        </>,
      );
    `,
    loader: 'tsx',
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const stylesheet = await postcss([tailwind()]).process(
  await readFile(resolve('app/globals.css'), 'utf8'),
  { from: resolve('app/globals.css') },
);

const offlineBanner = page => page.getByRole('status').filter({ hasText: 'No internet connection' });
const settle = banner => banner.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));

async function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/fixture.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(outputFiles[0].text);
    } else if (url.pathname === '/fixture.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' }).end(stylesheet.css);
    } else if (url.pathname === '/permission-denied') {
      response.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":{"status":"PERMISSION_DENIED"}}');
    } else if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div>'
        + '<script type="module" src="/fixture.js"></script></body></html>',
      );
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('offline banner enters from the top and clears when the connection returns', { timeout: 60000 }, async t => {
  const { server, origin } = await startFixture();
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'],
  });

  const open = async ({ reducedMotion = 'no-preference', shell = false, startingOffline = false } = {}) => {
    const context = await browser.newContext({ reducedMotion, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__forcedScrolls = 0;
      const scrollTo = window.scrollTo.bind(window);
      window.scrollTo = (...args) => { window.__forcedScrolls += 1; return scrollTo(...args); };
      const scrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        window.__forcedScrolls += 1;
        return scrollIntoView.apply(this, args);
      };
    });
    if (startingOffline) {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      });
    }
    if (shell) {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          value: { register: () => Promise.reject(new Error('registration blocked')) },
        });
      });
    }
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      return route.abort();
    });
    await page.goto(`${origin}/${shell ? '?shell' : ''}`);
    await page.getByText('Clinic workspace').waitFor();
    return { context, page, errors };
  };

  try {
    await t.test('mounts offline with the exact heading and a read-only explanation', async () => {
      const { context, page, errors } = await open({ startingOffline: true });
      try {
        const banner = offlineBanner(page);
        await banner.waitFor();
        const text = await banner.innerText();
        assert.match(text, /No internet connection/);
        assert.match(text, /read-only/i);
        assert.match(text, /Clinic changes require a connection/i);
        assert.equal(await banner.evaluate(element => getComputedStyle(element).position), 'sticky');
        assert.equal(await banner.evaluate(element => getComputedStyle(element).top), '0px');
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test('enters downward, sticks to the top, and clears on reconnect', async () => {
      const { context, page, errors } = await open();
      try {
        const banner = offlineBanner(page);
        assert.equal(await banner.count(), 0);
        await context.setOffline(true);
        await banner.waitFor();
        const entrance = await banner.evaluate(element => {
          const style = getComputedStyle(element);
          return { name: style.animationName, duration: style.animationDuration, background: style.backgroundColor };
        });
        assert.match(entrance.name, /offline/i);
        assert.notEqual(entrance.duration, '0s');
        assert.notEqual(entrance.background, 'rgba(0, 0, 0, 0)');
        await page.evaluate(() => window.scrollTo(0, 500));
        await settle(banner);
        assert.equal(await banner.evaluate(element => Math.round(element.getBoundingClientRect().top)), 0);
        await context.setOffline(false);
        await banner.waitFor({ state: 'detached' });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test('stays top-anchored on an already loaded page without forcing a scroll', async () => {
      const { context, page, errors } = await open();
      try {
        const banner = offlineBanner(page);
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.waitForFunction(() => window.scrollY > 0);
        await page.evaluate(() => { window.__forcedScrolls = 0; });
        await context.setOffline(true);
        await banner.waitFor();
        await settle(banner);
        assert.equal(await banner.evaluate(element => Math.round(element.getBoundingClientRect().top)), 0);
        assert.ok(await page.evaluate(() => window.scrollY) > 0);
        assert.equal(await page.evaluate(() => window.__forcedScrolls), 0);
        await context.setOffline(false);
        await banner.waitFor({ state: 'detached' });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test('disables the entrance animation under reduced motion', async () => {
      const { context, page, errors } = await open({ reducedMotion: 'reduce' });
      try {
        const banner = offlineBanner(page);
        await context.setOffline(true);
        await banner.waitFor();
        const animation = await banner.evaluate(element => {
          const style = getComputedStyle(element);
          return { name: style.animationName, duration: style.animationDuration };
        });
        assert.equal(animation.name, 'none');
        assert.equal(animation.duration, '0s');
        await context.setOffline(false);
        await banner.waitFor({ state: 'detached' });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test('a permission failure while online does not expose the banner', async () => {
      const { context, page, errors } = await open();
      try {
        const status = await page.evaluate(async () => (await fetch('/permission-denied')).status);
        assert.equal(status, 403);
        assert.equal(await offlineBanner(page).count(), 0);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test('keeps service-worker notices visible independently of the connection', async () => {
      const { context, page, errors } = await open({ shell: true });
      try {
        const notice = page.getByRole('status').filter({ hasText: 'Offline app shell is unavailable' });
        await notice.waitFor();
        await context.setOffline(true);
        await offlineBanner(page).waitFor();
        assert.equal(await notice.isVisible(), true);
        await context.setOffline(false);
        await offlineBanner(page).waitFor({ state: 'detached' });
        assert.equal(await notice.isVisible(), true);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
    await new Promise(done => server.close(done));
  }
});
