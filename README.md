# CrewBoard

Crew rotation and dispatch, made by **Mohaned Gobbi**. A desktop app for one manager on one Windows PC. The full functional plan is in
[crew-dispatch-platform-plan.md](crew-dispatch-platform-plan.md); how it became a desktop app is in [docs/desktop-plan.md](docs/desktop-plan.md).

## Run it

**Everyday use:** the CrewBoard desktop app. Install it with `desktop\dist\CrewBoard Setup 1.0.0.exe`; it adds
CrewBoard to the Start menu and the desktop, and opens in its own window. No Node, browser or database server needed.
`start-crewboard.cmd` still works (needs Node 20+): it builds if the code changed, runs one hidden process on
http://127.0.0.1:3000 and opens the browser; `stop-crewboard.cmd` stops it.

**Data** lives in `%APPDATA%\CrewBoard\data`, for the desktop app and `start-crewboard.cmd` alike: `crewboard.db`
(SQLite), `storage\` (uploaded files) and `backups\` (one a day, 14 kept then one per month, plus "Back up now" in
Settings). The app creates the database and applies new migrations (`apps/api/prisma/migrations`) when it starts.
The desktop app's engine log is `%APPDATA%\CrewBoard\logs\api.log`. Uninstalling keeps the data.
It holds the real crew data: never run the seeds, `demo` or the smoke suites against it (they wipe or change
data); set `DATA_DIR` to a throwaway folder first.

**Building the installer** (`desktop/`, outside the npm workspaces so the normal install stays small):

```bash
cd desktop
npm install                 # with ELECTRON_SKIP_BINARY_DOWNLOAD=1 if GitHub downloads are unreliable
# then unzip electron-v45.0.0-win32-x64.zip (from the Electron GitHub release) into desktop/electron-dist
npm run dist                # builds API and web, stages build/app, writes dist/CrewBoard Setup <version>.exe
```

`npm run stage` then `npm start` runs the staged app without installing it. `scripts/make-icon.cjs` redraws
`icon.ico` from the web logo.

**Working on the code:** `npm run start:dev` in `apps/api` (API on 127.0.0.1:3000, reloads on change) and
`npm run dev:web` (http://localhost:5173, proxies `/api` to the API). With `DATA_DIR` pointing at a test folder,
`npm run seed` fills it with mock data (catalogs, 4 bases, 16 units, ~150 people) and `npm run demo` (API running)
puts 8 units on jobs with a published plan and open replacement tasks.

**One user, no sign-in** (2026-10-23): the manager is the only user and the app opens straight on the board. There
are no accounts, roles, notifications, emails, employee portal or shift swaps; the API listens on this computer only.

## Checks

```bash
cd apps/api
npm run typecheck
npm test            # pure-logic unit tests (rules, engine, status, calendars...)
npx tsx scripts/db-summary.ts   # read-only: every table with its row count, and any broken references
```

The smoke suites (`npm run smoke`) and the browser tests (`npm run e2e` in apps/web) still sign in as several roles;
they are being rewritten for the single-user app. Run them only against a throwaway `DATA_DIR`: they change data.

Performance at 5x the mock volume: see [docs/performance.md](docs/performance.md).

## Configuration

Nothing is required. `apps/api/.env` (see `.env.example`) can set `DATA_DIR` and `PORT`.

## What is built

| Epic | State |
|---|---|
| E1 setup, design tokens | web shell done, English only (French and Arabic dropped, 2026-10-20); Storybook, Figma and usability tests not started |
| E2 auth, roles | removed (2026-10-23): one user, no sign-in, no roles or base scopes |
| E3 settings and catalogs | done |
| E4 mock data | catalogs, bases, 16 units, 191 people, certificates; `npm run demo` publishes a plan, plants the 14 scenarios and adds 4 earlier rotations of history (12 months of history not seeded) |
| E5-E8 bases, employees, units, jobs | API done |
| E9 seats and assignments, rule validator | done, incl. atomic transfer, swap, split |
| E10 calendars | API: personal, timeline, crew-change list, base roster. Web: timeline and crew-change list (base roster screen not built) |
| E11 dispatch board | API and web (drag and drop, badges, draft layer, time machine, TV mode; screens refresh after each change) |
| E12-E14 leave, medical leave, extensions, balance | API done; web: leave inbox, clearance queue, overlap warnings (extension screens not built). Certificates are uploaded to local disk in a separate medical folder with access logging |
| E15-E17 replacement center, planning engine, plan lifecycle | API and web screens done (replacement center, plan builder with explanations, gaps and diff) |
| E19 maintenance and work orders | work-order board, full unit page, preventive maintenance plans with an automatic scheduler, unit papers with files and expiry |
| E20 notifications | removed (2026-10-23): no bell, in-app notices or email. Near-due replacement tasks are still marked escalated when the list is read |
| E21 employee portal (PWA) | removed (2026-10-23), with shift swaps between employees and the offline service worker |
| E18 what-if | `POST /planning/what-if` runs the planner on a modified copy (deploy idle units, lose people, absences) and compares with today; web tab under Analytics |
| E22-E25 analytics, forecast, recommendations, map | API and web: 90-day coverage forecast with heat map, 13 KPIs, 7 dashboards, recommendations (recruit, transfer, relief, spread leave, train, promote), offline-friendly map |
| Web: extensions, settings | extension requests/approval/balances/report; settings editor |
| E26 audit log | audit screen with filters and field-by-field before/after; setting changes audited |
| E28-E30 testing and polish | 83 unit tests, 12 API smoke suites, 12 Playwright browser tests; performance at 5x; WCAG 2.1 AA audit with 0 violations |
| E27 import / export | Excel templates, export, validate-first import with a row-by-row report, then commit, for employees (incl. rotation sheet), units and bases. PDF export not built |

**Demo:** see [DEMO.md](DEMO.md) for logins, the planted scenarios and a click-by-click walkthrough of the 12 acceptance scenarios.

## Layout

```
apps/api   NestJS + Prisma. src/domain is pure logic (no database); the rest are Nest modules.
apps/web   React + Vite. The board lives in src/Board.tsx.
```
