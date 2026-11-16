---
version: alpha
name: NY Legislature Expenditures
description: >-
  A civic public-records explorer for the New York State Assembly's and Senate's spending reports.
  It reads like a well-kept public ledger rather than a startup dashboard: a navy state-government
  header band, white paper cards with hairline borders, Public Sans (the U.S. government's open
  typeface) with tabular figures, one civic blue for links and data, a teal map ramp, party colours
  used only where party is the subject, and a source line under every chart. Numbers are written
  for people who aren't numbers people ("$75.5 million", "about 8 in 10", "typical"), and every
  figure can be traced back to the report it came from.

colors:
  # Light theme (default). Dark values are listed under "dark" below.
  canvas: "#f4f6f9"
  surface: "#ffffff"
  ink: "#1b1f24"
  ink-muted: "#5b6573"
  hairline: "#e3e7ed"
  primary: "#1f5fa8"
  primary-soft: "#e5eef8"
  on-primary: "#ffffff"
  button-primary: "#1f5fa8"
  header-navy: "#0f2a4a"
  header-navy-mid: "#163c69"
  data-bar: "#2f74c0"
  data-bar-muted: "#8a96a6"
  up: "#1d7a55"
  down: "#b42318"
  highlight: "#fff4cc"
  # Spending makeup (always in this order: pay, office expenses, travel)
  seg-payroll: "#2f74c0"
  seg-office: "#e08a2c"
  seg-travel: "#3a9a6b"
  # Campaign-money categories
  cf-individual: "#2f74c0"
  cf-business: "#c2410c"
  cf-committee: "#7c3aed"
  cf-transfer: "#0f8a6b"
  cf-public-match: "#b8860b"
  cf-other: "#8a96a6"
  # Party (only where party is the subject)
  party-democratic: "#2563b8"
  party-republican: "#c0392b"
  party-other: "#8a6fd1"
  party-vacant: "#b8c0cc"
  party-chip-democratic: "#1d4f91"
  party-chip-republican: "#a8261b"
  party-chip-conservative: "#6b2318"
  party-chip-wfp: "#1b5e70"
  # Map: sequential (spending) and diverging (change) ramps
  map-seq-0: "#e3f1ee"
  map-seq-1: "#b2dacf"
  map-seq-2: "#72baa9"
  map-seq-3: "#33907d"
  map-seq-4: "#0d5c4f"
  map-div-down-strong: "#b35806"
  map-div-down: "#f1a340"
  map-div-neutral: "#ececec"
  map-div-up: "#998ec3"
  map-div-up-strong: "#542788"
  map-no-data: "#c4c9cf"
  dark:
    canvas: "#0e1116"
    surface: "#1a1e24"
    ink: "#e7eaee"
    ink-muted: "#9aa4b1"
    hairline: "#262c34"
    primary: "#6ea8ec"
    primary-soft: "#1d2a3a"
    button-primary: "#2a69b5"
    data-bar: "#5b9be0"
    data-bar-muted: "#6b7584"
    up: "#5cc092"
    down: "#f97066"
    highlight: "#3d3415"
    seg-payroll: "#4f8fdb"
    seg-office: "#cc7b2b"
    seg-travel: "#3ea676"
    party-democratic: "#5b9be0"
    party-republican: "#ef6b5b"
    map-seq-0: "#2a4a44"
    map-seq-1: "#24584e"
    map-seq-2: "#2f7d6c"
    map-seq-3: "#4fae97"
    map-seq-4: "#8fdcc6"
    map-no-data: "#6b7380"

typography:
  font-sans: '"Public Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  font-mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  display-lg:   { size: 40px, weight: 800, line-height: 1.12, letter-spacing: -0.025em }
  headline:     { size: 28px, weight: 800, line-height: 1.15, letter-spacing: -0.02em }
  section-title: { size: 21px, weight: 800, line-height: 1.25, letter-spacing: -0.015em }
  card-title:   { size: 17px, weight: 700, line-height: 1.5, letter-spacing: -0.01em }
  stat-value:   { size: 26px, weight: 800, line-height: 1.15, letter-spacing: -0.02em, numerals: tabular }
  body:         { size: 15px, weight: 400, line-height: 1.5 }
  body-plain:   { size: 16px, weight: 400, line-height: 1.55 }
  table:        { size: 14px, weight: 400, line-height: 1.4, numerals: tabular }
  note:         { size: 13px, weight: 400, line-height: 1.45 }
  micro-label:  { size: 12px, weight: 600, line-height: 1.3, letter-spacing: 0.05em, transform: uppercase }
  chart-label:  { size: 11px, weight: 500, line-height: 1.2, numerals: tabular }

