# Performance (plan E28)

Measured on 2026-10-20 in the cloud development container (API under `tsx`, PostgreSQL 16 on the same machine, no
caching anywhere). Every request was run five times; the table shows the median and the slowest.

How to repeat it (API running):

```bash
cd apps/api
SEED_SCALE=5 npm run seed            # 5x mock volume: 955 people, 80 units, same four bases
npx tsx scripts/perf.ts --deploy=40  # puts 40 units on jobs, publishes a 4-week plan, then times the requests
npm run seed                         # back to the normal demo data
```

## 1x (the demo volume, 8 units on jobs)

Data: 191 people, 16 units (8 on jobs), 103 assignments. 5 runs each.

| Request | Median ms | Worst ms | Size kB | Status |
|---|---:|---:|---:|---:|
| Board (today) | 93 | 96 | 57 | 200 |
| Units list | 12 | 16 | 8 | 200 |
| Unit page: detail | 14 | 23 | 7 | 200 |
| Unit page: 12-month history | 5 | 6 | 1 | 200 |
| Employees list | 31 | 36 | 203 | 200 |
| Person calendar (90 days) | 12 | 15 | 5 | 200 |
| Timeline (5 weeks, everyone) | 49 | 72 | 76 | 200 |
| Replacement center | 4 | 7 | 0 | 200 |
| Analytics overview | 102 | 129 | 0 | 200 |
| Coverage forecast (90 days) | 136 | 145 | 282 | 200 |
| Work orders | 5 | 9 | 0 | 200 |
| Tasks | 4 | 4 | 0 | 200 |
| Audit log (page) | 6 | 7 | 8 | 200 |
| Excel export: employees | 115 | 128 | 30 | 200 |
| Planner: 4 weeks, all bases | 106 | 115 | 5 | 201 |

## 5x (40 units on jobs)

Data: 955 people, 80 units (40 on jobs), 363 assignments. 5 runs each.

| Request | Median ms | Worst ms | Size kB | Status |
|---|---:|---:|---:|---:|
| Board (today) | 317 | 377 | 267 | 200 |
| Units list | 32 | 32 | 39 | 200 |
| Unit page: detail | 17 | 24 | 8 | 200 |
| Unit page: 12-month history | 7 | 16 | 1 | 200 |
| Employees list | 123 | 169 | 212 | 200 |
| Person calendar (90 days) | 15 | 19 | 5 | 200 |
| Timeline (5 weeks, everyone) | 73 | 88 | 114 | 200 |
| Replacement center | 3 | 6 | 0 | 200 |
| Analytics overview | 291 | 407 | 0 | 200 |
| Coverage forecast (90 days) | 511 | 586 | 285 | 200 |
| Work orders | 5 | 5 | 0 | 200 |
| Tasks | 4 | 5 | 0 | 200 |
| Audit log (page) | 7 | 8 | 24 | 200 |
| Excel export: employees | 261 | 292 | 89 | 200 |
| Planner: 4 weeks, all bases | 253 | 320 | 1 | 201 |

## Reading it

- Nothing reaches a second at 5x. The slowest are the 90-day coverage forecast (about 0.5 s), the board (about 0.3 s)
  and the analytics overview (about 0.3 s); they grow roughly with the number of people, since each person's
  calendar is computed on request.
- The planner plans four weeks for every base in about a quarter of a second at 5x.
- If the fleet grows well past 5x, cache the per-person calendars for the day (they only change when an assignment,
  leave or setting changes) before anything else; the forecast, board and overview all build on them.
