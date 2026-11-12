#!/usr/bin/env python3
"""Convert the NYS Assembly expenditure CSV into a compact JSON file for the site.

Usage:
    python3 scripts/build_data.py            # builds every CSV in data/raw/

Each source CSV is the export of one semi-annual NYS Assembly Expenditure Report.
The reporting period is read from the file name's YYYYMMDD end date:
    *-YYYY0331.csv -> October 1 (prior year) - March 31
    *-YYYY0930.csv -> April 1 - September 30
Outputs data/periods/<end-date>.json per report plus data/periods.json (manifest).

Columns:
    UNIT, EXP TYPE, DATE, VOUCHER, PAYEE, SERVICE DATES, DESCRIPTION, P, ($)AMOUNT

Output is dictionary-encoded to keep the file small:
    units/types/payees/descs are lookup tables; each row stores indexes into them.
"""
import csv
import json
import re
import sys
from collections import Counter
from datetime import date

import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def period_from_filename(name: str):
    m = re.search(r"(\d{4})(\d{2})(\d{2})\.csv$", name)
    if not m:
        raise ValueError(f"Can't read period end date from file name: {name}")
    y, mo, d = map(int, m.groups())
    if (mo, d) == (3, 31):
        return date(y - 1, 10, 1), date(y, 3, 31)
    if (mo, d) == (9, 30):
        return date(y, 4, 1), date(y, 9, 30)
    raise ValueError(f"Unexpected period end {y}-{mo:02d}-{d:02d} in {name}")

MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}

TYPE_LABELS = {
    "PERSSERV": "Personal Service (payroll)",
    "M & O": "Maintenance & Operations",
    "TRAVEL": "Travel",
    "MAIL": "Mail (allocated)",
    "TELEPHON": "Telephone (allocated)",
    "SUPPLIES": "Supplies (allocated)",
}
# Per the report's introduction, allocated operational expenditures are shares of
# centrally paid costs and "do not reflect actual expenditures".
ALLOCATED = {"MAIL", "TELEPHON", "SUPPLIES"}

STATUS_LABELS = {
    "A": "Annual Full Time",
    "L": "Annual Legislative",
    "P": "Annual Part Time",
    "S": "Session",
    "T": "Temporary",
    "I": "Inactive (left unit before last payroll of period)",
}


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def parse_voucher_date(s: str, PERIOD_START: date, PERIOD_END: date) -> str:
    """'9-Oct' -> '2025-10-09'. Oct-Dec belong to 2025, Jan-Mar to 2026."""
    s = clean(s)
    if not s:
        return ""
    m = re.fullmatch(r"(\d{1,2})-([A-Za-z]{3})", s)
    if not m:
        raise ValueError(f"Unrecognized voucher date: {s!r}")
    day, mon = int(m.group(1)), MONTHS[m.group(2).title()]
    year = PERIOD_START.year if mon >= PERIOD_START.month else PERIOD_END.year
    d = date(year, mon, day)
    if not (PERIOD_START <= d <= PERIOD_END):
        raise ValueError(f"Voucher date outside report period: {s!r}")
    return d.isoformat()


def build_one(src: pathlib.Path, dst: pathlib.Path) -> dict:
    PERIOD_START, PERIOD_END = period_from_filename(src.name)
    with open(src, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    body = [r for r in body if not clean(r[0]).startswith("___")]  # drop underline row

    members = {clean(r[0]) for r in body if clean(r[6]) == "MEMBER OF ASSEMBLY"}

    tables = {"units": {}, "types": {}, "payees": {}, "descs": {}}

    def idx(table: str, value: str) -> int:
        t = tables[table]
        if value not in t:
            t[value] = len(t)
        return t[value]

    out_rows = []
    for r in body:
        if len(r) != 9:
            raise ValueError(f"Expected 9 columns, got {len(r)}: {r}")
        unit, typ, dt, voucher, payee, svc, desc, status, amount = (clean(x) for x in r)
        out_rows.append([
            idx("units", unit),
            idx("types", typ),
            parse_voucher_date(dt, PERIOD_START, PERIOD_END),
            voucher,
            idx("payees", payee),
            svc,
            idx("descs", desc),
            status,
            round(float(amount), 2),
        ])

    units = [{"name": u, "kind": "member" if u in members else "office"} for u in tables["units"]]
    types = [{"code": t, "label": TYPE_LABELS.get(t, t), "allocated": t in ALLOCATED}
             for t in tables["types"]]

    actual = sum(r[8] for r in out_rows if types[r[1]]["code"] not in ALLOCATED)
    allocated = sum(r[8] for r in out_rows if types[r[1]]["code"] in ALLOCATED)

    meta = {
        "title": "New York State Assembly Expenditure Report",
        "period": {"start": PERIOD_START.isoformat(), "end": PERIOD_END.isoformat()},
        "sourceFile": src.name,
        "sourceUrl": "https://assembly.ny.gov/expenditure/",
        "columns": [clean(h) for h in header],
        "rowCount": len(out_rows),
        "members": len(members),
        "offices": len(units) - len(members),
        "totalActual": round(actual, 2),
        "totalAllocated": round(allocated, 2),
        "statusLabels": STATUS_LABELS,
        "typeCounts": dict(Counter(types[r[1]]["code"] for r in out_rows)),
    }

    payload = {
        "meta": meta,
        "units": units,
        "types": types,
        "payees": list(tables["payees"]),
        "descs": list(tables["descs"]),
        "fields": ["unit", "type", "date", "voucher", "payee", "serviceDates", "desc", "status", "amount"],
        "rows": out_rows,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
    print(f"Wrote {dst}: {len(out_rows):,} rows, {len(members)} members, "
          f"actual ${actual:,.2f}, allocated ${allocated:,.2f}")
    return meta


def main() -> None:
    raw = ROOT / "data" / "raw"
    out = ROOT / "data" / "periods"
    out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for src in sorted(raw.glob("*.csv")):
        meta = build_one(src, out / f"{period_from_filename(src.name)[1].isoformat()}.json")
        manifest.append({
            "id": meta["period"]["end"],
            "file": f"data/periods/{meta['period']['end']}.json",
            "start": meta["period"]["start"],
            "end": meta["period"]["end"],
            "sourceFile": meta["sourceFile"],
            "rowCount": meta["rowCount"],
            "totalActual": meta["totalActual"],
            "totalAllocated": meta["totalAllocated"],
        })
    manifest.sort(key=lambda m: m["end"], reverse=True)  # newest first
    with open(ROOT / "data" / "periods.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"Wrote data/periods.json ({len(manifest)} periods)")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(__doc__)
    main()
