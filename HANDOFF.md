# CrewBoard: handoff

Written at the end of the build session. The plan is `crew-dispatch-platform-plan.md`; this file says where the build stands and what to know before continuing. `README.md` has the run instructions.

## State in one paragraph

Plan epics E1-E21 are built (the demo scope), plus most of E10 and E11. The API (NestJS + Prisma + PostgreSQL) covers master data, seats and assignments with a rule validator, leave and medical leave, extensions, the planning engine and plan lifecycle, the replacement center, calendars, the dispatch board, maintenance, notifications, files, swaps, the portal, **analytics (coverage forecast, KPIs, dashboards, map), recommendations and the what-if simulator**. The web app (React + Vite) has the dispatch board, planner screens, work orders, extensions, settings, an Analytics area (overview, forecast heat map, what-if, people, leave, units, base staffing, compliance, map) and a phone-first employee portal that works offline for viewing. `DEMO.md` is the demo script. A follow-up session added **user admin, password change and reset, the SMTP sender (E2/E20), the audit log screen (E26) and Excel import/export (E27)**. Not started: E28-E30 polish.

## Run it

```
npm install
npm run db:up                      # Postgres on 5440 (not 5432: other containers on this machine use 5432-5434)
cd apps/api && cp .env.example .env && npx prisma migrate deploy && npm run seed
npm run start:dev                  # API :3000
npm run dev:web                    # web :5173, proxies /api to the API
npm run demo                       # (API running) 8 units on jobs, a published plan, a medical leave, an expired cert
```

Logins, password `demo1234`: `dispatcher`, `ops`, `hr`, `basemanager` (scoped to HMD), `admin`, `chief` (no employee behind it), `employee` (linked to the first field operator), and every employee by employee number, e.g. `e1044`.

Checks: `cd apps/api && npm run typecheck && npm test` (85 unit tests), `npm run smoke` (10 live suites, needs the API running; they mutate data, so reseed afterwards; they pass as one chain on a fresh seed), `cd apps/web && node scripts/test-sw.mjs` (service worker with a mock cache).

## Where things are

```
apps/api/src/domain/        pure logic, no database, unit tested
   status.ts      seniority, rotation calendar, status computation (plan section 25)
   rules.ts       hard/soft rule validator and crew rules (15.2, 15.3)
   engine.ts      planning engine (15.4): hardest seat first, weighted scoring, gaps with fix options
   absence.ts, spans.ts, derived.ts   carving assignments around leave, span arithmetic, unit status
apps/api/src/<module>/      one Nest module per area: auth, users, audit, mail, transfer (Excel), settings, catalogs, bases,
                            employees, units, jobs, assignments, leave, extensions, planning, replacements, calendar,
                            board, notifications, files, maintenance, swaps, portal, absence (shared), prisma
apps/api/prisma/            schema.prisma, migrations, seed.ts
apps/api/scripts/           smoke-*.ts live suites, lib.ts helpers, demo-plan.ts, demo-scenarios.ts
apps/web/src/               Shell (nav, role routing), Board, Replacements, Plans, Leave, Timeline, CrewChanges,
                            WorkOrders, Extensions, Settings, Users, Audit, DataTransfer, account.tsx (password screens),
                            Analytics, WhatIf, Portal (employee app), notifications.tsx, hooks.ts, api.ts, i18n*.ts
apps/web/public/            manifest, icons, sw.js (service worker)
```

## Decisions worth knowing

- **Everything is a setting.** Numbers from the plan (crew rules, limits, seniority thresholds, engine weights) live in `settings/settings.ts` defaults and can be changed through `PUT /settings/:key`.
- **Status is computed, never stored** (section 25). `calendar.service.ts` builds per-day statuses; `insights.ts` computes seniority and field days.
- **Seniority needs field days.** `Employee.priorFieldDays` carries history from before the system (the seed sets it). Without it everyone is a New Recruit and no crew can satisfy "one experienced".
- **Hard rules need an override reason**, which is audited. The same validator (`rules.ts` through `assignments/facts.ts`) is used by manual assignments, the engine, plan publishing and swaps, so they cannot disagree.
- **Plans are drafts until published.** Draft assignments never count as live. Publishing re-validates each draft against current facts (person-level rules only) and opens a replacement task for any it has to skip.
- **Leave and restrictions free seats** through `absence.service.ts`: the person's live assignment is trimmed or split and a replacement task is opened per freed span of a required seat. Only live assignments are touched, never drafts.
- **Filling a seat closes the task it was for** (`AbsenceService.coverTasks`): direct assignment, transfer, split, replacement confirm and plan publish all do it.
- **Medical privacy.** Others see "Unavailable", never the reason, in board, calendar, leave lists and notifications (even the notification type name is neutral). Certificates live in a separate folder; opening someone else's is logged.
- **Employees see only themselves.** Employee-only accounts get 403 on the board, seat grid, lists of people and calendars of others; assignments, leave, extensions and swaps are filtered to their own.
- **Swaps are for upcoming stretches only**; running ones need a dispatcher handover. Moves between seats use the atomic `POST /assignments/:id/transfer`, not release-then-assign.
- **One live-update stream** (`GET /board/events`, server-sent events read with fetch) is shared by all web screens. A connection per component starved ordinary requests.
- **The auth guard checks the user still exists** (cached 60 s) so tokens from before a database reset become 401, not 500.

