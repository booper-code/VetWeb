import test from 'node:test';
import assert from 'node:assert/strict';
import { withStaticDemoBrowser } from './helpers/static-demo-browser.mjs';

test('admission explains missing breed and weight until they are corrected', { timeout: 120000 }, async () => {
  await withStaticDemoBrowser(async ({ page, button, go }) => {
    await go('Patients');
    await page.getByPlaceholder('e.g. Buster').fill('Fictional Admission Patient');
    await page.getByPlaceholder('Guardian Name *').fill('Fictional Guardian');
    await page.getByPlaceholder('Phone Number *').fill('09170000000');
    const submit = button(page, 'Admit Patient to Directory');
    await submit.click();

    const error = page.getByRole('alert').filter({ hasText: /breed.*weight/i });
    await error.waitFor();
    const breed = page.getByRole('textbox', { name: /breed/i });
    const weight = page.getByRole('spinbutton', { name: /weight/i });
    assert.equal(await breed.getAttribute('required'), '');
    assert.equal(await weight.getAttribute('required'), '');
    await breed.fill('Aspin');
    await error.waitFor({ state: 'hidden' });

    const weightError = page.getByRole('alert').filter({ hasText: /weight/i });
    await weightError.waitFor();
    await weight.fill('201');
    await weightError.getByText(/0\.1.*200/).waitFor();
    await weight.fill('5.5');
    await weightError.waitFor({ state: 'hidden' });
    await submit.click();
    await page.getByRole('row').filter({ hasText: 'Fictional Admission Patient' }).waitFor();
  });
});
