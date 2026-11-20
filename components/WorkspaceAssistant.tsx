'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  askWorkspaceAssistant, assistantManilaTime, createAssistantReschedule, type AssistantDestination,
  type AssistantReply, type AssistantReschedule, type AssistantSchedule,
} from '@/lib/workspace-assistant';
import { routeAssistantTool, type AssistantToolCall, type AssistantToolError } from '@/lib/assistant-tools';
import type { AssistantLookup } from '@/lib/assistant-tool-client';

const links: Record<AssistantDestination, string> = {
  appointments: 'Open Appointments', patients: 'Open Patients', inventory: 'Open Inventory', dashboard: 'Open Overview',
};

const toolErrors: Record<AssistantToolError, string> = {
  'access-denied': 'Your clinic access or AI setting does not allow this lookup.',
  'invalid-request': 'That lookup could not be validated. Check the name or dates and try again.',
  unavailable: 'Could not verify clinic records. This does not mean there were no results.',
  timeout: 'The clinic lookup timed out. Try again.',
};

export function WorkspaceAssistant({ schedule, canEdit, onNavigate, onReview, onLookup, onOpenPerson }: {
  schedule: AssistantSchedule;
  canEdit: boolean;
  onNavigate: (destination: AssistantDestination) => void;
  onReview: (proposal: AssistantReschedule, stillOpen: () => boolean) => Promise<string | null> | string | null;
  onLookup?: (call: AssistantToolCall, signal: AbortSignal) => Promise<AssistantLookup>;
  onOpenPerson?: (reference: string, stillOpen: () => boolean) => Promise<string | null>;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const reviewVersion = useRef(0);
  const lookupRequest = useRef<AbortController | null>(null);
  const [lookup, setLookup] = useState<AssistantLookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookupNote, setLookupNote] = useState('');
  const [text, setText] = useState('');
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

  function cancelLookup() {
    lookupRequest.current?.abort();
    lookupRequest.current = null;
    setLookup(null); setLooking(false); setLookupNote('');
  }

  async function investigate(call: AssistantToolCall) {
    if (!onLookup) {
      setLookupNote('Clinic lookups are not configured here. The local appointment assistant is still available.');
      return;
    }
    const controller = new AbortController();
    lookupRequest.current = controller;
    const current = () => lookupRequest.current === controller && !controller.signal.aborted && dialog.current?.open === true;
    setLooking(true);
    try {
      const answer = await onLookup(call, controller.signal);
      if (current()) setLookup(answer);
    } catch {
      if (current()) setLookup({ error: 'unavailable' });
    } finally {
      if (current()) setLooking(false);
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
      else dialog.current?.close();
    } catch {
      if (current()) setLookupNote('Could not open the normal patient view. Ask again to verify access.');
    }
  }

  function cancelReview() {
    reviewVersion.current++;
    setChecking(false);
    setReviewError('');
  }

  function reset() {
    cancelReview(); cancelLookup();
    setText(''); setExchange(null); setSelectedId(null); setReviewError('');
  }

  async function reviewInAppointments(proposal: AssistantReschedule) {
    const version = ++reviewVersion.current;
    const stillOpen = () => dialog.current?.open === true && reviewVersion.current === version;
    setChecking(true); setReviewError('');
    try {
      const error = await onReview(proposal, stillOpen);
      if (!stillOpen()) return;
      if (error) setReviewError(error);
      else dialog.current?.close();
    } catch {
      if (stillOpen()) setReviewError('Could not verify the appointment. Try again.');
    } finally {
      if (stillOpen()) setChecking(false);
    }
  }

  function go(destination: AssistantDestination) {
    dialog.current?.close();
    onNavigate(destination);
  }

  return <>
    <button type="button" aria-label="AI Assistant" aria-haspopup="dialog" className="vc-btn h-10" ref={launcher}
      onClick={() => {
        reset();
        dialog.current?.showModal();
        field.current?.focus();
      }}>
      <Sparkles className="h-4 w-4" aria-hidden="true" />
      <span className="hidden lg:inline">AI Assistant</span>
    </button>
    <dialog ref={dialog} aria-labelledby={`${id}-title`} onClose={() => { reset(); launcher.current?.focus(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_1rem)] w-[calc(100%_-_1.5rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-panel p-4 text-ink shadow-xl backdrop:bg-slate-950/70 sm:p-5">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={`${id}-title`} className="text-lg font-bold">AI Assistant</h2>
          <button type="button" className="vc-btn vc-btn-sm" onClick={() => dialog.current?.close()}>Close assistant</button>
        </div>
        <p className="vc-note">Local assistant for app help and scheduled appointments{onLookup ? ', with read-only clinic lookups' : ''}. No AI provider is used and nothing is saved from this popup.</p>
        <p className="vc-note">Schedule window: {schedule.window.from} through {schedule.window.through}.
          {schedule.partial && ' Only some appointment pages are loaded.'} Reported times are Asia/Manila.
        </p>
        <form className="space-y-2" onSubmit={event => {
          event.preventDefault();
          cancelReview(); cancelLookup(); setSelectedId(null); setExchange(null);
          const routed = routeAssistantTool(text);
          if (routed.kind === 'tool') { void investigate(routed); return; }
          if (routed.kind === 'clarify') { setLookupNote(routed.message); return; }
          setExchange({ text, reply: askWorkspaceAssistant(text, schedule), windowKey });
        }}>
          <label className="vc-label">Ask the assistant
            <textarea ref={field} className="vc-input w-full" rows={2} value={text} aria-describedby={`${id}-examples`}
              spellCheck={false} autoCorrect="off" autoComplete="off" autoCapitalize="off"
              onChange={event => { cancelReview(); cancelLookup(); setText(event.target.value); setExchange(null); setSelectedId(null); }} />
          </label>
          <p id={`${id}-examples`} className="vc-note">
            Try “Where are appointments?”, “When is Milo&apos;s checkup?”, or “Move Milo&apos;s checkup to 2026-11-24 at 14:30”.
            {onLookup && ' For clinic lookups, try “How many CSV items were imported?” or “Find person Alex Reyes”.'}
          </p>
          <button type="submit" className="vc-btn vc-btn-primary" disabled={!text.trim()}>Ask</button>
        </form>
        {(lookup || looking || lookupNote) && <section aria-label="Clinic lookup" className="min-w-0 space-y-3 break-words rounded-xl border border-outline-soft bg-panel-subtle p-3 text-sm">
          {looking && <p role="status">Checking clinic records…</p>}
          {lookupNote && <p role="status">{lookupNote}</p>}
          {lookup && ('error' in lookup ? <p role="status">{toolErrors[lookup.error]}</p>
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
              <p className="vc-note">Nothing saved yet. Confirm in the appointment editor to make the change.</p>
              <button type="button" className="vc-btn" disabled={checking}
                onClick={() => void reviewInAppointments(proposal)}>Review in Appointments</button>
              {checking && <p role="status">Checking clinic access…</p>}
            </>}
            {reviewError && <p role="alert">{reviewError}</p>}
          </>}
        </section>}
      </div>
    </dialog>
  </>;
}
