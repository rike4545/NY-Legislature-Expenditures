# NYS Assembly Expenditures Explorer

An interactive, searchable presentation of the **New York State Assembly's semi-annual Expenditure Reports**, with a period switcher and period-over-period comparisons.

| Period | Source file | Lines |
|---|---|---:|
| Oct 1, 2025 – Mar 31, 2026 | `cad00251-20260331.csv` | 13,607 |
| Apr 1, 2025 – Sep 30, 2025 | `674cb5b2-20250930.csv` | 14,742 |

## What it does

| Section | What you get |
|---|---|
| **Period switcher** | Pick any report in the header; every view, filter and member page follows it. Member pages carry across periods by name. |
| **Overview** | Actual vs. allocated totals with change from the prior period, biggest member-office increases and decreases, spending by expense type, vouchered spending by month, highest-spending member offices (with the median), largest central offices, top vendors, and what M&O money bought. |
| **Members & Offices** | All 152 member offices and 68 central offices/committees with district, payroll, M&O, travel, allocated, headcount, and % change vs. the prior period. Filter by party. Filter by name, sort any column, export CSV. |
| **Member / office detail** | Rank among members (now and prior period), change vs. prior period, distance from the median, full payroll list with titles and pay status, M&O payees and purposes, travel reimbursements, allocated costs. |
| **All Records** | Full-text search across every line (quoted phrases supported), filters for member/office, expense type, month, pay status and amount range, sortable columns, and CSV export of exactly what's filtered. |
| **District Map** | All 150 districts shaded by actual spending, payroll, M&O, travel, headcount, or change vs. prior period, with a zoomed NYC panel, party filter, hover details, and click-through to each member. |
| **Compare** | Up to 4 members or offices side by side: every total, rank, distance from the median, change vs. prior period, spending mix, monthly spending on a shared scale, and top M&O purposes. Stays put when you switch periods. |
| **Payees** | Every vendor and person paid, totaled across the whole Assembly, with how many offices paid them. |
| **About the Data** | Glossary of expense types and pay status codes, and every assumption made while preparing the data. |

Every view's state lives in the URL, so any search or filter can be bookmarked or shared.

## Important caveats

- **Allocated costs (MAIL, TELEPHON, SUPPLIES) are not actual spending.** The Assembly's report describes them as each office's share of centrally paid costs, shown for informational purposes only. The site keeps them out of "actual" totals.
- Voucher dates in the source have no year; the year comes from the report period.
- Period comparisons match members and offices by name as printed in each report.
- District boundaries, member names and party come from the NYS GIS Assembly Districts layer (2024 lines), matched to report names by `scripts/build_districts.py` (two matches set by hand; see the script). The layer lists current members, so members who left earlier have no district shading.
- Unit and payee names are truncated to 40 characters in the source and are shown as published.
- A unit is classified as a member office when it contains a "MEMBER OF ASSEMBLY" payroll line.

## Totals (from the raw CSVs)

| Period | Actual spending (payroll + M&O + travel) | Allocated (informational) |
|---|---:|---:|
| Oct 2025 – Mar 2026 | $75,494,885.73 | $5,569,722.57 |
| Apr 2025 – Sep 2025 | $71,242,039.20 | $2,664,899.24 |

## Run it locally

No build tools or dependencies — just Python 3 for the data step and any static server.

```bash
# 1. Regenerate the site data from every CSV in data/raw/, then match districts
python3 scripts/build_data.py
python3 scripts/build_districts.py

# 2. Serve the site
python3 -m http.server 8000
# open http://localhost:8000
```

To produce a single self-contained HTML file that opens straight from disk:

```bash
python3 scripts/build_standalone.py dist/assembly-expenditures.html
```

## Adding a new reporting period

1. Drop the new CSV from [assembly.ny.gov/expenditure](https://assembly.ny.gov/expenditure/) into `data/raw/`, keeping the `-YYYYMMDD.csv` end-date suffix (`0331` or `0930`).
2. Run `python3 scripts/build_data.py` and commit. The period appears in the switcher automatically; GitHub Pages rebuilds on push.

## Project layout

```
index.html                 Page shell
assets/app.js              All interactivity (vanilla JS, hash routing)
assets/styles.css          Styles, light/dark
data/raw/                  Original CSVs, unmodified
data/periods.json          Manifest of reporting periods (newest first)
data/periods/*.json        Compact, dictionary-encoded data per period
data/geo/                  District boundaries (NYS GIS, 2024 lines), unmodified download
data/districts.json        Districts matched to report member names
scripts/build_data.py      CSV -> JSON with validation
scripts/build_standalone.py  One-file HTML bundle
.github/workflows/pages.yml  Deploys to GitHub Pages on push to main
```

## Publishing

The repo is public and deploys to GitHub Pages from `.github/workflows/pages.yml`. One-time setup: **Settings → Pages → Source: GitHub Actions**. The site is then at `https://rike4545.github.io/NYS-Assembly-Expenditures/`.

## Source

New York State Assembly, [Expenditure Reports](https://assembly.ny.gov/expenditure/). District boundaries: [NYS ITS Geospatial Services, NYS Assembly Districts](https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Assembly_Districts/MapServer). This is an independent presentation of public records and is not affiliated with or endorsed by the New York State Assembly.
