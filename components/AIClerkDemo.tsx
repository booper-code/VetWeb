'use client';

import { useId, useState } from 'react';
import { billingLocalTime, BILLING_TIME_ZONE } from '@/lib/billing-values';
import { CLERK_DEMO_EXAMPLES, CLERK_DEMO_MAX_NOTE_LENGTH, reviewClerkDemoNote, type ClerkDemoResult } from '@/lib/ai-clerk-demo';

const actionLabels = {
  create: 'Create appointment',
  reschedule: 'Reschedule appointment',
  cancel: 'Cancel appointment',
};
const showTime = (ms: number) => `${billingLocalTime(ms).replace('T', ' ')} ${BILLING_TIME_ZONE}`;

export function AIClerkDemo() {
  const headingId = useId();
  const guidanceId = useId();
  const proposalId = useId();
  const [note, setNote] = useState('');
  const [review, setReview] = useState<ClerkDemoResult | null>(null);
  const updateNote = (value: string) => {
    setNote(value);
    setReview(null);
  };
  const proposal = review?.kind === 'proposal' ? review.proposal : null;

  return <section aria-labelledby={headingId} className="min-w-0 space-y-3 rounded-xl border border-outline-soft bg-panel p-4 sm:p-5">
    <h2 id={headingId} className="font-bold text-content-heading">AI Clerk preview</h2>
    <p id={guidanceId} className="vc-note">
      Offline demo using fictional records and fixed note formats (up to {CLERK_DEMO_MAX_NOTE_LENGTH} characters). Don&apos;t enter real patient data.
      No AI provider is called and no appointment can be saved here.
    </p>
    <div className="flex flex-wrap gap-2">
      {CLERK_DEMO_EXAMPLES.map(example => <button key={example.label} type="button"
        className="vc-btn vc-btn-sm" onClick={() => updateNote(example.note)}>{example.label}</button>)}
    </div>
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); setReview(reviewClerkDemoNote(note)); }}>
      <label className="vc-label">Fictional appointment note
        <textarea className="vc-input w-full" rows={2}
          aria-describedby={guidanceId} value={note} onChange={event => updateNote(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="vc-btn">Review note</button>
        <button type="button" className="vc-btn" disabled={!note && !review} onClick={() => updateNote('')}>Clear preview</button>
      </div>
    </form>
    {review?.kind === 'clarification' && <p role="alert" className="text-sm text-warning-text-deep">
      <strong>Needs clarification. </strong><span>{review.message}</span>
    </p>}
    <div aria-live="polite">
      {proposal && <section aria-labelledby={proposalId} className="space-y-2 rounded-xl border border-outline-soft bg-panel-subtle p-3 text-sm">
        <h3 id={proposalId} className="font-bold text-content-heading">Appointment proposal</h3>
        <p className="font-semibold text-content-heading">{actionLabels[proposal.action]}</p>
        <dl className="space-y-1 break-words">
          <div><dt className="inline font-semibold">Patient: </dt><dd className="inline">{proposal.patientName} · {proposal.patientId}</dd></div>
          {proposal.action !== 'create' && <div><dt className="inline font-semibold">Appointment ID: </dt><dd className="inline">{proposal.appointmentId}</dd></div>}
          <div><dt className="inline font-semibold">Type and duration: </dt><dd className="inline">{proposal.appointmentType} · {proposal.durationMinutes} minutes</dd></div>
          {proposal.action === 'reschedule' && <div><dt className="inline font-semibold">Original time: </dt><dd className="inline">{showTime(proposal.previousAtMs)}</dd></div>}
          <div><dt className="inline font-semibold">{proposal.action === 'cancel' ? 'Existing time: ' : 'Proposed time: '}</dt>
            <dd className="inline">{showTime(proposal.scheduledAtMs)}</dd>
          </div>
        </dl>
        <p className="vc-note">For review only. Nothing was saved or sent.</p>
      </section>}
    </div>
  </section>;
}
