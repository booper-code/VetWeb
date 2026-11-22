import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function load(entry) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
}

const q = await load('../lib/clinic-query.ts');
const {
  parseClinicQueryPlan, projectQueryRow, executeClinicQuery,
  roleAllowed, buildClinicQuerySchema, CLINIC_TABLE_IDS,
} = q;

const plan = value => {
  const parsed = parseClinicQueryPlan(value);
  assert.ok(parsed, `plan must validate: ${JSON.stringify(value)}`);
  return parsed;
};
const run = (value, source) => executeClinicQuery(plan(value), source);
const ok = rows => ({ status: 'ok', rows, complete: true });

test('expiry and overdue comparisons exclude missing or invalid dates', () => {
  const source = ok(['', '2026-02-30', '2026-02-01', '2026-03-05'].map((expiryDate, i) =>
    projectQueryRow('inventory', String(i), { itemCode: String(i), expiryDate })));
  const result = run({ table: 'inventory', op: 'list', fields: ['itemCode'],
    filter: [{ field: 'expiryDate', op: 'lt', value: '2026-03-01' }] }, source);
  assert.deepEqual(result.rows, [{ itemCode: '2' }]);
  assert.deepEqual(run({ table: 'inventory', op: 'list', fields: ['itemCode'],
    filter: [{ field: 'expiryDate', op: 'gte', value: '2026-02-28' }] }, source).rows, [{ itemCode: '3' }]);
  const appointments = ok([projectQueryRow('appointments', 'invalid', { dueAt: '' })]);
  assert.equal(run({ table: 'appointments', op: 'count',
    filter: [{ field: 'dueAt', op: 'lt', value: '2026-03-01T16:00:00Z' }] }, appointments).count, 0);
});

test('appointment projection exposes only the outreach state for the current due date', () => {
  const dueAt = '2026-11-20T05:00:00Z';
  const contact = { dueAt, contactedAt: '2026-11-19T06:00:00Z', contactedBy: 'private-id' };
  const current = projectQueryRow('appointments', '1', { dueAt, type: 'Follow-up', followUpContact: contact });
  assert.equal(current.outreachStatus, 'Logged');
  assert.equal(current.manilaDueTime, '2026-11-20 13:00');
  assert.equal(current.followUpContact, undefined);
  const stale = projectQueryRow('appointments', '2', { dueAt: '2026-11-21T05:00:00Z', type: 'Follow-up', followUpContact: contact });
  assert.equal(stale.outreachStatus, 'Not logged');
  const invalid = projectQueryRow('appointments', '3', { dueAt, type: 'Follow-up', followUpContact: { dueAt } });
  assert.equal(invalid.outreachStatus, 'Could not verify');
});

const patient = (name, status = 'Waiting', balance = 0) => ({ id: `PAT-${name}`, name, status, balance });
const fourPatients = [
  patient('QA Mango'), patient('QA Mochi', 'Discharged', 500),
  patient('QA Pepper', 'In Treatment', 250), patient('QA Luna', 'Discharged', 0),
];

test('schema covers all clinic domains with role levels and no data', () => {
  assert.deepEqual([...CLINIC_TABLE_IDS], [
    'patients', 'inventory', 'appointments', 'consultations', 'staff',
    'billingEntries', 'auditEvents', 'payrollLedger', 'payrollPeriods', 'payProfiles',
  ]);
  const schema = buildClinicQuerySchema();
  assert.match(schema, /patients \[member\]/);
  assert.match(schema, /billingEntries \[editor\]/);
  assert.match(schema, /auditEvents \[owner\]/);
  assert.doesNotMatch(schema, /QA Mango|PAT-|Private Owner|fictional/i);
  assert.equal(roleAllowed('viewer', 'member'), true);
  assert.equal(roleAllowed('viewer', 'editor'), false);
  assert.equal(roleAllowed('editor', 'editor'), true);
  assert.equal(roleAllowed('editor', 'owner'), false);
  assert.equal(roleAllowed(null, 'member'), false);
});

