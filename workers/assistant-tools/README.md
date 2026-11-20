# Assistant tools — Phase 1

This standalone read-only Worker keeps the Next.js static export deployable.
It accepts **only** `POST /v1/lookup` (plus CORS preflight) and uses the caller's
Firebase ID token for all Firestore reads. It has no admin credential, model
key, billing operation, general Firestore route, or deploy target configured.

The request envelope is `{ clinicId, tool, input }`; clinic scope is supplied
by the signed-in app, never by an interpreter. Live Firestore membership and the
clinic AI switch are required before a query. Import history is Owner-only.
Name lookup projects only the names and gives the user record links; clicking
one revalidates access and opens the ordinary patient view outside the assistant.
Recorded owner names are matched exactly, including capitalization.

## Safe local checks

Run these from the repository, sequentially for the two emulator suites:

```sh
node --test tests/assistant-investigation.test.mjs
npm run test:rules
npm run test:offline:browser
```

The browser/emulator test opens the app with fictional accounts, the same Worker
handler, and loopback Firebase services. It imports the sample, checks the
count and evidence in the popup, verifies a partial import and a repeat, checks
Viewer denial for history, and confirms private fields appear only after
opening the normal record. The gateway's test transport uses emulator tokens;
the running Worker never accepts an unsigned production token.

## Activation requires separate approval

The existing app build and clinic data are unchanged unless explicitly configured.
For an approved environment, bind the Worker to the matching `FIREBASE_PROJECT_ID`
and a comma-separated list of exact `ALLOWED_ORIGINS`. Set
`NEXT_PUBLIC_ASSISTANT_TOOLS_URL` to that trusted Worker **origin** when building
the app; leave it empty until the environment is ready. Do not point the setting
at an arbitrary provider. A Firebase ID token is sent to this first-party Worker.
Keep `NEXT_PUBLIC_CSV_IMPORT_RECEIPTS` off until the matching receipt rules are
installed. Untracked import history is not backfilled. Do not log request bodies,
tokens, names, or tool outputs. Before hosted rollout, verify Cloudflare runtime
and CORS with fictional data, operational rate limits, and role denial on the
isolated project.

See the [design and model-phase boundaries](../../docs/superpowers/specs/2026-11-20-assistant-investigation-harness-design.md).
