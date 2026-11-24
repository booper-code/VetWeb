import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { withStaticDemoBrowser } from './helpers/static-demo-browser.mjs';

const exportRoot = resolve('out');
const buildHint = 'Run "npm run test:offline:banner" (it builds the static export first), or "npm run build:staging" before running this test file directly.';
const readExport = async (path, label) => {
  try {
    return await readFile(resolve(exportRoot, path), 'utf8');
  } catch (error) {
    throw new Error(`Static export ${label} is missing at ${resolve(exportRoot, path)}. ${buildHint}`, { cause: error });
  }
};

const exportedHtml = await readExport('index.html', 'HTML');
const exportedCss = exportedHtml.match(/<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+\.css)"/)?.[1];
if (!exportedCss) throw new Error(`Static export at ${exportRoot} has no linked stylesheet. ${buildHint}`);
const stylesheet = await readExport(`.${exportedCss}`, 'stylesheet');

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

const offlineBanner = page => page.getByRole('status').filter({ hasText: 'No internet connection' });
const liveRegion = page => page.locator('[role="status"][aria-live="polite"]');
const settle = banner => banner.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));

async function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/fixture.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(outputFiles[0].text);
    } else if (url.pathname === '/fixture.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' }).end(stylesheet);
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
    await t.test('mounts offline with a real heading, read-only explanation, and stale-cache caveat', async () => {
      const { context, page, errors } = await open({ startingOffline: true });
      try {
        const banner = offlineBanner(page);
        await banner.waitFor();
        const heading = banner.getByRole('heading', { name: 'No internet connection', exact: true });
        await heading.waitFor();
        const text = await banner.innerText();
        assert.match(text, /read-only/i);
        assert.match(text, /stale/i);
        assert.match(text, /Clinic changes require a connection/i);
        assert.equal(await banner.evaluate(element => getComputedStyle(element).position), 'sticky');
        assert.equal(await banner.evaluate(element => getComputedStyle(element).top), '0px');
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test('keeps an initially empty live region mounted until the connection drops', async () => {
      const { context, page, errors } = await open();
      try {
        const live = liveRegion(page);
        await live.waitFor({ state: 'attached' });
        assert.equal((await live.innerText()).trim(), '');
        await context.setOffline(true);
        const banner = offlineBanner(page);
        await banner.waitFor();
        await banner.getByRole('heading', { name: 'No internet connection', exact: true }).waitFor();
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
        assert.equal((await live.innerText()).trim(), '');
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

test('offline banner fits the real app shell without adding document overflow', { timeout: 90000 }, async () => {
  await withStaticDemoBrowser(async ({ page, go }) => {
    await go('Inventory');
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.context().setOffline(true);
      const banner = offlineBanner(page);
      await banner.waitFor();
      await settle(banner);
      const staging = page.getByRole('note').filter({ hasText: 'TEST STAGING' });
      await staging.waitFor();
      const layout = await page.evaluate(() => {
        const root = document.documentElement;
        const header = document.querySelector('header');
        const main = document.querySelector('main');
        const bannerElement = [...document.querySelectorAll('[role="status"]')]
          .find(element => element.textContent.includes('No internet connection'));
        const stagingElement = [...document.querySelectorAll('[role="note"]')]
          .find(element => element.textContent.includes('TEST STAGING'));
        const box = element => element.getBoundingClientRect().toJSON();
        return {
          innerHeight, innerWidth,
          scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
          scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,
          banner: box(bannerElement), staging: box(stagingElement), header: box(header),
          mainClientHeight: main.clientHeight, mainScrollHeight: main.scrollHeight, mainScrollTop: main.scrollTop,
          pageScrollY: window.scrollY,
        };
      });
      assert.ok(layout.banner.top >= 0 && layout.banner.bottom <= layout.innerHeight + 1, `banner outside ${width}px viewport`);
      assert.ok(layout.staging.top >= layout.banner.bottom - 1, `staging notice covered by banner at ${width}px`);
      assert.ok(layout.staging.bottom <= layout.innerHeight + 1, `staging notice outside ${width}px viewport`);
      assert.ok(layout.header.top >= layout.staging.bottom - 1, `header covered by banner or notice at ${width}px`);
      assert.ok(layout.header.bottom <= layout.innerHeight + 1, `header outside ${width}px viewport`);
      assert.ok(layout.scrollHeight <= layout.clientHeight + 1, `document overflow at ${width}px: ${layout.scrollHeight} > ${layout.clientHeight}`);
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `horizontal document overflow at ${width}px`);
      assert.equal(layout.pageScrollY, 0);

      await page.evaluate(() => { document.querySelector('main').scrollTop = 120; });
      const before = await page.evaluate(() => document.querySelector('main').scrollTop);
      assert.ok(before > 0, `main did not scroll at ${width}px`);
      await page.context().setOffline(false);
      await banner.waitFor({ state: 'detached' });
      await page.context().setOffline(true);
      await banner.waitFor();
      const after = await page.evaluate(() => document.querySelector('main').scrollTop);
      assert.equal(after, before, `internal main scroll changed at ${width}px`);
      await page.context().setOffline(false);
      await banner.waitFor({ state: 'detached' });
    }
  });
});

test('the offline banner stays accessible above an open mobile inventory drawer', { timeout: 90000 }, async () => {
  await withStaticDemoBrowser(async ({ page, go }) => {
    await go('Inventory');
    await page.locator('tbody tr').first().click();
    const drawer = page.getByRole('dialog', { name: 'Inventory item details' });
    await drawer.waitFor();
    const geometry = () => page.evaluate(() => {
      const banner = [...document.querySelectorAll('[role="status"]')]
        .find(element => element.textContent.includes('No internet connection'));
      const dialog = document.querySelector('[role="dialog"][aria-label="Inventory item details"]');
      const overlay = dialog?.parentElement;
      const close = dialog?.querySelector('button[aria-label="Close inventory item"]');
      const box = element => element?.getBoundingClientRect().toJSON() ?? null;
      const topmost = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(hit && (element === hit || element.contains(hit)));
      };
      return {
        innerHeight, innerWidth,
        banner: box(banner), overlay: box(overlay), close: box(close),
        bannerTopmost: topmost(banner), closeTopmost: topmost(close),
      };
    });

    await page.context().setOffline(true);
    const banner = offlineBanner(page);
    await banner.waitFor();
    await settle(banner);
    const offline = await geometry();
    assert.ok(offline.banner && offline.banner.top >= 0 && offline.banner.bottom <= offline.innerHeight + 1,
      'banner outside the mobile viewport');
    assert.ok(offline.overlay.top >= offline.banner.bottom - 1, 'the drawer covers the offline banner');
    assert.equal(offline.bannerTopmost, true, 'the banner is occluded by the drawer');
    assert.equal(offline.closeTopmost, true, 'the drawer close control is occluded');
    assert.ok(offline.close.bottom <= offline.innerHeight + 1, 'drawer controls are pushed off screen');

    await page.context().setOffline(false);
    await banner.waitFor({ state: 'detached' });
    const online = await geometry();
    assert.equal(online.overlay.top, 0, 'the drawer did not return to full height on reconnect');
    await page.getByRole('button', { name: 'Close inventory item' }).click();
    await drawer.waitFor({ state: 'detached' });
  });
});
