# Linux Mint setup

1. Extract the ZIP and open a terminal in the `VetWeb` folder.
2. Install **Node.js 24 LTS**, which includes npm, from
   <https://nodejs.org/en/download>. The Linux download page includes a
   user-local version-manager option. Open a new terminal after installation.
3. Run:

   ```bash
   bash setup-linux.sh
   ```

   The script installs project dependencies with `npm ci` and creates
   `.env.local` from `.env.example` if it doesn't already exist. It asks before
   replacing an existing `node_modules` directory.
4. To use the existing Cloudflare image Worker, edit `.env.local` and set
   `NEXT_PUBLIC_IMAGE_WORKER_URL` to its deployed URL. The signing secret stays
   in Cloudflare; do not copy it into this file. Leaving the value blank keeps
   the legacy inline-image behavior for real clinics.
5. Start the app:

   ```bash
   npm run dev
   ```

   Open <http://localhost:3000>. If it was already running when `.env.local`
   changed, stop it with Ctrl+C and restart it.

Optional checks: `npm run test:images`, `npx tsc --noEmit`, `npm run build`,
and `npm run lint`. `npm run test:rules` additionally requires a Java runtime
for the Firestore emulator. Network access is needed for installation and for
real Firebase/R2 accounts; the demo workspace remains independent of Firebase.

The ZIP does not include Git history. To push changes, clone the GitHub repo on
the laptop and copy your edited files into that clone, then review, commit and
push them. Do not add `.env.local` or credentials to Git.
