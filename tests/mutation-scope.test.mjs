import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, loadSource, domHarness } from './helpers/tsx-harness.mjs';

const patient = { id: 'shared-id', name: 'Synthetic A', species: 'Canine', breed: 'Mixed',
  gender: 'Unknown', ownerName: 'Fixture', ownerContact: '0000000000', weight: 1,
  balance: 0, status: 'Waiting', admissionTypes: [], reason: '', pictures: [], labResults: [] };
const item = { itemCode: 'shared-id', itemName: 'Synthetic A', category: 'Medicine',
  stock: 10, buyingPrice: 1, sellingPrice: 2, threshold: 1 };
const consultation = { id: 'shared-id', status: 'Draft', patient: 'Synthetic A' };

async function mountApp({ readPatient = async () => ({ exists: () => false }),
  init = async () => ({ auth: {}, db: {}, firestore: { doc: (_, ...path) => path, getDoc: readPatient } }),
  restore, trusted = false, billingCommit, billingRecords } = {}) {
  const dom = domHarness();
  const props = {};
  const pending = deferred();
  const signout = deferred();
  const calls = [];
  let deviceListener;
  const scopes = loadSource('../../lib/mutation-scope.ts');
  const stub = name => value => { props[name] = value; return null; };
  const components = new Proxy({}, { get: (_, name) => stub(name) });
  const source = loadSource('../../app/page.tsx', {
    react: React, 'lucide-react': { Sparkles: () => null },
    '@/lib/mutation-scope': scopes,
    '@/lib/useAppointments': { useAppointments: () => ({
      rows: [], busy: false, error: '', fromCache: false, hasMore: false,
      window: { from: '2026-11-01', through: '2026-12-01' }, load: async () => {}, save: async () => true,
    }) },
    '@/lib/clinic-pages': {
      patientFromDocument: (id, data) => ({ ...data, id, balance: data.billing ? data.billing.balanceMinor / 100 : data.balance }),
      inventoryFromDocument: (itemCode, data) => ({ ...data, itemCode }),
    },
    '@/lib/firebase': { initializeFirebase: init, dbRef: {}, firestore: {},
      restoreFirebaseSession: restore ?? (async () => null) },
    'firebase/auth': { signOut: () => signout.promise },
    '@/lib/clinical-mutations': {
      mutateClinicalRecord: input => { calls.push(input); return pending.promise; },
    },
    '@/lib/billing': {
      commitBilling: input => { calls.push(input); return billingCommit ? billingCommit(input) : pending.promise; },
      loadBillingRecords: billingRecords,
    },
    '@/lib/offline-device': {
      getDevicePreference: () => trusted ? 'trusted' : 'memory',
      watchDevicePreference: listener => { deviceListener = listener; return () => {}; },
    },
    '@/lib/useClinicPages': { useClinicPages: ({ clinicId, setPatients, setInventory, setConsultations }) => {
      React.useEffect(() => {
        if (!clinicId) return;
        const label = clinicId === 'clinic-a' ? 'Synthetic A' : 'Synthetic B';
        setPatients([{ ...patient, name: label }]);
        setInventory([{ ...item, itemName: label }]);
        setConsultations([{ ...consultation, patient: label }]);
      }, [clinicId, setPatients, setInventory, setConsultations]);
      return { state: {}, load() {} };
    } },
    '@/lib/patients': { nextPatientId: () => 'demo-id' },
    '@/lib/images': { MAX_PATIENT_DOC_BYTES: 900000, firestoreDocBytes: () => 100, formatBytes: String },
    '@/lib/record-validation': loadSource('../../lib/record-validation.ts'),
    '@/lib/clinics': { subscribeClinicAI: async () => () => {}, renameClinic: () => pending.promise },
    ...Object.fromEntries(['PageControls', 'OfflineDeviceSettings', 'AuditLogView', 'ImageStorageControls',
      'LoginScreen', 'Sidebar', 'Header', 'DashboardHome', 'PatientRecordsView', 'InventoryControlView',
      'AILaboratoryView', 'SystemSettingsView', 'AccountSettingsView', 'StaffPayrollView',
      'ClinicWorkspaceScreen', 'ClinicTeamView', 'AppointmentsView', 'AppointmentReminders'].map(name => [
      `@/components/${name}`, { __esModule: true, default: stub(name), [name]: components[name] },
    ])),
  }, {
    window: dom.window, navigator: dom.window.navigator,
    // Toast timers are irrelevant here and must not keep Node alive.
    setTimeout: () => 0,
    console: { log() {}, error() {} },
  });
  // Real React state/effects; shallow child doubles expose the page's callbacks.
  await act(() => dom.root.render(React.createElement(source.default)));
  await act(() => props.LoginScreen.onLoginSuccess({ uid: 'owner', email: 'fixture@example.com', displayName: 'Fixture' }));
  const select = async clinicId => act(() => props.ClinicWorkspaceScreen.onSelectClinic({
    clinicId, clinicName: clinicId, role: 'owner',
  }));
  await select('clinic-a');
  return { ...dom, props, pending, signout, calls, select,
    wipe: () => deviceListener('wipe'),
    tab: async name => act(() => props.Sidebar.setActiveTab(name)),
  };
}

