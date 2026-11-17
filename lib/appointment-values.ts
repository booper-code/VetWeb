import type { Appointment, AppointmentDraft, AppointmentStatus, AppointmentType } from '@/types';

export const APPOINTMENT_TYPES: AppointmentType[] = ['Checkup', 'Vaccination', 'Deworming', 'Grooming', 'Surgery', 'Follow-up'];
export const APPOINTMENT_STATUSES: AppointmentStatus[] = ['scheduled', 'completed', 'cancelled', 'no-show'];
export const APPOINTMENT_PAGE_SIZE = 50;
export type AppointmentWindow = { from: string; through: string };

export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function dateInput(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Choose valid calendar dates.');
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || localDate(date) !== value) throw new Error('Choose valid calendar dates.');
  return date;
}
export function defaultAppointmentWindow(now = new Date()): AppointmentWindow {
  const from = new Date(now); from.setDate(from.getDate() - 30);
  const through = new Date(now); through.setDate(through.getDate() + 30);
  return { from: localDate(from), through: localDate(through) };
}
export function appointmentWindowBounds(window: AppointmentWindow): { start: string; end: string } {
  const start = dateInput(window.from), end = dateInput(window.through);
  if (start > end || end.getTime() - start.getTime() > 366 * 86400000) {
    throw new Error('Choose a date range of at most one year, with the start before the end.');
  }
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
export function inAppointmentWindow(appointment: Appointment, window: AppointmentWindow): boolean {
  const { start, end } = appointmentWindowBounds(window);
  return appointment.dueAt >= start && appointment.dueAt < end;
}
export function appointmentValidationError(draft: AppointmentDraft, now = new Date()): string | null {
  if (typeof draft.patientId !== 'string' || !draft.patientId || draft.patientId.length > 1500 || draft.patientId.includes('/')) return 'Select a patient.';
  if (!APPOINTMENT_TYPES.includes(draft.type) || !APPOINTMENT_STATUSES.includes(draft.status)) return 'Choose a valid appointment type and status.';
  if (!Number.isInteger(draft.durationMinutes) || draft.durationMinutes < 5 || draft.durationMinutes > 480) return 'Duration must be 5–480 whole minutes.';
  if (typeof draft.notes !== 'string' || draft.notes.length > 2000) return 'Notes must be at most 2,000 characters.';
  const due = new Date(draft.dueAt);
  const validIso = (value: string, date: Date) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(date.getTime()) && value.slice(0, 19) === date.toISOString().slice(0, 19);
  if (!validIso(draft.dueAt, due) || due.getUTCFullYear() < 2000 || due.getUTCFullYear() > 2100) return 'Choose an appointment date between 2000 and 2100.';
  if (draft.status === 'completed') {
    const occurred = draft.occurredAt ? new Date(draft.occurredAt) : null;
    if (!occurred || !validIso(draft.occurredAt!, occurred) || occurred > now || occurred.getUTCFullYear() < 2000) {
      return 'Completed visits need the actual date/time, not a future time.';
    }
  } else if (draft.occurredAt !== null) return 'Only completed visits have an actual visit time.';
  return null;
}
export function toLocalDateTime(iso: string): string {
  const date = new Date(iso);
  return `${localDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
/** Reject impossible dates and DST gaps rather than silently shifting a visit. */
export function fromLocalDateTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a valid local date and time.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || toLocalDateTime(date.toISOString()) !== value) throw new Error('That local time does not exist. Choose another time.');
  return date.toISOString();
}
export function appointmentReminders(rows: Appointment[], now = new Date()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const nextWeek = new Date(today); nextWeek.setDate(nextWeek.getDate() + 7);
  const scheduled = rows.filter(row => row.status === 'scheduled');
  return {
    overdue: scheduled.filter(row => new Date(row.dueAt) < today),
    today: scheduled.filter(row => new Date(row.dueAt) >= today && new Date(row.dueAt) < tomorrow),
    upcoming: scheduled.filter(row => new Date(row.dueAt) >= tomorrow && new Date(row.dueAt) < nextWeek),
  };
}
export function reminderMessage(row: Appointment): string {
  return `Hello ${row.ownerName || 'there'}, a reminder: ${row.patientName} has a ${row.type.toLowerCase()} appointment on ${new Date(row.dueAt).toLocaleString()}. Please contact the clinic to confirm or reschedule.`;
}
export function reminderMailto(row: Appointment): string | null {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(row.ownerEmail) || /[\r\n]/.test(row.ownerEmail)) return null;
  return `mailto:${encodeURIComponent(row.ownerEmail)}?subject=${encodeURIComponent('Clinic appointment reminder')}&body=${encodeURIComponent(reminderMessage(row))}`;
}
export function reminderWhatsApp(row: Appointment): string | null {
  // Do not guess a country code from a local number.
  if (!/^\+[1-9]\d{6,14}$/.test(row.ownerContact.replace(/[\s()-]/g, ''))) return null;
  return `https://wa.me/${row.ownerContact.replace(/\D/g, '')}?text=${encodeURIComponent(reminderMessage(row))}`;
}
const escapeCalendar = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const calendarTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export function appointmentCalendar(row: Appointment, clinicId: string): string {
  // Fold UTF-8 content lines at 75 octets, without splitting a code point.
  const fold = (line: string) => {
    let current = '', bytes = 0;
    const lines = [];
    for (const char of line) {
      const length = new TextEncoder().encode(char).length;
      if (bytes + length > 75) { lines.push(current); current = ' '; bytes = 1; }
      current += char; bytes += length;
    }
    lines.push(current);
    return lines.join('\r\n');
  };
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VetCloudPro//Appointments//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${encodeURIComponent(clinicId)}-${encodeURIComponent(row.id)}@vetcloudpro`,
    `DTSTAMP:${calendarTime(row.updatedAt || new Date().toISOString())}`, `DTSTART:${calendarTime(row.dueAt)}`,
    `DTEND:${calendarTime(new Date(new Date(row.dueAt).getTime() + row.durationMinutes * 60000).toISOString())}`,
    `SUMMARY:${escapeCalendar(`${row.type}: ${row.patientName}`)}`,
    'DESCRIPTION:Clinic appointment. Confirm details with the clinic.',
    `STATUS:${row.status === 'cancelled' || row.status === 'no-show' ? 'CANCELLED' : 'CONFIRMED'}`, `SEQUENCE:${row.revision}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].map(fold).join('\r\n');
}
