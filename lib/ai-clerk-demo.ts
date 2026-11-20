import type { AppointmentType } from '@/types';
import { APPOINTMENT_TYPES, appointmentValidationError } from '@/lib/appointment-values';
import { parseBillingLocalTime } from '@/lib/billing-values';

export const CLERK_DEMO_MAX_NOTE_LENGTH = 160;
export const CLERK_DEMO_EXAMPLES = [
  { label: 'Create example', note: 'Create a 30-minute checkup for DEMO-PAT-101 on 2026-11-24 at 09:00' },
  { label: 'Reschedule example', note: 'Reschedule DEMO-APT-201 to 2026-11-25 at 14:30' },
  { label: 'Cancel example', note: 'Cancel DEMO-APT-201' },
] as const;

// These identifiers are independent of the app's demo and clinic records.
const patient = { patientId: 'DEMO-PAT-101', patientName: 'Cora' } as const;
const appointment = {
  ...patient, appointmentId: 'DEMO-APT-201', appointmentType: 'Checkup',
  durationMinutes: 30, scheduledAtMs: parseBillingLocalTime('2026-11-24T10:30'),
} as const;

type ProposalDetails = {
  patientId: string;
  patientName: string;
  appointmentType: AppointmentType;
  durationMinutes: number;
  scheduledAtMs: number;
};

type ClerkDemoProposal = ProposalDetails & (
  | { action: 'create' }
  | { action: 'reschedule'; appointmentId: string; previousAtMs: number }
  | { action: 'cancel'; appointmentId: string }
);

export type ClerkDemoResult =
  | { kind: 'proposal'; proposal: ClerkDemoProposal }
  | { kind: 'clarification'; message: string };

const clarify = (message: string): ClerkDemoResult => ({ kind: 'clarification', message });
const propose = (proposal: ClerkDemoProposal): ClerkDemoResult => ({ kind: 'proposal', proposal });

function reviewScheduledTime(date: string, time: string, appointmentType: AppointmentType,
  durationMinutes: number, actionDetails: Pick<ProposalDetails, 'patientId' | 'patientName'> &
    ({ action: 'create' } | { action: 'reschedule'; appointmentId: string; previousAtMs: number })): ClerkDemoResult {
  let scheduledAtMs: number;
  try {
    scheduledAtMs = parseBillingLocalTime(`${date}T${time}`);
  } catch {
    return clarify('Enter a valid date and time in Asia/Manila (YYYY-MM-DD at HH:MM).');
  }
  const error = appointmentValidationError({
    patientId: actionDetails.patientId, type: appointmentType, durationMinutes,
    status: 'scheduled', dueAt: new Date(scheduledAtMs).toISOString(), notes: '', occurredAt: null,
  });
  if (error) return clarify(error);
  if (actionDetails.action === 'reschedule' && actionDetails.previousAtMs === scheduledAtMs) {
    return clarify('Choose a different time for the rescheduled appointment.');
  }
  return propose({ ...actionDetails, appointmentType, durationMinutes, scheduledAtMs });
}

export function reviewClerkDemoNote(note: string): ClerkDemoResult {
  if (note.length > CLERK_DEMO_MAX_NOTE_LENGTH) return clarify(`Use at most ${CLERK_DEMO_MAX_NOTE_LENGTH} characters.`);
  const text = note.trim();
  if (!text || /[\r\n]/.test(text)) return clarify('Enter one fictional note at a time.');

  const create = /^create a (\d{1,3})-minute ([a-z-]+) for ([a-z0-9-]+) on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})$/i.exec(text);
  if (create) {
    const [, duration, type, id, date, time] = create;
    if (id.toUpperCase() !== patient.patientId) return clarify(`Use the fictional patient ID ${patient.patientId}; names and clinic IDs are not looked up.`);
    const appointmentType = APPOINTMENT_TYPES.find(value => value.toLowerCase() === type.toLowerCase());
    if (!appointmentType) return clarify('Choose an appointment type from the scheduling list, such as Checkup or Follow-up.');
    return reviewScheduledTime(date, time, appointmentType, Number(duration), { ...patient, action: 'create' });
  }

  const reschedule = /^reschedule ([a-z0-9-]+) to (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})$/i.exec(text);
  if (reschedule) {
    const [, id, date, time] = reschedule;
    if (id.toUpperCase() !== appointment.appointmentId) return clarify(`Use the fictional appointment ID ${appointment.appointmentId}.`);
    return reviewScheduledTime(date, time, appointment.appointmentType, appointment.durationMinutes, {
      ...patient, action: 'reschedule', appointmentId: appointment.appointmentId, previousAtMs: appointment.scheduledAtMs,
    });
  }

  const cancel = /^cancel ([a-z0-9-]+)$/i.exec(text);
  if (cancel) {
    if (cancel[1].toUpperCase() !== appointment.appointmentId) return clarify(`Use the fictional appointment ID ${appointment.appointmentId}.`);
    return propose({ ...appointment, action: 'cancel' });
  }

  return clarify('Start with one of the examples. Use the exact ID and, when scheduling, an explicit date and time (YYYY-MM-DD at HH:MM).');
}
