<p align="center">
  <img src="docs/banner.png" alt="NYS Assembly Expenditures — every line of the Assembly's spending reports, searchable and mapped by district" width="100%">
</p>

<p align="center">
  <a href="https://rike4545.github.io/NYS-Assembly-Expenditures/"><strong>Open the live site →</strong></a>
</p>

<p align="center">
  <a href="https://github.com/rike4545/NYS-Assembly-Expenditures/actions/workflows/pages.yml"><img alt="Deploy" src="https://github.com/rike4545/NYS-Assembly-Expenditures/actions/workflows/pages.yml/badge.svg"></a>
  <img alt="Reports" src="https://img.shields.io/badge/reports-Apr%202025%20%E2%80%93%20Mar%202026-1f5fa8">
  <img alt="Line items" src="https://img.shields.io/badge/line%20items-28%2C349-1f5fa8">
  <img alt="Districts" src="https://img.shields.io/badge/districts%20mapped-150-33907d">
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-none-5b6573">
</p>

---

The New York State Assembly publishes its spending twice a year as long, fixed-width reports: tens of thousands of lines of payroll, rent, utilities, travel and vendor payments. This project turns them into a fast, searchable website where anyone can see **where the money went, who it went to, and how each office compares**.

## Highlights from the data

| | Apr – Sep 2025 | Oct 2025 – Mar 2026 | Change |
|---|---:|---:|---:|
| **Actual spending** (payroll + operations + travel) | $71.24M | $75.49M | +6.0% |
| Payroll | $56.70M | $58.06M | +2.4% |
| Maintenance & operations | $12.60M | $16.28M | +29.2% |
| Travel | $1.94M | $1.16M | −40.2% |
| Median member office | $243,517 | $248,012 | +1.8% |

Mail, telephone and supplies "allocated" costs are tracked separately: the Assembly's report describes them as shares of centrally paid costs that don't reflect actual expenditures.

## A tour

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/overview.png" alt="Overview dashboard"><br><sub><b>Overview</b> — totals with change from the prior report, spending by type and month, top offices, vendors and purposes, and the biggest member-office increases and decreases.</sub></td>
    <td width="50%"><img src="docs/screenshots/map.png" alt="District map"><br><sub><b>District map</b> — all 150 districts shaded by spending, payroll, operations, travel, headcount or change, with a zoomed NYC panel and party filter. Hover for details, click through to the member.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/compare.png" alt="Compare view"><br><sub><b>Compare</b> — up to four members or offices side by side: totals, rank, distance from the median, spending mix, monthly spending on a shared scale.</sub></td>
    <td width="50%"><img src="docs/screenshots/member.png" alt="Member page"><br><sub><b>Member pages</b> — rank now and last period, every staff payroll line with title and pay status, vendors, purposes, monthly spending and travel.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/records.png" alt="Record search"><br><sub><b>All records</b> — full-text search across every line with exact phrases, filters for office, type, month, pay status and amount, and CSV export of exactly what you filtered.</sub></td>
    <td width="50%"><img src="docs/screenshots/map-dark.png" alt="Dark mode"><br><sub><b>Light and dark</b> — follows your system theme; works on phones too.</sub></td>
  </tr>
</table>

## Features

- 🔎 **Search everything** — 28,349 lines across both reports; quoted phrases, highlighted matches.
- 🗓️ **Switch report periods** — every view follows; member pages and comparisons carry across by name.
- 📈 **Change over time** — period-over-period change on totals, members, map and comparisons.
- 🗺️ **District map** — 2024 Assembly district lines, NYC inset, keyboard and touch friendly.
- 📍 **District profiles** — pick any of the 150 districts (menu, map click, or ← → keys): zoomed map with neighbors, percentile gauges against all members, spending mix, neighbor comparison, period trend and monthly spending.
- ⚖️ **Side-by-side comparison** — up to four members or offices.
- 🔗 **Shareable links** — every search, filter and view lives in the URL.
- ⬇️ **CSV export** — of member tables and filtered records.
- 🪶 **No build step, no dependencies** — plain HTML, CSS and JavaScript; Python only to prepare data.

## Data sources

| Source | Used for |
|---|---|
| [NYS Assembly Expenditure Reports](https://assembly.ny.gov/expenditure/) | Every spending line (`data/raw/`, unmodified) |
| [NYS ITS Geospatial Services — NYS Assembly Districts](https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Assembly_Districts/MapServer) | District boundaries (2024 lines), member names and party |

| Period | Source file | Lines | Actual spending | Allocated |
|---|---|---:|---:|---:|
| Oct 1, 2025 – Mar 31, 2026 | `cad00251-20260331.csv` | 13,607 | $75,494,885.73 | $5,569,722.57 |
| Apr 1, 2025 – Sep 30, 2025 | `674cb5b2-20250930.csv` | 14,742 | $71,242,039.20 | $2,664,899.24 |

### How the data is treated

- **Nothing is added or removed.** Every line in each report appears on the site; totals are reproducible from the raw CSVs.
- **Allocated costs are kept separate** from actual spending (see above).
- **Voucher dates** have no year in the source; the year comes from the report period.
- **Members vs. offices:** a unit is a member office if it has a "MEMBER OF ASSEMBLY" payroll line.
- **Period comparisons** match members and offices by name as printed in each report.
- **Districts** are matched to report names by last name (`scripts/build_districts.py`; two matches set by hand and documented there). The GIS layer lists current members, so members who left earlier have no district shading.
- **Names** are truncated to 40 characters in the source and shown as published.

## Run it locally

```bash
python3 scripts/build_data.py        # CSVs in data/raw/ -> data/periods/*.json
python3 scripts/build_districts.py   # match districts to member names
python3 -m http.server 8000          # open http://localhost:8000
```

Want a single file you can email or open from disk?

```bash
python3 scripts/build_standalone.py dist/assembly-expenditures.html
```

## Adding a new report

1. Download the CSV from [assembly.ny.gov/expenditure](https://assembly.ny.gov/expenditure/) into `data/raw/`, keeping the `-YYYYMMDD.csv` end-date suffix (`0331` or `0930`).
2. Run the two build scripts and commit. The new period shows up in the switcher, and GitHub Pages redeploys on push.

## Project layout

```
index.html                    Page shell
assets/app.js                 All interactivity (vanilla JS, hash routing, SVG map)
assets/styles.css             Styles, light and dark
data/raw/                     Original expenditure CSVs, unmodified
data/periods.json             Manifest of reporting periods (newest first)
data/periods/*.json           Compact, dictionary-encoded data per period
data/geo/                     District boundaries (NYS GIS), unmodified download
data/districts.json           Districts matched to report member names
scripts/build_data.py         CSV -> JSON with validation
scripts/build_districts.py    District/member matching
scripts/build_standalone.py   One-file HTML bundle
docs/                         README images and link-preview image
.github/workflows/pages.yml   Builds and deploys to GitHub Pages on push to main
```

## Publishing

The site deploys to GitHub Pages from `.github/workflows/pages.yml`. One-time setup: **Settings → Pages → Source: GitHub Actions**. For a nicer link preview on social media, upload `docs/social-preview.png` under **Settings → General → Social preview**.

---

<sub>Independent presentation of public records. Not affiliated with or endorsed by the New York State Assembly.</sub>
