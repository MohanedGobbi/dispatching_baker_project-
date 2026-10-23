# CrewBoard local desktop plan (final, reviewed 2026-10-23)

## Target

One user, one Windows PC, offline, English only. CrewBoard runs as an Electron program with an installer, a Start-menu
icon and its own window. The screens, rules and functionality stay exactly as they are. Made by Mohaned Gobbi.

## Decisions (locked unless changed)

1. Electron: its bundled Chromium draws the screens, so the visuals stay identical.
2. Prisma stays, switched to SQLite (Prisma 6.19 supports enums and Json on SQLite). No query rewrite.
3. English only, no encryption, no PIN. Anyone using the PC can open the app.
4. No notifications of any kind (bell, in-app, email).
5. Plans go Draft → Review → Approved → Published. The setting `workflow.requireApproval` defaults to `false` today
   (publish straight from Draft); its default is switched to `true` so the four steps are what you get.
6. The audit log stays.
7. Near-due replacement tasks are still marked "escalated", by a small function that runs when the task list is read.
   Nothing is sent.
8. No speed-fix step.
9. No tests between steps. One full pass at the end.
10. Signature: "Made by Mohaned Gobbi" appears in the app, the installer and the docs (Step 5).

## Step 0: Electron + Prisma + SQLite test (about an hour)

- A tiny Electron program with a Prisma/SQLite database, packaged with electron-builder exactly as the real app will be.
- Built and run on this PC (the session runs on Windows, so it can build and run the installer here).
- Proves the two main risks before any large change:
  - Prisma's query engine (`query_engine-windows.dll.node`) loading from outside the app archive (`asarUnpack`).
  - Creating and migrating the database on first launch **without the Prisma CLI**, which is not shipped in an
    installer. A small runner applies the migration SQL files in order and records them in a table.

**Result (2026-10-23): passed.** Test app in `spike/electron-prisma` (gitignored), Electron 45.0.0, electron-builder
26.15.3, Prisma 6.19.3. The installed app created its database, applied the migration on first launch and skipped it
on the second, ran in WAL mode, round-tripped an enum, Json arrays and a relation, ran an interactive transaction,
matched `contains` without `mode`, made a `VACUUM INTO` backup, and refused requests without the launch key (403).
Installer 133 MB, per-user, publisher "Mohaned Gobbi"; uninstalling keeps the data. Rules learned for Step 4:
- electron-builder drops `node_modules/.prisma`: generate the client to a plain folder (`output = "../generated/client"`)
  and `asarUnpack` its `*.node` engine; set `PRISMA_QUERY_ENGINE_LIBRARY` to the unpacked engine.
- If the API process fails to start, show an error and quit (otherwise the app hangs with no window).
- Electron's GitHub download drops on this connection: fetch the zip with a resumable download, check it against
  `SHASUMS256.txt`, and point `electronDist` at the unpacked folder.

## Step 1: one production process

- Build the API to plain JavaScript (`tsc`) and the web app to static files (`vite build`).
- The API serves the web app on `127.0.0.1:3000`, so one Node process runs everything.
- `start-crewboard.cmd` starts it hidden and opens the browser.
- `tsx watch` and the Vite dev server leave the normal start (they stay as `npm run dev:*` for development).
- Docker is still needed until Step 2.

**Result (2026-10-23): done.** `start-crewboard.cmd` builds when the code is newer than the build, then runs
`node apps/api/dist/src/main.js` hidden, with logs in `logs/`. The API serves `apps/web/dist` and strips `/api` from API
requests (as the Vite proxy does), listening on 127.0.0.1 only. The API build now runs `prisma generate` first: the
generated client was out of date (`openEnded`), which `tsx` never noticed because it does not type-check. Measured:
the app process uses about 100 MB; Docker Desktop and its Linux VM about 2.5 GB, which Step 2 removes.

## Step 2: Postgres to SQLite

