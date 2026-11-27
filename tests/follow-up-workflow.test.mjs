import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, domHarness, loadSource } from './helpers/tsx-harness.mjs';

const defaultNow = () => Date.parse('2026-11-18T16:05:00Z');
const first = { id: 'one', patientId: 'pet-one', patientName: 'Fictional first', ownerName: 'Owner',
  ownerEmail: '', ownerContact: '', dueAt: '2026-11-18T15:00:00Z', type: 'Follow-up', status: 'scheduled', revision: 1 };
const contact = { dueAt: first.dueAt, contactedAt: '2026-11-18T16:05:00Z', contactedBy: 'fictional-user' };
const empty = { rows: [], next: null };
const find = (doc, label) => [...doc.querySelectorAll('button')].find(button => button.textContent.trim() === label);

async function setup(props = {}, now = defaultNow) {
  const dom = domHarness();
  class ManilaDate extends Date {
    static now() { return now(); }
  }
  const { FollowUpQueue } = loadSource('../../components/FollowUpQueue.tsx', { react: React }, { Date: ManilaDate });
  const defaults = { canEdit: true, online: true, isCurrent: () => true, load: async () => ({ rows: [first], next: null }),
    onContact: async () => ({ ...first, revision: 2, followUpContact: contact }), onOpenPatient: async () => {}, onBack: () => {}, ...props };
  const render = (overrides = {}, key = 'first') => act(async () => { dom.root.render(React.createElement(FollowUpQueue, { key, ...defaults, ...overrides })); });
  const doc = dom.window.document;
  const click = async label => {
    const button = find(doc, label);
    assert.ok(button, `Missing button ${label}`);
    await act(async () => { button.click(); });
  };
  await render();
  return { ...dom, doc, render, click };
}

test('an open follow-up queue applies confirmed remote contact and removes rescheduled rows', async () => {
  let watch;
  const app = await setup({
    subscribe(size, endMs, accept, fail, deny) {
      watch = { size, endMs, accept, fail, deny };
      return Promise.resolve(() => {});
    },
  });
  try {
    assert.ok(watch?.size > 0);
    await act(async () => watch.accept({ rows: [first], next: null }));
    assert.match(app.doc.body.textContent, /Needs contact/);
    await act(async () => watch.accept({ rows: [{ ...first, revision: 2, followUpContact: contact }], next: null }));
    assert.match(app.doc.body.textContent, /Contact recorded/);
    await act(async () => watch.accept({ rows: [], next: null }));
    assert.doesNotMatch(app.doc.body.textContent, /Fictional first/);
    await act(async () => watch.deny(new Error('Revoked')));
    await act(async () => watch.accept({ rows: [first], next: null }));
    assert.doesNotMatch(app.doc.body.textContent, /Fictional first/);
    assert.match(app.doc.body.textContent, /access changed/i);
  } finally { await app.close(); }
});

test('Manila rollover retains the subscribed page depth and a pending contact save', async () => {
  const write = deferred();
  let now = defaultNow();
  let watch;
  const app = await setup({
    subscribe(size, endMs, accept) {
      watch = { size, endMs, accept };
      return Promise.resolve(() => {});
    },
    onContact: () => write.promise,
  }, () => now);
  try {
    await act(async () => watch.accept({ rows: [first], next: 1 }));
    await app.click('Load more follow-ups');
    assert.equal(watch.size, 50);
    await act(async () => watch.accept({ rows: [first], next: null }));
    await app.click('Mark contacted');
    const yesterday = watch;

    now = Date.parse('2026-11-19T16:01:00Z');
    await act(async () => app.window.dispatchEvent(new app.window.Event('focus')));
    assert.equal(watch.size, 50);
    assert.equal(watch.endMs, Date.parse('2026-11-20T16:00:00Z'));
    await act(async () => watch.accept({ rows: [first], next: null }));
    await act(async () => yesterday.accept(empty));
    assert.match(app.doc.body.textContent, /Fictional first.*Saving/);
    await act(async () => write.resolve({ ...first, revision: 2, followUpContact: contact }));
    assert.match(app.doc.body.textContent, /Contact recorded/);
    assert.equal(find(app.doc, 'Undo contact').disabled, false);
  } finally { await app.close(); }
});

