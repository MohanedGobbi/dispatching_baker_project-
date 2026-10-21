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

Checks: `cd apps/api && npm run typecheck && npm test` (89 unit tests), `npm run smoke` (12 live suites, needs the API running; they mutate data, so reseed afterwards; they pass as one chain on a fresh seed), `cd apps/web && node scripts/test-sw.mjs` (service worker with a mock cache), `cd apps/web && npm run e2e` (15 Playwright tests in a browser, including a WCAG 2.1 AA audit of every screen in light and dark; needs the API and web app running on the demo data). Performance: `docs/performance.md` (how to run it at 5x is in there).

## Where things are

```
apps/api/src/domain/        pure logic, no database, unit tested
   status.ts      seniority, rotation calendar, status computation (plan section 25)
   rules.ts       hard/soft rule validator and crew rules (15.2, 15.3)
   engine.ts      planning engine (15.4): hardest seat first, weighted scoring, gaps with fix options
   absence.ts, spans.ts, derived.ts   carving assignments around leave, span arithmetic, unit status
apps/api/src/<module>/      one Nest module per area: auth, users, audit, mail, transfer (Excel), fleet (unit page, preventive
                            maintenance, papers), tasks, settings, catalogs, bases,
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
   UnitPage.tsx   full unit page; unitforms.tsx holds the unit dialogs, unitstatus.ts the status table
   Tasks.tsx      manager's task list; the portal's To do tab is in Portal.tsx
   theme.ts       remembered light/dark, following the system until chosen
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
- **Replace / unassign from any seat** (2026-10-20): `seatactions.tsx` (dialog + button) is used on board seats (the chip itself is clickable too), the unit panel, the unit page and the person panel. Unassign is the existing `POST /assignments/:id/unassign` (opens a replacement task for a required seat). Replace is `POST /assignments/:id/replace`: holder ends the day before, the new person gets the rest of the stretch as a REPLACEMENT in one transaction, no task is opened; the optional `reason` goes to the audit log. Covered by `smoke-assignments.ts` and `apps/web/e2e/seats.spec.ts`.

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
- The web styles are `tokens.css` + `look.css`. The older component styles sit at the top of `look.css` inside `@layer legacy`, so every unlayered rule after it wins regardless of specificity; never use `!important` there. Colours in components come from `--pal-*` / status tokens in `tokens.css`, never raw hex. `DESIGN.md` records the design system (one loud colour: red "act now"; no gradients; stripes 3px).
- `prisma format` realigns the whole schema; write schema edits by hand and generate migrations with `prisma migrate diff --from-schema-datasource ... --script` (`migrate dev` refuses to run non-interactively when a column is dropped).

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

**Audit follow-up (2026-10-20):** all P2 items are done: title and favicon; Inter self-hosted; theme remembered and following the system; screens lazy-loaded (main script 635 kB -> 318 kB); the older stylesheets moved into a `legacy` cascade layer so `look.css` needs no `!important` (57 removed), 24 dead rules and `PersonDrawer.tsx` removed; all hex colours in components replaced by `--pal-*` tokens with dark values; touch drag on press-and-hold; Escape closes a dialog before the panel. FR/AR and the dispatcher "Repaired" item are moot. The CSS change was checked by pixel-diffing 44 screenshots before and after. An axe-core WCAG 2.1 AA audit of every screen, dialog, side panel and the phone portal, in both themes, now reports 0 violations (it runs in `npm run e2e`).

Still open (P3, a matter of taste rather than a defect): the thick coloured side stripes on cards and the overall colour volume (saturated gradients everywhere dilute the red "act now" signal). The older stylesheets could still be folded into one component stylesheet; the cascade layer makes that safe to do piece by piece.

There is no `PRODUCT.md` / `DESIGN.md` yet. Running `/impeccable init` then `/impeccable document` would capture the product brief and the current design system so future design work has a reference.

## Continuing in the cloud

- Start from `master` on GitHub (everything above is pushed there). Nothing local is needed except data, which the seed recreates.
- The cloud machine needs PostgreSQL. With Docker: `npm run db:up` (port 5440). Without Docker, install Postgres and point `DATABASE_URL` in `apps/api/.env` at it (copy `.env.example`). Then `npx prisma migrate deploy`, `npm run seed`, start the API, and `npm run demo` for the demo story.
- To check the web app without a browser login, the API smoke suites cover behaviour; for the UI, run `npm run build` in `apps/web` and `node scripts/test-sw.mjs`. Rendered checks need the app running and a signed-in browser (token in `localStorage['crewboard.token']`, from `POST /api/auth/login`).
- After any change: `npm run typecheck && npm test` and `npm run smoke` in `apps/api` (reseed afterwards), `npx tsc --noEmit -p tsconfig.app.json && npm run build` in `apps/web`.

## Solo-manager simplification (2026-10-21)

Decided with the manager after a review: make it as simple as possible so it gets used. **Hidden from the app, code kept** (API, tables and tests stay so it can come back):
- **Single user.** Users screen, employee portal, "My portal" link, notification broadcast and preferences are gone from the web app. Any account that is not SUPER_ADMIN gets "This platform is for the manager only" (`App.tsx`). Role logic and seeded accounts stay for the smoke suites.
- **Tasks, Leave and Work orders screens removed** (files `Tasks.tsx`, `Leave.tsx`, `WorkOrders.tsx`, `Portal.tsx`, `Users.tsx`, `WhatIf.tsx` are unreferenced). A person who cannot work is unassigned or replaced from their seat (`seatactions.tsx`). The workshop stays as a unit status: send to the workshop from the unit, **Repaired** (unit panel and unit page) finishes the visit. Preventive maintenance and papers stay on the unit page. Board lanes with nobody in them are hidden.
- **Analytics is one page** (`Analytics.tsx`): key numbers, people and fleet bars, crews needing attention, 12-week coverage by base. No map, what-if, fairness, leave, units or base-staffing tabs, no recommendations.
- **No driver seat.** Unit types have a chief and three operators. Migration `20261021090000_solo_manager` deleted driver seats (and their assignments/tasks) and turned Field Drivers into Field Operators; the seed no longer makes them. The `Field Driver` position still exists in the catalog because some smoke suites build their own templates with it.
- **Replacement center shows the fix.** `ReplacementTask.closedAt` (same migration). `GET /replacements?recent=true` also returns tasks closed by placing someone in the last 7 days (default listing is still open tasks only). The screen shows a green "Fixed" card (who covers the seat, Next problem, See the board), a "Fixed this week" tile and lane. "Propose" and "Mark overdue" were removed from the screen; the button is "Put on this seat".

## Product direction and plan (2026-10-20)

**Who uses it.** Two kinds of user: the **manager**, who monitors and runs everything, and the **employee**, who sees their own schedule and tasks in the phone portal. Everything in the plan is done by the manager, without the review pipeline; employees' own requests (leave, swaps) still come to the manager for a decision.

**Done in this round**
- CrewBoard logo (`apps/web/public/icon.svg`, the board-and-crew mark) used as the favicon, in the sidebar and on the sign-in card; page title "CrewBoard". Vite's template assets removed.
- **Units page** (sidebar → Today → Units): tiles by status that filter the list, search (code, plate, model, note), base/type/status filters, add, edit details, move to another base, out of service / back, send to the workshop (through the unit profile), delete with the history guard. API: `GET /units?q=`, list rows now carry plate, model, year, notes, job end and workshop return date; `DELETE /units/:id`.
- Manager only: sign-in offers only `admin`; plans publish directly; extensions apply in one step (setting `workflow.requireApproval`).
- English only: language switch, FR/AR strings and RTL rules removed from the web app.

**Done in the second round (2026-10-20)**
1. *Manager-only cleanup:* anything addressed to a staff role also reaches the manager; "escalate to the ops manager" became **Overdue**; texts no longer mention HR, ops or chiefs; the super admin is shown as **Manager**; the Users screen offers Manager and Employee; `SEED_STAFF=off` seeds only the manager and employee logins. English only on the API too (notification texts, reset email, the `lang` preference and `org.languages` removed).
2. *Units:* a full unit page (`#/units/:id`) with a 12-month chart (on a job / workshop / idle), crew, papers (registration, insurance, inspection, with files and expiry), preventive maintenance plans, work orders, jobs and crew history. Preventive maintenance (E19): plans per unit, an hourly scheduler that opens the work order when a service comes due (after any job the unit is on), finishing it records the service. Units list: Service due tile and Next service column.
3. *Design-review P2:* see "Audit follow-up" above.
6. *Employee side:* tasks from the manager (Tasks screen; one task for several people; notified; done with a note; the manager is told), and a **To do** tab in the portal gathering tasks, notices to confirm, swaps to answer and assigned work orders. Employees sign in with their employee number.
7. *E28-E30:* performance at 5x (`docs/performance.md`), WCAG 2.1 AA audit with 0 violations, Playwright end-to-end tests of the main flows (`apps/web/e2e`).