test('projection drops notes, owner contact, clinical and financial payload fields', () => {
  const row = projectQueryRow('patients', 'PAT-1', {
    name: 'QA Mango', status: 'Waiting', balance: 25, ownerName: 'Owner',
    ownerContact: 'private-contact', ownerEmail: 'private@example.com', ownerAddress: 'private address',
    notes: 'private clinical note', labResults: [{ findings: 'secret' }], aiLabSummary: 'secret',
    pictures: ['secret'], billing: { balanceMinor: 2500 }, reason: 'secret', weight: 12,
  });
  assert.deepEqual(Object.keys(row).sort(), [
    'balance', 'breed', 'dischargedAt', 'gender', 'id', 'name', 'ownerName', 'species', 'status', 'weight',
  ].sort());
  assert.equal(row.name, 'QA Mango');
  assert.equal(row.balance, 25);
  for (const secret of ['ownerContact', 'ownerEmail', 'notes', 'labResults', 'billing', 'reason', 'pictures']) {
    assert.equal(row[secret], undefined);
  }
  const visit = projectQueryRow('consultations', 'C-1', { patient: 'Milo', treatments: [{ id: 'a' }, { id: 'b' }], notes: 'secret' });
  assert.equal(visit.treatmentCount, 2);
  assert.equal(visit.notes, undefined);

  // Modern balances and legacy fallbacks match the app's own normalizers.
  const modern = projectQueryRow('patients', 'PAT-2', { name: 'Milo', billing: { balanceMinor: 2500 }, status: 'odd' });
  assert.equal(modern.balance, 25);
  assert.equal(modern.status, 'Waiting');
  const legacy = projectQueryRow('patients', 'PAT-3', { name: 'Milo', balance: 7 });
  assert.equal(legacy.balance, 7);
});

test('four-patient longest and shortest name over the full directory, with rank ties', () => {
  const longest = run({ table: 'patients', op: 'rank',
    sort: [{ field: 'name', transform: 'length', direction: 'desc' }], limit: 1, includeTies: true }, ok(fourPatients));
  assert.equal(longest.status, 'ok');
  assert.equal(longest.rows.length, 1);
  assert.equal(longest.rows[0].name, 'QA Pepper');
  assert.match(longest.message, /longest name is "QA Pepper" \(9 characters\)/);

  const shortest = run({ table: 'patients', op: 'rank',
    sort: [{ field: 'name', transform: 'length', direction: 'asc' }], limit: 1, includeTies: true }, ok(fourPatients));
  assert.equal(shortest.rows[0].name, 'QA Luna');
  assert.match(shortest.message, /shortest name is "QA Luna" \(7 characters\)/);

  const tied = [
    patient('QA Mango'), patient('BB Mango'), patient('QA Luna'),
  ];
  const tieResult = run({ table: 'patients', op: 'rank',
    sort: [{ field: 'name', transform: 'length', direction: 'desc' }], limit: 1, includeTies: true }, ok(tied));
  assert.deepEqual(tieResult.rows.map(row => row.name), ['BB Mango', 'QA Mango']);
  assert.match(tieResult.message, /2 names share this length/);
});

test('generic operations: count, filter, list, sort/limit, sum and group', () => {
  const counted = run({ table: 'patients', op: 'count',
    filter: [{ field: 'status', op: 'eq', value: 'Discharged' }] }, ok(fourPatients));
  assert.equal(counted.count, 2);
  assert.match(counted.message, /There are 2 patients/);

  const listed = run({ table: 'patients', op: 'list', fields: ['name'],
    sort: [{ field: 'name', transform: 'length', direction: 'desc' }], limit: 2 }, ok(fourPatients));
  assert.deepEqual(listed.rows, [{ name: 'QA Pepper' }, { name: 'QA Mango' }]);

  const summed = run({ table: 'patients', op: 'sum', sumField: 'balance' }, ok(fourPatients));
  assert.equal(summed.message, 'The total balance across 4 patients is 750.');
  const filteredSum = run({ table: 'patients', op: 'sum', sumField: 'balance',
    filter: [{ field: 'status', op: 'eq', value: 'Discharged' }] }, ok(fourPatients));
  assert.match(filteredSum.message, /across 2 patients/);

  const grouped = run({ table: 'patients', op: 'group', groupBy: 'status' }, ok(fourPatients));
  assert.deepEqual(grouped.groups, [
    { key: 'Waiting', count: 1 }, { key: 'Discharged', count: 2 }, { key: 'In Treatment', count: 1 },
  ].sort((a, b) => b.count - a.count));
});

