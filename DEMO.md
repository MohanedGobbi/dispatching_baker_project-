# CrewBoard demo walkthrough

Everything here runs on mock data. Reset the story at any time with:

```bash
cd apps/api
npm run seed      # wipes and rebuilds 191 employees, 16 units, 4 bases
npm run demo      # publishes a 4-week plan for 8 units, then plants the scenarios below
```

Open http://localhost:5173 and sign in as **`admin` / `demo1234`**: the manager, who does everything.

For now the platform has one kind of user, the manager (super admin), and no review step: plans are published straight from the draft and extensions apply at once (setting `workflow.requireApproval`, off). The walkthrough below still names the role that would do each step once more roles are switched on; as `admin` you can do all of them. The other demo accounts still exist in the seed (the automated tests use them) but are not offered on the sign-in page:

| Login | Role | Use it for |
|---|---|---|
| `dispatcher` | Dispatcher | board, replacements, plans |
| `ops` | Ops manager | approvals, publishing, analytics, what-if, settings |
| `hr` | HR | leave, medical, certificates, clearance |
| `basemanager` | Base manager (HMD only) | base posts, scoped view |
| `admin` | Super admin | everything, settings |
| `chief` | Chief of Unit | work orders, own unit |
| `employee` | Field operator | phone portal (open at phone width) |
| `e1044` … | any employee, by employee number | portal for a specific person |

Names below are what the seed produces; if you change the seed they will differ, the codes (HL-xxxx) are stable.

## What the data already contains (plan 28.2)

| # | Scenario | Where to see it |
|---|---|---|
| 1 | Deployed unit with only 2 of 3 operators | Board: **HL-6707** (INA), red "seat empty" |
| 2 | Deployed unit with no experienced operator | Board: **HL-6714** (TMN), "no experienced" warning |
| 3 | Cased Hole unit with an Open-Hole-only operator | Board: **HL-6784** (HMD), qualification warning |
| 4 | Unit with a job in 5 days and no crew | Replacements: **HL-6798** (TMN), tasks opened by the scan |
| 5 | Operator on medical leave today | Replacements: critical task for **HL-6700** (HMD) |
| 6 | 45-day medical leave on a scarce Experienced Cased Hole operator | Analytics → Leave: "long-term absences 1" (names stay with HR) |
| 7 | One person awaiting clearance, one restricted to base posts | Analytics → Leave: "awaiting clearance 1"; HR → Leave |
| 8 | HMD mechanics below minimum next week | Analytics → Base staffing: red cells, week of 26 Oct; recommendation "Spread leave" |
| 9 | Experienced Cased Hole shortage in about 6 weeks | Analytics → Forecast: red band from mid-November; recommendation "Recruit 5 …" |
| 10 | Standby surplus at one base, gaps at another | Analytics → Overview → Recommendations: several "Transfer …" |
| 11 | Three people owed 8–11 rest days | Extensions → Rest balances; recommendation "Prioritise relief" |
| 13 | Unit back from the workshop in 3 days | Work orders: **HL-6791**, expected return in 3 days |
| 14 | Swap request waiting for a manager | Leave → Swaps (as `ops` or `dispatcher`) |

## The 12 acceptance scenarios, as clicks

**1. New recruit on a unit with juniors → warning and override.**
`dispatcher` → Board. Pick a unit with no experienced operator (HL-6714). Drag a standby person onto one of its seats. The board warns "No experienced operator"; saving requires an override reason, which is audited.

**2. Medical leave → seat empties, critical task, candidates proposed.**
`hr` → Leave → New leave, choose an operator who is on a unit (Board shows who), type *Medical leave*, start today, attach any PDF. Then `dispatcher` → Replacements: the seat is empty, a **critical** task exists, and the top candidates are listed with reasons and with the people who were ruled out. Others only ever see "Unavailable", never the reason.

**3. Confirm the replacement → notifications and live board.**
Keep the Board open in a second window as `ops`. As `dispatcher`, pick a candidate on the task and confirm. The incoming person, the outgoing person and the chief get a notification (bell, top right), and the second window updates without a refresh.

**4. Medical leave ends → awaiting clearance → base posts only.**
`hr` → Leave → the person whose leave has ended (Analytics → Leave shows 1 awaiting clearance). Clear them with "base posts only". Then Plans → suggest a plan: they only appear on base posts.

**5. Two mechanics on overlapping leave → base below minimum.**
Already planted at HMD. Analytics → Base staffing shows the red cells; `basemanager` receives the alert in the bell. Open a seat suggestion on the HMD base roster: the engine offers a flexible employee.

**6. "Suggest plan" for four weeks.**
`ops` → Plans → New plan, 28 days, all bases. Every assignment has a "why" explanation; gaps are listed with fix options (extend, call back from days off, move from an idle unit, ask to postpone leave).

**7. Edit and publish → employees acknowledge.**
Edit a couple of assignments in the draft, then Publish (with `workflow.requireApproval` on in Settings: Send for review, Approve, then Publish). Open the portal as `employee` (phone width): the new rotation appears in Alerts and needs an acknowledgement.

