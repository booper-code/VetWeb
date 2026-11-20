# AI Clerk: offline appointment proposal preview

**Intent:** Let staff try reviewing a proposed appointment change without risking a real or demo clinic record.

## Approaches

- Prewritten, non-editable cards are easy to audit, but do not exercise incomplete or ambiguous input.
- Editable fictional sample notes with a strict local parser exercise the review and clarification flow without model setup or data access. This is the selected approach.
- A local model would accept more phrasing but needs separate model approval and evaluation. An external provider or a write path is not part of this slice.

## Design

- Show the preview in the offline demo's End-of-Day Close only while the demo AI switch is on. It is not available in an authenticated clinic.
- Load one of three editable fictional examples: create, reschedule, or cancel. Accept at most one supported note per review, and resolve identifiers only against a small, separate fixture.
- Show the proposed action, fictional patient name and canonical fixture ID, appointment type and duration, and explicit `Asia/Manila` date/time. A reschedule shows old and new times; a cancellation shows the existing time and target appointment ID.
- An unknown ID, incomplete note, invalid timestamp, or unsupported request asks for clarification and produces no proposal. Do not infer names, times, types, or durations. Editing, clearing, or leaving the preview discards the previous result.
- Explicit fixture dates remain usable after they pass on the device clock. The preview does not decide whether a real appointment time is bookable.
- No execution, storage, application record lookup, model, network call, messaging, or non-appointment proposals. Browser tests use fictional data and block external requests.
