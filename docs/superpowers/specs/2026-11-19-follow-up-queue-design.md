# Follow-up queue v1

Give staff one clinic-wide place to see scheduled **Follow-up** appointments due today or overdue in `Asia/Manila`, independently of whichever schedule pages have loaded. Missed, cancelled, completed, future-day, and other visit types stay in Appointments.

Staff can open the patient and use the existing manual reminder drafts. Owners and editors can explicitly mark an owner contacted after doing so, or undo a mistaken contact entry. The queue then shows **Contact recorded** and its time; nothing sends automatically or completes, cancels, or reschedules a visit. Viewers can read, not write. Cloud reads and writes require a connection; the fictional demo is session-only.

Use a separate clinic-scoped, indexed, paged query of scheduled follow-up appointments, not a derived dashboard summary or a second task database. Reuse the appointment audit transaction and add an optional latest contact record bound to the scheduled due time. A rescheduled follow-up becomes contactable again when due; edits to notes or duration preserve contact. Keep recorded contact visible in the queue while the visit remains due. No autonomous reminders, staff assignment, automatic creation or clinical recommendations.

No new dependencies or live releases. Preserve the unrelated pending workflow, testing docs, and `.gitignore` edits. Test with fictional data and local emulators; leave the existing staging and production sites unchanged.
