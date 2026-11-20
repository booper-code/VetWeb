import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const { outputFiles } = await build({
  stdin: { contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { SystemSettingsView } from '@/components/SystemSettingsView';
    const demo = new URLSearchParams(location.search).has('demo');
    function Fixture() {
      const [enabled, setEnabled] = useState(!demo);
      const [workspace, setWorkspace] = useState(0);
      return <>
        <button type="button" onClick={() => setWorkspace(value => value + 1)}>Switch fixture clinic</button>
        <SystemSettingsView key={workspace} inventory={[]} onAddInventoryItem={async () => {}}
          aiEnabled={enabled} canManageAI isDemo={demo} onSetAIEnabled={async value => setEnabled(value)} triggerToast={() => {}} />
      </>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const storageKey = 'vetcloudpro.ai';
const openaiModels = 'https://api.openai.com/v1/models';
const fakeKey = 'fictional-openai-key';
const button = (page, name) => page.getByRole('button', { name, exact: true });
const field = (page, name) => page.getByLabel(name, { exact: true });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const reply = (route, data, status = 200) => route.fulfill({
  status, json: data, headers: { 'access-control-allow-origin': '*' },
});

async function withSettings({ demo = false, respond }, exercise) {
  const server = createServer((request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(outputFiles[0].text);
    } else if (request.url === '/' || request.url === '/?demo') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
        .end('<!doctype html><html lang="en"><title>Settings fixture</title><div id="root"></div><script src="/fixture.js"></script></html>');
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const requests = [], errors = [], unexpected = [];
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request();
      if (new URL(request.url()).origin === origin) return route.continue();
      requests.push({ url: request.url(), method: request.method(), body: request.postData(), headers: request.headers() });
      if (!respond || !await respond(route, request)) {
        unexpected.push(request.url());
        await route.abort();
      }
    });
    await page.goto(`${origin}/${demo ? '?demo' : ''}`);
    assert.deepEqual(errors, []);
    await exercise(page, requests);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function prepareOpenAI(page) {
  await field(page, 'Provider').selectOption('openai');
  await field(page, 'API Key').fill(fakeKey);
}

test('a key loads a searchable model list before a model ID is entered; only explicit save persists it', { timeout: 30000 }, async () => {
  await withSettings({
    respond: async (route, request) => {
      if (request.url() !== openaiModels) return false;
      await reply(route, { data: [{ id: 'fixture-alpha', name: 'Bright Sparrow' }, { id: 'fixture-beta', name: 'Quiet Finch' }] });
      return true;
    },
  }, async (page, requests) => {
    await field(page, 'Provider').selectOption('openai');
    assert.equal(await button(page, 'Validate & load models').isDisabled(), true);
    await field(page, 'Model ID').fill('');
    await field(page, 'API Key').fill(fakeKey);
    await button(page, 'Validate & load models').click();
    await page.getByText(/API key accepted for model discovery/).waitFor();
    const search = field(page, 'Search models');
    const picker = field(page, 'Discovered model');
    await search.fill('sparrow');
    assert.deepEqual(await picker.getByRole('option').allTextContents(), ['Choose a model', 'Bright Sparrow — fixture-alpha']);
    await search.fill('fixture-beta');
    await picker.selectOption('fixture-beta');
    assert.equal(await field(page, 'Model ID').inputValue(), 'fixture-beta');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null);
    await button(page, 'Save AI Settings').click();
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.deepEqual(saved, { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'fixture-beta', apiKey: fakeKey });
    assert.deepEqual(requests.map(request => [request.url, request.method, request.body, request.headers.authorization]), [
      [openaiModels, 'GET', null, `Bearer ${fakeKey}`],
    ]);
    await button(page, 'Clear saved AI settings').click();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null);
    assert.equal(await field(page, 'Discovered model').count(), 0);
  });
});

test('editing the key cancels old discovery and changing endpoints, clinics or the AI switch clears results', { timeout: 30000 }, async () => {
  const incoming = deferred();
  const release = deferred();
  const settled = deferred();
  await withSettings({
    respond: async (route, request) => {
      if (request.url() !== openaiModels) return false;
      const auth = request.headers().authorization;
      if (auth === `Bearer ${fakeKey}`) {
        incoming.resolve();
        await release.promise;
        try { await reply(route, { data: [{ id: 'old-key-model' }] }); }
        catch (error) {
          if (!/already handled|invalid interception|closed/i.test(error.message)) throw error;
        } finally { settled.resolve(); }
      } else {
        await reply(route, { data: [{ id: 'new-key-model' }] });
      }
      return true;
    },
  }, async page => {
    try {
      await prepareOpenAI(page);
      await button(page, 'Validate & load models').click();
      await incoming.promise;
      await field(page, 'API Key').fill('another-fictional-key');
      assert.equal(await field(page, 'Discovered model').count(), 0);
      await button(page, 'Validate & load models').click();
      await field(page, 'Discovered model').getByRole('option', { name: 'new-key-model' }).waitFor({ state: 'attached' });
      release.resolve();
      await settled.promise;
      assert.deepEqual(await field(page, 'Discovered model').getByRole('option').allTextContents(), ['Choose a model', 'new-key-model']);
      await page.getByText('Advanced: base URL', { exact: true }).click();
      await field(page, 'Endpoint URL').fill('https://different.example.test/v1');
      assert.equal(await field(page, 'Discovered model').count(), 0);
      await field(page, 'Endpoint URL').fill('https://api.openai.com/v1');
      await field(page, 'API Key').fill('another-fictional-key');
      await button(page, 'Validate & load models').click();
      await field(page, 'Discovered model').waitFor();
      await field(page, 'Enable AI features').uncheck();
      await field(page, 'Enable AI features').check();
      assert.equal(await field(page, 'Discovered model').count(), 0);
      await prepareOpenAI(page);
      await field(page, 'API Key').fill('another-fictional-key');
      await button(page, 'Validate & load models').click();
      await field(page, 'Discovered model').waitFor();
      await field(page, 'Provider').selectOption('gemini');
      assert.equal(await field(page, 'Discovered model').count(), 0);
      await prepareOpenAI(page);
      await field(page, 'API Key').fill('another-fictional-key');
      await button(page, 'Validate & load models').click();
      await field(page, 'Discovered model').waitFor();
      await button(page, 'Switch fixture clinic').click();
      assert.equal(await field(page, 'Discovered model').count(), 0);
    } finally { release.resolve(); }
  });
});

test('unverified, empty, rejected and unreachable catalogs leave manual entry usable', { timeout: 30000 }, async () => {
  let attempts = 0;
  await withSettings({
    respond: async (route, request) => {
      if (request.url() !== 'https://models.example.test/v1/models') return false;
      attempts++;
      if (attempts === 1) await reply(route, { data: [{ id: 'candidate' }] });
      else if (attempts === 2) await reply(route, { data: [] });
      else if (attempts === 3) await reply(route, { error: { message: 'secret text from provider' } }, 401);
      else await route.abort('failed');
      return true;
    },
  }, async page => {
    await field(page, 'Provider').selectOption('custom');
    await field(page, 'Endpoint URL').fill('https://models.example.test/v1');
    await button(page, 'Load models').click();
    await page.getByText('Provider catalog — access not verified', { exact: true }).waitFor();
    await button(page, 'Load models').click();
    await page.getByText(/No compatible models were reported/).waitFor();
    await button(page, 'Load models').click();
    await page.getByRole('alert').filter({ hasText: /requires an API key/ }).waitFor();
    assert.equal(await page.getByText('secret text from provider').count(), 0);
    await button(page, 'Load models').click();
    await page.getByRole('alert').filter({ hasText: /Could not reach the model endpoint/ }).waitFor();
    await field(page, 'Model ID').fill('manual/fixture-model');
    assert.equal(await field(page, 'Model ID').inputValue(), 'manual/fixture-model');
  });
});

test('OpenRouter’s public fallback separates key recognition from model access', { timeout: 30000 }, async () => {
  await withSettings({
    respond: async (route, request) => {
      if (new URL(request.url()).origin !== 'https://openrouter.ai') return false;
      if (request.url().endsWith('/key')) await reply(route, { data: { is_management_key: false } });
      else if (request.url().endsWith('/models/user')) await reply(route, {}, 403);
      else if (request.url().endsWith('/models')) await reply(route, { data: [{ id: 'public-model' }] });
      else return false;
      return true;
    },
  }, async page => {
    await field(page, 'Provider').selectOption('openrouter');
    await field(page, 'API Key').fill(fakeKey);
    await button(page, 'Validate & load models').click();
    await page.getByText('API key recognized.', { exact: true }).waitFor();
    await page.getByText('Provider catalog — access not verified', { exact: true }).waitFor();
    assert.equal(await page.getByText('API key accepted for model discovery.', { exact: true }).count(), 0);
  });
});

test('leaving the clinic while loading aborts the provider request', { timeout: 30000 }, async () => {
  const incoming = deferred();
  const release = deferred();
  await withSettings({
    respond: async (route, request) => {
      if (request.url() !== openaiModels) return false;
      incoming.resolve();
      await release.promise;
      try { await reply(route, { data: [{ id: 'late-model' }] }); }
      catch (error) {
        if (!/already handled|invalid interception|closed/i.test(error.message)) throw error;
      }
      return true;
    },
  }, async page => {
    try {
      await prepareOpenAI(page);
      await button(page, 'Validate & load models').click();
      await incoming.promise;
      const [aborted] = await Promise.all([
        page.waitForEvent('requestfailed', { predicate: request => request.url() === openaiModels, timeout: 3500 }),
        button(page, 'Switch fixture clinic').click(),
      ]);
      assert.match(aborted.failure().errorText, /abort/i);
      release.resolve();
      assert.equal(await field(page, 'API Key').inputValue(), '');
      assert.equal(await field(page, 'Discovered model').count(), 0);
    } finally { release.resolve(); }
  });
});

test('the offline demo can enable demo AI without exposing provider setup or contacting a provider', { timeout: 30000 }, async () => {
  await withSettings({ demo: true }, async (page, requests) => {
    await field(page, 'Enable AI features').check();
    await page.getByText('Provider connections are unavailable in the offline demo.', { exact: true }).waitFor();
    assert.equal(await field(page, 'API Key').count(), 0);
    assert.equal(await button(page, 'Validate & load models').count(), 0);
    assert.deepEqual(requests, []);
  });
});