- Schema:
  - Datasource becomes `sqlite`.
  - `Employee.tags`, `Base.facilities` and `Plan.scope` (the three `String[]` fields) become JSON, behind small
    helpers so the code still sees arrays.
  - The 3 raw SQL statements in `apps/api/src/employees/employees.ts:340-344` (rank rename inside `tags`) are rewritten
    in TypeScript.
  - `mode: 'insensitive'` is dropped in the 7 places (SQLite's `LIKE` already ignores case for plain letters).
  - The 17 migrations are replaced by one fresh starting migration.
- Database file: `crewboard.db` in a `data` folder for now, `%APPDATA%\CrewBoard` from Step 4. WAL mode and a longer
  busy timeout are set at startup.
- Uploaded files (unit papers, medical certificates in `apps/api/storage`) move with the data: `STORAGE_DIR` points
  next to the database.
- Your real data:
  - A one-time copy script, Postgres to SQLite, copies every table and the `storage` folder, then prints a row count
    per table for both sides.
  - Run on this PC against the Docker volume.
  - Postgres stays untouched until the counts match and you have looked at the app.
- Backups: a daily copy into `backups`, keeping the last 14 plus one per month, and a "Back up now" button in Settings.
  Copies are made with SQLite's `VACUUM INTO` (a plain file copy can miss data still in the WAL file) and include the
  `storage` folder.
- Removed: `docker-compose.yml`, Redis, and the Docker steps in the scripts and docs.
- **Checkpoint:** pause for your OK before anything is deleted.

**Result (2026-10-23): copied, waiting at the checkpoint.** The real data is in `data/crewboard.db` (gitignored) with the
51 uploaded files in `data/storage`. `npm run copy-from-postgres` matched every table's row count (690 rows and files)
with no broken references, and `-- --verify` found every row of all 42 models identical. The app ran on a throwaway
copy with every screen loading and no failed request; "Back up now" made a backup that opens with the same numbers.
Notes for later work:
- The API creates and migrates the database itself at start (`src/prisma/migrate.ts`, table `_migrations`); the
  Prisma CLI no longer runs migrations. New migration: `npx prisma migrate diff --from-schema-datasource
  prisma/schema.prisma ...` is not available without a live URL, so diff from the previous schema file and **check
  JSON defaults**: Prisma writes `DEFAULT []` / `DEFAULT {}` unquoted for SQLite, which SQLite rejects.
- The seeds (`seed`, `seed:real`) wipe every table. They must never run against the real data.
- Still in place until the checkpoint OK: Docker, `docker-compose.yml`, the Postgres schema copy and old migrations
  in `prisma/postgres/`, the `POSTGRES_URL` line in `.env`, and the Docker step in `start-crewboard.ps1`.

## Step 3: remove the multi-user parts and notifications

- Auth: no sign-in, password, token or role check; every endpoint acts as the manager. The permissions file, the role
  guard, base scopes and the extra seeded accounts are deleted. The audit log records "Manager" as the author.
- Delete:
  - the employee portal, its service worker (`sw.js`) and manifest;
  - user admin and password reset;
  - email, the outbox and its one-minute timer;
  - the whole notifications module, the bell and its screens, preferences, broadcast and acknowledgements. The
    `notify(...)` calls in assignments, extensions, leave, maintenance, planning, replacements and tasks are removed;
  - shift swaps and the swap tab on the Leave page;
  - the live-update channel (`/board/events`); screens reload after your own changes.
- Moved, not deleted: the escalation of near-due replacement tasks (today part of the notifications daily job) moves
  to the replacements module and runs when the task list is read (decision 7).
- Kept: the audit log, the plans workflow, the "reason to override" prompt with its Settings toggle, and the hourly
  preventive-maintenance scheduler in `fleet.ts`.
- Database: a migration drops the unused tables (users, roles, email outbox, notification preferences, notifications,
  acknowledgements, swaps).

**Result (2026-10-23): done.** Docker, Postgres and their leftovers were removed first (a final `pg_dump` is kept in
`data/backups`). Then:
- API: the auth, users, mail, notifications, portal and swaps modules are gone; every permission check became the
  manager's answer (full access, no base scope, medical details visible; analytics still hides medical reasons as it
  did for everyone). "Done by" columns store `manager`; `audit()` no longer takes a user.
