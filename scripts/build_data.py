#!/usr/bin/env python3
"""Convert the NYS Assembly expenditure CSV into a compact JSON file for the site.

Usage:
    python3 scripts/build_data.py data/raw/cad00251-20260331.csv data/expenditures.json

The source CSV is the fixed-width-style export of the NYS Assembly Expenditure
Report (October 1, 2025 - March 31, 2026). Columns:
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

PERIOD_START = date(2025, 10, 1)
PERIOD_END = date(2026, 3, 31)

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


def parse_voucher_date(s: str) -> str:
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


def main(src: str, dst: str) -> None:
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
            parse_voucher_date(dt),
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
        "sourceFile": src.split("/")[-1],
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


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