const operations = {
  createQuickPatient: ['patients', props => props.PatientRecordsView.onCreatePatient(
    'Synthetic', 'Canine', 'Mixed', 'Unknown', 'Fixture', '0000000000', 1, [], '', [])],
  createInventoryItem: ['inventory', props => props.InventoryControlView.onAddInventoryItem(item)],
  updateInventoryItem: ['inventory', props => props.InventoryControlView.onUpdateInventoryItem(item)],
  deleteInventoryItem: ['inventory', props => props.InventoryControlView.onDeleteInventoryItem(item.itemCode)],
  updatePatientRecord: ['patients', props => props.PatientRecordsView.onUpdatePatient(patient)],
  deletePatientRecord: ['patients', props => props.PatientRecordsView.onDeletePatient(patient.id)],
  commitBilling: ['patients', props => props.PatientRecordsView.billingGateway.submit('opening', {
    kind: 'opening', cutoffMs: 1795000000000, verifiedMinor: 0, source: 'Fixture ledger',
  }, patient.id, 0)],
  toggleConsultationStatus: ['dashboard', props => props.DashboardHome.onToggleStatus(consultation.id)],
};
const completionResult = name => name === 'commitBilling'
  ? { patientRevision: 1, state: { balanceMinor: 120000, lastEntryId: 'opening' }, stock: [{ itemCode: item.itemCode, stock: 8, revision: 1 }] }
  : { revision: 1 };

test('uncertain checkout blocks a replacement and survives a clinic switch', async () => {
  let sends = 0;
  const app = await mountApp({ billingCommit: async () => { if (++sends === 1) throw new Error('Lost receipt response'); return completionResult('commitBilling'); } });
  try {
    await app.tab('patients');
    const draft = { kind: 'payment', amountMinor: 100, method: 'cash', occurredAtMs: 1795000000000 };
    let gateway = app.props.PatientRecordsView.billingGateway;
    await act(async () => { await assert.rejects(() => gateway.submit('original', draft, patient.id, 0), /Lost receipt/); });
    await act(() => app.props.Sidebar.onSwitchClinic()); await app.select('clinic-b'); await app.tab('patients');
    assert.equal(app.props.PatientRecordsView.billingGateway.pending(patient.id), null);
    await act(() => app.props.Sidebar.onSwitchClinic()); await app.select('clinic-a'); await app.tab('patients');
    gateway = app.props.PatientRecordsView.billingGateway;
    const unresolved = gateway.pending(patient.id);
    assert.equal(unresolved.operationId, 'original');
    await assert.rejects(() => gateway.submit('replacement', draft, patient.id, 0), /unconfirmed/i);
    assert.equal(sends, 1);
    await act(async () => { await gateway.submit(unresolved.operationId, unresolved.draft, patient.id, unresolved.expectedPatientRevision); });
    assert.equal(sends, 2);
    assert.equal(app.props.PatientRecordsView.billingGateway.pending(patient.id), null);
  } finally { await app.close(); }
});

test('billing replay and manual refresh replace whole records rather than relabel stale fields', async () => {
  const replay = completionResult('commitBilling');
  const fresh = { patient: { ...patient, revision: 8, billing: replay.state, notes: 'Newer clinical note' },
    inventory: [{ ...item, revision: 6, stock: 8, sellingPrice: 17 }] };
  const app = await mountApp({
    billingCommit: async () => ({ ...replay, patientRevision: 8, stock: fresh.inventory, records: fresh }),
    billingRecords: async () => ({ ...fresh, patient: { ...fresh.patient, revision: 9, notes: 'Latest clinical note' },
      inventory: [{ ...fresh.inventory[0], revision: 7, sellingPrice: 19 }] }),
  });
  try {
    await app.tab('patients');
    await act(async () => { await operations.commitBilling[1](app.props); });
    assert.equal(app.props.PatientRecordsView.patients[0].notes, 'Newer clinical note');
    assert.equal(app.props.PatientRecordsView.inventory[0].sellingPrice, 17);
    await act(async () => { await app.props.PatientRecordsView.billingGateway.refreshRecords(patient.id, [item.itemCode]); });
    assert.equal(app.props.PatientRecordsView.patients[0].notes, 'Latest clinical note');
    assert.equal(app.props.PatientRecordsView.inventory[0].sellingPrice, 19);
  } finally { await app.close(); }
});

