import test from 'node:test';
import assert from 'node:assert/strict';
import { withStaticDemoBrowser } from './helpers/static-demo-browser.mjs';

const openDobby = async ({ page, go }) => {
  await go('Patients');
  const row = page.getByRole('row').filter({ hasText: 'Dobby' });
  await row.click();
  await page.getByRole('heading', { name: 'Patient Clinical Dossier' }).waitFor();
  return row;
};

test('the dossier does not save a notes-only visit when a treatment selection has not been added', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async app => {
    const { page, button } = app;
    await openDobby(app);
    await button(page, 'Record treatment').click();
    const item = page.getByLabel('Treatment item');
    await item.selectOption('SRV-00101');
    await page.getByLabel('Clinical notes').fill('Fictional visit with medicine and a service.');
    await button(page, 'Save treatment').click();
    assert.equal(await page.locator('article').filter({ hasText: 'Fictional visit with medicine and a service.' }).count(), 0);
    await page.getByRole('alert').filter({ hasText: /Add line/ }).waitFor();
    assert.equal(await item.inputValue(), 'SRV-00101');
  }));

test('saved treatment and service names lead the visit card while preserving its visit type', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async app => {
    const { page, button } = app;
    const row = await openDobby(app);
    await button(page, 'Record treatment').click();
    const item = page.getByLabel('Treatment item');
    await item.selectOption('SRV-00101');
    await page.getByLabel('Line note').fill('Fictional service detail.');
    await button(page, 'Add line').click();
    await item.selectOption('ITM-00142');
    await page.getByLabel('Quantity', { exact: true }).fill('2');
    await page.getByLabel('Dose or instructions').fill('Fictional dose');
    await button(page, 'Add line').click();
    await page.getByLabel('Clinical notes').fill('Fictional visit with medicine and a service.');
    await button(page, 'Save treatment').click();

    const visit = page.locator('article').filter({ hasText: 'Fictional visit with medicine and a service.' });
    const verifyVisit = async () => {
      await visit.getByRole('heading', { name: /Professional Fee/ }).waitFor();
      await visit.getByText(/Visit type: Consultation/).waitFor();
      await visit.getByText(/Professional Fee × 1/).waitFor();
      await visit.getByText(/Fictional service detail/).waitFor();
      await visit.getByText(/Amoxicillin Clavulanate × 2 · Fictional dose/).waitFor();
    };
    await verifyVisit();
    await button(page, 'Close dossier').click();
    await row.click();
    await verifyVisit();

    await button(page, 'Record treatment').click();
    const remaining = await item.locator('option[value="ITM-00142"]').textContent();
    assert.match(remaining, /3 left/);
    await page.getByLabel('Visit type').selectOption('Follow-up');
    await page.getByLabel('Clinical notes').fill('Fictional notes-only follow-up.');
    await button(page, 'Save treatment').click();
    await page.locator('article').filter({ hasText: 'Fictional notes-only follow-up.' })
      .getByRole('heading', { name: 'Follow-up', exact: true }).waitFor();
  }));

test('fractional quantities are rejected without rounding down', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async app => {
    const { page, button } = app;
    await openDobby(app);
    await button(page, 'Record treatment').click();
    await page.getByLabel('Treatment item').selectOption('ITM-00142');
    const quantity = page.getByLabel('Quantity', { exact: true });
    await quantity.fill('1.5');
    await button(page, 'Add line').click();
    await page.getByRole('alert').filter({ hasText: /whole positive quantity/ }).waitFor();
    assert.equal(await quantity.inputValue(), '1.5');
  }));

test('a missing visit time is rejected without losing the treatment draft', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async app => {
    const { page, button } = app;
    await openDobby(app);
    await button(page, 'Record treatment').click();
    await page.getByLabel('Treatment item').selectOption('ITM-00142');
    await page.getByLabel('Quantity', { exact: true }).fill('2');
    await button(page, 'Add line').click();
    const time = page.getByLabel('Actual visit time');
    await time.fill('');
    await button(page, 'Save treatment').click();
    await page.getByRole('alert').filter({ hasText: /valid visit date and time/ }).waitFor();
    await time.fill('2026-11-19T08:00');
    await button(page, 'Save treatment').click();
    await page.locator('article').getByText(/Amoxicillin Clavulanate × 2/).waitFor();
  }));

test('the dossier editor preserves a billing balance and does not offer a direct ledger edit', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async app => {
    const { page, button } = app;
    await openDobby(app);
    await button(page, 'Edit Dossier Details').click();
    const ledger = page.getByText('Ledger Balance (PHP)', { exact: true }).locator('..');
    assert.equal(await ledger.locator('input').count(), 0);
    await ledger.getByText('PHP 1500.00', { exact: true }).waitFor();
    await button(page, 'Save Changes to Dossier').click();
    await page.getByText('Ledger Balance Summary', { exact: true }).locator('..')
      .getByText('PHP 1500.00', { exact: true }).waitFor();
  }));

