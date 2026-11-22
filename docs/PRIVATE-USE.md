# Private use: sign-in, recovery, and access removal

Keep the sign-in page reachable by bookmark or direct URL. Verify the intended
host sends `X-Robots-Tag: noindex` before relying on search exclusion. Staging
already uses it; it is not an access control or a guarantee that every crawler
will comply. Don't block crawlers from seeing `noindex` if you expect them to
remove already indexed pages. Use Cloudflare Access only if you separately
decide to hide the sign-in page itself from unapproved visitors.

## Accounts and clinic admission

- Give each person their own login. The owner controls invites, roles,
  removal, and ownership transfer. Editors make routine changes; use viewer
  for read-only access. Review the roster and unused invitations periodically.
- Registration creates a Firebase Auth account, not access to an existing
  clinic. Invite the exact email address; the recipient must verify it before
  accepting. Public registration and clinic creation remain supported.
  Hiding the signup button would not restrict the Auth API. Any registration
  restriction needs a separate provider-side design that preserves a route
  for new invitees and authorized clinic creators.

## If an owner cannot sign in

1. On the known sign-in URL, choose **Forgot password?** and enter the original
   account email. Check inbox and spam. The reset confirmation doesn't say
   whether the address belongs to an account. Use the newest reset link, then
   return to the bookmarked URL and sign in. Resetting the password on the
   same account preserves its UID and clinic role; a new account is not a
   substitute for the owner.
2. If the mailbox is lost, recover it through the mail provider first. If the
   mailbox or second factor cannot be recovered, use the prearranged project
   administrator contact and verify the owner's identity through an independent
   channel before any administrative recovery. An editor cannot take over the
   clinic. There is one owner at a time: planned handover uses the existing
   owner's **ownership transfer** to an existing member. Do not delete the
   owner account or relax rules to get around a lockout.
3. Protect the owner mailbox and Google/Firebase/Cloudflare administrator
   accounts with MFA and store recovery material separately. These are
   distinct from the application's Firebase email/password login. App-level
   MFA is **not configured by this change**. Before enabling it on an owner
   account, verify provider support, implement and test the second-factor
   challenge in the app, and rehearse loss of the factor in isolation. Do not
   enroll the sole owner ahead of that rehearsal.

## Remove access

An owner revokes any pending invitations for that person and removes their
membership from each applicable clinic. When authorized, also revoke provider
sessions or disable a compromised account, and remove any Cloudflare Access
or project-administrator grants if present. Verify with fresh online Firestore
and image requests that the old account cannot access the clinic. Do not
assume a password reset alone removes clinic access.

Server revocation cannot erase prior downloads, screenshots, or cached
records. On a clinic-controlled trusted device, use **Disable, sign out &
clear device data** after reviewing unsynced work; verify cleanup completed
and handle exported files separately. For a lost device, follow the clinic's
device-loss procedure rather than assuming remote clinic removal wiped it.

See the [isolated restore drill](CLINIC-RECOVERY.md) and
[security status](SECURITY-STATUS.md) before relying on the site for real data.
