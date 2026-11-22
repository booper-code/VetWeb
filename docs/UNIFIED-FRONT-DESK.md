# Unified Workspace Assistant front desk — local preview only

**Snapshot: 2026-11-22.** One front desk, one **Ask** input, no provider toggle.
This is a localhost staging preview, not a hosted rollout or permission to send
real clinic records anywhere. Nothing was deployed and no account, record or AI
setting was changed while preparing this note.

**Update:** general front-desk briefings are now native **local** reads of the
signed-in clinic’s real staging records, not provider questions with a fixed
sample summary. See [DAILY-BRIEFING.md](DAILY-BRIEFING.md).

## What changed

The conversation popup previously had a vendor-named opt-in checkbox. That
checkbox is **removed**. There is now a single conversational front desk:

- There is no "Enable conversations" toggle and no vendor name in the disclosure.
  The sender sees one generic note: counts, appointment lookups and drafts stay
   in the app; other questions may be sent to **your configured AI provider**
   with query context but without clinic records or verified results. Use
   fictional messages only.
- Every submission is first evaluated by the same deterministic router used in
  standard mode (`evaluateWorkspaceQuestion` in `lib/workspace-assistant.ts`).
- Requests the app natively supports are answered **locally**, in the same
  transcript: greetings/thanks, navigation help, inventory catalog counts,
  scheduled-appointment lookup, draft reschedules (manual **Review in
  Appointments** handoff), and the two typed read-only Worker lookups (exact
  owner name, tracked CSV imports).
- Only a question the deterministic router cannot support is offered to the
  model. Clear briefing variants such as "What should I check today?", "are
  there any things in the clinic that i should be mindful of" and "who needs
  checking?" are **native local reads**, not model questions: they use the
  signed-in clinic’s real staging appointments, due follow-ups and stock alerts
  through a deterministic aggregator with no provider call and no data
  forwarded. Provider-neutral wording and the one Ask field are unchanged.
- With no provider settings saved, the local workflow is unchanged and a general
  question returns provider-neutral setup guidance (choose a provider and model,
  then save a key in Clinic setup). No request is sent.

`shouldDeferToModel(result)` is the explicit routing decision. It returns true
only for the generic, unsupported-question clarification. A *specific*
clarification (for example a reschedule with a malformed time, or a malformed
find-person request) is still a recognized native request and stays local, so a
patient/owner name in that prompt is not disclosed as a side effect of a typo.

## Provider-neutral transport

`lib/workspace-ai.ts` uses the provider, model and key **saved by the user in
Clinic setup** — never a guessed, bundled or environment-supplied key, and never
a log of that configuration. It speaks the two wire formats already registered
in `lib/ai.ts`:

- the Gemini-style `generateContent` format (system instruction + `contents`
  user/model turns, key in the `x-goog-api-key` header);
- the OpenAI-compatible `chat/completions` format (system message + user/
  assistant messages, key in the `Authorization: Bearer` header), used by the
  other built-in providers, including Ollama's registered loopback endpoint.

The endpoint is the provider's **exact registered base URL**, compared against
the saved base URL after trimming trailing slashes. A custom/unverified URL, or
an edited base URL that does not match the built-in registration, fails closed
with a provider-neutral error and sends nothing. The two official endpoint
families used here were checked against provider documentation; no live model
call, key or account was used for that check.

Preview gating in `app/page.tsx` requires a signed-in (not demo) workspace,
`NODE_ENV === 'development'`, the exact `http://localhost:3000` origin and
the isolated staging project. Every non-native turn uses the same
[read-only query planner](CLINIC-QUERY-ENGINE.md); the sample catalog and
follow-up chat are no longer wired into the popup. The hosted static build
does not wire the planner callback — the local-only assistant still works.

The transport makes exactly one request per send: no retry, no redirect
(`redirect: 'error'`), no credentials, and a 15-second abort. Errors are phrased
provider-neutrally (for example a rate limit or "check the saved provider, model
and key in Clinic setup"); no vendor name is shown to the sender.

## Privacy boundary (what is never sent to the model)

- Real clinic records, patient IDs, chart data, owner contact details, notes,
  billing or payroll data, clinic IDs, or any account/owner data.
- Raw records or tool outputs, and the grounded local inventory count or
  appointment lookup results.
- Local-only conversation turns, including the fact that a local lookup or draft
  happened. Model history is seeded exclusively from earlier successful turns
  in this same chat.
- Any write path. The assistant remains proposal-only: **Review in Appointments**
  opens or offers an unsaved draft, and an authorized user still has to use
  **Review & save appointment** in the ordinary audited editor. No message is
  sent and no billing is changed.

## Failure, cancellation and stale-scope guarantees

- A failed or unavailable local lookup fails closed (no false zero, no empty
  schedule claim) and is archived as past-tense text without draft controls.
- A failed model turn is shown as an error and is not retained in chat history.
- A new question can supersede a pending local lookup. During a model request,
  sending is paused; **Clear chat**, minimize, or a workspace/scope change can
  cancel it. Late responses cannot render or enter history. The popup is keyed
  by workspace scope, so a scope change remounts it and drops both transcripts
  and model context.
- Appointment replies are re-checked against the current schedule window,
  revision, and candidate set before a draft can be reviewed; a changed or stale
  schedule blocks review until the question is asked again.
- Chat history is keyed in `app/page.tsx` by workspace scope **and** a setup
  generation that changes with the saved provider, model, exact endpoint, or key.
  Changing any of those starts a fresh history; turns from the previous setup
  are never forwarded. The transport repeats this check at the request boundary.
  The saved key itself is never logged or printed.

## Verification

- `npm run test:assistant:workspace` — offline router, tool, aggregate briefing
  and provider-neutral transport tests. The transport suite checks both wire
  formats and their exact endpoints, bounded history, `redirect: 'error'`, one
  request per send, no tools, no arbitrary-URL send, no saved config/key, and
  that canaries (private owner data, record IDs and the key) never appear in the
  serialized request. Briefing routing is asserted to stay local.
- `npm run test:assistant:briefing` with the pinned Chromium — the component/
  browser flow covers native routing staying local, **briefing questions making
  zero provider calls**, and the real read-only clinic query and reschedule
  draft/Review in Appointments flows continuing to work. General conversation,
  failure, cancellation and stale-scope behavior are still covered.
- `npx tsc --noEmit` and targeted ESLint on the touched files.

## Limitations

- "Native" is decided by the existing deterministic router's exact patterns, not
  by a natural-language classifier. A supported request with unusual phrasing may
  be treated as a general question and offered to the configured provider. The
  generic disclosure therefore asks the user to send fictional messages only,
  and each send is still an explicit user action. Briefing variants use a small
  explicit pattern list; a qualifier, write verb or different clinic keeps them
  out of the local briefing path.
- The app does not inspect free text for identifiers. The user's own question is
  their input; the guarantee here is that the app's verified results, records,
  tool outputs, grounded counts, appointment lookups and local-only turns are
  never attached to a model request.
- This is not a hosted provider integration or a permissions boundary. Firestore
  rules and the localhost/staging gates remain the actual controls. Only the
  exact built-in endpoints are allowed; a Custom endpoint is not auto-sent.

Automated tests used mocked transport. No live provider call was made for this
note. An earlier localhost smoke check (before the local briefing change)
confirmed that the nine-item inventory count made zero model calls and a
front-desk briefing made one successful call that flagged QA Luna’s overdue
follow-up. That briefing path is now local; no equivalent live staging smoke
check was performed for it.
