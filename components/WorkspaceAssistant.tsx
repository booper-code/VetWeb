'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  askWorkspaceAssistant, assistantManilaTime, createAssistantReschedule, evaluateWorkspaceQuestion, shouldDeferToModel, type AssistantDestination,
  type AssistantInventoryCount, type AssistantReply, type AssistantReschedule, type AssistantSchedule,
} from '@/lib/workspace-assistant';
import type { AssistantToolCall, AssistantToolError } from '@/lib/assistant-tools';
import type { AssistantLookup } from '@/lib/assistant-tool-client';
import { clinicQueryLabel, type ClinicQueryReply, type QueryOutcome } from '@/lib/clinic-query';
import type { DailyBriefingOutcome } from '@/lib/daily-briefing';
import { workspaceAIHistoryLimit, type ClinicPlanTurn } from '@/lib/workspace-ai';

const links: Record<AssistantDestination, string> = {
  appointments: 'Open Appointments', patients: 'Open Patients', inventory: 'Open Inventory', dashboard: 'Open Overview',
};

const toolErrors: Record<AssistantToolError, string> = {
  'access-denied': 'Your clinic access or AI setting does not allow this lookup.',
  'invalid-request': 'That lookup could not be validated. Check the name or dates and try again.',
  unavailable: 'Could not verify clinic records. This does not mean there were no results.',
  timeout: 'The clinic lookup timed out. Try again.',
};

type ChatTurn = { question: string; answer: string };
type WorkspaceLookup = AssistantLookup | { tool: 'inventory-count'; count: number };
const historyLimit = 30;

function inventoryCountMessage(count: number) {
  return `${count === 1 ? 'There is 1 item' : `There are ${count.toLocaleString('en-PH')} items`} in this clinic’s inventory catalog.`;
}

