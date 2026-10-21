---
name: CrewBoard
description: Calm operations console for crew dispatch, where only what needs action today is loud.
colors:
  accent: "#2563eb"
  accent-dark-theme: "#60a5fa"
  bg: "#f6f7f9"
  bg-dark: "#0b1220"
  surface: "#ffffff"
  surface-dark: "#111a2e"
  text: "#0f172a"
  text-dark: "#e5e9f2"
  muted: "#556275"
  muted-dark: "#94a3b8"
  border: "#e2e8f0"
  border-dark: "#1f2a44"
  sidebar: "#14204a"
  act-now-red: "#dc2626"
  act-now-red-deep: "#b91c1c"
  ok-green: "#16a34a"
  warn-amber: "#d97706"
  open-hole-green: "#15803d"
  cased-hole-amber: "#b45309"
  on-job-blue: "#2563eb"
  base-indigo: "#4f46e5"
  standby-teal: "#0f766e"
  leave-purple: "#9333ea"
  medical-rose: "#e11d48"
  clearance-orange: "#c2410c"
  off-slate: "#64748b"
typography:
  display:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.05
  headline:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
  title:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    letterSpacing: "0.02em"
  body:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "0.12em"
rounded:
  sm: "9px"
  md: "14px"
  lg: "18px"
  pill: "99px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s6: "24px"
components:
  kpi-tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  kpi-tile-alert:
    backgroundColor: "{colors.act-now-red-deep}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
---

# Design System: CrewBoard

## Overview

**Creative North Star: "The Quiet Control Room"**

CrewBoard is a tool for one manager making decisions under time pressure, so the interface stays calm and lets a single signal speak: red means someone must act now. Everything else (identity colours, statuses, headers) is present for orientation but held back, so a short-crewed unit, an empty seat or an overdue service is the first thing the eye lands on.

The system is a light-and-dark, card-based console: a deep navy sidebar, pale canvas, white cards with soft shadows and generous radii, Inter throughout. Colour carries meaning (Open Hole green, Cased Hole amber, base identities, leave/medical/standby states) and is used as tint or a single flat tone, never gradients or glows. Density is moderate and scannable; on phones (the employee portal) targets grow to 44px.

**Key Characteristics:**
- One loud colour: solid red tiles and chips are reserved for "act now".
- Identity and status colours are tinted or flat, with white text only on darkened tones.
- Flat by default; shadow is a soft ambient lift on cards, not a structural device.
- Every name and unit code is a link that opens its profile in a side panel.
- WCAG 2.1 AA in both themes, enforced by an automated axe audit.

## Colors

A cool slate neutral base, one blue accent, and a restrained status palette defined in `tokens.css`; components use `--pal-*` and status tokens, never raw hex.