test('a paged queue records contact once without completing the visit', async () => {
  const recorded = deferred();
  let writes = 0, reads = 0;
  const app = await setup({
    load: async (after, endMs) => {
      reads++;
      assert.equal(endMs, Date.parse('2026-11-19T16:00:00Z'));
      return after === null ? { rows: [first], next: 1 } : { rows: [{ ...first, id: 'two', patientName: 'Fictional second' }], next: null };
    },
    onContact: row => { writes++; assert.equal(row.id, first.id); assert.equal(row.status, 'scheduled'); return recorded.promise; },
  });
  try {
    assert.match(app.doc.body.textContent, /More follow-ups are available/);
    await app.click('Load more follow-ups');
    assert.equal(reads, 2);
    assert.match(app.doc.body.textContent, /Fictional second/);
    await app.click('Mark contacted');
    const pendingButton = find(app.doc, 'Mark contacted');
    assert.ok(!pendingButton || pendingButton.disabled);
    assert.equal(writes, 1);
    await act(async () => { recorded.resolve({ ...first, revision: 2, followUpContact: contact }); });
    assert.match(app.doc.body.textContent, /Contact recorded/);
    assert.match(app.doc.body.textContent, /Appointment remains scheduled/);
  } finally { await app.close(); }
});

test('viewers can see due follow-ups but cannot record contact; offline is not a complete queue', async () => {
  let reads = 0;
  const app = await setup({ canEdit: false, load: async () => { reads++; return { rows: [first], next: null }; } });
  try {
    assert.match(app.doc.body.textContent, /Fictional first/);
    assert.equal(find(app.doc, 'Mark contacted'), undefined);
    await app.render({ online: false }, 'offline');
    assert.match(app.doc.body.textContent, /Offline/);
    assert.doesNotMatch(app.doc.body.textContent, /Fictional first/);
    assert.equal(reads, 1);
  } finally { await app.close(); }
});

test('staff can correct a mistaken contact without changing the scheduled visit', async () => {
  const recorded = { ...first, revision: 2, followUpContact: contact };
  const app = await setup({ load: async () => ({ rows: [recorded], next: null }),
    onContact: async (row, contacted) => {
      assert.equal(row.id, first.id);
      assert.equal(contacted, false);
      return { ...first, revision: 3 };
    } });
  try {
    await app.click('Undo contact');
    assert.match(app.doc.body.textContent, /Needs contact/);
    assert.doesNotMatch(app.doc.body.textContent, /Contact recorded/);
  } finally { await app.close(); }
});

test('late loads and patient navigation do not survive switching workspaces', async () => {
  const delayed = deferred();
  const app = await setup({ load: () => delayed.promise });
  try {
    await app.render({ load: async () => empty }, 'another-clinic');
    await act(async () => { delayed.resolve({ rows: [first], next: null }); });
    assert.doesNotMatch(app.doc.body.textContent, /Fictional first/);
  } finally { await app.close(); }
  const opening = deferred();
  let navigated = false;
  const next = await setup({ onOpenPatient: async (id, active) => { await opening.promise; navigated = id === first.patientId && active(); } });
  try {
    await next.click('Open patient Fictional first');
    await next.render({ load: async () => empty }, 'another-clinic');
    await act(async () => { opening.resolve(); });
    assert.equal(navigated, false);
  } finally { await next.close(); }
});

test('a pending contact result cannot update a different clinic', async () => {
  const write = deferred();
  const app = await setup({ onContact: () => write.promise });
  try {
    await app.click('Mark contacted');
    await app.render({ load: async () => empty }, 'another-clinic');
    await act(async () => { write.resolve({ ...first, revision: 2, followUpContact: contact }); });
    assert.match(app.doc.body.textContent, /No scheduled follow-ups are due/);
    assert.doesNotMatch(app.doc.body.textContent, /Contact recorded|Fictional first/);
  } finally { await app.close(); }
});