rounded:
  xs: 4px      # party and data chips
  sm: 6px      # small buttons, inputs inside tables
  md: 10px     # primary buttons, tooltips
  lg: 12px     # cards
  xl: 16px     # hero
  pill: 999px  # filter chips, pinned items

spacing:
  hair: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px      # gap between cards, card side padding
  xl: 24px
  section: 44px # space above a section title
  page-max: 1200px
  page-gutter: 16px

elevation:
  card: "0 1px 2px rgba(16, 24, 40, .04)"
  raised: "0 10px 30px rgba(16, 24, 40, .08)"

components:
  site-header:
    background: "linear-gradient(120deg, {colors.header-navy}, {colors.header-navy-mid} 60%, {colors.primary})"
    text: "{colors.on-primary}"
  hero:
    background: "{colors.surface}"
    radius: "{rounded.xl}"
    shadow: "{elevation.raised}"
    title: "{typography.display-lg}"
  card:
    background: "{colors.surface}"
    border: "1px solid {colors.hairline}"
    radius: "{rounded.lg}"
    padding: "{spacing.lg} 18px"
    shadow: "{elevation.card}"
  card-head:
    title: "{typography.card-title}"
    rule: "1px solid {colors.hairline}"
  section-title:
    type: "{typography.section-title}"
    rule: "3px solid {colors.ink}"
  stat-tile:
    label: "{typography.micro-label}"
    value: "{typography.stat-value}"
    note: "{typography.note}"
  stat-row:
    divider: "1px solid {colors.hairline}"
  plain-summary:
    background: "{colors.primary-soft}"
    border: "1px solid {colors.hairline}"
    radius: "{rounded.lg}"
    type: "{typography.body-plain}"
  glossary-term:
    underline: "1px dotted currentColor"
  button:
    background: "{colors.surface}"
    border: "1px solid {colors.hairline}"
    radius: "{rounded.sm}"
  button-primary:
    background: "{colors.button-primary}"
    text: "{colors.on-primary}"
    radius: "{rounded.md}"
  chip:
    background: "{colors.primary-soft}"
    text: "{colors.primary}"
    radius: "{rounded.pill}"
  party-chip:
    text: "{colors.on-primary}"
    radius: "{rounded.xs}"
  data-table:
    header: "{typography.micro-label}"
    header-background: "{colors.canvas}"
    body: "{typography.table}"
    row-header: "{typography.table}"
  bar-list:
    fill: "{colors.data-bar}"
    track: "{colors.primary-soft}"
    radius: "{rounded.pill}"
  column-chart:
    fill: "{colors.data-bar}"
    current: "{colors.primary}"
    label: "{typography.chart-label}"
  district-map:
    ramp: "{colors.map-seq-0} → {colors.map-seq-4}"
    no-data: "{colors.map-no-data}"
  tooltip:
    background: "{colors.ink}"
    text: "{colors.surface}"
    radius: "{rounded.md}"
  pin-tray:
    background: "{colors.surface}"
    radius: "{rounded.lg}"
    shadow: "{elevation.raised}"
---

# NY Legislature Expenditures — DESIGN.md

## Overview

This is a public-records site. Its readers are voters, reporters, civic advocates and staffers,
and many of them aren't comfortable with numbers. Every design decision serves two things: **trust**
(can I check where this number came from?) and **plain reading** (do I understand what it means
without doing arithmetic?).