**Next, in order**
1. *Before real use:* `JWT_SECRET`, `APP_URL`, SMTP; a login rate limit; demo accounts off (`SEED_STAFF=off` helps); backups.
2. *Real data:* import the remaining sheets (certificates, base staffing rules, sites, maintenance plans), PDF exports.
3. *Polish (P3), done 2026-10-20:* calmer colour (tinted KPI tiles, only red solid, flat headers, no gradients), 3px stripes, one stylesheet; `PRODUCT.md` and `DESIGN.md` added. The `legacy` layer is still there; dissolving it needs a specificity audit.
4. If the fleet grows well past 5x: cache per-person calendars for the day (see `docs/performance.md`).

## Base staff removed (2026-10-21)

The Board's "Base staff" view, the "Base posts below minimum" tile and Analytics line are gone from the web app. Data: migration `20261021120000_no_base_staff` deleted base-post seats (with their assignments, tasks and extensions) and the staffing minimums, and archived (`active = false`) everyone in a `BASE_STAFF` position. The seed no longer creates staffing rules, base seats or base-staff employees (management staff such as the Base Manager entries stay; they hold no seats). The API for staffing rules, base rosters and base posts still exists, so it can come back; `smoke-assignments.ts` makes its own base post for the base-manager scope checks.

## Real data (2026-10-21)