test('species filters match clinic terminology without losing unrecognized species', () => {
  const source = ok([
    projectQueryRow('patients', '1', { species: 'Canine' }),
    projectQueryRow('patients', '2', { species: 'Canine' }),
    projectQueryRow('patients', '3', { species: 'Feline' }),
    projectQueryRow('patients', '4', { species: 'Rabbit' }),
  ]);
  for (const [op, value, expected] of [
    ['eq', 'dogs', 2], ['eq', 'canine', 2], ['in', ['dog', 'cats'], 3],
    ['neq', 'dog', 2], ['eq', 'rabbit', 1], ['eq', 'dogfish', 0],
  ]) {
    const result = run({ table: 'patients', op: 'count', filter: [{ field: 'species', op, value }] }, source);
    assert.equal(result.count, expected, `${op} ${value}`);
  }
});

const inventoryFixture = ok([
  ['MED-A', 'Medicine', 60, 5],
  ['MED-B', 'Medicine', 4, 4],
  ['SUP-A', 'Supplies', 15, 10],
  ['SUP-B', 'Supplies', 0, 2],
  ['SUP-C', 'Supplies', 0, 0],
  ['SRV-A', 'Service', 61, 99],
  ['GRM-A', 'Grooming', 64, 99],
].map(([itemCode, category, stock, threshold]) => projectQueryRow('inventory', itemCode, {
  itemCode, category, stock, threshold, buyingPrice: 500,
})));

test('stock-unit sums omit service placeholders without changing catalog totals', () => {
  assert.equal(run({ table: 'inventory', op: 'count' }, inventoryFixture).count, 7);
  const result = run({ table: 'inventory', op: 'sum', sumField: 'stock' }, inventoryFixture);
  assert.equal(result.sum, 79);
  assert.match(result.message, /stock units.*5 stocked.*exclud/i);
});

test('a stock ranking explains distinct values and ties at the cutoff', () => {
  const result = run({ table: 'inventory', op: 'rank', limit: 2, includeTies: true, fields: ['itemCode', 'stock'],
    sort: [{ field: 'stock', direction: 'asc' }] }, inventoryFixture);
  assert.deepEqual(result.rows, [{ itemCode: 'SUP-B', stock: 0 }, { itemCode: 'SUP-C', stock: 0 }]);
  assert.match(result.message, /2 stocked items.*lowest stock/i);
  const more = run({ table: 'inventory', op: 'rank', limit: 3, fields: ['itemCode', 'stock'],
    sort: [{ field: 'stock', direction: 'asc' }] }, inventoryFixture);
  assert.deepEqual(more.rows.map(row => row.stock), [0, 0, 4]);
  assert.doesNotMatch(more.message, /3 records share/);
});

test('reorder alerts compare each stocked item with its own enabled threshold', () => {
  const result = run({ table: 'inventory', op: 'list', fields: ['itemCode'], filter: [
    { field: 'reorderDue', op: 'eq', value: true },
  ] }, inventoryFixture);
  assert.deepEqual(result.rows.map(row => row.itemCode), ['MED-B', 'SUP-B']);
});

test('partial and denied/unavailable sources are isolated and never exhaustive', () => {
  const partial = run({ table: 'patients', op: 'rank',
    sort: [{ field: 'name', transform: 'length', direction: 'desc' }], limit: 1 },
  { status: 'ok', rows: fourPatients, complete: false });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.truncated, true);
  assert.match(partial.message, /not necessarily the clinic-wide extreme/);

  const partialCount = run({ table: 'patients', op: 'count' }, { status: 'ok', rows: fourPatients, complete: false });
  assert.match(partialCount.message, /not a clinic-wide total/);
  const completeCount = run({ table: 'patients', op: 'count' }, ok(Array.from({ length: 150 }, () => ({}))));
  assert.equal(completeCount.status, 'ok');
  assert.equal(completeCount.count, 150);

  const denied = run({ table: 'payrollLedger', op: 'count' }, { status: 'denied' });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.rows.length, 0);
  assert.equal(denied.count, 0);
  assert.match(denied.message, /not available to your clinic role/);

  const unavailable = run({ table: 'billingEntries', op: 'count' }, { status: 'unavailable' });
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(unavailable.rows, []);
  assert.doesNotMatch(unavailable.message, /0 billing entries/);
});