test('double confirmation records one visit and dispenses stock only once', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async app => {
    const { page, button } = app;
    await openDobby(app);
    await button(page, 'Record treatment').click();
    await page.getByLabel('Treatment item').selectOption('ITM-00142');
    await button(page, 'Add line').click();
    await page.getByLabel('Clinical notes').fill('Fictional duplicate-submit check.');
    await button(page, 'Save treatment').evaluate(save => { save.click(); save.click(); });
    const visits = page.locator('article').filter({ hasText: 'Fictional duplicate-submit check.' });
    await visits.first().waitFor();
    assert.equal(await visits.count(), 1);
    await button(page, 'Record treatment').click();
    assert.match(await page.getByLabel('Treatment item').locator('option[value="ITM-00142"]').textContent(), /4 left/);
  }));

test('dossier edits can be canceled, and saved contact, notes and manual lab results reopen intact', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async app => {
    const { page, button } = app;
    const row = await openDobby(app);
    const edit = button(page, 'Edit Dossier Details');
    const notes = page.getByPlaceholder(/Attending veterinarian clinical observations/);

    await edit.click();
    await notes.fill('Fictional canceled edit.');
    await button(page, 'Cancel Editing').click();
    assert.equal(await page.getByText('Fictional canceled edit.', { exact: true }).count(), 0);

    await edit.click();
    await page.locator('fieldset input[type=email]').fill('dossier-test@example.com');
    await notes.fill('Fictional saved patient notes.');
    await button(page, '+ Add Lab Printout').click();
    await page.getByPlaceholder('Panel Name (e.g. Complete Blood Count)').last().fill('Fictional lab panel');
    page.once('dialog', dialog => dialog.accept('QA-MARKER'));
    await button(page, '+ Add Metric Row').last().click();
    await page.getByPlaceholder('e.g. Normal, High, 12.5').last().fill('Fictional result');
    await button(page, 'Save Changes to Dossier').click();

    const verify = async () => {
      for (const text of ['dossier-test@example.com', 'Fictional saved patient notes.', 'Fictional lab panel', 'QA-MARKER', 'Fictional result']) {
        await page.getByText(text, { exact: true }).waitFor();
      }
    };
    await verify();
    await button(page, 'Close dossier').click();
    await row.click();
    await verify();
  }));

test('dossier header and treatment controls fit inside the phone and desktop layouts', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async app => {
    const { page, button } = app;
    await openDobby(app);
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const close = button(page, 'Close dossier');
      const fits = await close.evaluate(element => {
        const panel = element.closest('.overflow-hidden');
        return element.getBoundingClientRect().right <= panel.getBoundingClientRect().right;
      });
      assert.equal(fits, true, `close button clipped at ${width}px`);
      await button(page, 'Record treatment').click();
      const field = page.getByLabel('Actual visit time');
      const fitsField = await field.evaluate(element => {
        const column = element.closest('.overflow-y-auto');
        return element.getBoundingClientRect().right <= column.getBoundingClientRect().right;
      });
      assert.equal(fitsField, true, `visit time clipped at ${width}px`);
      await button(page, 'Cancel').click();
    }
  }));

test('inline profile and lab images persist, and the lab thumbnail opens at full size', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async app => {
    const { page, button } = app;
    const row = await openDobby(app);
    const pixels = await page.evaluate(() => document.createElement('canvas').toDataURL().split(',')[1]);
    const image = { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(pixels, 'base64') };
    await button(page, 'Edit Dossier Details').click();
    await page.locator('#editPatientProfilePictureUpload').setInputFiles(image);
    await page.waitForFunction(() => document.querySelector('img[alt="Dobby profile"]')?.naturalWidth > 0);
    await page.getByText('Upload Lab Printout', { exact: true }).locator('..').locator('input[type=file]').setInputFiles(image);
    await page.waitForFunction(() => document.querySelector('img[alt="Lab Printout"]')?.naturalWidth > 0);
    await button(page, 'Save Changes to Dossier').click();
    await button(page, 'Close dossier').click();
    await row.click();
    await page.waitForFunction(() => document.querySelector('img[alt="Dobby"]')?.naturalWidth > 0);
    const thumbnail = button(page, 'Enlarge Complete Blood Count (CBC)');
    await thumbnail.waitFor();
    const newTab = page.context().waitForEvent('page', { timeout: 5000 });
    await thumbnail.press('Enter');
    const fullSize = await newTab;
    try {
      await fullSize.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0, { timeout: 5000 });
    } finally { await fullSize.close(); }
  }));
