# NYS Assembly Expenditures Explorer

An interactive, searchable presentation of the **New York State Assembly Expenditure Report for October 1, 2025 – March 31, 2026** (source file `cad00251-20260331.csv`, 13,607 line items).

## What it does

| Section | What you get |
|---|---|
| **Overview** | Actual vs. allocated totals, spending by expense type, vouchered spending by month, highest-spending member offices (with the median), largest central offices, top vendors, and what M&O money bought. |
| **Members & Offices** | All 152 member offices and 68 central offices/committees with payroll, M&O, travel, allocated, and headcount. Filter by name, sort any column, export CSV. |
| **Member / office detail** | Rank among members and distance from the median, full payroll list with titles and pay status, M&O payees and purposes, travel reimbursements, allocated costs. |
| **All Records** | Full-text search across every line (quoted phrases supported), filters for member/office, expense type, month, pay status and amount range, sortable columns, and CSV export of exactly what's filtered. |
| **Payees** | Every vendor and person paid, totaled across the whole Assembly, with how many offices paid them. |
| **About the Data** | Glossary of expense types and pay status codes, and every assumption made while preparing the data. |

Every view's state lives in the URL, so any search or filter can be bookmarked or shared.

## Important caveats

- **Allocated costs (MAIL, TELEPHON, SUPPLIES) are not actual spending.** The Assembly's report describes them as each office's share of centrally paid costs, shown for informational purposes only. The site keeps them out of "actual" totals.
- Voucher dates in the source have no year; Oct–Dec are read as 2025 and Jan–Mar as 2026.
- Unit and payee names are truncated to 40 characters in the source and are shown as published.
- A unit is classified as a member office when it contains a "MEMBER OF ASSEMBLY" payroll line.

## Totals (from the raw CSV)

| Expense type | Amount |
|---|---:|
| Personal Service (payroll) | $58,058,764.79 |
| Maintenance & Operations | $16,277,160.36 |
| Travel | $1,158,960.58 |
| **Actual spending** | **$75,494,885.73** |
| Mail / Supplies / Telephone (allocated, informational) | $5,569,722.57 |

## Run it locally

No build tools or dependencies — just Python 3 for the data step and any static server.

```bash
# 1. Regenerate the site data from the raw CSV (only needed if the CSV changes)
python3 scripts/build_data.py data/raw/cad00251-20260331.csv data/expenditures.json

# 2. Serve the site
python3 -m http.server 8000
# open http://localhost:8000
```

To produce a single self-contained HTML file that opens straight from disk:

```bash
python3 scripts/build_standalone.py dist/assembly-expenditures.html
```

## Adding a new reporting period

1. Download the new CSV from [assembly.ny.gov/expenditure](https://assembly.ny.gov/expenditure/) into `data/raw/`.
2. Update `PERIOD_START` / `PERIOD_END` in `scripts/build_data.py`.
3. Re-run step 1 above (and update the file name in `.github/workflows/pages.yml`).

## Project layout

```
index.html                 Page shell
assets/app.js              All interactivity (vanilla JS, hash routing)
assets/styles.css          Styles, light/dark
data/raw/                  Original CSV, unmodified
data/expenditures.json     Compact, dictionary-encoded data the site loads
scripts/build_data.py      CSV -> JSON with validation
scripts/build_standalone.py  One-file HTML bundle
.github/workflows/pages.yml  Deploys to GitHub Pages on push to main
```

## Source

New York State Assembly, [Expenditure Reports](https://assembly.ny.gov/expenditure/). This is an independent presentation of public records and is not affiliated with or endorsed by the New York State Assembly.
