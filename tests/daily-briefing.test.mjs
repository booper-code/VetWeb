import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Offline aggregation tests for the real, deterministic local briefing builder.
// All records and times below are fictional. No Firebase or provider is used.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../lib/daily-briefing.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', logLevel: 'silent',
});
const { buildDailyBriefing, renderDailyBriefing, DAILY_BRIEFING_MAX_CHARS, DAILY_BRIEFING_SECTION_LIMIT } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

// 2026-11-22 17:30 UTC is 2026-11-23 01:30 in Asia/Manila.
const now = Date.parse('2026-11-22T17:30:00Z');
const section = (rows, complete = true, state = 'ready') => ({ state, complete, rows });
const input = (overrides = {}) => ({
  now, access: 'ok',
  scheduled: section([]), followUps: section([]), stock: section([]),
  ...overrides,
});
const appointment = (overrides = {}) => ({
  patientName: 'Milo', type: 'Checkup', status: 'scheduled',
  dueAt: '2026-11-23T02:30:00.000Z', ...overrides,
});
const item = (overrides = {}) => ({
  itemCode: 'QA-1', itemName: 'Sample item', category: 'Medicine',
  stock: 10, threshold: 5, buyingPrice: 1, sellingPrice: 2, ...overrides,
});

test('Manila day boundary decides today, due today and overdue', () => {
  const briefing = buildDailyBriefing(input({
    scheduled: section([
      appointment({ patientName: 'Midnight', dueAt: '2026-11-22T16:00:00.000Z' }),
      appointment({ patientName: 'Late', dueAt: '2026-11-23T15:59:00.000Z' }),
      appointment({ patientName: 'Yesterday', dueAt: '2026-11-22T15:59:00.000Z' }),
      appointment({ patientName: 'Tomorrow', dueAt: '2026-11-23T16:00:00.000Z' }),
      appointment({ patientName: 'Done', status: 'completed' }),
    ]),
    followUps: section([
      appointment({ patientName: 'Today', type: 'Follow-up', dueAt: '2026-11-23T02:30:00.000Z' }),
      appointment({ patientName: 'Old', type: 'Follow-up', dueAt: '2026-11-22T10:00:00.000Z' }),
    ]),
  }));
  assert.equal(briefing.today, '2026-11-23');
  assert.deepEqual(briefing.scheduled.map(row => row.patient), ['Midnight', 'Late']);
  assert.equal(briefing.scheduled[0].time, '2026-11-23 00:00');
  assert.equal(briefing.scheduled[1].time, '2026-11-23 23:59');
  assert.deepEqual(briefing.followUps.map(row => [row.patient, row.timing]), [
    ['Old', 'overdue'], ['Today', 'due today'],
  ]);
  assert.match(briefing.text, /Daily front-desk briefing for 2026-11-23 \(Asia\/Manila\)/);
  assert.match(briefing.text, /Old \(overdue since 2026-11-22/);
  assert.doesNotMatch(briefing.text, /Yesterday|Tomorrow|Done/);
});

test('status, type and contact rules: only scheduled follow-ups, current outreach only', () => {
  const contacted = { dueAt: '2026-11-23T02:30:00.000Z', contactedAt: '2026-11-22T18:00:00.000Z', contactedBy: 'fictional-staff' };
  const briefing = buildDailyBriefing(input({
    scheduled: section([
      appointment({ status: 'scheduled' }),
      appointment({ patientName: 'Cancelled', status: 'cancelled' }),
      appointment({ patientName: 'No-show', status: 'no-show' }),
    ]),
    followUps: section([
      appointment({ patientName: 'Logged', type: 'Follow-up', followUpContact: contacted }),
      appointment({ patientName: 'Stale', type: 'Follow-up', followUpContact: { ...contacted, dueAt: '2026-11-20T02:30:00.000Z' } }),
      appointment({ patientName: 'Wrong type', type: 'Checkup' }),
      appointment({ patientName: 'Completed', type: 'Follow-up', status: 'completed' }),
    ]),
  }));
  assert.deepEqual(briefing.scheduled.map(row => row.patient), ['Milo']);
  assert.deepEqual(briefing.followUps.map(row => [row.patient, row.outreach]), [
    ['Logged', 'logged'], ['Stale', 'not logged'],
  ]);
  assert.match(briefing.text, /Logged \(due today, outreach logged\)/);
  assert.match(briefing.text, /Stale \(due today, no outreach logged yet\)/);
  assert.doesNotMatch(briefing.text, /Cancelled|No-show|Wrong type|Completed/);
});

test('stock rules: reorder, out of stock, expired, today, soon and non-stock categories', () => {
  const briefing = buildDailyBriefing(input({
    stock: section([
      item({ itemName: 'Low', stock: 2, threshold: 5 }),
      item({ itemName: 'Out', stock: 0, threshold: 5 }),
      item({ itemName: 'Expired', stock: 3, threshold: 0, expiryDate: '2026-11-20' }),
      item({ itemName: 'Today', stock: 3, threshold: 0, expiryDate: '2026-11-23' }),
      item({ itemName: 'Soon', stock: 3, threshold: 0, expiryDate: '2026-12-10' }),
      item({ itemName: 'Fine', stock: 30, expiryDate: '2027-01-01' }),
      item({ itemName: 'Service', category: 'Service', stock: 0, threshold: 5 }),
      item({ itemName: 'Grooming', category: 'Grooming', stock: 0, threshold: 5 }),
    ]),
  }));
  assert.deepEqual(briefing.stock.map(row => [row.item, row.reasons]), [
    ['Expired', ['expired']],
    ['Low', ['reorder']],
    ['Out', ['reorder']],
    ['Soon', ['expiring-soon']],
    ['Today', ['expires-today']],
  ]);
  assert.match(briefing.text, /Out \(out of stock\)/);
  assert.match(briefing.text, /Low \(low stock: 2 left\)/);
  assert.match(briefing.text, /Expired \(expired 2026-11-20\)/);
  assert.match(briefing.text, /Today \(expires today\)/);
  assert.match(briefing.text, /Soon \(expiring soon 2026-12-10\)/);
  assert.doesNotMatch(briefing.text, /Fine|Service|Grooming/);
});

test('partial reads, unavailable reads and denial are independent and never empty all-clears', () => {
  const partial = buildDailyBriefing(input({
    scheduled: section([appointment()], false),
    followUps: section([], true, 'unavailable'),
    stock: section([], true, 'unavailable'),
  }));
  assert.equal(partial.complete.scheduled, false);
  assert.equal(partial.complete.followUps, false);
  assert.equal(partial.allComplete, false);
  assert.match(partial.text, /Scheduled today: Milo · Checkup 2026-11-23 10:30; partial read, more may exist/);
  assert.match(partial.text, /Follow-ups: could not be verified\. This does not mean nobody needs checking/);
  assert.match(partial.text, /Stock alerts: could not be verified\. This does not mean there were no alerts/);
  assert.doesNotMatch(partial.text, /none found/);

  const denied = buildDailyBriefing(input({
    access: 'denied',
    scheduled: section([appointment({ patientName: 'Private' })]),
    followUps: section([appointment({ patientName: 'Private', type: 'Follow-up' })]),
    stock: section([item({ itemName: 'Private item', stock: 0 })]),
  }));
  assert.deepEqual(denied.states, { scheduled: 'denied', followUps: 'denied', stock: 'denied' });
  assert.equal(denied.allComplete, false);
  assert.equal(denied.text.match(/access could not be verified/g).length, 3);
  assert.doesNotMatch(denied.text, /Private/);
});

test('hidden entries are capped and flagged, and the whole reply is bounded', () => {
  const many = Array.from({ length: DAILY_BRIEFING_SECTION_LIMIT + 3 }, (_, index) =>
    appointment({ patientName: `Patient ${index}`, dueAt: `2026-11-23T0${index}:00:00.000Z` }));
  const capped = buildDailyBriefing(input({ scheduled: section(many) }));
  assert.equal(capped.scheduled.length, DAILY_BRIEFING_SECTION_LIMIT);
  assert.equal(capped.hidden.scheduled, 3);
  assert.match(capped.text, /3 more not shown/);

  const long = renderDailyBriefing({
    today: '2026-11-23',
    states: { scheduled: 'ready', followUps: 'ready', stock: 'ready' },
    complete: { scheduled: true, followUps: true, stock: true },
    allComplete: true,
    hidden: { scheduled: 0, followUps: 0, stock: 0 },
    scheduled: [{ patient: 'P'.repeat(1200), type: 'Checkup', time: '2026-11-23 10:30' }],
    followUps: [{ patient: 'F'.repeat(1200), date: '2026-11-23', timing: 'due today', outreach: 'not logged' }],
    stock: [{ item: 'S'.repeat(1200), stock: 0, threshold: 5, reasons: ['reorder'] }],
  });
  assert.ok(long.length <= DAILY_BRIEFING_MAX_CHARS, `reply length ${long.length}`);
  assert.match(long, /Briefing shortened; open the normal screens for the full list\./);
});

test('empty, complete reads say what was checked without fabricating clinic-wide data', () => {
  const empty = buildDailyBriefing(input());
  assert.equal(empty.allComplete, true);
  assert.match(empty.text, /Scheduled today: none found in the checked records\. This is not a clinic-wide all-clear/);
  assert.match(empty.text, /Follow-ups: none found in the checked records\. This is not a clinic-wide all-clear/);
  assert.match(empty.text, /Stock alerts: none found in the checked records\. This is not a clinic-wide all-clear/);
  assert.doesNotMatch(empty.text, /\b0 (?:items|appointments|patients)\b/i);
  assert.match(empty.text, /not a chart review\. No messages sent or records changed/);
  assert.doesNotMatch(empty.text, /urgent|critical|diagnos|fine/i);
});