### Primary
- **Operations Blue** (#2563eb; #60a5fa in dark): the accent for links, primary buttons, focus and "on a job".

### Secondary (status and identity)
- **Open Hole Green** (#15803d) and **Cased Hole Amber** (#b45309): the two unit types, always paired with their text label.
- **Standby Teal** (#0f766e), **Base Indigo** (#4f46e5), **Leave Purple** (#9333ea), **Medical Rose** (#e11d48), **Clearance Orange** (#c2410c), **Off Slate** (#64748b): person and base states on the board, calendar and charts.

### Tertiary (signal)
- **Act-Now Red** (#dc2626 / deep #b91c1c): the only colour allowed as a solid, saturated fill on a KPI tile (`.kpi2.alert`). Also used for rule violations and empty required seats.

### Neutral
- **Canvas** (#f6f7f9; #0b1220 dark), **Surface** (#ffffff; #111a2e dark), **Ink** (#0f172a; #e5e9f2 dark), **Muted** (#556275; #94a3b8 dark), **Hairline** (#e2e8f0; #1f2a44 dark).
- **Sidebar Navy** (#14204a): flat; group titles #94a3b8, active item descriptions #e2e8f0.

### Named Rules
**The One Loud Colour Rule.** Solid saturated fills are for red "act now" only. Everything else is a tint (about 9% of the colour over the surface, with a 28% border) or a single flat darkened tone for headers.
**The No Gradient Rule.** No gradients or coloured glows on surfaces; a flat tone carries identity.
**The Tokens Rule.** Component colours come from `--pal-*` / status tokens, never raw hex; text on a pale tint uses the `--ink-*` tokens.

## Typography

**Display / Body / Label Font:** Inter Variable (self-hosted, with system-ui fallback), so it works offline.

**Character:** neutral, tabular and highly legible; hierarchy comes from weight and size, not a second typeface.

### Hierarchy
- **Display** (700, 30px, 1.05): KPI numbers.
- **Headline** (700, 22px): profile and focus headers.
- **Title** (700, 17px, +0.02em): unit codes, base names, card titles.
- **Body** (400, 14px): lists, forms, tables.
- **Label** (700, 12px, uppercase, +0.12em): sidebar group titles and section labels.

### Named Rules
**The 12px Floor Rule.** No text under 12px anywhere.

## Layout

A 236px sidebar (collapsing to 64px icons; a slide-in menu under 760px) beside a fluid main column. Pages start with a `PageGuide` (one-sentence purpose, folded "How it works"), then a row of KPI tiles, then the working content in cards or tables. Spacing scale 4/8/12/16/24px. The board is a grid of unit cards grouped under base banners. Phones get a dedicated bottom-tab employee portal and 44px touch targets.

## Elevation & Depth

Hybrid, mostly flat: cards sit on the canvas with a soft ambient shadow (`0 1px 2px rgba(15,23,42,.06), 0 4px 16px rgba(15,23,42,.06)`); the red alert tile adds a small tinted lift. Dark mode relies on the surface/canvas tone difference and hairlines rather than shadow. Stateful depth only: hover nudges, selected tiles get a 3px outline ring.

### Named Rules
**The Ambient Only Rule.** Shadows are soft and neutral; no coloured glow except under the red alert tile.

## Shapes

Generously rounded: 14px for tiles and cards, 16–18px for large panels and heads, 9–10px for buttons and inputs, full pills for chips and badges. Status stripes on cards are 3px (side or top), never thicker.

## Components

### KPI tiles
Quiet tint with the number in ink and a small coloured icon; clickable ones filter the list below. `.alert` switches to the solid deep red with white text. Selected: 3px ring.

### Unit cards and headers
White card; the header is one flat darkened tone of the unit's identity colour with white text, a darkened (black 24%) pill for the type, and a crew ring. Empty required seats show a red "Assign someone".

### Buttons and chips
Primary: Operations Blue fill, white text, 9px radius. Secondary: surface fill, hairline border. Filter chips are pills with an `aria-pressed` state.

### Navigation
Dark navy sidebar grouped Today / Planning / Insights / Administration; each item has a tinted icon square in its group colour and a one-line description; the active item gets a tinted row and a 3px inset stripe.

### Side panels and dialogs
Person and unit profiles open in a right-hand panel with a flat coloured head; dialogs trap focus, restore it on close, and close with Escape.

## Do's and Don'ts

### Do:
- **Do** keep red for things that need action today, and make them the strongest element on the screen.
- **Do** use tint or a single flat tone for identity colours; verify white text on any filled colour clears 4.5:1.
- **Do** make every name and unit code a link to its profile.
- **Do** run `npm run e2e` in `apps/web` after styling changes; it includes the axe audit of every screen in both themes.

### Don't:
- **Don't** add gradients, glows or decorative blobs.
- **Don't** make card stripes thicker than 3px.
- **Don't** use raw hex in components or `!important` in `look.css`.
- **Don't** put translucent white chips on coloured heads; use translucent black so text keeps its contrast.
