# Workspace assistant: help and appointment rescheduling

**Intent:** Give staff a virtual assistant they can open from any clinic screen. It can answer supported questions and prepare work in the app, while the staff member decides whether to save.

## Approaches

- A help-only panel is easy to ship but leaves staff to re-enter every change.
- **Selected:** An accessible header popup that answers locally and hands a reviewed rescheduling draft to the existing appointment form. It provides a real shortcut without adding a second save path.
- Provider-backed chat and direct record writes would expand what the assistant understands and does, but require separate decisions about data handling, permissions, and confirmation. They are not part of this slice.

## Experience

- When the owner's AI switch is on, show **AI Assistant** next to **Record visit** in the shared header. Use a labeled dialog, keyboard focus containment, Escape to close, and focus return to the launcher. On narrow screens the launcher and dialog must fit without hiding existing controls.
- Provide short examples for finding app features, asking when a scheduled appointment is, and asking to move one. Make the supported scope and local-only behavior clear. Do not suggest it can answer any topic.
- Use only scheduled rows already loaded for the active clinic's selected date window. Show the window and whether the schedule is partial. Do not present a missing, cached, loading, offline, or failed schedule as “no appointments.” If no exact match can be shown, offer to open Appointments. If names repeat or the result is partial, require staff to select a particular loaded appointment; do not infer that it is the intended visit.
- Ask for an explicit date including year and a 24-hour time or AM/PM; entry and proposal times are Asia/Manila. Accept short supported phrasing and offer an example rather than guessing missing values.
- For rescheduling, show the selected patient and appointment, old and proposed times, and **Review in Appointments**. Opening it pre-fills the ordinary appointment editor and changes nothing. Its existing confirmation and save handler are the only write path; retain the captured appointment revision. Never silently replace an unsaved manual draft.
- Viewers can ask supported questions but cannot hand off or save a change. If the appointment, clinic, session, role, or AI setting changes before handoff, invalidate it. Switching clinics, logging out, and closing the popup discard chat and proposals; nothing is persisted.

## Constraints and acceptance

- No provider calls, external data sharing, new Firestore permissions, or assistant-triggered writes. No direct model access, diagnosis, treatment, inventory, financial operations, payroll, or messages. Keep the existing offline Clerk preview unchanged.
- Verify with fictional data: popup at desktop/mobile widths, keyboard close and focus return, an info answer, explicit disambiguation, read errors, date/time correctness outside the Manila device timezone, no mutation before confirmation or after dismissing, only the intended appointment changes on save, and viewers/stale sessions cannot apply the proposal.
