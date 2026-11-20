import test from 'node:test';
import assert from 'node:assert/strict';
import { withStaticDemoBrowser } from './helpers/static-demo-browser.mjs';

async function goToSettings(page, button) {
  const toggle = button(page, 'Toggle navigation');
  if (await toggle.isVisible()) await toggle.click();
  await button(page.getByRole('navigation', { name: 'Administration' }), 'Clinic setup').click();
}

async function uploadCsv(page, contents) {
  await page.locator('#inventoryCsvUpload').setInputFiles({
    name: 'fictional-inventory.csv', mimeType: 'text/csv', buffer: Buffer.from(contents)
  });
}

test('the lab displays a fictional example without claiming a provider analyzed data', { timeout: 120000 }, async () => {
  await withStaticDemoBrowser(async ({ page, button }) => {
    await goToSettings(page, button);
    await page.getByRole('switch', { name: 'Enable AI features' }).check();
    const toggle = button(page, 'Toggle navigation');
    if (await toggle.isVisible()) await toggle.click();
    await button(page.getByRole('navigation', { name: 'Clinic operations' }), 'Laboratory & AI').click();
    const main = page.getByRole('main');
    await button(main, 'Show fictional example').click();
    const status = page.getByRole('status').filter({ hasText: /example/i });
    await status.first().waitFor();
    assert.match(await status.first().innerText(), /no analysis was performed/i);
    assert.doesNotMatch(await main.innerText(), /diagnostic matrix|clinical synthesis|fluid therapy/i);
    await main.getByRole('heading', { name: 'Fictional example output' }).waitFor();
    await main.getByText(/predefined output, not a clinical finding/).waitFor();
    assert.equal(await main.locator('textarea, input[type=file]').count(), 0);
  });
});

test('CSV import keeps the canonical Supplies category and accepts an explicit zero', { timeout: 120000 }, async () => {
  await withStaticDemoBrowser(async ({ page, button, go }) => {
    await goToSettings(page, button);
    await uploadCsv(page, 'Item Code,Item Name,Category,Stock\nCSV-SUP,"Example Gauze, roll",Supplies,"0"');
    await page.getByRole('status').filter({ hasText: 'Imported 1 inventory item' }).waitFor();
    await go('Inventory');
    const row = page.getByRole('row').filter({ hasText: 'Example Gauze' });
    await row.getByRole('cell', { name: '0 unit/s', exact: true }).waitFor();
    assert.match(await row.innerText(), /Supplies/i);
  });
});

test('invalid or missing stock stops the entire CSV import before any rows are saved', { timeout: 120000 }, async () => {
  await withStaticDemoBrowser(async ({ page, button, go }) => {
    await goToSettings(page, button);
    const cases = [
      ['CSV-BAD', 'not a number', 'stock'],
      ['CSV-BAD', '', 'stock'],
      ['CSV-BAD', '-1', 'stock'],
      ['CSV-BAD', 'Infinity', 'stock'],
      ['CSV-BAD', '0x10', 'stock'],
      ['CSV-BAD', '1"2"', 'quoting'],
      ['CSV-FIRST', 'not a number', 'stock'],
    ];
    for (const [index, [code, quantity, issue]] of cases.entries()) {
      await uploadCsv(page, `Item Code,Item Name,Category,Stock\nCSV-FIRST,Example First Row,Medicine,6\n${'\n'.repeat(index + 1)}${code},Example Bad Row,Supplies,${quantity}`);
      await page.waitForFunction(() => document.querySelector('#inventoryCsvUpload').value === '');
      const status = page.getByRole('status').filter({ hasText: /CSV/ });
      await status.first().waitFor();
      assert.match(await status.first().innerText(), new RegExp(`row ${index + 4}.*${issue}.*nothing was imported`, 'i'));
    }
    await go('Inventory');
    assert.equal(await page.getByRole('row').filter({ hasText: /Example First Row|Example Bad Row/ }).count(), 0);
  });
});
