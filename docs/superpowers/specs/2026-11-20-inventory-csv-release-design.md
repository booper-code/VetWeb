# Inventory CSV release rehearsal

The deployed shared Firestore rules predate the audit transaction used by the local inventory app. An owner can parse the CSV but cannot complete the first save. The approved scope is a release rehearsal, not a shared deployment.

Use Chromium with the real app page and Auth/Firestore emulators to exercise the exact sample with a signed-in Owner and Viewer. Prove the Viewer leaves the empty clinic unchanged, the Owner saves all 24 items and their audits, and retrying does not duplicate them. Build the matching app and document the remaining isolated-staging and shared-rollout gates.

An offline demo alone cannot exercise authorization. Deploying rules alone could break older clients. The rehearsal leaves production code, client behavior, shared rules, and cloud records unchanged.
