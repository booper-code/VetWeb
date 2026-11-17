import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, loadSource, domHarness } from './helpers/tsx-harness.mjs';
const values = loadSource('../../lib/appointment-values.ts');
const { createMutationScope } = loadSource('../../lib/mutation-scope.ts');
const patient = { id: 'shared-patient', name: 'Synthetic', ownerName: 'Fixture', ownerContact: '+639123456789', ownerEmail: 'fixture@example.com' };
const now = new Date().toISOString();
const row = { id: 'same-id', revision: 1, patientId: patient.id, patientName: patient.name,
  ownerName: patient.ownerName, ownerContact: patient.ownerContact, ownerEmail: patient.ownerEmail,
  dueAt: now, type: 'Vaccination', status: 'scheduled', durationMinutes: 30, notes: 'Keep this scheduling note',
  occurredAt: null, createdAt: now, updatedAt: now, createdBy: 'owner', updatedBy: 'owner' };
const draft = { patientId: patient.id, dueAt: now, type: 'Vaccination', status: 'scheduled', durationMinutes: 30, notes: '', occurredAt: null };

async function hookHarness({ demo = false, canEdit = true, defaultWindow = values.defaultAppointmentWindow } = {}) {
  const dom = domHarness(), scope = createMutationScope();
  const reads = [], writes = [];
  const { useAppointments } = loadSource('../../lib/useAppointments.ts', {
    react: React, '@/lib/appointment-values': { ...values, defaultAppointmentWindow: defaultWindow },
    '@/lib/appointments': {
      loadAppointmentsPage(...args) { const pending = deferred(); reads.push({ args, ...pending }); return pending.promise; },
      saveAppointment(input) { const pending = deferred(); writes.push({ input, ...pending }); return pending.promise; },
    },
  });
  let result;
  function Screen({ clinicId, uid, online, canEdit }) {
    result = useAppointments({ clinicId, uid, online, canEdit, patients: [patient], scope, workspaceGeneration: scope.capture() });
    return React.createElement('div', null, result.rows.map(row => row.patientName).join(','));
  }
  const render = async (clinicId = demo ? 'demo-clinic' : 'clinic-a', uid = 'owner', online = true, editable = canEdit) =>
    act(async () => { dom.root.render(React.createElement(Screen, { clinicId, uid, online, canEdit: editable })); });
  await render();
  return { ...dom, reads, writes, render, scope, get result() { return result; },
    async resolveRead(index, records, hasMore = false) {
      await act(async () => { reads[index].resolve({ records, hasMore, fromCache: false, cursor: `cursor-${index}` }); });
    },
  };
}
for (const transition of ['switch', 'logout', 'wipe']) {
  test(`appointment reads/saves/old callback entry are scoped across ${transition}`, async () => {
    const app = await hookHarness();
    try {
      await app.resolveRead(0, [row]);
      const oldSave = app.result.save;
      let completing;
      await act(async () => { completing = oldSave(row.id, 1, { ...draft, notes: 'Delayed A' }); });
      assert.equal(app.writes.length, 1);
      app.scope.invalidate();
      if (transition !== 'switch') await app.render(null, null);
      await app.render('clinic-b');
      assert.equal(app.result.rows.length, 0, 'must not display previous clinic data');
      await app.resolveRead(1, [{ ...row, patientName: 'Clinic B same ID' }]);
      await act(async () => { app.writes[0].resolve({ ...row, notes: 'Delayed A' }); assert.equal(await completing, false); });
      assert.equal(app.result.rows[0].patientName, 'Clinic B same ID');
      assert.equal(await oldSave('stale-child', null, draft), false);
      assert.equal(app.writes.length, 1);
    } finally { await app.close(); }
  });
}
test('failed saves retain records and synchronous double submission starts one operation', async () => {
  const app = await hookHarness();
  try {
    await app.resolveRead(0, [row]);
    let saving;
    await act(async () => { saving = app.result.save(row.id, 1, draft).catch(error => error); });
    await assert.rejects(app.result.save(row.id, 1, draft), /already saving/);
    assert.equal(app.writes.length, 1);
    await act(async () => { app.writes[0].reject(new Error('Conflict: refresh')); await saving; });
    assert.equal(app.result.rows[0].notes, row.notes);
    assert.equal(app.result.rows[0].revision, 1);
  } finally { await app.close(); }
});
for (const outside of [false, true]) {
  test(`a late schedule read cannot undo a committed ${outside ? 'reschedule outside the window' : 'create/edit'}`, async () => {
    const app = await hookHarness();
    try {
      let saving;
      const saved = { ...row, revision: 2, notes: 'Committed latest',
        dueAt: outside ? '2001-01-01T12:00:00.000Z' : row.dueAt };
      await act(async () => { saving = app.result.save(row.id, 1, { ...draft, dueAt: saved.dueAt }); });
      await act(async () => { app.writes[0].resolve(saved); assert.equal(await saving, true); });
      await app.resolveRead(0, [row]);
      if (outside) assert.equal(app.result.rows.length, 0);
      else {
        assert.equal(app.result.rows[0].revision, 2);
        assert.equal(app.result.rows[0].notes, 'Committed latest');
      }
    } finally { await app.close(); }
  });
}
test('schedule refresh rejects stale read completions and retries without duplicate rows', async () => {
  const app = await hookHarness();
  try {
    let refresh;
    await act(async () => { refresh = app.result.load(true); });
    await app.resolveRead(0, [{ ...row, patientName: 'Stale' }]);
    assert.equal(app.result.rows.length, 0);
    await app.resolveRead(1, [row], true);
    await refresh;
    let more;
    await act(async () => { more = app.result.load(); });
    await act(async () => { app.reads[2].reject(new Error('offline')); await more; });
    assert.equal(app.result.rows.length, 1);
    assert.ok(app.result.error);
    await act(async () => { more = app.result.load(); });
    await app.resolveRead(3, [row, { ...row, id: 'next-id' }]);
    await more;
    assert.equal(app.result.rows.length, 2);
    assert.equal(app.reads[3].args[2], 'cursor-1');
  } finally { await app.close(); }
});
test('viewer/offline edits are refused before any cloud call', async () => {
  const app = await hookHarness({ canEdit: false });
  try {
    await app.resolveRead(0, [row]);
    await assert.rejects(app.result.save(row.id, 1, draft), /owner or editor/);
    await app.render('clinic-a', 'owner', false, true);
    await assert.rejects(app.result.save(row.id, 1, draft), /owner or editor/);
    assert.equal(app.writes.length, 0);
  } finally { await app.close(); }
});
test('offline demo scheduling stays entirely in memory and clears on sign-out', async () => {
  const app = await hookHarness({ demo: true });
  try {
    await app.render('demo-clinic', 'demo-user', false, true);
    await act(async () => { assert.equal(await app.result.save('demo-appointment', null, draft), true); });
    assert.equal(app.result.rows.length, 1);
    await act(async () => { assert.equal(await app.result.save('demo-appointment', 1, { ...draft, status: 'cancelled' }), true); });
    assert.equal(app.result.rows[0].status, 'cancelled');
    assert.equal(app.reads.length, 0); assert.equal(app.writes.length, 0);
    app.scope.invalidate(); await app.render(null, null);
    await app.render('demo-clinic', 'demo-user', false, true);
    assert.equal(app.result.rows.length, 0);
  } finally { await app.close(); }
});
test('a changed date range cannot receive a late saved row from the previous query', async () => {
  const app = await hookHarness();
  try {
    await app.resolveRead(0, [row]);
    let save;
    await act(async () => { save = app.result.save(row.id, 1, draft); });
    await act(async () => { app.result.changeWindow({ from: '2001-01-01', through: '2001-01-02' }); });
    await app.resolveRead(1, []);
    await act(async () => { app.writes[0].resolve(row); assert.equal(await save, false); });
    assert.equal(app.result.rows.length, 0);
  } finally { await app.close(); }
});
test('refresh advances the default window after a day change, without overriding custom dates', async () => {
  let current = { from: '2026-10-16', through: '2026-12-15' };
  const app = await hookHarness({ defaultWindow: () => current });
  try {
    await app.resolveRead(0, [row]);
    current = { from: '2026-10-17', through: '2026-12-16' };
    await act(async () => { await app.result.load(true); });
    assert.equal(app.result.window.from, current.from);
    assert.equal(app.reads.length, 2);
    assert.equal(app.reads[1].args[1].through, current.through);
    await app.resolveRead(1, []);
    await act(async () => { app.result.changeWindow({ from: '2001-01-01', through: '2001-01-02' }); });
    await app.resolveRead(2, []);
    current = { from: '2026-10-18', through: '2026-12-17' };
    let refresh;
    await act(async () => { refresh = app.result.load(true); });
    assert.equal(app.reads[3].args[1].from, '2001-01-01');
    await app.resolveRead(3, []); await refresh;
    assert.equal(app.result.window.from, '2001-01-01');
  } finally { await app.close(); }
});

