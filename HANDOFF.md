# CrewBoard: handoff

Written 2026-10-23, at the end of the move from a multi-user web platform to a single-user Windows desktop app.
Read this first, then the [README](README.md). The history of the move is in [docs/desktop-plan.md](docs/desktop-plan.md).

## State in one paragraph

CrewBoard is finished and installed: an Electron app (`desktop/`) that runs a NestJS engine (`apps/api`) and shows a React
app (`apps/web`) in its own window, on a SQLite file in `%APPDATA%\CrewBoard\data`. One user (the manager), English only,
fully offline, no sign-in. `master` on GitHub holds all of it. All checks pass: 83 logic tests, 12 API smoke suites
(386 checks), 14 browser tests, and both type-checks. Nothing is half-done. What is left is listed under "Open".

## The one rule: never touch the real data

The folder `%APPDATA%\CrewBoard\data` holds the manager's **real crew data** (real people). It has to be used in the final
version. So:

- Never run `npm run seed`, `npm run demo`, `npm run smoke`, `npm run e2e` or the screenshot/video scripts against it. They wipe
  or change data. Always point `DATA_DIR` at a throwaway folder first (the README shows how).
- Without `DATA_DIR` the engine uses `%APPDATA%\CrewBoard\data`, so an unprepared command **will** hit the real data.
- Do not click around in the installed app "to test": opening the board, for example, holds stays whose end has passed
  (and changes the data). Test on a copy (`CREWBOARD_USER_DATA=<folder>` points the desktop app at another folder).
- Never commit data. `.gitignore` covers `data/`, `data.*/`, `apps/api/storage/`, `apps/api/prisma/real/`, `.env`, `logs/`, installers.
- `data.moved-to-appdata-2026-10-23/` (in the project folder) is a safe copy from before the move; the old Postgres dump is in
  `%APPDATA%\CrewBoard\data\backups`. Both can be deleted when the manager is happy.
- Git history was scanned (names, employee keys, tokens): clean. Re-scan before publishing anything new that was built
  from real data. Screenshots and the video use generated demo people only.

## How the pieces fit

```
desktop/main.js  --fork-->  apps/api/dist/src/main.js (NestJS, 127.0.0.1, PORT=0, needs header x-crewboard-key)
      |                              |-- serves apps/web/dist (the React build) and the API under /api
      |-- BrowserWindow loads http://127.0.0.1:<port>      |-- SQLite: DATA_DIR/crewboard.db (WAL), DATA_DIR/storage, DATA_DIR/backups
```

- `apps/api/src/env.ts` sets `DATA_DIR` (default `%APPDATA%\CrewBoard\data`), `DATABASE_URL`, `STORAGE_DIR`, `BACKUP_DIR`.
- The engine creates and migrates its own database at start (`src/prisma/migrate.ts`, table `_migrations`). Installed copies have no Prisma CLI.
- The Prisma client is generated into `apps/api/prisma/client` (not `node_modules/.prisma`, which the installer drops) and
  imported through `src/db.ts`. `apps/api/scripts/build.cjs` copies it and the migrations to `dist/prisma`.
- `desktop/scripts/stage.cjs` builds everything into `desktop/build/app`; electron-builder packs it. `snapshot-data.cjs` adds a
  copy of the current data as `resources/seed-data`; `main.js` copies it to `%APPDATA%` **only if no database exists there**.
