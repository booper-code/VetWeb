# Handoff: run the VetCloudPro assistant stress test

## Task

Run the existing [48-case question bank](WORKSPACE-ASSISTANT-STRESS-QUESTIONS.md) through VetCloudPro’s real **AI Assistant → Ask** box. Capture and score the answers against the normal app screens, then recommend what to fix first. **This pass is testing and diagnosis only.** Do not change assistant code, provider settings, clinic permissions, or records.

Use **Hy4 Flash with High thinking** as the tester. This is the OpenCode model `opencode/hy4-flash-free#high`, not a replacement for the Gemini 3.5 Flash Lite configuration saved in Clinic setup. If possible, start the new top-level chat on Hy4 Flash (High) with the desktop browser attached. The previous Hy4 child session could not access the signed-in parent browser. If the new chat cannot see that session, sign in through its browser or arrange a browser relay; do not copy tokens, cookies, or credentials, and do not silently substitute a different tester or mocked replies.

## Where we left off

- The previous desktop chat saw **Booper** signed in at `http://localhost:3000` against `vetcloudpro-staging-6f819b`. Check again from the new chat before submitting anything. The assistant is a localhost staging preview, not a hosted rollout.
- **0 of 48 cases ran** in the delegated live run. Hy4’s browser was disconnected; its alternate contexts were signed out. No Ask submissions or live provider requests were made by the test run.
- The user’s own example is the only reported live result so far: **“how many patients and items in the inventory do we havve”** → **“There are 4 patients.”** Inventory was omitted. This is a partial answer, not a verified live replay. Four patients and nine catalog entries are fixture expectations until independently checked.
- Local inspection confirmed that the current planner can return one table and one operation per turn. It cannot express the two independent counts in that question. The [results log](WORKSPACE-ASSISTANT-STRESS-RESULTS.md) separates this and the other local findings from live evidence.

## First actions in the new chat

1. Open the attached browser, confirm the signed-in Booper workspace and the **AI Assistant** button, and preserve the user’s existing chat. Use a fresh test tab or fresh test conversation if available. Have the user sign in if necessary.
2. Verify the patient and catalog totals in the regular Patients and Inventory screens. Count catalog entries, **not stock units**, and include discharged patients in the patient control total.
3. Run M01–M06 first, then P01, I01, A01, F01, F02, and F07. Run the remaining cases if access and quota hold. Start each case with fresh context unless it is an ordered follow-up sequence. Leave at least **6.5 seconds between Ask submissions** (no more than 10 per rolling minute, even for local turns). Use one tester, no automatic retries, and stop live sends if a quota warning appears.
4. Append redacted results to [the results log](WORKSPACE-ASSISTANT-STRESS-RESULTS.md). Record case ID, each turn’s outcome, what the reply did or missed, and the app screen used to verify it. Score a missing clause as **partial**, not a pass. For A01, check zero provider calls using request metadata only if observable; otherwise mark that check unverified. Separate `not run`, `safe limitation`, and errors from factual failures.
5. Summarize repeated patterns and recommend the first improvement. Compare combined turns with their single-question controls before deciding whether the problem is query capability, routing, lost context, misleading wording, or an unavailable read.

Use fictional staging data only. Keep raw rows and full replies in the app, and report only redacted observations or safe fixture aggregates. Do not send messages, save a draft, or make any other change. “Currently here” means recorded active directory status, not confirmed physical presence.

Implementation references if needed for diagnosis: `lib/workspace-assistant.ts` (local routing), `lib/workspace-ai.ts` (provider planner), `lib/clinic-query.ts` (plan validator and result wording), `app/page.tsx` (permission and read orchestration), and `components/WorkspaceAssistant.tsx` (Ask UI).
