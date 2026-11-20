import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { withStaticDemoBrowser } from './helpers/static-demo-browser.mjs';

const question = (dialog, text) => dialog.getByRole('textbox', { name: 'Ask the assistant' }).fill(text);
const review = (page, name) => page.getByRole('button', { name, exact: true });

test('header assistant answers and prefills an existing appointment, then only manual save changes it', { timeout: 120000 }, async () => {
  await withStaticDemoBrowser(async ({ page, button, go }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
    const header = page.getByRole('banner');
    const launcher = button(header, 'AI Assistant');
    const popup = page.getByRole('dialog', { name: 'AI Assistant' });
    const form = page.getByRole('form', { name: 'Appointment details' });
    const ask = async text => {
      await question(popup, text);
      await button(popup, 'Ask').click();
    };
    const move = 'Move Dobby’s checkup to November 24, 2026 at 2:30 PM Manila time.';
    const moveAndReview = async () => {
      await launcher.click();
      await ask(move);
      await button(popup, 'Review in Appointments').click();
      await popup.waitFor({ state: 'hidden' });
    };
    await page.getByRole('heading', { name: 'Visits needing attention' }).waitFor();
    assert.equal(await launcher.count(), 0);
    await button(page, 'Toggle navigation').click();
    await button(page.getByRole('navigation', { name: 'Administration' }), 'Clinic setup').click();
    await page.getByRole('switch', { name: 'Enable AI features' }).check();
    await launcher.waitFor();
    await launcher.click();
    const staffInput = popup.getByRole('textbox', { name: 'Ask the assistant' });
    assert.equal(await staffInput.getAttribute('spellcheck'), 'false');
    assert.equal(await staffInput.getAttribute('autocorrect'), 'off');
    assert.equal(await staffInput.getAttribute('autocomplete'), 'off');
    await page.keyboard.press('Escape');

    for (const width of [320, 768, 1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await launcher.click();
      assert.equal(await popup.evaluate(dialog => {
        const box = dialog.getBoundingClientRect();
        return dialog.clientWidth > 0 && dialog.scrollWidth <= dialog.clientWidth + 1 &&
          box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth + 1;
      }), true, `assistant fits ${width}px`);
      assert.equal(await popup.getByRole('textbox', { name: 'Ask the assistant' }).evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await popup.evaluate(node => node.contains(document.activeElement)), true);
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'hidden' });
      assert.equal(await launcher.evaluate(node => node === document.activeElement), true);
    }

    await launcher.click();
    await ask('Where are appointments?');
    await popup.getByText(/Everyday work → Appointments/).waitFor();
    await button(popup, 'Open Appointments').click();
    await page.getByRole('heading', { name: 'Appointments & reminders' }).waitFor();

    for (const [patient, at] of [['PAT-00101', '2026-11-23T18:30'], ['PAT-00102', '2026-11-23T20:00']]) {
      await button(page, 'New appointment').click();
      await form.getByRole('combobox', { name: 'Patient' }).selectOption(patient);
      await form.getByRole('combobox', { name: 'Type' }).selectOption('Checkup');
      await form.getByLabel('Scheduled date & time').fill(at);
      page.once('dialog', prompt => prompt.accept());
      await button(form, 'Review & save appointment').click();
      await form.waitFor({ state: 'hidden' });
    }
    const first = page.getByRole('article').filter({ hasText: 'Dobby · Checkup' });
    const second = page.getByRole('article').filter({ hasText: 'Max · Checkup' });
    const calendar = async card => {
      const download = page.waitForEvent('download');
      await button(card, 'Download calendar').click();
      return readFile(await (await download).path(), 'utf8');
    };
    const oldFirst = await first.innerText();
    const oldSecond = await second.innerText();
    await go('Overview');
    await launcher.click();
    await ask('When is Dobby’s checkup?');
    await popup.getByText(/2026-11-24 10:30 Asia\/Manila/).waitFor();
    await ask(move);
    await popup.getByText(/2026-11-24 14:30 Asia\/Manila/).waitFor();
    await page.keyboard.press('Escape');
    await go('Appointments');
    assert.equal(await first.innerText(), oldFirst);

    await button(page, 'New appointment').click();
    await form.getByLabel('Scheduling notes').fill('Unsaved fictional draft');
    await moveAndReview();
    assert.equal(await form.getByLabel('Scheduling notes').inputValue(), 'Unsaved fictional draft');
    await button(page, 'Dismiss assistant draft').click();
    await button(form, 'Discard form').click();

    await moveAndReview();
    assert.equal(await form.getByLabel('Scheduled date & time').inputValue(), '2026-11-23T22:30');
    assert.equal(await first.innerText(), oldFirst);
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Manila' });
    const dismissUnexpected = prompt => prompt.dismiss();
    page.on('dialog', dismissUnexpected);
    try {
      await button(form, 'Review & save appointment').click();
      await form.getByRole('alert').filter({ hasText: /timezone changed/i }).waitFor();
      assert.match(await calendar(first), /DTSTART:20261124T023000Z/);
    } finally {
      page.off('dialog', dismissUnexpected);
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
    }
    page.once('dialog', prompt => prompt.dismiss());
    await button(form, 'Review & save appointment').click();
    assert.match(await calendar(first), /DTSTART:20261124T023000Z/);
    assert.match(await calendar(second), /DTSTART:20261124T040000Z/);

    page.once('dialog', prompt => prompt.accept());
    await button(form, 'Review & save appointment').click();
    await form.waitFor({ state: 'hidden' });
    assert.equal(await second.innerText(), oldSecond);
    assert.match(await calendar(first), /DTSTART:20261124T063000Z/);

    await button(page, 'New appointment').click();
    await form.getByRole('combobox', { name: 'Patient' }).selectOption('PAT-00101');
    await form.getByLabel('Scheduled date & time').fill('2026-11-24T09:00');
    page.once('dialog', prompt => prompt.accept());
    await button(form, 'Review & save appointment').click();
    await form.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 320, height: 844 });
    await launcher.click();
    await ask(move);
    await popup.getByText(/Choose the scheduled appointment/).waitFor();
    assert.equal(await popup.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
    await page.keyboard.press('Escape');
  }, { timezoneId: null });
});

