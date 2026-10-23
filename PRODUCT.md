# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop (a Windows program built with Electron; the screens are a web app inside it)

## Users
One **manager** at an oilfield-services company in Algeria (bases such as In Amenas). They run the whole operation from a desktop: who crews which unit, who covers an absence, which unit is on a job or in the workshop. Their job is monitoring and deciding under time pressure, so what needs action today must be unmistakable.

The manager is the **only user** (decision 2026-10-21): no employee app, no other account types, no leave, tasks or work-order screens. Crews are a chief and three field operators; the field operator is also the driver. If someone cannot work, the manager unassigns or replaces them from the seat.

## Product Purpose
CrewBoard plans crew rotations, dispatches crews on units and jobs, and keeps the fleet in order. It validates every assignment against hard and soft crew rules, covers absences through a replacement center, forecasts coverage, and tracks the fleet (units, papers, preventive maintenance). Success: no unit goes out short-crewed, and the manager spots problems before they become gaps.

## Positioning
Crew-rule-aware planning tied to the fleet: one validator behind manual assignments, the planning engine, plan publishing and swaps, so screens never disagree about what is allowed.

## Operating Context
Mock data for now (seeded, with a demo story); real data is not connected. One user kind (the manager) in the product today; other roles stay in the API for tests. English only. Employees use phones, sometimes with poor connectivity (the portal views work offline). Medical leave is shown to others only as "Unavailable".

## Capabilities and Constraints
Dispatch board, replacement center, timeline, plans, leave, extensions, work orders, units and unit pages, tasks, analytics (forecast, what-if, KPIs, map), users, audit log, Excel import/export, employee portal. Stack: React + Vite web app, NestJS + Prisma + PostgreSQL API. Certificates do not expire. Everything numeric is a setting.

## Brand Commitments
Name CrewBoard and its board-and-crew logo (`apps/web/public/icon.svg`). Red is the "act now" signal.

## Evidence on Hand
Seeded demo data only; no real customer data, testimonials or benchmarks.

## Product Principles
- The thing that needs action today is the loudest thing on screen.
- One source of truth for rules: screens never contradict the validator.
- Every name and unit code opens its profile.
- Private by default: medical reasons hidden, employees see only themselves.
- The manager decides; the system proposes.

## Accessibility & Inclusion
WCAG 2.1 AA, checked by an axe audit of every screen in light and dark (currently 0 violations); 44px touch targets on touch screens; text never under 12px; keyboard focus managed in dialogs and panels.
