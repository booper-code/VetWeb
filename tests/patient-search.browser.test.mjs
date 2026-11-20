import test from 'node:test';
import assert from 'node:assert/strict';
import { withStaticDemoBrowser } from './helpers/static-demo-browser.mjs';

test('demo clinic search opens the right dossier without changing the loaded directory filter', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async ({ page, button, go }) => {
    await go('Patients');
    await page.getByRole('searchbox', { name: 'Search records' }).fill('Luna');
    await page.getByRole('row').filter({ hasText: 'Luna' }).waitFor();
    assert.equal(await page.getByRole('row').filter({ hasText: 'Max' }).count(), 0);
    const search = page.getByRole('form', { name: 'Search clinic patients' });
    await search.getByRole('searchbox').fill('Sarah Cruz');
    await button(search, 'Search').click();
    const result = button(page, 'Open patient Max (PAT-00102)');
    await result.waitFor();
    assert.equal(await page.getByRole('searchbox', { name: 'Search records' }).inputValue(), 'Luna');
    await result.click();
    await page.getByText('Patient Clinical Dossier', { exact: true }).waitFor();
    await page.getByText('Sarah Cruz', { exact: true }).first().waitFor();
    await button(page, 'Close dossier').click();
    await result.click();
    await page.getByText('Patient Clinical Dossier', { exact: true }).waitFor();
    await button(page, 'Close dossier').click();
    assert.equal(await page.getByRole('searchbox', { name: 'Search records' }).inputValue(), 'Luna');
    assert.equal(new URL(page.url()).search, '');
  }));