- Escalation of near-due replacement tasks now runs when the task list is read (`replacements.ts`, `escalateDue`).
- `workflow.requireApproval` now defaults to on. The same setting also decides whether extensions are requested then
  approved (on) or applied at once (off); turn it off in Settings if that second step is not wanted.
- Web: no sign-in, account menu, bell, portal, user admin or swaps tab; the offline service worker is unregistered
  from browsers that had it. Screens refresh after each change through an in-page signal instead of the server
  stream.
- Migration `20261023120000_single_user` drops User, UserRole, PasswordResetToken, Notification, UserPrefs,
  EmailOutbox and SwapRequest, and the user columns of AuditLog and StoredFile. Applied to the real data after a
  backup (`data/backups/before-single-user-2026-10-23`); every crew table kept its row count.
- The migration runner now switches foreign keys off around each migration and checks every reference before it
  commits (SQLite ignores the switch inside a transaction, which Prisma's table rebuilds rely on).
- Not yet done (final pass): the smoke suites, `demo` scripts and Playwright tests still sign in as several roles.

## Step 4: Electron wrapper

- Tools: Electron, electron-vite and electron-builder (NSIS installer for Windows), at the versions the install pulls,
  pinned in `package.json`.
- How it runs:
  - The main process starts the API with `utilityProcess.fork` (Electron's built-in Node; no separate Node install).
  - The API listens on `127.0.0.1` on a random free port and only answers requests carrying a per-launch secret
    header, which the window's preload passes in.
  - The window loads the built web app from the API.
- Details: one instance only (a second launch focuses the open window), data in `%APPDATA%\CrewBoard`, closing the
  window stops the API, Prisma's engine unpacked from the archive, Start-menu and desktop icon, the migration runner
  from Step 0 runs at every start.
- Delivery: configuration written and tested here, the app run unpacked, then `npm run dist` builds the `.exe`
  installer on this PC.

**Result (2026-10-23): done.** `desktop/` (outside the npm workspaces): `main.js` (Electron main process),
`scripts/stage.cjs` (builds API and web, assembles `build/app` with the API's runtime packages at their tested
versions), `scripts/make-icon.cjs` (256 px icon from the web logo; the old 64 px `.ico` was refused by the
installer). Electron 45.0.0, electron-builder 26.15.3, assisted NSIS installer (138 MB, per user, choice of folder,
Start menu and desktop shortcuts, data kept on uninstall). electron-vite was not needed: the web app is already built
by Vite and the main process is plain JavaScript.
- The Prisma client is generated into `apps/api/prisma/client` and imported through `src/db.ts`; the API build copies
  it and the migrations to `dist/prisma`, so nothing depends on `node_modules/.prisma`.
- The API listens on a free port (`PORT=0`), reports it to the main process, and refuses requests without the launch
  key (`CB_KEY`). Engine log: `%APPDATA%\CrewBoard\logs\api.log`.
- Data moved from `<repo>/data` to `%APPDATA%\CrewBoard\data` (copied, compared table by table and byte by byte, then
  the old folder renamed to `data.moved-to-appdata-2026-10-23`). `start-crewboard.cmd` uses the same folder.
- Checked: unpacked and installed, every screen renders through the key-guarded API on a copy of the real data with
  no failed request; a request without the key gets 403; the daily backup runs at start.

## Step 5: signature

- "Made by Mohaned Gobbi" in small text at the foot of the sidebar, and in an About section in Settings (with the
  version).
- `package.json` `author`; electron-builder `copyright` ("© 2026 Mohaned Gobbi") and publisher name, so it shows in the
  installer and in Windows "Apps & features".
- README and the user manual.

## Final pass (after Step 5)

- Type check and lint on API and web.
- The 89 logic tests, unchanged.
- The smoke scripts, rewritten for SQLite and no logins. The ones for the portal, users and notifications are deleted;
  permission checks are removed from the others. `smoke-transfer.ts` (Excel import/export) is **kept**: it tests a
  feature that stays.
- A look at the main screens in the Electron window.
- Fixes for whatever breaks, including the failing check `transfer to same base rejected`
  (`apps/api/scripts/smoke-master-data.ts:105`, moving a unit to the base it is already at).
