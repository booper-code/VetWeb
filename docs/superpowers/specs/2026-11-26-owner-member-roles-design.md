# Two clinic roles

VetWeb has one Owner and any number of Members per clinic. A new clinic's creator becomes its Owner. For an existing clinic, its recorded Owner stays in place, including after a transfer that already happened. The former Owner of a transferred clinic is a Member. There are no new ownership transfers.

Members have the same clinic-work permissions as the Owner: clinical records, inventory, clinic settings, payroll, audit, data export, images and enabled assistant tools. Only the Owner can create or revoke an invitation and remove another member. A signed-in person can still accept their own valid invitation using its verified email address. These boundaries apply in the backend as well as in the UI.

## Approach

Use `owner` and `member` for new records. Recognize existing `editor` and `viewer` records as Members at the point of access; no bulk rewrite is needed to move current members onto the new permissions. This includes existing read-only Viewers. Keep the recorded `ownerId` authoritative. This approach avoids a data migration that could leave member records and clinic-picker indexes out of step. A UI-only rename would leave existing rules and Workers enforcing the old permissions.

Keep previously issued Editor invitations usable. Pending Viewer invitations explicitly offered read-only access; require the Owner to reissue them as Member invitations so they knowingly grant the new permissions.

Verify locally and on a separately approved fictional staging fixture. Deploying rules, Workers, or UI is a separate step from implementing the change.