test('plans reject unknown keys, fields, ops and malformed values', () => {
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'count', bogus: 1 }), null);
  assert.equal(parseClinicQueryPlan({ table: 'secrets', op: 'count' }), null);
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'write' }), null);
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'count', filter: [{ field: 'notes', op: 'eq', value: 'x' }] }), null);
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'count', filter: [{ field: 'name', op: 'eq', value: 'x', extra: 1 }] }), null);
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'list', fields: ['name', 'notes'] }), null);
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'list', fields: ['constructor'] }), null);
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'rank', sort: [{ field: 'balance', transform: 'length', direction: 'asc' }] }), null);
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'count', limit: 101 }), null);
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'count', filter: [{ field: 'status', op: 'in', value: [] }] }), null);
  assert.equal(parseClinicQueryPlan({ table: 'patients', op: 'sum' }), null);
});

test('no-match list distinguishes verified absence from an incomplete scan', () => {
  const plan = { table: 'patients', op: 'list', fields: ['name'],
    filter: [{ field: 'name', op: 'contains', value: 'no-such-patient' }] };
  assert.match(run(plan, ok(fourPatients)).message, /^No matching patients found\.$/);
  assert.match(run(plan, { status: 'ok', rows: fourPatients, complete: false }).message,
    /^No matching patients found among the records checked\./);
});

test('multi-query execution reads each table once and returns ordered, independent outcomes', async () => {
  const plans = [
    plan({ table: 'patients', op: 'count' }),
    plan({ table: 'inventory', op: 'count' }),
    plan({ table: 'patients', op: 'count', filter: [{ field: 'status', op: 'eq', value: 'Discharged' }] }),
  ];
  const reads = [];
  const outcomes = await q.executeClinicQueries(plans, async table => {
    reads.push(table);
    return table === 'patients' ? ok(fourPatients) : ok(Array.from({ length: 9 }, () => ({})));
  });
  assert.deepEqual(reads, ['patients', 'inventory']);
  assert.deepEqual(outcomes.map(({ table, count }) => [table, count]), [
    ['patients', 4], ['inventory', 9], ['patients', 2],
  ]);
});

test('one denied or unavailable table does not suppress other outcomes', async () => {
  const plans = ['payrollLedger', 'patients', 'inventory'].map(table => plan({ table, op: 'count' }));
  const outcomes = await q.executeClinicQueries(plans, async table => table === 'patients'
    ? { status: 'ok', rows: fourPatients, complete: false }
    : { status: table === 'payrollLedger' ? 'denied' : 'unavailable' });
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['denied', 'partial', 'unavailable']);
  assert.equal(outcomes[1].count, 4);
});

test('clinic result markup shows ordered labels, rows, groups and per-result access messages', async () => {
  const { outputFiles } = await build({
    stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx', contents: `
      import { renderToStaticMarkup } from 'react-dom/server';
      import { ClinicQueryResponse } from '@/components/WorkspaceAssistant';
      export const render = reply => renderToStaticMarkup(<ClinicQueryResponse reply={reply} />);
    ` },
    bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', write: false, logLevel: 'silent',
    // React's server renderer has native module imports.
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});` },
  });
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
  const plans = [
    plan({ table: 'patients', op: 'list', fields: ['name'], filter: [{ field: 'status', op: 'eq', value: 'Discharged' }] }),
    plan({ table: 'inventory', op: 'group', groupBy: 'category' }),
    plan({ table: 'payrollLedger', op: 'count' }),
  ];
  const sources = [
    { status: 'ok', rows: fourPatients, complete: false },
    ok([{ category: 'Supplies' }, { category: 'Supplies' }]),
    { status: 'denied' },
  ];
  const results = plans.map((plan, index) => ({ plan, outcome: executeClinicQuery(plan, sources[index]) }));
  const markup = render({ kind: 'results', results });
  assert.match(markup, /patients — list \(status is Discharged\).*Partial result.*<td[^>]*>QA Mochi<\/td>.*inventory items — group.*Supplies: 2.*payroll ledger entries — count.*Your clinic role could not read this area/);
  assert.match(render({ kind: 'result', ...results[0] }), /<details open=""/);
  assert.doesNotMatch(render({ kind: 'result', ...results[0] }), /<h3/);
});