- The API answers under `/api/...` and at the root (Vite's dev proxy strips `/api`). Scripts use `http://127.0.0.1:3000/api`.
- No sign-in: every request is the manager. "Done by" columns store the string `manager` (`MANAGER` in `src/common/validate.ts`).

## Commands

```powershell
# everyday checks (no data involved)
cd apps/api; npm run typecheck; npm test
cd apps/web; npx tsc --noEmit -p tsconfig.app.json; npx oxlint

# anything that writes data: a throwaway folder first
$env:DATA_DIR = 'C:\temp\crewboard-test'
cd apps/api; npm run build; npm run seed; npm run start:dev      # or: node dist\src\main.js
npm run demo; npm run smoke                                        # API running
cd ../web; $env:PW_CHANNEL = 'msedge'; npm run e2e                 # needs the built app running on :3000

# installer (desktop/): see the README. npm run dist = with the current real data inside; npm run dist:empty = without
```

Summary of data tools: `npx tsx scripts/db-summary.ts` (read-only: every table's row count and broken references),
`npx tsx scripts/migrate.ts` (create/migrate a database).

## Decisions worth knowing

- **Status is computed, never stored** (rotation + leave + assignments for that day): `calendar.service.ts`, `domain/status.ts`.
- **One validator** (`assignments/facts.ts` → `domain/rules.ts`) serves manual assignments, the planner, publishing and replacements. A hard rule needs an override reason (audited); the Settings switch `rules.overrideReasonRequired` turns it into a warning.
- **Plans**: the Plans screen was removed (2026-10-28); the planner stays in the engine (`planning.ts`) without a screen. `workflow.requireApproval` (default **on**) still makes extensions request-then-approve.
- **Nobody leaves a unit on their own** (2026-10-28): a crew stay whose end date passes with nobody lined up is kept on the seat with no date (`holdPassedStays` in `assignments.ts`: at start, hourly, on each board load). `endPassed` keeps the missed date and the board warns until the manager unassigns or sets a date. An unassign (or a leave that ends the stay) sets `actualEnd`, which makes the end final.
- **Replacement tasks** are still opened by the engine (unassign, leave, archiving) but the Replacements screen was removed (2026-10-28): empty seats are handled from the board. Escalation (`replacements.ts`, `escalateDue`) only runs when the API task list is read. Timers: preventive maintenance and holding passed stays (hourly, `fleet.ts`, `assignments.ts`) and the daily backup (`backup.ts`); `JOBS=off` disables them (use it in tests).
- **Backups**: `VACUUM INTO` (consistent while the app runs) + the uploaded files; 14 newest kept, then one per month. A folder named `before-…` is never pruned (names must match `crewboard-YYYY-MM-DD-HHMM`).
- **Moving a unit to the base it is already at is a deliberate no-op** (bulk moves send whole selections).
- **Seniority** comes from field days (`Employee.priorFieldDays` + history) unless the rank sets it. Ranks are a setting (`people.ranks`), edited on the People screen; the rank is the first entry of `Employee.tags`.
- **Medical privacy** was removed with the other users: the manager sees everything. The analytics service still passes a viewer that hides medical reasons.
- Certificates do not expire (decision 2026-10-19). Crews are a chief and three field operators; the operator also drives.

## Gotchas learned the hard way

- **Prisma is pinned to 6.x** (the npm default pulled an 8.0 RC with a different CLI).
- **SQLite JSON defaults**: `prisma migrate diff` writes `DEFAULT []` / `DEFAULT {}` unquoted, which SQLite rejects. Quote them (`'[]'`, `'{}'`) in new migrations. Write migrations by diffing the previous schema, check them by running them on a **copy** of the data.
- **Foreign keys during migrations**: Prisma rebuilds tables with foreign keys off, which SQLite ignores inside a transaction. The runner switches them off on its one connection first and checks `foreign_key_check` before committing. Clients that do this must use `singleConnectionUrl()`.
- **List columns** (`Employee.tags`, `Base.facilities`, `Plan.scope`) are JSON; read them through `strings()`.
- **No `mode: 'insensitive'`**: SQLite's `LIKE` already ignores case for plain letters.
- **Nest under `tsx`** has no decorator metadata: constructors need explicit `@Inject(Service)`. `tsx` also does not type-check: run `tsc` (the stale-Prisma-client bug hid for days).
- **Windows**: `npm`/`npx` fail inside the Git Bash tool here (they point at another program's Node); use PowerShell for them. Many files have CRLF endings; scripted search-and-replace must normalise them first, or it silently misses. PowerShell here-strings mangle `$` and backticks, and `Set-Content -Encoding utf8` adds a BOM (use the Write/Edit tools or `git commit -F file`).
- **Electron's binary** downloads from GitHub and often drops the connection: download `electron-v45.0.0-win32-x64.zip` with a resumable `curl -C -`, check it against `SHASUMS256.txt`, unzip into `desktop/electron-dist`, and set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` for `npm install`. The installer needs an icon of at least 256×256 (`desktop/icon.ico`, drawn by `scripts/make-icon.cjs`).
- **Playwright**: its own browsers are out of date on this PC; use `PW_CHANNEL=msedge`. The video needs ffmpeg (installed with winget) to make an MP4.
- **Web styles**: `tokens.css` + `look.css`; older component styles sit at the top of `look.css` in `@layer legacy`, so later unlayered rules win without `!important`. Colours come from `--pal-*` tokens, never raw hex ([DESIGN.md](DESIGN.md)). The web tsconfig has `verbatimModuleSyntax`, `noUnusedLocals`, `erasableSyntaxOnly`: use `import type`, no enums.
- **The installed app unpacks Prisma's engine** (`asarUnpack`) and `main.js` sets `PRISMA_QUERY_ENGINE_LIBRARY`; do not move `prisma/client` without updating both.

## Open

- **License**: none yet (the owner said to leave it). Until one is added, the public code may be read but not reused.
- **Installer is unsigned**: Windows SmartScreen shows a warning; IT may need to allow it (a draft email is in `desktop/dist`, not in git).
- **API without a screen**: leave and medical leave, restrictions and clearance, per-person tasks, and the what-if simulator are in the engine and tested (`smoke-leave`, `smoke-tasks`) but have no screen. The manager handles absence from the seat (unassign / replace). Either build screens or remove the modules.
- **Planner speed**: about 1.1 s for a four-week plan at five times the demo size (`docs/performance.md`). Cache per-person calendars first if it matters.
- **No auto-update**: a newer installer is installed over the old one; data is kept. `npm run dist` bakes the *current* real data into the installer, so rebuild it before moving to another PC, and treat the file like the data.
- **Lint**: `oxlint` reports a few `react` hints in `Board.tsx` and `personform.tsx` (set-state-in-effect, refs in render). The design hook also flags the 3 px side stripes in `look.css`, which `DESIGN.md` records as intended.
- **Git**: the author email (a Gmail address) is in the commit history. The remote also has two `claude/…` branches from earlier cloud sessions; they are not part of `master`.
- Ideas, not promises: automatic updates, a signed installer, a screen for leave, importing the rota from Excel on first run.
