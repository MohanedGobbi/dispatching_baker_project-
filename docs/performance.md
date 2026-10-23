# Performance

Measured on 2026-10-23 on the development PC (the compiled engine under Node, SQLite in WAL mode, the database on the
local disk, no caching anywhere). Every request was run five times; the tables show the median and the slowest, in
milliseconds. The data is the generated demo data (seed), at its normal size and at five times that.

How to repeat it (PowerShell, on a **throwaway** data folder, never the real data):

```powershell
$env:DATA_DIR = 'C:\temp\crewboard-perf'; $env:SEED_SCALE = '5'
cd apps/api; npm run build; npm run seed
Start-Process node -ArgumentList 'dist\src\main.js' -WindowStyle Hidden     # the app on http://127.0.0.1:3000
npx tsx scripts/perf.ts --deploy=40                                         # puts 40 units on jobs, then times the requests
```

## Demo size

Data: 140 people, 16 units (8 on jobs), 60 assignments.

| Request | Median ms | Worst ms | Size kB |
|---|---:|---:|---:|
| Board (today) | 33 | 37 | 43 |
| Units list | 5 | 6 | 8 |
| Unit page: detail | 4 | 6 | 2 |
| Unit page: 12-month history | 2 | 2 | 1 |
| Employees list | 12 | 13 | 151 |
| Person calendar (90 days) | 5 | 6 | 2 |
| Timeline (5 weeks, everyone) | 19 | 21 | 35 |
| Replacement center | 3 | 4 | 0 |
| Analytics overview | 31 | 34 | 2 |
| Coverage forecast (90 days) | 51 | 54 | 129 |
| Work orders | 1 | 2 | 0 |
| Tasks | 1 | 1 | 0 |
| Audit log (page) | 1 | 2 | 7 |
| Excel export: employees | 57 | 100 | 26 |
| Planner: 4 weeks, all bases | 123 | 137 | 61 |

## Five times the demo size

Data: 700 people, 80 units (40 on jobs), 322 assignments.

| Request | Median ms | Worst ms | Size kB |
|---|---:|---:|---:|
| Board (today) | 123 | 141 | 211 |
| Units list | 12 | 14 | 39 |
| Unit page: detail | 5 | 5 | 2 |
| Unit page: 12-month history | 2 | 3 | 1 |
| Employees list | 46 | 48 | 215 |
| Person calendar (90 days) | 5 | 6 | 2 |
| Timeline (5 weeks, everyone) | 40 | 46 | 79 |
| Replacement center | 3 | 4 | 0 |
| Analytics overview | 113 | 120 | 7 |
| Coverage forecast (90 days) | 217 | 360 | 130 |
| Work orders | 1 | 2 | 0 |
| Tasks | 1 | 2 | 0 |
| Audit log (page) | 2 | 3 | 21 |
| Excel export: employees | 111 | 161 | 70 |
| Planner: 4 weeks, all bases | 1102 | 1144 | 130 |

## Reading it

- Every screen answers in well under a quarter of a second at five times the demo size, apart from the planner.
- The board, the screen the manager keeps open, takes about 0.03 s at demo size and 0.12 s at five times.
- The planner (a new four-week plan for every base, run once per request) is the one slow request: about 0.12 s at demo
  size and 1.1 s at five times. It runs only when the manager asks for a plan.
- The 90-day coverage forecast, the board and the analytics overview all build on each person's calendar, which is
  computed on request. If the fleet grows well past five times, cache the calendars for the day (they only change when
  an assignment, leave or setting changes) before anything else.
- An earlier measurement with PostgreSQL (2026-10-20, 191 people at demo size) showed a 0.09 s board and a 0.25 s planner at
  five times. The screens are faster on SQLite, with no network hop between the engine and the database, and the planner
  is slower at five times because it reads its data in many small queries. The data sets differ in size, so the two
  runs are not strictly comparable.