- `npm run seed:real` (in `apps/api`) wipes the database and loads the manager's real crews from `apps/api/prisma/real/crew.json` (gitignored, built from "Operator list.xlsx" and "Truck Owners.xlsx"): one base ("Base", rename it in Locations), no sites, 15 trucks (all Open Hole until changed), 74 people. Manager sign-ins and settings survive the reset. `npm run seed` still builds the demo data the tests use.
- **Ranks** (Chef crew >= Specialist > OP2 > OP3) are the person's tag; `employees/ranks.ts` (API) and `People.tsx` (web) map them to position (Chef crew = Chief of Unit, others Field Operator) and level (Senior, Senior, Experienced, Junior) through `seniorityOverride`.
- Each truck's two chiefs are back-to-back partners and are named in the truck's notes; nobody is assigned yet.
- **Rules warn, never block** when setting `rules.overrideReasonRequired` is off (the real seed turns it off; default on so the smoke suites keep their 422 checks). Only a double booking still needs a reason. Web dialogs make the reason an optional note.
- New screens: **People** (add, edit, rank, partner, Open/Cased Hole skills, archive) and **Locations** (bases and sites). The unit type can now be changed from Edit unit (crew stays on their seats). The board map and `fleetmap.tsx` are gone.

## No sign-in, editable ranks, whiteboard (2026-10-21)

