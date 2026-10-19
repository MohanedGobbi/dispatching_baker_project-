# CrewBoard: handoff

Written at the end of the build session. The plan is `crew-dispatch-platform-plan.md`; this file says where the build stands and what to know before continuing. `README.md` has the run instructions.

## State in one paragraph

Plan epics E1-E21 are built (the demo scope), plus most of E10 and E11. The API (NestJS + Prisma + PostgreSQL) covers master data, seats and assignments with a rule validator, leave and medical leave, extensions, the planning engine and plan lifecycle, the replacement center, calendars, the dispatch board, maintenance, notifications, files, swaps, the portal, **analytics (coverage forecast, KPIs, dashboards, map), recommendations and the what-if simulator**. The web app (React + Vite) has the dispatch board, planner screens, work orders, extensions, settings, an Analytics area (overview, forecast heat map, what-if, people, leave, units, base staffing, map), person and unit profile panels opened from any name or unit code, forms to add units and jobs, and a phone-first employee portal that works offline for viewing. `DEMO.md` is the demo script. A follow-up session added **user admin, password change and reset, the SMTP sender (E2/E20), the audit log screen (E26) and Excel import/export (E27)**. A UI rework and a design audit followed (see "UI rework and design audit" below). On 2026-10-20 the product was narrowed to **one user, the manager**, English only, with a Units (fleet) page and the CrewBoard logo; see "Product direction and plan" below. Not started: E28-E30.

## Run it

```
npm install
npm run db:up                      # Postgres on 5440 (not 5432: other containers on this machine use 5432-5434)
cd apps/api && cp .env.example .env && npx prisma migrate deploy && npm run seed
npm run start:dev                  # API :3000
npm run dev:web                    # web :5173, proxies /api to the API
npm run demo                       # (API running) 8 units on jobs, a published plan, a medical leave and the planted scenarios
```

Logins, password `demo1234`: `dispatcher`, `ops`, `hr`, `basemanager` (scoped to HMD), `admin`, `chief` (no employee behind it), `employee` (linked to the first field operator), and every employee by employee number, e.g. `e1044`.

Windows shortcut: `start-crewboard.cmd` / `stop-crewboard.cmd` at the repo root (scripts in `scripts/`) start Docker, the database, the API and the web app and open the browser. They are Windows-only; in the cloud use the commands above.