async function viewHarness({ canEdit = true, save = async () => true } = {}) {
  const dom = domHarness();
  const { AppointmentsView } = loadSource('../../components/AppointmentsView.tsx', {
    react: React, '@/lib/appointment-values': values,
  }, { window: dom.window, navigator: dom.window.navigator, document: dom.window.document });
  dom.window.confirm = () => true;
  await act(async () => dom.root.render(React.createElement(AppointmentsView, {
    rows: [row], patients: [patient], canEdit, isDemo: true, online: false,
    busy: false, loaded: true, error: '', hasMore: false, fromCache: true,
    window: values.defaultAppointmentWindow(), refreshedAt: now, clinicId: 'demo-clinic', searchQuery: '',
    onWindow() {}, onLoad: async () => {}, onSave: save, onOpenPatient: async () => {},
  })));
  return dom;
}
test('real form retains its draft on failure and locks duplicate submits', async () => {
  const pending = deferred(), calls = [];
  const app = await viewHarness({ save: (...args) => { calls.push(args); return pending.promise; } });
  try {
    const edit = [...app.window.document.querySelectorAll('button')].find(button => button.textContent.startsWith('Edit appointment'));
    await act(() => edit.click());
    const form = app.window.document.querySelector('form[aria-label="Appointment details"]');
    assert.ok(form);
    await act(async () => {
      form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(calls.length, 1);
    await act(async () => { pending.reject(new Error('Save failed: keep the form')); await pending.promise.catch(() => {}); });
    assert.equal(form.querySelector('textarea').value, row.notes);
    assert.match(app.window.document.querySelector('[role="alert"]').textContent, /keep the form/);
    assert.match(app.window.document.body.textContent, /Cached results may be incomplete/);
  } finally { await app.close(); }
});
test('viewer sees schedule but no enabled editing controls', async () => {
  const app = await viewHarness({ canEdit: false });
  try {
    for (const button of [...app.window.document.querySelectorAll('button')].filter(button => /New appointment|Edit appointment/.test(button.textContent))) {
      assert.equal(button.disabled, true);
    }
    assert.match(app.window.document.body.textContent, /Synthetic/);
    assert.equal(app.window.document.querySelector('form[aria-label="Appointment details"]'), null);
  } finally { await app.close(); }
});

test('clinic JSON backup includes appointments alongside audit collections', async () => {
  let blob;
  const { exportClinicBackup } = loadSource('../../lib/backup.ts', {
    '@/lib/firebase': { initializeFirebase: async () => ({ db: {}, firestore: {
      collection: (_, ...path) => path, doc: (_, ...path) => path, documentId: () => '__name__',
      orderBy: value => value, limit: value => value, query: path => path,
      getDoc: async () => ({ exists: () => true, id: 'clinic', data: () => ({ name: 'Synthetic' }) }),
      getDocs: async path => {
        const records = path.at(-1) === 'appointments' ? [{ id: row.id, data: () => row }] : [];
        return { docs: records, size: records.length };
      },
    } }) },
  }, {
    Blob, URL: { createObjectURL: value => { blob = value; return 'blob:test'; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
  });
  const result = await exportClinicBackup({ clinicId: 'clinic', clinicName: 'Synthetic' });
  const backup = JSON.parse(await blob.text());
  assert.equal(backup.collections.appointments[0].id, row.id);
  assert.ok('auditHeads' in backup.collections);
  assert.ok('auditEvents' in backup.collections);
  assert.equal(result.documentCount, 1);
});
test('dashboard reminder dates recalculate on focus without background record fetching', async () => {
  const dom = domHarness();
  let calculations = 0, fetches = 0;
  const { AppointmentReminders } = loadSource('../../components/AppointmentReminders.tsx', {
    react: React, '@/lib/appointment-values': { appointmentReminders: () => {
      calculations += 1; return { overdue: [], today: [], upcoming: [] };
    } },
  }, { window: dom.window, document: dom.window.document });
  Object.defineProperty(dom.window.document, 'hidden', { value: false, configurable: true });
  try {
    await act(async () => dom.root.render(React.createElement(AppointmentReminders, {
      rows: [], busy: false, error: '', fromCache: false, partial: false, range: 'test range',
      onOpen() {}, onRefresh: () => { fetches += 1; },
    })));
    const before = calculations;
    await act(() => dom.window.dispatchEvent(new dom.window.Event('focus')));
    assert.ok(calculations > before);
    assert.equal(fetches, 0);
    await act(() => [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === 'Refresh appointments').click());
    assert.equal(fetches, 1);
  } finally { await dom.close(); }
});