- **No sign-in page.** `POST /auth/auto` gives the first manager account a token when the request comes from this computer (loopback only); the web app calls it on start and whenever a token expires, and hides sign-out and change password. `AUTO_LOGIN=off` brings the sign-in page back.
- **Ranks are a list the manager edits** (setting `people.ranks`, People → Ranks): rename, add, remove, reorder, and choose chief/operator seats and level. `PUT /ranks` renames the tag on everyone who has it and re-applies position and level. `personform.tsx` holds `PersonForm` (also opened from the person panel's Edit button) and `ManageRanks`.
- **Whiteboard (Board → TV):** full screen, remembered across reloads; every unit in compact cards, Free / Days off / Away columns beside them (drag onto seats as on the board), clock, date, search, filter chips (base, type, crew state, rank). Names open the profile above it; Escape closes a dialog or profile before leaving the whiteboard.

## Quick actions and work/days-off setup (2026-10-21)

- **Quick actions** (`quick.tsx`, context in `quickctx.ts`): right-click any person chip or name link, or the "⋯" that appears on hover over a chip (and on People rows), for: open profile, edit details, work and days off (rotation), medical leave, leave or extra days off, extend days of work (only when on a seat: request + approve in one go, with "extend anyway" over limits and "delay their start" when someone takes over the seat). Leave is created through `POST /leaves`, so seats are freed and replacement tasks opened as before.
- **Work & days off** (Planning → `Rotations.tsx`): everyone's rotation pattern and "first day on" (`rotationAnchorDate`), partners listed together, an 8-week strip, "Today" / "Off today" shortcuts and ⇄ to give the partner the opposite stretches. Nobody has a first day yet after `seed:real`; until set, nobody counts as on days off.

## Bulk editing and the 35/28 rotation (2026-10-21)

- **Tick rows to change them together** (`bulk.tsx`: `useSelection`, `SelectAllBox`, `RowBox`, `BulkBar`). The header box selects everything currently shown, so filtering first narrows what a change touches. Choosing a value in the bar applies it at once and keeps the selection.
  - **People:** rank, level, home base. `POST /employees/bulk` gained `rank` (tag + position + level together), `seniority` (empty = back to the rank's level, or computed when there is no rank) and `rotationAnchor`.
  - **Units:** type, home base, status. New `POST /units/bulk` reuses the single-unit handlers per row and reports the ones it could not change instead of failing the batch; `/units/:id/transfer` to the base a unit is already on is now a no-op rather than a 400.
  - **Work & days off:** rotation, first day on (date, "Today", "None") and "Off today", which is worked out per person because it depends on their own days-on.
- **35/28 (5 weeks on, 4 weeks off)** is the company's rotation: `seed-real.ts` creates it, makes it both positions' default and puts everyone on it. It was also added to the live database and applied to all 74 people. The other patterns stay for anyone on a different cycle. Note `rules.maxConsecutiveDays` is 35, so a full stretch sits exactly on the limit.

## Jobs: site only, inline sites, open-ended (2026-10-21)

- **New job asks for the site, not a well and rig.** `Job.wellName` stays in the schema (older jobs and several
  screens use it) and is filled with the site's name when none is given, so a job is named after its site. The board
  card drops the repeat when they match.
- **A site can be created from the job dialog**: pick "+ New site…" and give it a name; it is added to the chosen
  base (`POST /sites`, then the job). Client, travel time and access notes are filled in later on Locations.
- **Open-ended jobs** (`Job.openEnded`, migration `20261021140000_open_ended_jobs`): tick "No end date" and the job
  runs until it is ended by hand. `plannedEnd` is still stored, parked 5 years ahead, so every date range, deployment
  and status calculation keeps working; the screens read `openEnded` and say "until you end it" instead of that date.
  "End job today" is now on the unit page as well as the unit panel. Note that ending a job today leaves the unit
  deployed for the rest of that day (unchanged behaviour); it is back at base the next day.

## Starting the platform: "right now" marks (2026-10-21)

Nobody's rotation is known on day one, so `Employee.startState` (migration `20261021150000_start_state`,
`'STANDBY' | 'DAYS_OFF' | null`) records what a person is doing **right now**. While they have no
`rotationAnchorDate` it stands in for the rotation in both status paths (`calendar.service.ts` and
`employees/insights.ts`), so the board, lanes and lists are right from the first day.

The mark is temporary by design: setting a first day of work clears it (single `PUT /employees/:id` and the
`rotationAnchor` bulk action both do), and from then on the rotation calendar decides. The handover is one click on
Work & days off: **Starts today** (anchor = today) the day someone goes back to work, or **Off today**
(anchor = today − daysOn) the day they finish. Setting any date by hand still works and always has.
Bulk action `startState` sets or clears the mark for a whole selection.

The same two buttons are on **People** too: next to each person's "Today" status, and in the bulk bar for everyone
selected. Someone with no rotation yet gets 35/28 when pressed there (as typing a date on Work & days off does).

## Moving a crew change (2026-10-21)

`POST /assignments/crew-change` `{ seatIds, from, to, overrideReason? }` moves the crew change on `from` to `to` on
each seat: whoever leaves on `from` now stays until `to − 1`, whoever arrives on `from` now starts on `to`. All seats
go through the crew rules together (422 + reason, as elsewhere). A seat where nobody arrives keeps its gap: the open
replacement task for `from` moves to `to`. Crew-change rows now carry `unitId`/`unitCode`.
In the app: the calendar button on each row of **Crew changes**, and on the unit page under "Crew today" (one line
per day the crew changes, plus the date on each seat). The dialog moves one seat or the whole unit's crew changing
that day. Draft-plan arrivals ("suggested") are not moved. Live checks: `scripts/smoke-crewchange.ts`.

## Edit job, and 3 people is a full enough crew (2026-10-21)

- **Edit job** (unit page Jobs list and the unit panel's Jobs tab, for jobs not finished or cancelled): client, base/site,
  service and dates, or open-ended. `PUT /jobs/:id` now moves the unit deployments with the job: a deployment that
  started/ended with the job takes the new start/end, one inside the job keeps its dates but is clipped to them. A clash
  with the unit's other jobs is refused (409). A job still named after its site takes the new site's name.
- **`rules.minCrewOnUnit`** (Settings → Crew rules, default 3): a deployed unit with at least this many required seats
  filled is not short of crew. `crewEnough()` in `domain/rules.ts` drives the board crew badge, the Units list
  "problem" flag, Analytics crew compliance, and the red KPI / empty-seat colour on the unit page and panel.
  Replacement tasks for the empty 4th seat are still created and listed, so it can be filled when someone is free.
