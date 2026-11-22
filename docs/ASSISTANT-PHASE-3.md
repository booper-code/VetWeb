# Assistant Phase 3 — fictional confirmation and transaction rehearsal

**Local only.** Phase 2B did not justify a model. Phase 3 uses one predefined
fictional appointment and an explicit Manila date and time. Neither rehearsal
is imported by the app or Workers. No provider, credentials, or clinic records
are involved.

The [lab](../scripts/assistant-phase3/appointment-review.ts) makes one immutable
review at a time with the current and proposed times. Confirming the review ID
rechecks the fictional actor, role, workspace, AI setting, connection, target
status, original time, and revision. A review expires after five minutes and is
invalidated by replacement, dismissal, or a confirmation attempt. Successful
confirmation is **simulated approval**, not a save or an appointment update.

The [transaction rehearsal](../scripts/assistant-phase3/reschedule-transaction.ts)
adds a separate step after confirmation. That step rechecks access, expiry,
and the target revision, then updates only an in-memory fixture and publishes
its audit receipt together with the new state. A competing approval based on
the original revision cannot apply. Duplicate delivery can return the original
receipt without applying again, and an audit failure publishes neither change.

If a response is lost after application, a fresh simulated session with the
same access binding can look up the receipt by operation ID. It never retries
the change as part of that check. `not-found` and `unavailable` are not permission
to retry; a different access binding is deliberately not told whether a receipt
exists. Opening a new session shares the same in-memory store, but restarting
the process loses it. The rehearsal does not prove durability, database
transaction isolation, or authorization enforcement in a real deployment.

Run `npm run test:assistant:phase3` to exercise confirmation, duplicate delivery,
competing approvals, rollback, and uncertain responses.

## Isolated Firestore verification

Run `npm run test:assistant:phase3:firestore` (Java 21) for the dedicated
loopback emulator and demo project. It uses separate fixture rules and
synthetic approvals. The tests verify that a rejected audit write rolls back
the appointment, competing revisions and simultaneous duplicate keys only
commit once, and a new SDK client can read the receipt after a simulated lost
caller response. The transaction also rechecks the stored scope and expiry.

The fixture suite is not an assistant integration or production authorization
test. It does not interrupt the Firestore commit RPC, restart the emulator,
or verify recovery across a service outage. The production appointment and
clinical audit rules were checked separately in the standard local emulator.

## Gate before real execution

The workspace assistant is **proposal-only**. It shows the current and proposed
appointment times. **Review in Appointments** opens or offers an unsaved draft;
it does not commit anything. An authorized owner or editor must separately use
**Review & save appointment** and confirm in the editor. That is the ordinary
audited appointment save. It sends no message and changes no billing. Phase 3
does not add an assistant execution path.

A separately authorized design must make the server own the approved payload
and derive actor, clinic, and role from trusted state. It must check the
approval scope, expiry, and target revision in the same transaction that
changes the appointment and writes the audit receipt. A durable, clinic-scoped
operation key must return the original result only for the same authorized
payload. The client must retain that key and reconcile uncertainty through an
authorized receipt read; it must not generate a new key and retry on timeout.
Before any live write path, test rollback, concurrent writers, and loss of a
commit acknowledgment against the chosen datastore in an isolated environment.