test('the popup asks which visit, fails closed on stale or missing data, and gives viewers no review action', { timeout: 30000 }, async () => {
  const { outputFiles } = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { WorkspaceAssistant } from '@/components/WorkspaceAssistant';
      const row = { id: 'one', revision: 1, patientName: 'Milo', type: 'Checkup', dueAt: '2026-11-24T02:30:00.000Z' };
      const duplicate = { ...row, id: 'two', dueAt: '2026-11-24T03:30:00.000Z' };
      window.reviews = 0;
      window.lookups = [];
      window.opened = [];
      function Fixture() {
        const [state, setState] = useState('duplicate');
        window.changeState = setState;
        return <WorkspaceAssistant key={state === 'switched' ? 'other' : 'current'}
          schedule={{ window: { from: '2026-11-20', through: '2026-11-30' },
            availability: state === 'error' ? 'error' : 'ready', partial: false,
            rows: state === 'duplicate' ? [row, duplicate] : [{ ...row, revision: state === 'stale' ? 2 : 1 }] }}
          canEdit={state !== 'viewer'} onNavigate={() => {}} onReview={() => { window.reviews++; return null; }}
          onLookup={call => {
            window.lookups.push(call.tool);
            if (call.tool === 'inventory_import_history') return Promise.resolve({ tool: call.tool, result: {
              ...call.input, count: 1, recent: [{batchId: '00000000-0000-4000-8000-000000000000', at: call.input.from + 'T16:00:00Z'}],
            }});
            if (call.input.name === 'Pending Name') return new Promise(resolve => {
              window.resolvePending = () => resolve({ tool: call.tool, result: { more: false, matches: [
                { name: 'Pending Name', patientName: 'Must not appear', reference: 'pending' },
              ] } });
            });
            return Promise.resolve({ tool: call.tool, result: { more: false, matches: [
              { name: 'Alex Reyes', patientName: 'Milo', reference: 'one' },
              { name: 'Alex Reyes', patientName: 'Luna', reference: 'two' },
            ] } });
          }} onOpenPerson={async reference => { window.opened.push(reference); return null; }} />;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    ` },
    bundle: true, platform: 'browser', jsx: 'automatic', write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(4000);
    const unexpected = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url === 'https://assistant-fixture.test/') return route.fulfill({
        contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Assistant fixture</title><div id="root"></div><script src="/fixture.js"></script>',
      });
      if (url === 'https://assistant-fixture.test/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      unexpected.push(url);
      return route.abort();
    });
    await page.goto('https://assistant-fixture.test/');
    const popup = page.getByRole('dialog', { name: 'AI Assistant' });
    const input = popup.getByRole('textbox', { name: 'Ask the assistant' });
    const move = 'Move Milo’s checkup to 2026-11-25 at 14:30';
    const ask = async text => { await input.fill(text); await review(popup, 'Ask').click(); };
    const open = () => review(page, 'AI Assistant').click();
    await open();
    await ask(move);
    assert.equal(await review(popup, 'Review in Appointments').count(), 0);
    assert.match(await popup.innerText(), /Choose the scheduled appointment/);
    await popup.getByRole('button', { name: /Milo.*10:30/ }).click();
    await review(popup, 'Review in Appointments').waitFor();
    await page.evaluate(() => window.changeState('stale'));
    await popup.getByText(/appointment changed/i).waitFor();
    assert.equal(await review(popup, 'Review in Appointments').count(), 0);
    await page.evaluate(() => window.changeState('error'));
    await ask('When is Milo’s checkup?');
    await popup.getByText(/could not load/i).waitFor();
    await page.evaluate(() => window.changeState('stale'));
    await ask('When is Missing’s checkup?');
    await popup.getByText(/No matching scheduled appointment/).waitFor();
    await page.evaluate(() => window.changeState('error'));
    await popup.getByText(/schedule is no longer current/i).waitFor();
    assert.equal(await popup.getByText(/No matching scheduled appointment/).count(), 0);
    await page.evaluate(() => window.changeState('viewer'));
    await ask('When is Milo’s checkup?');
    await popup.getByText(/2026-11-24 10:30 Asia\/Manila/).waitFor();
    await ask(move);
    await popup.getByText(/Your schedule access is read-only/i).waitFor();
    assert.equal(await review(popup, 'Review in Appointments').count(), 0);
    await page.evaluate(() => window.changeState('switched'));
    await popup.waitFor({ state: 'hidden' });
    await open();
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.evaluate(() => window.reviews), 0);
    await page.clock.setFixedTime(new Date('2026-11-20T10:00:00Z'));
    await ask('Ilang items ang na-import kamakailan?');
    await popup.getByText(/1 catalog item was imported/i).waitFor();
    await popup.getByText(/older imports/i).waitFor();
    await popup.getByText('View import history', { exact: true }).click();
    await popup.getByText(/Import batch 00000000/i).waitFor();
    await ask('Hanapin si Alex Reyes');
    await popup.getByText(/Choose the matching record/i).waitFor();
    assert.equal(await popup.getByRole('link').count(), 2);
    assert.deepEqual(await page.evaluate(() => window.opened), []);
    await popup.getByRole('link', { name: /Alex Reyes.*Luna/ }).click();
    await popup.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.opened), ['two']);
    await open();
    await ask('Find person Pending Name');
    await popup.getByText(/Checking clinic records/).waitFor();
    await ask('Find Alex and show phone numbers');
    await popup.getByText(/Contact details are not available/).waitFor();
    await page.evaluate(() => window.resolvePending());
    assert.equal(await popup.getByText('Must not appear').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.lookups), ['inventory_import_history', 'find_person_by_name', 'find_person_by_name']);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
