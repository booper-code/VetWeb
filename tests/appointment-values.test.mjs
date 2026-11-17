import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(readFileSync(new URL('../lib/appointment-values.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const values = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const row = { id: 'appointment', revision: 1, patientId: 'patient', patientName: 'Synthetic',
  ownerName: 'Fixture', ownerContact: '+63 912 345 6789', ownerEmail: 'fixture@example.com',
  type: 'Vaccination', status: 'scheduled', dueAt: '2026-11-15T01:00:00.000Z', durationMinutes: 30,
  occurredAt: null, notes: '', createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z' };

test('appointment validation accepts later-day entry and separates actual visit from record time', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  assert.equal(values.appointmentValidationError({ ...row, status: 'completed', occurredAt: '2026-11-15T08:00:00Z' }, now), null);
  for (const patch of [{ durationMinutes: -1 }, { durationMinutes: 3.5 }, { durationMinutes: 481 },
    { type: 'Diagnosis' }, { status: 'sent' }, { patientId: '../elsewhere' }, { notes: 'x'.repeat(2001) },
    { dueAt: 'invalid' }, { dueAt: '2101-01-01T00:00:00Z' }, { status: 'completed', occurredAt: null },
    { status: 'completed', occurredAt: '2026-11-16T00:00:00Z' }, { occurredAt: '2026-11-14T00:00:00Z' }]) {
    assert.ok(values.appointmentValidationError({ ...row, ...patch }, now), JSON.stringify(patch));
  }
});
test('date ranges include the final whole local day, reject reversed/oversized/impossible dates', () => {
  const range = { from: '2026-11-15', through: '2026-11-15' };
  const bounds = values.appointmentWindowBounds(range);
  assert.equal(values.localDate(new Date(bounds.start)), range.from);
  assert.equal(values.localDate(new Date(bounds.end)), '2026-11-16');
  assert.equal(values.inAppointmentWindow({ ...row, dueAt: bounds.start }, range), true);
  assert.equal(values.inAppointmentWindow({ ...row, dueAt: bounds.end }, range), false);
  for (const value of [{ from: '2026-02-30', through: '2026-03-01' },
    { from: '2026-11-16', through: '2026-11-15' }, { from: '2020-01-01', through: '2026-01-01' }]) {
    assert.throws(() => values.appointmentWindowBounds(value));
  }
});
test('local date/time roundtrips and reminders ignore cancelled/completed rows', () => {
  const local = '2026-11-15T08:30';
  assert.equal(values.toLocalDateTime(values.fromLocalDateTime(local)), local);
  assert.throws(() => values.fromLocalDateTime('2026-02-30T08:30'));
  const day = n => values.fromLocalDateTime(`2026-11-${n}T08:00`);
  const reminders = values.appointmentReminders([
    { ...row, dueAt: day(14) }, { ...row, dueAt: day(15) }, { ...row, dueAt: day(21) },
    { ...row, dueAt: day(22) }, { ...row, status: 'completed', dueAt: day(15) },
    { ...row, status: 'cancelled', dueAt: day(15) },
  ], new Date(values.fromLocalDateTime('2026-11-15T19:00')));
  assert.equal(reminders.overdue.length, 1);
  assert.equal(reminders.today.length, 1);
  assert.equal(reminders.upcoming.length, 1);
});
test('DST gaps are rejected and local-day ranges respect daylight-saving transitions', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    assert.throws(() => values.fromLocalDateTime('2026-03-08T02:30'));
    const spring = values.appointmentWindowBounds({ from: '2026-03-08', through: '2026-03-08' });
    assert.equal(new Date(spring.end) - new Date(spring.start), 23 * 3600000);
    const autumn = values.appointmentWindowBounds({ from: '2026-11-01', through: '2026-11-01' });
    assert.equal(new Date(autumn.end) - new Date(autumn.start), 25 * 3600000);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
test('manual sharing never guesses country codes or permits mail header injection', () => {
  assert.match(values.reminderWhatsApp(row), /^https:\/\/wa.me\/639123456789\?text=/);
  assert.equal(values.reminderWhatsApp({ ...row, ownerContact: '09123456789' }), null);
  assert.equal(values.reminderMailto({ ...row, ownerEmail: 'fixture@example.com\r\nBcc:evil@example.com' }), null);
  const link = values.reminderMailto(row);
  assert.match(link, /^mailto:fixture%40example.com\?/);
  assert.match(decodeURIComponent(link), /Synthetic/);
});
test('calendar export escapes content, folds UTF-8 lines and keeps stable clinic-scoped identity', () => {
  const calendar = values.appointmentCalendar({ ...row, patientName: '猫'.repeat(40) + '\nBEGIN:VALARM,;' }, 'clinic');
  const lines = calendar.split('\r\n');
  assert.ok(lines.every(line => Buffer.byteLength(line, 'utf8') <= 75));
  assert.equal(lines.filter(line => line === 'BEGIN:VEVENT').length, 1);
  assert.equal(lines.filter(line => line === 'BEGIN:VALARM').length, 0);
  assert.ok(calendar.includes('UID:clinic-appointment@vetcloudpro'));
  assert.ok(calendar.includes('DTSTART:20261115T010000Z'));
  assert.ok(calendar.includes('DTEND:20261115T013000Z'));
  assert.ok(!calendar.includes(row.ownerEmail));
  assert.ok(calendar.endsWith('\r\n'));
});
