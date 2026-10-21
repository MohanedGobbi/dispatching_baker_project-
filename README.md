# CrewBoard

Crew rotation and dispatch platform. The full functional plan is in
[crew-dispatch-platform-plan.md](crew-dispatch-platform-plan.md). The platform runs on **mock data** until real data is connected.

## Run it

Needs Node 20+ and Docker.

```bash
npm install
npm run db:up                       # PostgreSQL on port 5440 (Redis on 6380, not used yet)
cd apps/api
cp .env.example .env                # DATABASE_URL points at the container
npx prisma migrate deploy
npm run seed                        # catalogs, 4 bases, 16 units, ~150 people, demo users
npm run start:dev                   # API on http://localhost:3000
```

In a second terminal: `npm run dev:web` (http://localhost:5173, proxies `/api` to the API).

To fill the board with something to look at (8 units on jobs, a published four-week plan and some open replacement tasks), with the API running:

```bash
cd apps/api && npm run demo
```

Sign in as the manager: `admin` / `demo1234`. The manager is the only user of the web app. The other seeded accounts (`dispatcher`, `ops`, `hr`, every employee number) exist only for the automated tests; they are told the platform is for the manager only.

## Checks

```bash
cd apps/api
npm run typecheck
npm test            # pure-logic unit tests (rules, engine, status, calendars...)
npm run smoke       # 12 live end-to-end suites against a running API and a freshly seeded database
cd ../web && node scripts/test-sw.mjs   # the offline service worker, with a mock cache and network
npm run e2e         # (apps/web) Playwright browser tests of the main flows + WCAG 2.1 AA audit, on the demo data
```

Performance at 5x the mock volume: see [docs/performance.md](docs/performance.md).

The smoke suites change data: run `npm run seed` afterwards to reset.

## Configuration

`apps/api/.env` (copy of `.env.example`) holds `DATABASE_URL`. For anything beyond the demo also set `JWT_SECRET`,
`APP_URL` (used in password reset links) and, to send email, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASS`, `MAIL_FROM`. Without SMTP, emails stay in the outbox (`GET /notifications/outbox`, admin only).

## What is built

| Epic | State |
|---|---|
| E1 setup, design tokens | web shell done, English only (French and Arabic dropped, 2026-10-20); Storybook, Figma and usability tests not started |
| E2 auth, roles | login, role matrix, base scope on assignments and plans; user admin screen, temporary passwords, change password, reset by emailed link |
| E3 settings and catalogs | done |
| E4 mock data | catalogs, bases, 16 units, 191 people, certificates; `npm run demo` publishes a plan, plants the 14 scenarios and adds 4 earlier rotations of history (12 months of history not seeded) |
| E5-E8 bases, employees, units, jobs | API done |
| E9 seats and assignments, rule validator | done, incl. atomic transfer, swap, split |
| E10 calendars | API: personal, timeline, crew-change list, base roster. Web: timeline and crew-change list (base roster screen not built) |
| E11 dispatch board | API and web (drag and drop, badges, draft layer, time machine, TV mode, live updates) |
| E12-E14 leave, medical leave, extensions, balance | API done; web: leave inbox, clearance queue, overlap warnings, swap approvals (extension screens not built). Certificates are uploaded to local disk in a separate medical folder with access logging |
| E15-E17 replacement center, planning engine, plan lifecycle | API and web screens done (replacement center, plan builder with explanations, gaps and diff) |
| E19 maintenance and work orders | work-order board, full unit page, preventive maintenance plans with an automatic scheduler, unit papers with files and expiry |
| E20 notifications | in-app and email (outbox sent over SMTP when `SMTP_HOST` is set, otherwise kept queued), EN/FR/AR, acknowledgements, preferences, broadcast, a daily job that runs hourly inside the API |
| E21 employee portal (PWA) | Today, To do (tasks from the manager, notices to confirm, swaps to answer, work orders), Calendar, Requests (leave, swaps, work orders), Alerts, Me; installable, works offline for viewing |
| E18 what-if | `POST /planning/what-if` runs the planner on a modified copy (deploy idle units, lose people, absences) and compares with today; web tab under Analytics |
| E22-E25 analytics, forecast, recommendations, map | API and web: 90-day coverage forecast with heat map, 13 KPIs, 7 dashboards, recommendations (recruit, transfer, relief, spread leave, train, promote), offline-friendly map |
| Web: extensions, settings | extension requests/approval/balances/report; settings editor |
| E26 audit log | audit screen with filters and field-by-field before/after; medical entries redacted for readers without medical access; setting changes audited |
| E28-E30 testing and polish | 89 unit tests, 12 API smoke suites, 12 Playwright browser tests; performance at 5x; WCAG 2.1 AA audit with 0 violations |
| E27 import / export | Excel templates, export, validate-first import with a row-by-row report, then commit, for employees (incl. rotation sheet), units and bases. PDF export not built |

**Demo:** see [DEMO.md](DEMO.md) for logins, the planted scenarios and a click-by-click walkthrough of the 12 acceptance scenarios.

## Layout

```
apps/api   NestJS + Prisma. src/domain is pure logic (no database); the rest are Nest modules.
apps/web   React + Vite. The board lives in src/Board.tsx.
```
