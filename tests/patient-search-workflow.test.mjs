import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, domHarness, loadSource } from './helpers/tsx-harness.mjs';

const patient = (id, name, extra = {}) => ({
  id, name, ownerName: 'Fictional owner', ownerContact: '', species: 'Canine', breed: '',
  gender: 'Unknown', weight: 0, balance: 0, admissionTypes: [], reason: '', status: 'Waiting', ...extra,
});

async function setup(overrides = {}) {
  const { ClinicPatientSearch } = loadSource('../../components/ClinicPatientSearch.tsx', { react: React });
  const dom = domHarness();
  const doc = dom.window.document;
  const defaults = { online: true, isCurrent: () => true, onOpenPatient: async () => {}, ...overrides };
  const render = (props = {}, key = 'initial') =>
    act(async () => dom.root.render(React.createElement(ClinicPatientSearch, { key, ...defaults, ...props })));
  const submit = async value => {
    const input = doc.querySelector('form input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      input.form.requestSubmit();
    });
  };
  const click = async label => {
    const button = [...doc.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') || element.textContent.trim()) === label);
    assert.ok(button, `Missing button: ${label}`);
    await act(async () => button.click());
  };
  await render();
  return { ...dom, doc, render, submit, click };
}

test('clinic search continues beyond five pages and includes discharged matches', async () => {
  const cursors = [];
  const app = await setup({
    load: async after => {
      cursors.push(after);
      const page = cursors.length;
      if (page === 6) return { rows: [patient('six', 'Max History', { status: 'Discharged' })], next: null };
      if (page > 6) return { rows: [], next: null };
      return { rows: [patient(`row-${page}`, 'Unrelated', { reason: 'max' })], next: `page-${page}` };
    },
  });
  try {
    assert.deepEqual(cursors, []);
    await app.submit('  mAx ');
    assert.deepEqual(cursors, [null, 'page-1', 'page-2', 'page-3', 'page-4']);
    assert.match(app.doc.body.textContent, /5 patients checked/);
    assert.doesNotMatch(app.doc.body.textContent, /No matching patients|Unrelated/);
    await app.click('Continue search');
    assert.match(app.doc.body.textContent, /Max History.*Discharged/s);
    assert.equal(cursors.at(-1), 'page-5');
    await app.submit('missing');
    assert.match(app.doc.body.textContent, /No matching patients/);
    assert.doesNotMatch(app.doc.body.textContent, /Max History/);
  } finally { await app.close(); }
});

test('matching names and owners stay distinct, and a result opens by canonical ID', async () => {
  const selected = [];
  const app = await setup({
    load: async () => ({ rows: [
      patient('pet-a', 'Max'),
      patient('pet-b', 'Max', { ownerName: 'Another owner' }),
      patient('max-03', 'Cleo'),
      patient('pet-d', 'Fido', { ownerName: 'Maxwell' }),
      patient('pet-e', 'Rex', { breed: 'Max' }),
    ], next: null }),
    onOpenPatient: async (id, active) => { if (active()) selected.push(id); },
  });
  try {
    await app.submit('max');
    assert.equal(app.doc.querySelectorAll('li').length, 4);
    assert.match(app.doc.body.textContent, /Another owner/);
    assert.doesNotMatch(app.doc.body.textContent, /Rex/);
    await app.click('Open patient Max (pet-b)');
    assert.deepEqual(selected, ['pet-b']);
  } finally { await app.close(); }
});

test('a failed page preserves matches and retry resumes at the last successful cursor', async () => {
  const cursors = [];
  const app = await setup({
    load: async after => {
      cursors.push(after);
      if (cursors.length === 3) throw new Error('private error details');
      if (after === null) return { rows: [patient('one', 'Max One')], next: 'one' };
      if (after === 'one') return { rows: [patient('two', 'Max Two')], next: 'two' };
      return { rows: [patient('three', 'Max Three')], next: null };
    },
  });
  try {
    await app.submit('max');
    assert.match(app.doc.body.textContent, /Max One.*Max Two/s);
    assert.doesNotMatch(app.doc.body.textContent, /private error details|No matching patients/);
    await app.click('Retry search');
    assert.deepEqual(cursors, [null, 'one', 'two', 'two']);
    assert.match(app.doc.body.textContent, /Max Three/);
    assert.equal(app.doc.querySelectorAll('li').length, 3);
  } finally { await app.close(); }
});

test('late results cannot replace a new query or appear in a changed workspace', async () => {
  const prior = deferred(), switched = deferred();
  let page = 0, active = true;
  const app = await setup({ isCurrent: () => active, load: () => {
    page += 1;
    if (page === 1) return prior.promise;
    if (page === 3) return switched.promise;
    return Promise.resolve({ rows: [patient('new', 'Luna')], next: null });
  } });
  try {
    await app.submit('max');
    await app.submit('luna');
    await act(async () => prior.resolve({ rows: [patient('old', 'Max Late')], next: null }));
    assert.match(app.doc.body.textContent, /Luna/);
    assert.doesNotMatch(app.doc.body.textContent, /Max Late/);
    await app.submit('dobby');
    active = false;
    await app.render({}, 'new-clinic');
    await act(async () => switched.resolve({ rows: [patient('prior', 'Dobby')], next: 'must-not-load' }));
    assert.doesNotMatch(app.doc.body.textContent, /Dobby/);
    assert.equal(page, 3);
  } finally { await app.close(); }
});

test('too-short and offline queries do not read cloud pages', async () => {
  let reads = 0;
  const app = await setup({ load: async () => { reads += 1; return { rows: [], next: null }; } });
  try {
    await app.submit(' x ');
    assert.equal(reads, 0);
    await app.render({ online: false }, 'offline');
    assert.match(app.doc.body.textContent, /Offline.*loaded/s);
    const input = app.doc.querySelector('form input');
    if (input) await app.submit('Max');
    assert.equal(reads, 0);
  } finally { await app.close(); }
});

test('a pending dossier open is invalidated when the search panel unmounts', async () => {
  const opening = deferred();
  let opened = false;
  const app = await setup({
    load: async () => ({ rows: [patient('one', 'Max One')], next: null }),
    onOpenPatient: async (_id, active) => { await opening.promise; opened = active(); },
  });
  try {
    await app.submit('max');
    await app.click('Open patient Max One (one)');
    await app.render({}, 'different-panel');
    await act(async () => opening.resolve());
    assert.equal(opened, false);
  } finally { await app.close(); }
});
