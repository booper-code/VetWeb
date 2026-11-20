import test from 'node:test';
import assert from 'node:assert/strict';
import { withStaticDemoBrowser } from './helpers/static-demo-browser.mjs';

test('the offline demo reviews fictional appointment notes only while AI is enabled, without saving', { timeout: 120000 }, async () => {
  await withStaticDemoBrowser(async ({ page, button, go }) => {
    const main = page.getByRole('main');
    const heading = main.getByRole('heading', { name: 'AI Clerk preview' });
    const preview = main.getByRole('region', { name: 'AI Clerk preview' });
    const note = preview.getByRole('textbox', { name: 'Fictional appointment note' });
    const proposal = preview.getByRole('region', { name: 'Appointment proposal' });
    const openClose = async () => {
      await button(main, 'End-of-Day Close').click();
      await main.getByRole('heading', { name: 'End-of-Day Close', exact: true }).waitFor();
    };
    const setAI = async enabled => {
      const toggle = button(page, 'Toggle navigation');
      if (await toggle.isVisible()) await toggle.click();
      await button(page.getByRole('navigation', { name: 'Administration' }), 'Clinic setup').click();
      await page.getByRole('switch', { name: 'Enable AI features' }).setChecked(enabled);
      await go('Overview');
    };
    const appointmentCards = async () => {
      await go('Appointments');
      await main.getByRole('heading', { name: 'Appointments & reminders' }).waitFor();
      return main.getByRole('article').allTextContents();
    };

    const before = await appointmentCards();
    await go('Overview');
    await openClose();
    assert.equal(await heading.count(), 0);
    await setAI(true);
    await openClose();
    await heading.waitFor();

    await button(preview, 'Create example').click();
    await button(preview, 'Review note').click();
    await proposal.getByText('Create appointment', { exact: true }).waitFor();
    assert.match(await proposal.innerText(), /Cora.*DEMO-PAT-101/);
    assert.match(await proposal.innerText(), /2026-11-24 09:00.*Asia\/Manila/);

    await note.fill('Reschedule DEMO-APT-201 tomorrow');
    await proposal.waitFor({ state: 'hidden' });
    await button(preview, 'Review note').click();
    await preview.getByRole('alert').getByText(/date and time/).waitFor();
    assert.equal(await proposal.count(), 0);

    const multiAction = 'Cancel DEMO-APT-201'.padEnd(160, ' ') + '\nCancel DEMO-APT-999';
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(text => navigator.clipboard.writeText(text), multiAction);
    await note.fill('');
    await note.press('ControlOrMeta+v');
    await page.waitForFunction(() => document.activeElement.value?.length >= 160);
    await button(preview, 'Review note').click();
    assert.equal(await proposal.count(), 0, 'review must not accept a truncated prefix of the paste');
    await preview.getByRole('alert').getByText(/160 characters/).waitFor();

    await button(preview, 'Reschedule example').click();
    await button(preview, 'Review note').click();
    await proposal.getByText('Reschedule appointment', { exact: true }).waitFor();
    assert.match(await proposal.innerText(), /DEMO-APT-201/);
    assert.match(await proposal.innerText(), /2026-11-24 10:30.*Asia\/Manila/);
    assert.match(await proposal.innerText(), /2026-11-25 14:30.*Asia\/Manila/);

    await button(preview, 'Cancel example').click();
    await button(preview, 'Review note').click();
    await proposal.getByText('Cancel appointment', { exact: true }).waitFor();
    assert.match(await proposal.innerText(), /DEMO-APT-201/);
    assert.match(await proposal.innerText(), /2026-11-24 10:30.*Asia\/Manila/);
    assert.equal(await proposal.getByRole('button').count(), 0);
    assert.deepEqual(await appointmentCards(), before);

    await go('Overview');
    await openClose();
    assert.equal(await note.inputValue(), '');
    assert.equal(await proposal.count(), 0);
    await setAI(false);
    await openClose();
    assert.equal(await heading.count(), 0);
  });
});
