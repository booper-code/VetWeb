import test from 'node:test';
import assert from 'node:assert/strict';
import { withStaticDemoBrowser } from './helpers/static-demo-browser.mjs';

test('demo inventory scans one row per item and respects clearing and non-stock categories', { timeout: 30000 }, () =>
  withStaticDemoBrowser(async ({ page, button }) => {
    await button(page, 'Stock alerts').click();
    const panel = page.getByRole('region', { name: 'Stock alerts', exact: true });
    const add = page.getByRole('form', { name: 'New inventory item' });
    const drawer = page.getByRole('dialog', { name: 'Inventory item details' });
    const name = 'Fictional clinic supply';
    await add.getByPlaceholder('e.g. Ketoconazole 200mg').fill(name);
    await add.getByPlaceholder('e.g. 50', { exact: true }).fill('2');
    await add.getByPlaceholder('e.g. 10', { exact: true }).fill('2');
    await add.getByPlaceholder('0.00', { exact: true }).nth(0).fill('1');
    await add.getByPlaceholder('0.00', { exact: true }).nth(1).fill('2');
    await add.getByLabel('Expiry date', { exact: true }).fill('2026-11-20');
    await button(add, 'Add to Catalog').click();
    const catalogRow = page.getByRole('row').filter({ hasText: name });
    await catalogRow.waitFor();
    await button(panel, 'Check stock alerts').click();
    await panel.getByText(/2026-11-20 Manila/).waitFor();
    const alert = panel.getByRole('listitem').filter({ hasText: name });
    await alert.getByText('Reorder', { exact: true }).waitFor();
    await alert.getByText('Expires today', { exact: true }).waitFor();
    assert.equal(await alert.count(), 1);

    await catalogRow.getByText(name, { exact: true }).click();
    await drawer.getByText('2026-11-20', { exact: true }).waitFor();
    await button(drawer, 'Edit Item Details').click();
    await drawer.getByLabel('Expiry date', { exact: true }).fill('');
    await button(drawer, 'Save Changes').click();
    await drawer.getByText('Not recorded', { exact: true }).waitFor();
    await button(drawer, 'Close inventory item').click();
    await button(panel, 'Refresh alerts').click();
    await alert.getByText('Reorder', { exact: true }).waitFor();
    assert.equal(await alert.getByText('Expires today', { exact: true }).count(), 0);

    await catalogRow.getByText(name, { exact: true }).click();
    await button(drawer, 'Edit Item Details').click();
    await drawer.getByLabel('Expiry date', { exact: true }).fill('2026-11-20');
    await drawer.getByRole('combobox', { name: 'Item category' }).selectOption('Service');
    assert.equal(await drawer.getByLabel('Expiry date', { exact: true }).count(), 0);
    await button(drawer, 'Save Changes').click();
    await button(drawer, 'Close inventory item').click();
    await button(panel, 'Refresh alerts').click();
    await alert.waitFor({ state: 'hidden' });
  }));