function ClinicQueryOutcome({ outcome }: { outcome: QueryOutcome }) {
  const columns = Object.keys(outcome.rows[0] ?? {}).slice(0, 6);
  return <>
    <p role={outcome.status === 'ok' ? 'status' : 'alert'}>{outcome.message}</p>
    {outcome.table === 'patients' && (outcome.status === 'ok' || outcome.status === 'partial') &&
      <p className="vc-note">Source: Patient Directory. Recorded status does not confirm physical presence.</p>}
    {outcome.status === 'partial' && <p className="vc-note">{outcome.complete
      ? 'Some tied matches are not shown.'
      : 'Partial result — the read limit was reached. This is not a clinic-wide figure.'}</p>}
    {outcome.status === 'denied' && <p className="vc-note">Your clinic role could not read this area.</p>}
    {outcome.status === 'unavailable' && <p className="vc-note">Records could not be verified. This does not mean there were no results.</p>}
    {outcome.rows.length > 0 && <details open={outcome.op === 'list' || (outcome.op === 'rank' && outcome.rows.length > 1)}>
      <summary className="cursor-pointer">View {outcome.rows.length} row{outcome.rows.length === 1 ? '' : 's'}</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="vc-table w-full text-left text-xs">
          <thead><tr>{columns.map(key => <th key={key} scope="col" className="px-2 py-1">{key}</th>)}</tr></thead>
          <tbody>{outcome.rows.slice(0, 12).map((row, index) => <tr key={index}>
            {columns.map(key => <td key={key} className="px-2 py-1">{String(row[key] ?? '')}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      {outcome.rows.length > 12 && <p className="vc-note">Showing the first 12 of {outcome.rows.length} rows.</p>}
    </details>}
    {outcome.groups && outcome.groups.length > 0 && <ul className="space-y-1">
      {outcome.groups.map(group => <li key={group.key}>
        {group.key || '(none)'}: {group.count}{group.sum !== undefined ? ` (total ${group.sum})` : ''}
      </li>)}
    </ul>}
  </>;
}

export function ClinicQueryResponse({ reply }: { reply: ClinicQueryReply }) {
  return <section aria-label="Clinic query" className="min-w-0 space-y-3 break-words rounded-xl border border-outline-soft bg-panel-subtle p-3 text-sm">
    {reply.kind === 'decline' ? <p role="status">{reply.message}</p>
      : reply.kind === 'result' ? <>
        <ClinicQueryOutcome outcome={reply.outcome} />
        {reply.notice && <p className="vc-note">{reply.notice}</p>}
      </>
      : reply.results.map(({ plan, outcome }, index) => <div key={index} className="space-y-2">
        <h3 className="font-semibold">{clinicQueryLabel(plan)}</h3>
        <ClinicQueryOutcome outcome={outcome} />
      </div>)}
  </section>;
}

const archiveClinicOutcome = (outcome: QueryOutcome) =>
  outcome.message + (outcome.status === 'partial' ? ' (incomplete check)' : '');

export function WorkspaceAssistant({ schedule, canEdit, onNavigate, onReview, onLookup, onCountInventory, onOpenPerson, onClinicQuery, onDailyBriefing }: {
  schedule: AssistantSchedule;
  canEdit: boolean;
  onNavigate: (destination: AssistantDestination) => void;
  onReview: (proposal: AssistantReschedule, stillOpen: () => boolean) => Promise<string | null> | string | null;
  onLookup?: (call: AssistantToolCall, signal: AbortSignal) => Promise<AssistantLookup>;
  onCountInventory?: (signal: AbortSignal) => Promise<number | null>;
  onOpenPerson?: (reference: string, stillOpen: () => boolean) => Promise<string | null>;
  onClinicQuery?: (prompt: string, history: readonly ClinicPlanTurn[], signal: AbortSignal) => Promise<ClinicQueryReply>;
  /** Local read-only daily briefing; never uses or forwards to a provider. */
  onDailyBriefing?: (signal: AbortSignal) => Promise<DailyBriefingOutcome>;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const reviewVersion = useRef(0);
  const lookupRequest = useRef<AbortController | null>(null);
  const clinicPlanContext = useRef<ClinicPlanTurn[]>([]);
  const [clinicReply, setClinicReply] = useState<ClinicQueryReply | null>(null);
  const [briefing, setBriefing] = useState<({ kind: 'pending' } | DailyBriefingOutcome) | null>(null);
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [lookup, setLookup] = useState<WorkspaceLookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookupNote, setLookupNote] = useState('');
  const [text, setText] = useState('');
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [exchange, setExchange] = useState<{ text: string; reply: AssistantReply; windowKey: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [checking, setChecking] = useState(false);
  const reply = exchange?.reply;
  const matching = reply?.kind === 'appointments' || reply?.kind === 'reschedule' ? reply : null;
  const windowKey = `${schedule.window.from}:${schedule.window.through}`;
  const scheduleReply = !!matching || reply?.kind === 'not-found' || reply?.kind === 'unavailable';
  const current = scheduleReply && exchange ? askWorkspaceAssistant(exchange.text, schedule) : null;
  const stale = scheduleReply && (exchange?.windowKey !== windowKey || current?.kind !== reply?.kind ||
    (matching && (current?.kind !== 'appointments' && current?.kind !== 'reschedule' ||
      current.requiresSelection !== matching.requiresSelection ||
      current.candidates.length !== matching.candidates.length ||
      matching.candidates.some(row => !current.candidates.some(candidate =>
        candidate.id === row.id && candidate.revision === row.revision && candidate.dueAt === row.dueAt)))) ||
    ((reply?.kind === 'not-found' || reply?.kind === 'unavailable') && current &&
      (!('message' in current) || current.message !== reply.message)));
  const selected = matching && !stale
    ? matching.candidates.find(row => row.id === selectedId) ?? (matching.requiresSelection ? null : matching.candidates[0])
    : null;
  const proposal = selected && reply?.kind === 'reschedule' ? createAssistantReschedule(selected, reply.proposedDueAt) : null;

  useEffect(() => () => { lookupRequest.current?.abort(); }, []);
  useEffect(() => {
    if (dialog.current?.open && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [history, question, exchange, looking, lookupNote, lookup, clinicReply, briefing, querying, queryError]);

  function cancelLookup() {
    lookupRequest.current?.abort();
    lookupRequest.current = null;
    setLookup(null); setLooking(false); setLookupNote('');
  }

  async function investigate(call: AssistantToolCall | AssistantInventoryCount) {
    if (call.kind === 'tool' && !onLookup) {
      setLookupNote('Clinic lookups are not configured here. The local appointment assistant is still available.');
      return;
    }
    const controller = new AbortController();
    lookupRequest.current = controller;
    const current = () => lookupRequest.current === controller && !controller.signal.aborted && dialog.current?.open === true;
    setLooking(true);
    try {
      let answer: WorkspaceLookup;
      if (call.kind === 'inventory-count') {
        const count = await onCountInventory?.(controller.signal);
        answer = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
          ? { tool: 'inventory-count', count } : { error: 'unavailable' };
      } else {
        answer = await onLookup!(call, controller.signal);
      }
      if (current()) setLookup(answer);
    } catch {
      if (current()) setLookup({ error: 'unavailable' });
    } finally {
      if (current()) setLooking(false);
    }
  }

  async function queryClinic(prompt: string) {
    if (!onClinicQuery) return;
    const controller = new AbortController();
    lookupRequest.current = controller;
    const current = () => lookupRequest.current === controller && !controller.signal.aborted && dialog.current?.open === true;
    setQuerying(true); setClinicReply(null); setQueryError('');
    try {
      const reply = await onClinicQuery(prompt, clinicPlanContext.current, controller.signal);
      if (!current()) return;
      // Only the nonsensitive plans are retained; the verified answer is not
      // forwarded to a later provider request.
      const turn = reply.kind === 'results' ? { prompt, plans: reply.results.map(result => result.plan) } : { prompt, plan: reply.plan };
      clinicPlanContext.current = [...clinicPlanContext.current, turn].slice(-workspaceAIHistoryLimit);
      setClinicReply(reply);
    } catch (error) {
      if (current()) setQueryError(error instanceof Error ? error.message : 'The clinic query could not be completed.');
    } finally {
      if (current()) setQuerying(false);
    }
  }

  async function loadBriefing() {
    if (!onDailyBriefing) {
      setBriefing({ kind: 'unavailable', message: 'Today’s briefing is available in the signed-in localhost staging workspace.' });
      return;
    }
    const controller = new AbortController();
    lookupRequest.current = controller;
    const current = () => lookupRequest.current === controller && !controller.signal.aborted && dialog.current?.open === true;
    setBriefing({ kind: 'pending' });
    try {
      const outcome = await onDailyBriefing(controller.signal);
      if (current()) setBriefing(outcome);
    } catch {
      if (current()) setBriefing({ kind: 'unavailable', message: 'Today’s briefing could not be verified. Try again.' });
    }
  }

  async function openPerson(reference: string) {
    const scope = lookupRequest.current;
    const current = () => dialog.current?.open === true && !!scope && lookupRequest.current === scope && !scope.signal.aborted;
    if (!onOpenPerson || !current()) return;
    try {
      const error = await onOpenPerson(reference, current);
      if (!current()) return;
      if (error) setLookupNote(error);
      else minimize();
    } catch {
      if (current()) setLookupNote('Could not open the normal patient view. Ask again to verify access.');
    }
  }

  function cancelReview() {
    reviewVersion.current++;
    setChecking(false);
    setReviewError('');
  }

  function clearActiveTurn() {
    cancelReview(); cancelLookup();
    setQuestion(''); setExchange(null); setSelectedId(null);
    setClinicReply(null); setBriefing(null); setQueryError(''); setQuerying(false);
  }

  function clearChat() {
    clearActiveTurn();
    clinicPlanContext.current = [];
    setHistory([]); setText('');
  }

  function archiveTurn() {
    if (!question) return;
    const catalogAnswer = lookup && 'tool' in lookup && lookup.tool === 'inventory-count'
      ? `At the time of the lookup: ${inventoryCountMessage(lookup.count)}` : null;
    const briefingAnswer = briefing ? (briefing.kind === 'pending' ? 'Briefing canceled.'
      : briefing.kind === 'ok' ? briefing.briefing.text : briefing.message) : null;
    const clinicAnswer = clinicReply ? (clinicReply.kind === 'decline' ? clinicReply.message
      : clinicReply.kind === 'result' ? [archiveClinicOutcome(clinicReply.outcome), clinicReply.notice].filter(Boolean).join('\n')
      : clinicReply.results.map(({ plan, outcome }) => `${clinicQueryLabel(plan)}: ${archiveClinicOutcome(outcome)}`).join('\n')) : null;
    const answer = briefingAnswer ?? clinicAnswer ?? (queryError || (querying ? 'AI request canceled.' : null)) ??
      catalogAnswer ?? (reply?.kind === 'help' || reply?.kind === 'conversation' || reply?.kind === 'clarification'
      ? reply.message
      : lookupNote || (lookup && 'error' in lookup ? toolErrors[lookup.error] : looking
        ? 'Clinic lookup canceled.' : 'Clinic result or draft not retained. Ask again for current information.'));
    setHistory(previous => [...previous.slice(1 - historyLimit), { question, answer }]);
  }

  function minimize() {
    archiveTurn();
    clearActiveTurn();
    dialog.current?.close();
  }

  async function reviewInAppointments(proposal: AssistantReschedule) {
    const version = ++reviewVersion.current;
    const stillOpen = () => dialog.current?.open === true && reviewVersion.current === version;
    setChecking(true); setReviewError('');
    try {
      const error = await onReview(proposal, stillOpen);
      if (!stillOpen()) return;
      if (error) setReviewError(error);
      else minimize();
    } catch {
      if (stillOpen()) setReviewError('Could not verify the appointment. Try again.');
    } finally {
      if (stillOpen()) setChecking(false);
    }
  }

  function go(destination: AssistantDestination) {
    minimize();
    onNavigate(destination);
  }

  return <>
    <button type="button" aria-label="AI Assistant" aria-haspopup="dialog" aria-controls={`${id}-dialog`} className="vc-btn h-10" ref={launcher}
      onClick={() => {
        dialog.current?.showModal();
        if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
        field.current?.focus();
      }}>
      <Sparkles className="h-4 w-4" aria-hidden="true" />
      <span className="hidden lg:inline">AI Assistant</span>
    </button>
    <dialog ref={dialog} id={`${id}-dialog`} aria-labelledby={`${id}-title`}
      onClose={() => { if (!dialog.current?.open) launcher.current?.focus(); }}
      onCancel={event => { event.preventDefault(); minimize(); }}
      className="vc-assistant-dialog fixed inset-0 m-auto h-[min(46rem,calc(100dvh_-_1rem))] max-h-none w-[calc(100%_-_1rem)] max-w-3xl overflow-hidden rounded-2xl border border-line bg-panel text-ink shadow-xl backdrop:bg-slate-950/70">
      <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        <div className="space-y-2 border-b border-line px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`${id}-title`} className="text-lg font-bold">AI Assistant</h2>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="vc-btn vc-btn-sm" disabled={!history.length && !question && !text}
                onClick={() => { clearChat(); field.current?.focus(); }}>Clear chat</button>
              <button type="button" className="vc-btn vc-btn-sm" onClick={minimize}>Minimize assistant</button>
            </div>
          </div>
          <p id={`${id}-conversation-privacy`} className="vc-note">{onClinicQuery
            ? 'Counts, appointment lookups, and drafts stay in the app. Other questions may go to your configured AI provider. Clinic records and verified results are read and shown only in the app. Use fictional messages only.'
            : 'Chat history stays in this workspace until you refresh or leave. No AI provider is used.'}
            {onClinicQuery && ' Clinic data questions send only a read-only query plan; verified results are read and shown in the app.'}</p>
        </div>
        <div ref={transcript} role="log" aria-label="Chat history" className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-5">
          {!history.length && !question && <>
            <p className="text-sm font-semibold">Hi! How can I help?</p>
            <p id={`${id}-examples`} className="vc-note">
              {onClinicQuery ? 'Try “What should I check today?”, “Which patients are currently here?”, or “When is Milo’s checkup?”.' :
                'Try “Where can I find appointments?”, “How many items are in the inventory?”, or “When is Milo’s checkup?”.'}
              {' To prepare a draft, try “Move Milo’s checkup to 2026-11-24 at 14:30”.'}
              {onLookup && ' For read-only clinic lookups, try “How many CSV items were imported?” or “Find person Alex Reyes”.'}
            </p>
          </>}
          {history.map((turn, index) => <div key={index} className="space-y-2">
            <p className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-xl bg-field-subtle px-3 py-2 text-sm"><span className="sr-only">You: </span>{turn.question}</p>
            <p className="mr-auto max-w-[90%] whitespace-pre-wrap break-words rounded-xl border border-outline-soft bg-panel-subtle px-3 py-2 text-sm"><span className="sr-only">Assistant: </span>{turn.answer}</p>
          </div>)}
          {question && <p className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-xl bg-field-subtle px-3 py-2 text-sm"><span className="sr-only">You: </span>{question}</p>}
          {querying && <p role="status">Checking your question…</p>}
          {queryError && <p role="alert">{queryError}</p>}
          {clinicReply && <ClinicQueryResponse reply={clinicReply} />}
        {briefing && <section aria-label="Daily briefing" className="min-w-0 space-y-2 break-words rounded-xl border border-outline-soft bg-panel-subtle p-3 text-sm">
          {briefing.kind === 'pending' ? <p role="status">Checking today’s clinic records…</p>
            : briefing.kind === 'ok' ? <p role="status" className="whitespace-pre-wrap">{briefing.briefing.text}</p>
              : <p role="alert">{briefing.message}</p>}
        </section>}
        {(lookup || looking || lookupNote) && <section aria-label="Clinic lookup" className="min-w-0 space-y-3 break-words rounded-xl border border-outline-soft bg-panel-subtle p-3 text-sm">
          {looking && <p role="status">Checking clinic records…</p>}
          {lookupNote && <p role="status">{lookupNote}</p>}
          {lookup && ('error' in lookup ? <p role="status">{toolErrors[lookup.error]}</p>
            : lookup.tool === 'inventory-count' ? <>
              <p role="status">{inventoryCountMessage(lookup.count)}</p>
              <p className="vc-note">Counts medicines, supplies, services, and grooming entries. It does not add up stock quantities.</p>
              <button type="button" className="vc-btn vc-btn-sm" onClick={() => go('inventory')}>Open Inventory</button>
            </>
            : lookup.tool === 'inventory_import_history' ? <>
              <p role="status">
                {lookup.result.count === 0 ? 'No tracked CSV imports were found.' : lookup.result.count === 1
                  ? '1 catalog item was imported.' : `${lookup.result.count} catalog items were imported.`}
                {' '}{lookup.result.from} through {lookup.result.through} (Asia/Manila).
              </p>
              <p className="vc-note">Tracked, saved catalog items only. Older imports may not be recorded. This is not stock received.</p>
              {lookup.result.recent.length > 0 && <details>
                <summary className="cursor-pointer">View import history</summary>
                <ul className="mt-2 space-y-1">
                  {lookup.result.recent.map((row, index) => <li key={index}>
                    Import batch {row.batchId.slice(0, 8)} · {assistantManilaTime(row.at)}
                  </li>)}
                </ul>
                {lookup.result.count > lookup.result.recent.length && <p className="vc-note">Showing the latest {lookup.result.recent.length} item saves.</p>}
              </details>}
            </> : <>
              <p role="status">{lookup.result.matches.length === 0 ? 'No exact recorded owner name matched.' :
                lookup.result.matches.length > 1 ? 'Choose the matching record.' : 'One matched record.'}</p>
              {lookup.result.more && <p className="vc-note">More records share this name. Use Patients if the record you need is not listed.</p>}
              <ul className="space-y-2">
                {lookup.result.matches.map(match => <li key={match.reference}>
                  {onOpenPerson ? <a href="#patients" className="underline" onClick={event => {
                    event.preventDefault(); void openPerson(match.reference);
                  }}>{match.name} · {match.patientName} — Open record</a> : <span>{match.name} · {match.patientName}</span>}
                </li>)}
              </ul>
            </>)}
        </section>}
        {reply && <section aria-label="Assistant reply" className="min-w-0 space-y-3 break-words rounded-xl border border-outline-soft bg-panel-subtle p-3 text-sm">
          {'message' in reply && !stale && <p role="status">{reply.message}</p>}
          {reply.kind === 'help' && <button type="button" className="vc-btn vc-btn-sm" onClick={() => go(reply.destination)}>{links[reply.destination]}</button>}
          {stale && <p role="alert">The appointment changed or the schedule is no longer current. Ask again before reviewing.</p>}
          {(reply.kind === 'unavailable' || reply.kind === 'not-found' || stale) &&
            <button type="button" className="vc-btn vc-btn-sm" onClick={() => go('appointments')}>Open Appointments</button>}
          {matching && !stale && <>
            {matching.requiresSelection && <div className="space-y-2">
              <p role="status">Choose the scheduled appointment you mean.</p>
              <ul className="space-y-2">
                {matching.candidates.map(row => <li key={row.id}>
                  <button type="button" aria-pressed={selectedId === row.id} className="vc-btn vc-btn-sm max-w-full"
                    onClick={() => { cancelReview(); setSelectedId(row.id); }}>
                    <span className="min-w-0 break-all whitespace-normal text-left">
                      {row.patientName} · {row.type} · {assistantManilaTime(row.dueAt)} · {row.id}
                    </span>
                  </button>
                </li>)}
              </ul>
            </div>}
            {selected && <div role="status" className="space-y-1">
              <p className="font-semibold">{selected.patientName} · {selected.type}</p>
              <p>Appointment ID: {selected.id}</p>
              <p>{proposal ? 'Current time: ' : 'Scheduled: '}{assistantManilaTime(selected.dueAt)}</p>
              {proposal && <p>Proposed time: {assistantManilaTime(proposal.proposedDueAt)}</p>}
              {reply.kind === 'reschedule' && !proposal && <p>That is already the scheduled time. Choose a different time.</p>}
            </div>}
            {reply.kind === 'reschedule' && !canEdit && <p role="status">Your schedule access is read-only. An online owner or editor can review changes.</p>}
            {proposal && canEdit && <>
              <p className="vc-note">The assistant only prepares a draft. Opening it does not save anything.
                To reschedule, select Review &amp; save appointment in Appointments and confirm. This does not send messages or change billing.</p>
              <button type="button" className="vc-btn" disabled={checking}
                onClick={() => void reviewInAppointments(proposal)}>Review in Appointments</button>
              {checking && <p role="status">Checking clinic access…</p>}
            </>}
            {reviewError && <p role="alert">{reviewError}</p>}
          </>}
        </section>}
        </div>
        <form className="space-y-2 border-t border-line px-3 py-2 sm:px-5 sm:py-3" onSubmit={event => {
          event.preventDefault();
          const prompt = text.trim();
          if (!prompt || querying) return;
          archiveTurn();
          clearActiveTurn();
          setQuestion(prompt);
          setText('');
          const answer = evaluateWorkspaceQuestion(prompt, schedule);
          // App requests stay in the app. Other questions go to the configured
          // provider with only prior successful provider turns as context.
          if (answer.kind === 'daily-briefing') void loadBriefing();
          else if (onClinicQuery && shouldDeferToModel(answer)) void queryClinic(prompt);
          else if (answer.kind === 'tool' || answer.kind === 'inventory-count') void investigate(answer);
          else setExchange({ text: prompt, reply: answer, windowKey });
          field.current?.focus({ preventScroll: true });
        }}>
          <label className="vc-label">Ask the assistant
            <textarea ref={field} className="vc-input w-full" rows={2} maxLength={400} value={text}
              aria-describedby={!history.length && !question ? `${id}-conversation-privacy ${id}-examples` : `${id}-conversation-privacy`}
              spellCheck={false} autoCorrect="off" autoComplete="off" autoCapitalize="off"
              onChange={event => setText(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (text.trim()) event.currentTarget.form?.requestSubmit();
              }} />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="vc-note">Schedule: {schedule.window.from} – {schedule.window.through} (Asia/Manila).{schedule.partial && ' Some pages are not loaded.'}</p>
            <button type="submit" className="vc-btn vc-btn-primary" disabled={!text.trim() || querying}>Ask</button>
          </div>
        </form>
      </div>
    </dialog>
  </>;
}