Checks: `cd apps/api && npm run typecheck && npm test` (84 unit tests), `npm run smoke` (10 live suites, needs the API running; they mutate data, so reseed afterwards; they pass as one chain on a fresh seed), `cd apps/web && node scripts/test-sw.mjs` (service worker with a mock cache).

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
   guide.tsx      PageGuide (page header with "How it works"), Legend, Donut, Ring, BASE_COLORS
   profiles.tsx   ProfileProvider + PersonLink / UnitLink / SeatLabel: any name or unit code opens a side panel
                  (person: contact, status, schedule, history; unit: job, crew, maintenance with notes, jobs, crew history)
   assign.tsx     click-to-assign picker (planner's best matches with a span choice, or everyone free today)
   unitforms.tsx  AddUnitDialog, NewJobDialog (create a job and optionally deploy a unit)
   fleetmap.tsx   SVG map of bases and active sites drawn from coordinates (no tiles)
   a11y.ts        useDialogFocus: focus in, Tab trap, focus restored to the opener (Modal and the profile panel use it)
   look.css       the current visual layer (sidebar, guides, cards, board, replacement center, timeline focus, profiles,
                  P1 audit fixes for contrast, 12px text floor, scroll cues, phone layout, 44px touch targets)
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
- **Certificates do not expire** (user decision, 2026-10-19). A certificate is held or not; `Certification.expiresAt` is nullable and unused. Expiry rules, board badges, notifications, the compliance dashboard, the certificate KPI and the renewal recommendation were removed.
- **Medical privacy.** Others see "Unavailable", never the reason, in board, calendar, leave lists and notifications (even the notification type name is neutral). Certificates live in a separate folder; opening someone else's is logged.
- **Employees see only themselves.** Employee-only accounts get 403 on the board, seat grid, lists of people and calendars of others; assignments, leave, extensions and swaps are filtered to their own.
- **Swaps are for upcoming stretches only**; running ones need a dispatcher handover. Moves between seats use the atomic `POST /assignments/:id/transfer`, not release-then-assign.
- **One live-update stream** (`GET /board/events`, server-sent events read with fetch) is shared by all web screens. A connection per component starved ordinary requests.
- **The auth guard checks the user still exists** (cached 60 s) so tokens from before a database reset become 401, not 500.
- **One user for now: the manager (super admin)** (user decision, 2026-10-20). The sign-in page offers only `admin`. The role matrix, base scopes and the other seeded accounts stay in the API (the smoke suites use them) so roles can be switched back on later without rework.
- **No review step by default.** Setting `workflow.requireApproval` (default `false`): plans publish straight from DRAFT and, for a manager, "Extend" requests and approves in one go (limits still need an override reason). Turn it on to get draft → review → approved → published and request → approve back.
- **English only** (user decision, 2026-10-20). The web app has no language switch and no FR/AR strings; components keep their English text as the `t()` default. The API's notification templates still have FR/AR and the `lang` preference, unused.
- **Units are deleted only when they have no history** (no crew assignment, job or work order); otherwise `DELETE /units/:id` answers 409 and the page offers "Out of service".

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

- Some files have Windows line endings (CRLF), some do not. Scripted search-and-replace over source must normalise line endings first or it silently misses; the editor tools handle both.
- The web app is `look.css` on top of four older stylesheets (`App.css`, `pages.css`, `analytics.css`, `portal.css`, imported in that order from `App.tsx`). `look.css` is imported last and wins, sometimes with `!important`; change the visual layer there, not in the older files.

## UI rework and design audit (2026-10-19, local session)

What changed in the web app, at the user's request:
- **Navigation:** grouped, coloured sidebar (Today / Planning / Insights / Administration) with a one-line description per screen; collapses to icons, and on phones (under 760px) becomes a slide-in menu from a menu button. Language switch becomes a single picker on phones; password and sign-out move into the menu.
- **Page guides:** every main screen starts with `PageGuide`: purpose in one sentence and numbered "How it works" steps (open on the first visit to a screen, folded afterwards, remembered per screen in localStorage).
- **Board:** coloured KPI tiles (clickable filters), an overview with the base/site map, an "everyone today" donut and crew health per base, filter chips (base, OH/CH, crew state), full-colour unit cards with a crew ring, "Assign someone" on every empty seat (picker, then the usual rule check), people lanes. Unit card headers open the unit profile. "New job" and "Add a unit" buttons.
- **Replacement center:** urgency tiles, a four-week bar chart of open tasks, tasks grouped by how soon, ranked candidates with fit bars and a chart of why others are ruled out.
- **Timeline:** clicking a person shows only them (13-week strip, month calendar, day split, stretches); "Full profile" opens the profile panel.
- **Profiles:** every name and unit code across the app is clickable (board, replacement center, leave, extensions, crew changes, plans, work orders, analytics, assign picker).
- **Units:** send to the workshop with a note and expected return (opens a corrective work order), mark repaired, give it a job, end its job, out of service / back in service, edit notes.
- **Scrollbars** are hidden app-wide except on sideways scrollers (timeline, heat map, four-week chart, tables on phones, lists, panels), which show a thin themed bar.

An `impeccable` design audit was run (detector + rendered checks on every screen at 1366px and 375px, light and dark). Score before fixes: 11/20. **All P1 issues are fixed and re-verified:** phone layout (no page wider than 375px), dialog and panel focus, text contrast (0 failures on the checked screens in light and dark; status and identity colours were darkened in `tokens.css`, `--ink-*` tokens added for text on pale tints, `--accent-fill` for filled buttons), no text under 12px, scroll cues, shorter board header, 44px touch targets on touch screens.

**Remaining audit work (P2 first), for the next session:**
1. ~~`index.html` title "web"~~: done, "CrewBoard", with `icon.svg` as the favicon.
2. Fonts: Inter is named in `tokens.css` but never loaded; everything falls back to system fonts. Self-host it (IBM Plex Sans Arabic is no longer needed).
3. Theme: the light/dark choice is not remembered and ignores the system preference (`Shell.tsx` `useState(false)`).
4. One 608 KB JS bundle: lazy-load Analytics/WhatIf, Portal, Users/Audit/DataTransfer/Settings, and the profile panel.
5. CSS consolidation: dead rules from the old board and replacement center remain (`App.css` `.unit`, `.seat`, `.column`, `.summary`, `.kpi`, `.side-grid`, `.staffing`; `pages.css` `.task`, `.split`, `.detail`), `PersonDrawer.tsx` is unused, and `look.css` relies on `!important`. Fold everything into tokens + one component stylesheet.
6. About 140 hard-coded hex colours in TSX inline styles (KPI tiles, urgency, role and base colours). Move them to tokens with dark-mode values.
7. ~~FR/AR strings and RTL~~: dropped, the app is English only.
8. ~~Dispatchers see "Repaired"~~: moot while the manager is the only user; revisit if dispatcher accounts come back.
9. Touch: chips let the page scroll (`touch-action: pan-y`), so drag-and-drop is effectively mouse-only; "Assign someone" is the touch path. Consider a dnd-kit TouchSensor with a long press.
10. P3: thick coloured side stripes on cards (`border-inline-start` 4-5px, flagged by the detector), very high colour volume (saturated gradients everywhere dilute the red "act now" signal; keep strong colour for state and OH/CH identity, calm the rest), and Escape in a dialog opened over the profile panel closes both.

There is no `PRODUCT.md` / `DESIGN.md` yet. Running `/impeccable init` then `/impeccable document` would capture the product brief and the current design system so future design work has a reference.

## Continuing in the cloud

- Start from `master` on GitHub (everything above is pushed there). Nothing local is needed except data, which the seed recreates.
- The cloud machine needs PostgreSQL. With Docker: `npm run db:up` (port 5440). Without Docker, install Postgres and point `DATABASE_URL` in `apps/api/.env` at it (copy `.env.example`). Then `npx prisma migrate deploy`, `npm run seed`, start the API, and `npm run demo` for the demo story.
- To check the web app without a browser login, the API smoke suites cover behaviour; for the UI, run `npm run build` in `apps/web` and `node scripts/test-sw.mjs`. Rendered checks need the app running and a signed-in browser (token in `localStorage['crewboard.token']`, from `POST /api/auth/login`).
- After any change: `npm run typecheck && npm test` and `npm run smoke` in `apps/api` (reseed afterwards), `npx tsc --noEmit -p tsconfig.app.json && npm run build` in `apps/web`.

## Product direction and plan (2026-10-20)

**Who uses it.** Two kinds of user in the end: the **manager**, who monitors and runs everything, and the **employee**, who sees their own schedule and tasks. For now only the manager (super admin) is in scope; the employee side comes later. Everything in the plan is done by the manager, without the review pipeline.

**Done in this round**
- CrewBoard logo (`apps/web/public/icon.svg`, the board-and-crew mark) used as the favicon, in the sidebar and on the sign-in card; page title "CrewBoard". Vite's template assets removed.
- **Units page** (sidebar → Today → Units): tiles by status that filter the list, search (code, plate, model, note), base/type/status filters, add, edit details, move to another base, out of service / back, send to the workshop (through the unit profile), delete with the history guard. API: `GET /units?q=`, list rows now carry plate, model, year, notes, job end and workshop return date; `DELETE /units/:id`.
- Manager only: sign-in offers only `admin`; plans publish directly; extensions apply in one step (setting `workflow.requireApproval`).
- English only: language switch, FR/AR strings and RTL rules removed from the web app.

**Next, in order**
1. *Finish the manager-only cleanup:* hide what only makes sense with several roles (swap approvals in Leave, "waiting for the ops manager" texts, role-specific notification types, the Users screen's role list can default to Administrator); decide whether the production seed creates only `admin`.
2. *Units, second step:* a unit detail page (not just the side panel) with maintenance history, utilisation over time and documents (registration, inspections); preventive maintenance schedule (plan E19, not built).
3. *Remaining audit work:* the P2 list above (fonts, remembered theme, bundle splitting, CSS consolidation, colour tokens, touch drag-and-drop).
4. *Before real use:* `JWT_SECRET`, `APP_URL`, SMTP; a login rate limit; demo accounts off; backups.
5. *Real data:* import the remaining sheets (certificates, base staffing rules, sites), PDF exports.
6. *Employee side (later):* what an employee sees (own calendar, tasks, leave requests, acknowledgements: the portal already exists and works), and whether their requests need the approval step (`workflow.requireApproval`).
7. E28-E30: performance test at 5x volume, WCAG audit, polish.
