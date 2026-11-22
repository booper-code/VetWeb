import type { Appointment, AppointmentType } from '@/types';
import { APPOINTMENT_TYPES, fromLocalDateTime, toLocalDateTime, type AppointmentWindow } from '@/lib/appointment-values';
import { billingLocalTime, BILLING_TIME_ZONE, parseBillingLocalTime } from '@/lib/billing-values';
import { routeAssistantTool, type AssistantToolCall } from '@/lib/assistant-tools';

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
export type AssistantInventoryCount = { kind: 'inventory-count' };
/** Local, deterministic front-desk briefing; never handed to a provider. */
export type AssistantDailyBriefing = { kind: 'daily-briefing' };

type Matches = { candidates: AssistantAppointment[]; requiresSelection: boolean };
export type AssistantReply =
  | { kind: 'help'; message: string; destination: AssistantDestination }
  | { kind: 'conversation' | 'unavailable' | 'not-found'; message: string }
  | { kind: 'clarification'; message: string; modelHandoff?: boolean }
  | ({ kind: 'appointments' } & Matches)
  | ({ kind: 'reschedule'; proposedDueAt: string } & Matches);
export type WorkspaceQuestionResult = AssistantReply | AssistantToolCall | AssistantInventoryCount | AssistantDailyBriefing;

const MAX_INPUT = 400;
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const normalize = (value: string) => value.normalize('NFC').trim().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').toLowerCase();
// A specific clarification belongs to a recognized native request (for example a
// reschedule with a malformed time) and must stay local. Only the generic
// catch-all, which is not a supported app request, is offered to the model.
const clarify = (message: string): AssistantReply => ({ kind: 'clarification', message });
const modelClarification = (message: string): AssistantReply => ({ kind: 'clarification', message, modelHandoff: true });