The look borrows from a state government's printed ledger, not from a SaaS dashboard. A navy band
carries the site's name and the chamber and period controls; below it, everything is white paper on
a cool grey desk. Headlines put the number in the sentence ("The Assembly spent **$75.5 million** in
Oct 2025 – Mar 2026"). Colour is spent on data, never on decoration.

### Key Characteristics

- Public Sans throughout, with tabular figures in every number column
- One civic blue (`{colors.primary}`) for links, current selection and data bars
- Hairline-bordered white cards; a raised shadow only on the hero and floating trays
- A source line under every chart and table: who published it, and when
- Amounts in words outside charts ("$75.5 million", "$7,000"), shares as "about 8 in 10"
- Dotted-underline glossary terms that explain jargon on hover, tap or keyboard focus
- Party colours appear only where party is the subject (chips, seat charts, party filters)
- Light and dark themes are both first-class, with every data palette tuned for each

## Colors

### Surfaces and ink
`{colors.canvas}` is the desk; `{colors.surface}` is the paper. Ink is near-black
`{colors.ink}` with `{colors.ink-muted}` for notes and labels; both pass WCAG AA on both surfaces
in both themes. Hairlines (`{colors.hairline}`) separate rather than shadows.

### Civic blue
`{colors.primary}` marks what you can act on (links, the current period, the active nav item) and
is also the default data colour. `{colors.button-primary}` exists separately because the dark
theme's link blue is too light to carry white button text.

### Data
- **Spending makeup** always uses the same three colours in the same order: payroll
  `{colors.seg-payroll}`, office expenses (M&O) `{colors.seg-office}`, travel
  `{colors.seg-travel}`.
- **Change** uses `{colors.up}` and `{colors.down}` with an arrow and the word ("up", "down"), never
  colour alone.
- **Maps** use a single-hue teal ramp for amounts (`map-seq-0` to `map-seq-4`) and an
  orange-to-purple diverging ramp for change, which stays readable for red-green colour blindness.
  The dark theme lifts the lightest step so low values don't vanish into the background.
- **Campaign money** has its own six categories; public matching funds are gold
  (`{colors.cf-public-match}`) so they stand apart from private money.

### Party
Democratic blue and Republican red appear only where party is what's being shown. Small party
chips with white text use fixed darker shades (`party-chip-*`) so they pass contrast in both
themes. Blue for data never implies a party.

## Typography

| Role | Token | Use |
|---|---|---|
| Page headline | `display-lg` | Overview hero, one per page |
| Page title | `headline` | Member, district and list pages |
| Section title | `section-title` | Groups of cards, with a 3px rule above |
| Card title | `card-title` | Every card head |
| Stat value | `stat-value` | Headline figures in stat tiles |
| Body | `body` | Ledes and running text |
| Plain summary | `body-plain` | The "In plain terms" box, a step larger |
| Table | `table` | Data tables, tabular numerals |
| Note | `note` | Source lines, method notes, chart captions |
| Micro label | `micro-label` | Stat-tile labels and column headers only |
| Chart label | `chart-label` | Axis and column labels inside charts |

**Principles**
- Use the steps above only; no in-between sizes.
- Uppercase is reserved for micro labels. Names, row headers and headings are sentence case.
- Members' names appear as people say them ("Carl E. Heastie"), with the report's spelling
  ("HEASTIE, CARL E.") shown under the heading. Office and vendor names stay as filed.
- Notes and paragraphs are capped near 70 characters wide so they're easy to read.

## Layout

- Content sits in a 1200px column with 16px gutters; left and right edges always match.
- Cards stack 16px apart. Two-column card grids fit as many 440px columns as there's room for, so they become one column on tablets and phones.
- Pages read top-down from the answer to the detail: headline figure and plain summary first,
  then stat tiles, then charts, then the full tables, then method and sources.
- Long pages get an "On this page" jump bar once they have more than five card sections.
- Overview order: hero → stat tiles → both chambers → spending over the years → money lists →
  "Budgets, seats and the record over time".

## Elevation

There are two tiers and no others. `{elevation.card}` is almost flat; cards are defined by their
hairline border. `{elevation.raised}` is for the hero and things that float over content (the
pin tray, tooltips). Cards are never nested in cards: tiles inside a card become a stat row
divided by hairlines.

## Components

- **site-header**: the only gradient on the site, navy to civic blue. Holds the brand, the
  chamber switch, the report-period menu, theme toggle, search and the grouped navigation.
- **hero**: overview only. The answer as a sentence, one supporting line, a find-your-member link
  and search, with the district map beside it.
- **card**: white paper, hairline border, `rounded.lg`. Its head has a card title, an optional
  short note on the right, and a hairline under it.
- **card-head**: title left, a note or control right; wraps on phones.
- **section-title**: groups related cards on long pages, with a 3px ink rule above.
- **stat-tile**: micro label, big value, then one or two notes. The change note is a sentence
  ("Up $1.4 million from Apr–Sep 2025 (2% more)").
- **stat-row**: stat tiles inside a card, separated by vertical hairlines instead of borders.
- **plain-summary**: the "In plain terms" box on member and district pages: what was spent, how
  much a month, what share went to pay, how it compares with a typical office, what it costs per
  resident. No symbols, no signs, no parentheses of maths.
- **glossary-term**: a word with a dotted underline that reveals a one-line definition. Every
  definition also lives on the About page under "Words used on this site".
- **button**: white, hairline, `rounded.sm`. Hover outlines in civic blue.
- **button-primary**: one per view at most (Search, Compare).
- **chip**: soft-blue pill for kinds and filters.
- **party-chip**: small square-ish tag with white text on a fixed dark party shade.
- **data-table**: micro-label column headers on a light band, sticky on scroll; row headers in
  sentence case at table size; hairline rows with a faint stripe on every other row; numbers right-aligned in tabular
  figures; headers sort on click; long tables get a row filter.
- **bar-list**: name, amount, and a thin pill bar on a soft track, always zero-based.
- **column-chart**: flat bars from a shared zero baseline so heights are proportional; the
  current period is the darker blue; short labels under each column; values above.
- **district-map**: teal ramp by amount with a legend in plain words; every district has a
  tooltip and links to its page.
- **tooltip**: ink background, surface text, appears on hover, first tap, or keyboard focus.
- **pin-tray**: floating bar that holds up to four pinned members to compare.

## Data and Language Rules

These are as much a part of the system as the colours.

1. **Every number shows where it came from.** A source line under each chart or table names the
   publisher and date. Unofficial counts say so.
2. **Charts are honest.** Bars start at zero and stay proportional. No gradients, 3D or decoration
   on data marks. Totals that don't include something say what's left out.
3. **Say it, don't make them compute it.** Amounts in words ("$75.5 million"), rounded in prose and
   exact in tables. Changes as "up/down $X (Y% more/less)", or "about twice as much". "Typical"
   instead of median, "about 7 in 10" for shares, "give or take" for margins of error, "in the top
   third" for ranks.
4. **Define jargon where it appears.** M&O, allocated, vouchered, percentile and the like get a
   glossary term.
5. **No individual donor names.** Campaign money is shown by category and size only.
6. **Colour is never the only signal.** Up and down carry arrows and words; parties carry letters.

## Responsive Behavior

| Width | Behaviour |
|---|---|
| > 900px | Two-column card grids; map beside the district facts |
| 641–900px | Card grids drop to one column (each column needs 440px); navigation still inline |
| ≤ 640px | Phone layout: menu button, wide tables become labelled cards or show their key columns only, the overview hides the header search (the hero has one), stat rows go two-up |

### Touch Targets
Interactive controls are at least 24px tall; inline links in lists get extra vertical padding on
phones. One known exception: the 14 columns of the overview's history chart are just under 24px
wide on a phone; the report-period menu does the same job.

### Collapsing Strategy
Tables keep the name, the total and the change on phones and drop secondary columns; very wide
tables switch to stacked, labelled cards. Charts thin their labels (first, every fourth, last).
Nothing scrolls the whole page sideways.

## Accessibility

- WCAG 2.1 AA contrast in both themes, checked with axe on every release.
- Visible focus rings in civic blue; skip link; landmarks with unique labels.
- Reduced-motion and forced-colours modes respected.
- Tooltips work on keyboard focus and touch, not only hover.

## Known Gaps

- Office and vendor names are shown as the reports print them (all caps); they aren't re-cased.
- The Pay > Statistics page still uses statistical vocabulary on purpose, for data-minded readers.
- No print stylesheet beyond the printable district fact sheet.
- No brand mark beyond the capitol icon and the wordmark.