## Known gaps and shortcuts

- **E2:** passwords are scrypt, tokens are an HMAC JWT with a dev default secret (set `JWT_SECRET`). Tokens carry a password version (`pv`), so a change or reset ends other sessions. The guard takes roles, the employee link and `active` from the account, cached 60 s per user; changes made through the API drop the cache at once, but a change written straight to the database can take up to a minute. No login rate limit yet (only `/auth/forgot` is throttled, 3 links per 15 minutes).
- **E4 seed:** `npm run demo` (after `npm run seed`) plants the 14 scenarios of plan 28.2 and four earlier rotations of history; 12 months of history is not seeded. Scenario numbers are tuned against `scripts/peek-analytics.ts`; re-run it after changing the seed. The forecast counts only Field Operators for the op/exp profiles, so scarce-profile stories depend on `demo-scenarios.ts` marking most Experienced Cased Hole operators Junior.
- **Analytics:** forecast, KPIs and dashboards are computed on request (about 150 ms), nothing is cached. The map is drawn from coordinates with SVG (no tiles, so it works offline); Leaflet was not used. Recommendations are upserted by a stable `key`; dismissed ones stay dismissed, snoozed ones reopen.
- **What-if:** changes are described by profile (lose N experienced CH operators at base X), applied in `loadWorld` via `WhatIfChanges`; nothing is written. Absences cut the person out of the seats they would hold, and the engine then tries to refill them.
- **Email:** queued in `EmailOutbox` and sent by `mail/mailer.ts` (nodemailer) every minute when `SMTP_HOST` is set; up to 5 attempts, the error is kept on the row. Reset links use `APP_URL`.
- **Background jobs:** the daily job runs hourly in-process (set `JOBS=off` to disable); Redis is in docker-compose but unused. Replace with BullMQ.
- **Files:** local disk under `apps/api/storage` (gitignored), not MinIO.
- **Web screens missing for built APIs:** catalogs editor. The base roster is covered by Analytics → Base staffing.
- **Import (E27):** employees, units and bases. Blank cells keep stored values; unit type, unit home base and archiving people are refused on purpose (their own flows release seats). Certificates, staffing rules, sites and past assignments are not importable yet. `exceljs` pulls `uuid@8`, flagged moderate by `npm audit` for a buffer bounds check that exceljs does not use.
- **Board "time machine"** shows who held a seat on a past date from assignment rows; history changed retroactively (e.g. a leave recorded late that cancelled a past stretch) is not reconstructed exactly.
- **Service worker** could not be registered in the embedded browser used during the build. Its logic is tested in Node; real-device install and offline behaviour are unverified. It caches recent leave/notification lists for staff too (cleared on sign-out); narrow that before real use.
- **Base-scope enforcement** is on assignments, plans, work orders, swaps and replacements, but not on the E5-E8 master-data endpoints.
- **Engine** is the heuristic version. A late crew-rule check differs slightly between the engine's "who fits" list (checks the start date) and confirm (checks every change date), so a top candidate can still prompt an override.
- **Not done from the plan:** i18n coverage is partial for FR/AR on staff screens, no Storybook/Figma/usability tests, no PDF export, no 3D globe or Vanta effects, no WCAG audit.

## Gotchas for whoever continues

- Prisma is pinned to 6.x. The npm default pulled 8.0 RC, which has a different CLI.
- Nest runs under `tsx`/esbuild, which does not emit decorator metadata: constructors need explicit `@Inject(Service)`.
- On Windows PowerShell 5.1, `Set-Content -Encoding utf8` writes a BOM that breaks JSON configs; write files with the Write tool or a no-BOM encoder. Backticks and `$` in template strings get mangled in PowerShell here-strings; use the Edit tool for those.
- The web `tsconfig` has `verbatimModuleSyntax`, `noUnusedLocals` and `erasableSyntaxOnly`: use `import type`, no enums, no unused names.
- Several smoke suites create their own isolated base, unit type and qualification (PLN, BRD, BRD2, PRT) so results do not depend on seed randomness; copy that pattern for new tests (`scripts/lib.ts` has `mkEmployee`, `mkUser`).
- Test dates are relative to "today", so suites stay valid on any day.
- Entry points load `apps/api/.env` through `src/env.ts` (the generated Prisma client does not read it); new scripts should `import '../src/env'` first.
- Auth decorators live in `auth/decorators.ts` so modules that `auth.module.ts` imports (settings) do not form an import cycle.

## Suggested next steps

1. Before real people use it: set `JWT_SECRET`, `APP_URL` and SMTP; add a login rate limit; turn off the demo accounts.
2. Import the remaining sheets (certificates, base staffing rules, sites) and PDF exports; then E28-E30 (performance test at 5x volume, polish, WCAG audit).
