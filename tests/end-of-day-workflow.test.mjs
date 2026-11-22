import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, domHarness, loadSource } from './helpers/tsx-harness.mjs';

class ManilaMidnight extends Date {
  static now() { return Date.parse('2026-11-18T16:00:00Z'); }
}
const payment = { entry: { id: 'one', kind: 'payment', method: 'cash', amountMinor: 50000 }, reversed: false };
const visit = { id: 'visit', patientId: 'pet', patientName: 'Fictional pet', occurredAtMs: ManilaMidnight.now(), linkedTreatment: false };
const empty = { rows: [], next: null };

async function setup(load, onOpenPatient = async () => {}, observe = () => {}) {
  const dom = domHarness();
  const runtime = { react: React };
  const globals = { Date: ManilaMidnight };
  const { useEndOfDay } = loadSource('../../lib/useEndOfDay.ts', runtime, globals);
  const { EndOfDayClose } = loadSource('../../components/EndOfDayClose.tsx', runtime, globals);
  const config = { clinicId: 'first', uid: 'user-one', workspaceGeneration: 1, isCurrent: () => true,
    enabled: true, online: true, load };
  function Harness(props) {
    const report = useEndOfDay(props);
    React.useLayoutEffect(() => observe(dom.window.document.body.textContent, props));
    return props.enabled ? React.createElement(EndOfDayClose, { report, onOpenPatient, onBack: () => {} }) : null;
  }
  const render = (changes = {}) => {
    Object.assign(config, changes);
    return act(async () => { dom.root.render(React.createElement(Harness, { ...config })); });
  };
  const doc = dom.window.document;
  const pick = name => [...doc.querySelectorAll('button')].find(button => button.textContent.trim() === name);
  const click = async name => { assert.ok(pick(name), name); await act(async () => { pick(name).click(); }); };
  const date = () => doc.querySelector('input[type="date"]');
  const select = async value => {
    const input = date();
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  };
  return { ...dom, doc, render, click, date, select };
}

test('partial or failed sections never look complete; refresh replaces rows', async () => {
  let refresh = false;
  const app = await setup(async (kind, { after }) => {
    if (kind === 'visits' && !refresh) throw new Error('Lookup unavailable');
    if (kind === 'entries' && !refresh) return after === null ? { rows: [payment], next: 25 } : { rows: [payment], next: null };
    return empty;
  });
  try {
    await app.render();
    assert.equal(app.date().value, '2026-11-19');
    assert.doesNotMatch(app.doc.body.textContent, /PHP 500\.00|No linked treatment/);
    assert.match(app.doc.body.textContent, /Incomplete coverage/);
    assert.match(app.doc.querySelector('[role="alert"]').textContent, /could not load/i);
    await app.click('Load more collections and settlements');
    assert.equal((app.doc.body.textContent.match(/PHP 500\.00/g) ?? []).length, 1, 'duplicate rows must not add money');
    refresh = true;
    await app.click('Refresh report');
    assert.doesNotMatch(app.doc.body.textContent, /PHP 500\.00/);
    await app.render({ online: false });
    assert.match(app.doc.body.textContent, /Offline/);
    assert.doesNotMatch(app.doc.body.textContent, /PHP 0\.00/);
  } finally { await app.close(); }
});

test('late loads cannot display another day, clinic, account, or previous role data', async () => {
  for (const change of ['day', { clinicId: 'second' }, { uid: 'user-two' }, { enabled: false }]) {
    const old = deferred();
    let calls = 0;
    const app = await setup(async kind => kind === 'entries' && calls++ === 0 ? old.promise : empty);
    try {
      await app.render();
      if (change === 'day') await app.select('2026-11-18');
      else await app.render(change);
      await act(async () => old.resolve({ rows: [payment], next: null }));
      assert.doesNotMatch(app.doc.body.textContent, /PHP 500\.00/, JSON.stringify(change));
    } finally { await app.close(); }
  }
});

test('the paid-in-full panel can finish paging from its own control', async () => {
  const settlement = { entry: { id: 'settled', kind: 'unitemized-settlement', amountMinor: 40000, patientId: 'pet' }, reversed: false };
  const app = await setup(async (kind, { after }) => kind !== 'entries' ? empty
    : after === null ? { rows: [payment], next: 25 } : { rows: [settlement], next: null });
  try {
    await app.render();
    const panel = [...app.doc.querySelectorAll('section')].find(node => node.querySelector('h2')?.textContent === 'Paid in full — not itemized');
    assert.ok(panel);
    const button = panel.querySelector('button');
    assert.match(button.textContent, /Load more/);
    assert.doesNotMatch(panel.textContent, /PHP 400\.00/);
    await act(async () => button.click());
    assert.match(panel.textContent, /PHP 400\.00/);
    assert.doesNotMatch(panel.textContent, /Incomplete coverage/);
  } finally { await app.close(); }
});

test('changing the date invalidates a patient open already in progress', async () => {
  const delayed = deferred();
  let navigated = false;
  const app = await setup(async kind => kind === 'visits' ? { rows: [visit], next: null } : empty,
    async (_id, stillOpen) => { await delayed.promise; navigated = stillOpen(); });
  try {
    await app.render();
    await app.click('Open patient Fictional pet');
    await app.select('2026-11-18');
    await act(async () => delayed.resolve());
    assert.equal(navigated, false);
  } finally { await app.close(); }
});

test('reconnecting never renders the old complete total while fresh reads start', async () => {
  const firstPaints = [];
  const fresh = deferred();
  let reconnecting = false;
  const app = await setup(async kind => kind === 'entries'
    ? reconnecting ? fresh.promise : { rows: [payment], next: null }
    : empty, undefined, (body, props) => { if (reconnecting && props.online) firstPaints.push(body); });
  try {
    await app.render();
    assert.match(app.doc.body.textContent, /PHP 500\.00/);
    await app.render({ online: false });
    reconnecting = true;
    await app.render({ online: true });
    assert.ok(firstPaints.length);
    for (const body of firstPaints) assert.doesNotMatch(body, /PHP 500\.00/);
  } finally { await app.close(); }
});