// A small, explicit set of front-desk briefing variants. These are local
// reads: none may be offered to a provider, and unusual phrasing simply falls
// through to the ordinary (provider-backed) general question.
const briefingPatterns = [
  /^(?:what (?:is|s)|show me) (?:today's schedule|the schedule for today) and (?:which stock items should i check|(?:the )?stock alerts)$/,
  /^what should i check(?: today| for today)?$/,
  /^what (?:do|should) i need to check(?: today)?$/,
  /^anything (?:i )?(?:should )?check(?: today)?$/,
  /^who needs (?:checking|to be checked)$/,
  /^is there (?:someone|anyone|anybody|any patients?) (?:that )?needs? checking$/,
  /^is there (?:someone|anyone|anybody|any patients?) (?:that )?i should check$/,
  /^(?:are there )?any patients? (?:that )?needs? checking$/,
  /^what needs (?:checking|attention)(?: today)?$/,
  /^what should i be mindful of(?:(?: today| in the clinic))?$/,
  /^(?:are there )?any things?(?: in the clinic(?: that)?)? i should be mindful of$/,
  /^anything(?: in the clinic(?: that)?)? i should be mindful of$/,
  /^(?:are there )?anythings?(?: in the clinic(?: that)?)? i should know(?: today)?$/,
  /^(?:give me |show me )?(?:a |the )?(?:daily |front desk )?briefing$/,
  /^(?:daily|front desk|morning) briefing$/,
  /^what should i be aware of(?: today)?$/,
];

export function isDailyBriefingQuestion(input: string): boolean {
  if (input.length > MAX_INPUT || /[\r\n]/.test(input.trim())) return false;
  const text = normalize(input).replace(/[?.!,]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:so|ok|okay|and) )?(?:how about (?:the )?(?:patients|staff|clinic)|about the patients)(?: then)? /, '')
    .replace(/^(?:can you|could you|please|will you) /, '')
    .replace(/,? please$/, '');
  return briefingPatterns.some(pattern => pattern.test(text));
}

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
  const text = normalize(input).replace(/[?.!]+$/, '').trim();
  if (/^(?:hi|hello|hey)(?: there)?$|^good (?:morning|afternoon|evening)$|^kumusta$/.test(text)) {
    return { kind: 'conversation', message: 'Hi! How can I help? I can help you find your way around VetCloudPro or check a scheduled visit.' };
  }
  if (/^(?:thanks|thank you|thanks so much|thank you so much|salamat)$/.test(text)) {
    return { kind: 'conversation', message: 'You’re welcome!' };
  }
  const topic = /^(?:where (?:is|are)|(?:where|how) (?:do i|can i) (?:open|find|view|see|access)) (.+?)(?:,? please)?$/.exec(text)?.[1];
  const helpItem = topic && help.find(item => item.topic.test(topic));
  if (helpItem) return { kind: 'help', message: helpItem.message, destination: helpItem.destination };

  const move = /^(?:move|reschedule) (.+?)'s (.+?) to (.+)$/.exec(text);
  const question = /^when is (.+?)'s (.+)$/.exec(text);
  const patient = (move ?? question)?.[1];
  const type = findType((move ?? question)?.[2] ?? '');
  if (!patient || !type) {
    const message = 'I can help with app navigation, count inventory catalog items, look up scheduled appointments, or prepare a reschedule draft. Each question is independent: for appointments, include the exact patient name and visit type. Try one of the examples above.';
    // A partially phrased appointment request may still contain a private name.
    const appointmentIntent = !!question || /^(?:(?:please|(?:can|could|would) you) )?(?:move|reschedule)\b/.test(text);
    return appointmentIntent ? clarify(message) : modelClarification(message);
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

export function evaluateWorkspaceQuestion(input: string, schedule: AssistantSchedule, now = Date.now()): WorkspaceQuestionResult {
  if (isDailyBriefingQuestion(input)) return { kind: 'daily-briefing' };
  if (input.length <= MAX_INPUT && !/[\r\n]/.test(input.trim())) {
    const text = normalize(input).replace(/[?.!]+$/, '').trim().replace(/,? please$/, '');
    if (/^(?:(?:can|could|would) you |please )?(?:(?:text|sms|email|call|message|contact|notify)\b|send (?:an? |the )?(?:text|sms|email|message|reminder)\b)/.test(text) &&
        /\b(?:owners?|clients?)\b/.test(text)) {
      return clarify('I can’t send messages or log outreach. Use Appointments to review the visit and record outreach manually where available.');
    }
    if (/^(?:what (?:were|are|was|is)|(?:show|give|tell) me|(?:can|could) you (?:show|give|tell) me|read|list)\b/.test(text) &&
        /\b(?:lab (?:findings|results)|soap notes?|clinical notes?)\b/.test(text)) {
      return clarify('I can’t access private chart details such as lab findings or SOAP notes. I didn’t check the chart.');
    }
    if (/^(?:how many (?:catalog )?items (?:are (?:there )?|do we have )?in (?:the |our )?inventory|how many inventory items (?:are there|do we have)|(?:count|(?:what(?:'s| is) )?(?:the )?total (?:number )?of) (?:inventory (?:catalog )?items|(?:catalog )?items in (?:the |our )?inventory))$/.test(text)) {
      return { kind: 'inventory-count' };
    }
  }
  const routed = routeAssistantTool(input, now);
  if (routed.kind === 'tool') return routed;
  if (routed.kind === 'clarify') return clarify(routed.message);
  return askWorkspaceAssistant(input, schedule);
}

/**
 * Unified routing: only a request the deterministic app cannot support is
 * offered to the model. Everything else — including grounded counts,
 * appointment/patient lookups, typed tools and draft actions — stays local so
 * that no clinic result, record, tool output or local-only turn is disclosed.
 */
export function shouldDeferToModel(result: WorkspaceQuestionResult): boolean {
  return result.kind === 'clarification' && result.modelHandoff === true;
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