for (const [name, [tab, invoke]] of Object.entries(operations)) {
  for (const transition of ['switch', 'logout', 'wipe']) {
    for (const failure of [false, true]) test(`${name}: late ${failure ? 'failure' : 'success'} after ${transition} is ignored`, async () => {
      const app = await mountApp();
      try {
        await app.tab(tab);
        let completion;
        await act(async () => { completion = invoke(app.props); completion = Promise.resolve(completion).catch(() => false); });
        assert.equal(app.calls.length, 1, 'test must reach the actual cloud mutation');
        if (transition === 'switch') {
          await act(() => app.props.Sidebar.onSwitchClinic());
          await app.select('clinic-b');
        } else if (transition === 'logout') {
          await act(async () => { void app.props.Sidebar.onLogout(); });
        } else await act(() => app.wipe());
        const before = app.window.document.body.textContent;
        await act(async () => {
          if (failure) app.pending.reject(new Error('Late failure must not toast'));
          else app.pending.resolve(completionResult(name));
          await completion;
        });
        assert.equal(app.window.document.body.textContent, before);
        if (transition === 'switch') {
          await app.tab(tab);
          const list = tab === 'inventory' ? app.props.InventoryControlView.inventory
            : tab === 'patients' ? app.props.PatientRecordsView.patients : app.props.DashboardHome.consultations;
          assert.equal(list.length, 1);
          assert.equal(list[0].name ?? list[0].itemName ?? list[0].patient, 'Synthetic B');
        }
      } finally { app.signout.resolve(); await app.close(); }
    });
  }
}

test('logout blocks every previously captured mutation callback before signOut resolves', async () => {
  const app = await mountApp();
  try {
    for (const tab of ['patients', 'inventory', 'dashboard']) await app.tab(tab);
    await act(async () => { void app.props.Sidebar.onLogout(); });
    for (const [, invoke] of Object.values(operations)) {
      await act(async () => { await Promise.resolve(invoke(app.props)).catch(() => false); });
    }
    assert.equal(app.calls.length, 0);
    assert.match(app.window.document.body.textContent, /Signing out/);
  } finally { app.signout.resolve(); await app.close(); }
});

for (const transition of ['switch', 'logout', 'wipe']) {
  test(`old child callbacks cannot start mutations after ${transition} completes`, async () => {
    const app = await mountApp();
    try {
      for (const tab of ['patients', 'inventory', 'dashboard']) await app.tab(tab);
      const oldProps = { ...app.props };
      if (transition === 'switch') {
        await act(() => app.props.Sidebar.onSwitchClinic());
        await app.select('clinic-b');
      } else if (transition === 'logout') {
        app.signout.resolve();
        await act(async () => { await app.props.Sidebar.onLogout(); });
      } else await act(() => app.wipe());
      for (const [, invoke] of Object.values(operations)) {
        await act(async () => { await Promise.resolve(invoke(oldProps)).catch(() => false); });
      }
      assert.equal(app.calls.length, 0, 'late child upload/import callbacks must not start an old-clinic write');
    } finally { await app.close(); }
  });
}

test('late admission initialization error does not toast into another clinic', async () => {
  const initialization = deferred();
  const app = await mountApp({ init: () => initialization.promise });
  try {
    await app.tab('patients');
    let completion;
    await act(async () => { completion = operations.createQuickPatient[1](app.props); });
    await act(() => app.props.Sidebar.onSwitchClinic());
    await app.select('clinic-b');
    const before = app.window.document.body.textContent;
    await act(async () => { initialization.reject(new Error('Late init failure')); await completion; });
    assert.equal(app.window.document.body.textContent, before);
    assert.equal(app.calls.length, 0);
  } finally { await app.close(); }
});

for (const [name, [tab, invoke]] of Object.entries(operations)) {
  test(`${name}: completion still updates the current workspace`, async () => {
    const app = await mountApp();
    try {
      await app.tab(tab);
      let completion;
      await act(async () => { completion = invoke(app.props); });
      assert.equal(app.calls.length, 1);
      await act(async () => {
        app.pending.resolve(completionResult(name));
        await completion;
      });
      const list = tab === 'inventory' ? app.props.InventoryControlView.inventory
        : tab === 'patients' ? app.props.PatientRecordsView.patients : app.props.DashboardHome.consultations;
      if (name.startsWith('delete')) assert.equal(list.length, 0);
      else if (name.startsWith('create')) assert.ok(list.some(record => record.revision === 1));
      else assert.equal(list[0].revision, 1);
      if (name === 'commitBilling') assert.equal(list[0].balance, 1200);
    } finally { await app.close(); }
  });
}

