import type { Appointment, AppointmentType } from '@/types';
import { APPOINTMENT_TYPES, fromLocalDateTime, toLocalDateTime, type AppointmentWindow } from '@/lib/appointment-values';
import { billingLocalTime, BILLING_TIME_ZONE, parseBillingLocalTime } from '@/lib/billing-values';

export type AssistantAppointment = Pick<Appointment, 'id' | 'revision' | 'patientName' | 'type' | 'dueAt'>;
export type AssistantSchedule = {
  window: AppointmentWindow;
  availability: 'ready' | 'loading' | 'offline' | 'error';
  partial: boolean;
  rows: AssistantAppointment[];
};
export type AssistantReschedule = {
  appointmentId: string;
  expectedRevision: number;
  originalDueAt: string;
  proposedDueAt: string;
};
export type AssistantDestination = 'appointments' | 'patients' | 'inventory' | 'dashboard';

type Matches = { candidates: AssistantAppointment[]; requiresSelection: boolean };
export type AssistantReply =
  | { kind: 'help'; message: string; destination: AssistantDestination }
  | { kind: 'unavailable' | 'clarification' | 'not-found'; message: string }
  | ({ kind: 'appointments' } & Matches)
  | ({ kind: 'reschedule'; proposedDueAt: string } & Matches);

const MAX_INPUT = 400;
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const normalize = (value: string) => value.normalize('NFC').trim().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').toLowerCase();
const clarify = (message: string): AssistantReply => ({ kind: 'clarification', message });

const help: Array<{ topic: RegExp; message: string; destination: AssistantDestination }> = [
  { topic: /^(?:the )?(?:appointments|appointment schedule|schedule)$/, destination: 'appointments',
    message: 'Open Everyday work → Appointments. Use Refine schedule to change the date range and filters.' },
  { topic: /^(?:the )?(?:patients|patient directory)$/, destination: 'patients',
    message: 'Open Everyday work → Patients to find a patient and open their record.' },
  { topic: /^(?:the )?(?:inventory|stock alerts)$/, destination: 'inventory',
    message: 'Open Everyday work → Inventory for stock information and alerts.' },
  { topic: /^(?:the )?end.of.day close$/, destination: 'dashboard',
    message: 'Owners and editors can open End-of-Day Close from Overview.' },
];

function parseManilaTime(value: string): string | null {
  const parts = /^(?:(\d{4})-(\d{2})-(\d{2})|([a-z]+) (\d{1,2}),? (\d{4})) at (\d{1,2}):(\d{2})(?:\s*(am|pm))?(?: (?:manila(?: time)?|asia\/manila))?$/.exec(value);
  if (!parts) return null;
  const [, isoYear, isoMonth, isoDay, namedMonth, namedDay, namedYear, hours, minutes, period] = parts;
  const month = isoMonth ? Number(isoMonth) : months.findIndex(item => item === namedMonth || item.slice(0, 3) === namedMonth) + 1;
  const year = isoYear ?? namedYear;
  let hour = Number(hours);
  if (period) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (period === 'pm' ? 12 : 0);
  }
  const pad = (number: number) => String(number).padStart(2, '0');
  try {
    const time = new Date(parseBillingLocalTime(`${year}-${pad(month)}-${pad(Number(isoDay ?? namedDay))}T${pad(hour)}:${minutes}`));
    return time.getUTCFullYear() >= 2000 && time.getUTCFullYear() <= 2100 ? time.toISOString() : null;
  } catch { return null; }
}

function findType(value: string): AppointmentType | undefined {
  return APPOINTMENT_TYPES.find(type => type.toLowerCase() === value);
}

export function askWorkspaceAssistant(input: string, schedule: AssistantSchedule): AssistantReply {
  if (input.length > MAX_INPUT || /[\r\n]/.test(input.trim())) return clarify(`Ask one question at a time, up to ${MAX_INPUT} characters.`);
  const text = normalize(input).replace(/[?.!]$/, '').trim();
  const topic = /^(?:where (?:is|are)|how (?:do i|can i) (?:open|find|view)) (.+)$/.exec(text)?.[1];
  const helpItem = topic && help.find(item => item.topic.test(topic));
  if (helpItem) return { kind: 'help', message: helpItem.message, destination: helpItem.destination };

  const move = /^(?:move|reschedule) (.+?)'s (.+?) to (.+)$/.exec(text);
  const question = /^when is (.+?)'s (.+)$/.exec(text);
  const patient = (move ?? question)?.[1];
  const type = findType((move ?? question)?.[2] ?? '');
  if (!patient || !type) {
    return clarify('I can help with app navigation, look up a scheduled appointment, or prepare a reschedule. Try an example using the patient’s exact name and visit type.');
  }
  const proposedDueAt = move ? parseManilaTime(move[3]) : null;
  if (move && !proposedDueAt) {
    return clarify('Enter a valid date including the year and an exact time in Asia/Manila, such as 2026-11-24 at 14:30. Relative dates are not used.');
  }
  if (schedule.availability !== 'ready') {
    const message = schedule.availability === 'loading' ? 'The current schedule is still loading. Try again when it is ready.' :
      schedule.availability === 'offline' ? 'The current schedule is unavailable offline or is cached. Reconnect or refresh before reviewing an appointment.' :
        'The current schedule could not load. Open Appointments to retry. This does not mean the schedule is empty.';
    return { kind: 'unavailable', message };
  }
  const candidates = schedule.rows.filter(row => normalize(row.patientName) === patient && row.type === type);
  if (!candidates.length) {
    return { kind: 'not-found', message: `No matching scheduled appointment in the loaded date window.${schedule.partial ? ' More pages may contain a match.' : ''} Open Appointments to check more dates or records.` };
  }
  const matches = { candidates, requiresSelection: schedule.partial || candidates.length > 1 };
  return proposedDueAt ? { ...matches, kind: 'reschedule', proposedDueAt } : { ...matches, kind: 'appointments' };
}

export function createAssistantReschedule(row: AssistantAppointment, proposedDueAt: string): AssistantReschedule | null {
  if (Date.parse(row.dueAt) === Date.parse(proposedDueAt)) return null;
  return { appointmentId: row.id, expectedRevision: row.revision, originalDueAt: row.dueAt, proposedDueAt };
}

export function matchAssistantReschedule<T extends AssistantAppointment>(proposal: AssistantReschedule, rows: T[]): T | null {
  return rows.find(row => row.id === proposal.appointmentId && row.revision === proposal.expectedRevision &&
    row.dueAt === proposal.originalDueAt) ?? null;
}

export function assistantEditorTime(dueAt: string): string | null {
  try {
    const local = toLocalDateTime(dueAt);
    return fromLocalDateTime(local) === dueAt ? local : null;
  } catch { return null; }
}

export function assistantManilaTime(dueAt: string): string {
  const millis = Date.parse(dueAt);
  return Number.isFinite(millis) ? `${billingLocalTime(millis).replace('T', ' ')} ${BILLING_TIME_ZONE}` : 'Time unavailable';
}
