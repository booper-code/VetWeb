# Two clinic roles implementation plan

**Goal:** Enforce one Owner per clinic and full-power Members, with team access management reserved for the Owner.

**Spec:** [Two clinic roles](../specs/2026-11-26-owner-member-roles-design.md)

**Stack:** Next.js, React, TypeScript, Firebase Auth and Firestore Rules, Cloudflare Workers.

### 1. Firestore authorization and legacy data

- [ ] In `tests/firestore.rules.test.mjs`, add or update emulator checks for a Member doing existing clinic work, a legacy Viewer receiving Member permissions, Owner-only invitations and removal, and ownership staying fixed. Cover Owner and Member reads of audit and payroll and outsider denial. Run the rules suite and confirm the new expectations fail with the old rules.
- [ ] In `firestore.rules`, grant clinical and clinic administration privileges to current members and preserve the existing membership and audit checks. Reserve team/invite changes for the canonical Owner. Remove ownership and role reassignment paths. Update invitation validation and both atomic membership writes for the new role, preserving acceptance of valid legacy Editor invitations and requiring reissue of legacy Viewer invitations.
- [ ] Run `npm run test:rules`. Update older assertions that intentionally exercised Viewer restrictions or transferable ownership to cover the new boundaries.

### 2. App and Worker role checks

- [ ] Add failing workflow and Worker tests for the new Member's capabilities, legacy role normalization, invite acceptance, and absence of Owner-only team controls. Use existing fixtures and test harnesses.
- [ ] In `types.ts`, `lib/clinics.ts`, `app/page.tsx`, and the relevant components, normalize stored legacy roles, present Owner and Member, simplify team controls to invite/revoke/remove, and preserve clinic scoping, stale-session handling, and offline restrictions. Review payroll, account settings, audit, billing, and assistant entry points for former Owner-only or Viewer gates.
- [ ] In the assistant and image Workers and their client-side access adapters, recognize the new and legacy Member values and grant the approved clinic permissions. Continue checking clinic and feature access for each request.
- [ ] Verify with the relevant workflow and Worker suites, type-check, and a build. Use focused role review to check that UI, rules, and Workers agree.

### 3. Acceptance

- [ ] Run `npm run test:offline:browser` after `npm run test:rules` has stopped; both use the same emulators. Verify separate Owner, Member, and unrelated-clinic sessions. Cover Member writes and Inventory sync, verified invite acceptance, and access revocation. Keep emulator fixtures disposable.
- [ ] Document the verified results and rollout dependencies. Use only an approved staging fixture for the live invitation; coordinate rules, Workers, and UI before enabling Members on a deployed backend.

## Local verification

- Firestore rules: 65 tests plus custom scenarios, including the expected pre-change Member-invite denial and the passing post-change acceptance.
- Emulator browser: 6 tests, including Owners creating an invite that a separate verified user accepts as a Member, and Member inventory changes and clinic isolation.
- Focused workflow, Worker, and assistant suites: 235 tests. Static browser suites: 16 tests. Type-check, ordinary build, and static export passed.
- Lint still reports the pre-existing React Compiler memoization error in `app/page.tsx`.
- Staging publication and live invitation acceptance remain pending.