test('late rename and ownership/toast callbacks cannot change another clinic', async () => {
  const app = await mountApp();
  try {
    await app.tab('account');
    let completion;
    await act(async () => { completion = app.props.AccountSettingsView.onRenameClinic('Renamed A'); });
    const oldToast = app.props.AccountSettingsView.triggerToast;
    await app.tab('team');
    const oldTransfer = app.props.ClinicTeamView.onOwnershipTransferred;
    await act(() => app.props.Sidebar.onSwitchClinic());
    await app.select('clinic-b');
    await act(async () => {
      app.pending.resolve('Renamed A'); await completion;
      oldTransfer('editor'); oldToast('Stale clinic toast');
    });
    assert.equal(app.props.Sidebar.currentClinicName, 'clinic-b');
    assert.equal(app.props.Sidebar.currentClinicRole, 'owner');
    assert.doesNotMatch(app.window.document.body.textContent, /Stale clinic toast/);
  } finally { await app.close(); }
});

test('same-clinic ownership completion updates role without interrupting another view', async () => {
  const app = await mountApp();
  try {
    await app.tab('team');
    const transfer = app.props.ClinicTeamView.onOwnershipTransferred;
    await app.tab('patients');
    await act(() => transfer('editor'));
    assert.equal(app.props.Sidebar.currentClinicRole, 'editor');
    assert.equal(app.props.Sidebar.activeTab, 'patients');
  } finally { await app.close(); }
});

test('appointment links open a patient by document ID even when not on a loaded page', async () => {
  const app = await mountApp({ readPatient: async () => ({
    exists: () => true, id: 'archived-patient', data: () => ({ ...patient, id: 'wrong-stored-id', name: 'Archived', status: 'Discharged' }),
  }) });
  try {
    await app.tab('appointments');
    await act(async () => { await app.props.AppointmentsView.onOpenPatient('archived-patient'); });
    assert.equal(app.props.Sidebar.activeTab, 'patients');
    assert.equal(app.props.PatientRecordsView.initialPatientId, 'archived-patient');
    assert.equal(app.props.PatientRecordsView.patients.find(row => row.id === 'archived-patient').name, 'Archived');
  } finally { await app.close(); }
});
test('a late appointment patient lookup cannot navigate or add data to another clinic', async () => {
  const lookup = deferred();
  const app = await mountApp({ readPatient: () => lookup.promise });
  try {
    await app.tab('appointments');
    let opening;
    await act(async () => { opening = app.props.AppointmentsView.onOpenPatient('archived-patient'); });
    await act(() => app.props.Sidebar.onSwitchClinic()); await app.select('clinic-b');
    await act(async () => {
      lookup.resolve({ exists: () => true, id: 'archived-patient', data: () => patient }); await opening;
    });
    assert.equal(app.props.Sidebar.activeTab, 'dashboard');
    await app.tab('patients');
    assert.equal(app.props.PatientRecordsView.patients.length, 1);
    assert.equal(app.props.PatientRecordsView.patients[0].name, 'Synthetic B');
  } finally { await app.close(); }
});
test('leaving appointments cancels late patient navigation within the same clinic', async () => {
  const lookup = deferred();
  const app = await mountApp({ readPatient: () => lookup.promise });
  let stillOpen = true;
  try {
    await app.tab('appointments');
    let opening;
    await act(async () => { opening = app.props.AppointmentsView.onOpenPatient('archived-patient', () => stillOpen); });
    stillOpen = false; await app.tab('inventory');
    await act(async () => {
      lookup.resolve({ exists: () => true, id: 'archived-patient', data: () => patient }); await opening;
    });
    assert.equal(app.props.Sidebar.activeTab, 'inventory');
  } finally { await app.close(); }
});

test('session restoration cannot supersede an explicit login or its mutation', async () => {
  const restore = deferred();
  const app = await mountApp({ trusted: true, restore: () => restore.promise });
  try {
    await app.tab('patients');
    let completion;
    await act(async () => { completion = operations.updatePatientRecord[1](app.props); });
    await act(async () => {
      restore.resolve({ uid: 'obsolete-user', email: 'obsolete@example.com' });
      await restore.promise;
    });
    await act(async () => { app.pending.resolve({ revision: 1 }); await completion; });
    assert.equal(app.props.PatientRecordsView.patients[0].revision, 1);
    assert.equal(app.props.Sidebar.currentClinicName, 'clinic-a');
  } finally { await app.close(); }
});