**8. Extension approved → balance up → relief prioritised.**
Extensions → Request extension (any active person, 3 days, "replacement late"). As `ops` approve. Rest balances shows the new total; the next plan favours that person's relief, and Analytics → Overview lists "Prioritise relief for …".

**9. Unit in maintenance → crew seats optional → forecast updates.**
Board → click the coloured header of a deployed unit (HL-6721) → "Send to the workshop", describe the problem, expected back in 10 days. (Or Work orders → New work order.) Its crew seats stop being required for those days; Analytics → Forecast changes accordingly.

**10. Forecast shows an Experienced Cased Hole shortage → recruitment recommendation.**
Analytics → Forecast, profile *Experienced Cased Hole operators*: coverage falls to 17 % from mid-November. Overview → Recommendations: "Recruit 5 Experienced Cased Hole operators", with the data behind it. Accept, snooze or dismiss.

**11. Swap in the portal → colleague accepts → manager approves.**
The planted swap is already past the colleague step. As `ops`: Leave → Swaps → Approve. Calendars update for both people. To see the whole chain, log in as an operator (`e1044`-style login), Requests → Swap, pick a colleague, then log in as that colleague to accept.

**12. Board time machine.**
Board → date picker (or the arrows) → go back up to three months. The same board is shown with the crews of the day (four earlier rotations are in the demo data).

## Adding trucks and jobs, and profiles

* **New truck:** Board → "Add a unit" (ops manager or admin): code, type, home base, plate/model/year. Its crew seats are created from the type.
* **New job:** Board → "New job" (dispatcher and above): well, rig, client, base and site, dates, and optionally the unit to send. The unit's empty seats then appear in the replacement center and in the planner.
* **Click any person's name** (board, replacement center, leave, extensions, crew changes, plans, work orders) for their profile: contact (phone, email, emergency contact), status today, seniority, qualifications and certificates, a 10-week schedule, and the history of assignments and leave.
* **Click any unit** (the coloured header on the board, or a unit code anywhere) for its profile: current job, crew today, utilization, jobs past and coming, maintenance history, crew history, notes. From there: send it to the workshop with a note, mark a repair done, give it a job, end its job, or take it out of service.
* Certificates are simply held or not; they do not expire.

## Extra tour: analytics and what-if

* **Analytics → Overview**: headcount by status, crews not meeting the rules, key figures, recommendations.
* **Forecast**: heat map of available against needed people per base and day (click a cell for the numbers); pick a profile to see the line chart and shortage windows.
* **What if**: "Put an idle unit to work" and "Lose 4 experienced Field Operators" → Run. Shows uncovered days before and after, by base, and the biggest new gaps. Nothing is saved.
* **People & fairness, Leave & absence** (HR, ops, base manager only), **Units & maintenance**, **Base staffing**, **Map** (offline-friendly, no map tiles).
* **Settings** (`admin`): every threshold and engine weight, e.g. change *maxConsecutiveDays* and watch rules react.
* **Units** (sidebar → Units): the fleet by status (tiles filter the list), search by code, plate, model or note, add a unit, edit plate/model/year/notes, move it to another base, take it out of service or back, delete one entered by mistake (a unit with history is refused and offered "Out of service" instead). Unit codes open the unit profile, where it can be sent to the workshop.
* **Phone / PWA**: log in as `employee`, resize to phone width; install from the browser menu. Today, Calendar, Requests, Alerts, Me work offline for viewing.

## Extra tour: accounts, audit, import

* **Users** (`admin`; `ops` can look): create an account without a password to get a temporary one, shown once. Sign in with it: CrewBoard asks for a new password before anything else. Change roles or disable an account and its open sessions follow within the request.
* **Forgot your password?** on the sign-in page, e.g. for `hr`: the reset email lands in the outbox (no SMTP in the demo). As `admin`, `GET /api/notifications/outbox` shows it; open the link to set a new password. Reseed afterwards to get `demo1234` back.
* **Audit** (`admin`, `ops`, `hr`): every change with who and when; click a row for before/after. Filter by record type, e.g. *Setting* after changing one in Settings.
* **Import / export** (`hr` or `ops`): *Export current data* for Employees, change a cell and add a row in Excel, then *Upload and check*. The report shows new, changed and unchanged rows and every error per row; nothing is written until *Import*.

## Extra tour: units and the employee side

* **Unit page:** Units → click a unit code. The last 12 months (on a job, in the workshop, idle), crew today, papers (one insurance is expired or expiring on some units), preventive maintenance with next due dates, work orders, jobs and crew history. *Add a service*, mark one *Done*, *Book* one now; add a paper with a PDF and download it. On the Units list, the *Service due* tile shows units whose service is due or overdue; the scheduler has already opened work orders for them (Work orders board).
* **Tasks:** Tasks → *New task*, pick a few people, a title and a date. Then sign in as one of them (employee number, e.g. `e1001`) at phone width: the **To do** tab has the task with a badge; tap *Done* and leave a note. Back as `admin`, the task shows done with the note, and the bell has a "Task done" notice. The `employee` account already has three tasks from the demo, one overdue.

## Not built yet (on purpose)

SSO, PDF export, sync with an HR/ERP system, a login rate limit. See `HANDOFF.md`.
