#!/usr/bin/env python3
"""Convert NYS Assembly and NYS Senate expenditure CSVs into compact JSON for the site.

Usage:
    python3 scripts/build_data.py

Inputs (unmodified downloads):
    data/raw/assembly/*-YYYYMMDD.csv            NYS Assembly Expenditure Reports
    data/raw/senate/nysenate_expenditures_YYYYMMDD.csv   NYS Senate Expenditure Reports

The reporting period comes from the file name's YYYYMMDD end date:
    ...0331.csv -> October 1 (prior year) - March 31
    ...0930.csv -> April 1 - September 30

Outputs:
    data/chambers.json                 list of chambers and their periods
    data/<chamber>/periods/<end>.json  one compact, dictionary-encoded file per report

Both chambers are normalised to the same row layout:
    [unit, type, date, voucher, payee, serviceDates, desc, status, amount]
Each expense type carries a "group" (ps, mo, travel, allocated) so the site can
total payroll, operations and travel the same way for either chamber.
"""
import csv
import json
import pathlib
import re
import sys
from collections import Counter
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent.parent
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


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


# ---------------------------------------------------------------- Assembly

ASSEMBLY_TYPES = {
    "PERSSERV": ("Personal Service (payroll)", "ps"),
    "M & O": ("Maintenance & Operations", "mo"),
    "TRAVEL": ("Travel", "travel"),
    # Per the report's introduction, allocated operational expenditures are shares of
    # centrally paid costs and "do not reflect actual expenditures".
    "MAIL": ("Mail (allocated)", "allocated"),
    "TELEPHON": ("Telephone (allocated)", "allocated"),
    "SUPPLIES": ("Supplies (allocated)", "allocated"),
}
ASSEMBLY_STATUS = {
    "A": "Annual Full Time",
    "L": "Annual Legislative",
    "P": "Annual Part Time",
    "S": "Session",
    "T": "Temporary",
    "I": "Inactive (left unit before last payroll of period)",
}


def assembly_voucher_date(s, start, end):
    """'9-Oct' -> '2025-10-09'. The year comes from the report period."""
    s = clean(s)
    if not s:
        return ""
    m = re.fullmatch(r"(\d{1,2})-([A-Za-z]{3})", s)
    if not m:
        raise ValueError(f"Unrecognized voucher date: {s!r}")
    day, mon = int(m.group(1)), MONTHS[m.group(2).title()]
    year = start.year if mon >= start.month else end.year
    d = date(year, mon, day)
    if not (start <= d <= end):
        raise ValueError(f"Voucher date outside report period: {s!r}")
    return d.isoformat()


def read_assembly(path: pathlib.Path, start, end):
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    body = [r for r in rows[1:] if not clean(r[0]).startswith("___")]  # drop underline row
    members = {clean(r[0]) for r in body if clean(r[6]) == "MEMBER OF ASSEMBLY"}
    out = []
    for r in body:
        if len(r) != 9:
            raise ValueError(f"Expected 9 columns, got {len(r)}: {r}")
        unit, typ, dt, voucher, payee, svc, desc, status, amount = (clean(x) for x in r)
        if typ not in ASSEMBLY_TYPES:
            raise ValueError(f"Unknown Assembly expense type {typ!r}")
        out.append(dict(unit=unit, type=typ, date=assembly_voucher_date(dt, start, end), voucher=voucher,
                        payee=payee, svc=svc, desc=desc, status=status, amount=float(amount)))
    return out, members


# ---------------------------------------------------------------- Senate

SENATE_TYPES = {
    "PERSONAL SERVICE": ("Personal Service (payroll)", "ps"),
    "MAINTENANCE & OPERATIONS": ("Maintenance & Operations", "mo"),
    "MEMBER TRAVEL": ("Member travel", "travel"),
    "STAFF TRAVEL": ("Staff travel", "travel"),
    # The report's note: these costs are "allocated back to each office after-the-fact" and
    # "are for informational purposes only"; the vouchers appear under the central offices.
    "ALLOCATED OPERATIONAL EXPENSES": ("Allocated operational expenses (postage & supplies)", "allocated"),
}
# The Senate report lists pay types without defining them, so they're shown as published.
SENATE_STATUS = {c: "Pay type as published (not defined in the report)" for c in ("RA", "SA", "TE", "VA")}


def read_senate(path: pathlib.Path, start, end):
    with open(path, encoding="latin-1", newline="") as f:
        lines = [ln for ln in f if not ln.startswith('"#')]  # drop the note lines at the top
    rows = list(csv.DictReader(lines))
    out, members = [], set()
    for r in rows:
        unit = clean(r["OFFICE"])
        typ = clean(r["EXPENSE_TYPE"])
        if typ not in SENATE_TYPES:
            raise ValueError(f"Unknown Senate expense type {typ!r}")
        b, e = clean(r["REPORT_PERIOD_BEGIN_DATE"]), clean(r["REPORT_PERIOD_END_DATE"])
        if (b, e) != (start.isoformat(), end.isoformat()):
            raise ValueError(f"{path.name}: row period {b}..{e} doesn't match file name")
        desc = clean(r["TITLE/DESCRIPTION"])
        voucher = ""
        m = re.search(r"\s*-?\s*VOUCHER#\s*(\S+)\s*$", desc)
        if m:
            voucher, desc = m.group(1), desc[:m.start()].strip()
        note = clean(r["NOTE"])
        if note and note.upper() != "SEE NOTE ABOVE":
            desc = f"{desc} ({note.lower()})"
        paytype = clean(r["PAYTYPE"])
        is_ps = SENATE_TYPES[typ][1] == "ps"
        svc_begin, svc_end = clean(r["PERS_SERV_BEGIN_DATE"]), clean(r["PERS_SERV_END/CHECK_DATE"])
        if is_ps:
            svc = f"{svc_begin} – {svc_end}" if svc_begin else svc_end
            dt = ""  # payroll has service dates, not a voucher date (same as the Assembly)
        else:
            svc, dt = "", svc_end
            if dt and not (start.isoformat() <= dt <= end.isoformat()):
                raise ValueError(f"{path.name}: check date {dt} outside period")
        if is_ps and desc == "MEMBER":
            members.add(unit)  # same rule as the Assembly: the office pays a member's salary
        out.append(dict(unit=unit, type=typ, date=dt, voucher=voucher, payee=clean(r["PAYEE"]), svc=svc,
                        desc=desc, status=paytype if is_ps else "", amount=float(r["AMOUNT"] or 0)))
    return out, members


CHAMBERS = {
    "assembly": dict(
        name="Assembly", title="New York State Assembly", abbr="AD", glob="*.csv", read=read_assembly,
        types=ASSEMBLY_TYPES, status=ASSEMBLY_STATUS,
        sourceUrl="https://assembly.ny.gov/expenditure/",
        memberRule='a unit containing a "MEMBER OF ASSEMBLY" payroll line'),
    "senate": dict(
        name="Senate", title="New York State Senate", abbr="SD", glob="nysenate_expenditures_*.csv", read=read_senate,
        types=SENATE_TYPES, status=SENATE_STATUS,
        sourceUrl="https://www.nysenate.gov/open-data",
        memberRule='an office with a payroll line titled "MEMBER"'),
}


def build_one(chamber: str, cfg: dict, src: pathlib.Path, dst: pathlib.Path) -> dict:
    start, end = period_from_filename(src.name)
    rows, members = cfg["read"](src, start, end)

    tables = {"units": {}, "types": {}, "payees": {}, "descs": {}}

    def idx(table: str, value: str) -> int:
        t = tables[table]
        if value not in t:
            t[value] = len(t)
        return t[value]

    out_rows = [[idx("units", r["unit"]), idx("types", r["type"]), r["date"], r["voucher"], idx("payees", r["payee"]),
                 r["svc"], idx("descs", r["desc"]), r["status"], round(r["amount"], 2)] for r in rows]

    units = [{"name": u, "kind": "member" if u in members else "office"} for u in tables["units"]]
    types = [{"code": t, "label": cfg["types"][t][0], "group": cfg["types"][t][1],
              "allocated": cfg["types"][t][1] == "allocated"} for t in tables["types"]]
    by_group = Counter()
    for r in out_rows:
        by_group[types[r[1]]["group"]] += r[8]
    actual = by_group["ps"] + by_group["mo"] + by_group["travel"]

    meta = {
        "chamber": chamber,
        "title": f"{cfg['title']} Expenditure Report",
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "sourceFile": src.name,
        "sourceUrl": cfg["sourceUrl"],
        "rowCount": len(out_rows),
        "members": len(members),
        "offices": len(units) - len(members),
        "totalActual": round(actual, 2),
        "totalAllocated": round(by_group["allocated"], 2),
        "byGroup": {k: round(v, 2) for k, v in by_group.items()},
        "statusLabels": cfg["status"],
        "typeCounts": dict(Counter(types[r[1]]["code"] for r in out_rows)),
    }
    payload = {
        "meta": meta, "units": units, "types": types,
        "payees": list(tables["payees"]), "descs": list(tables["descs"]),
        "fields": ["unit", "type", "date", "voucher", "payee", "serviceDates", "desc", "status", "amount"],
        "rows": out_rows,
    }
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{chamber:8s} {start}..{end}: {len(out_rows):,} rows, {len(members)} members, "
          f"actual ${actual:,.2f}, allocated ${by_group['allocated']:,.2f}")
    return meta


def main() -> None:
    manifest = []
    for chamber, cfg in CHAMBERS.items():
        periods = []
        for src in sorted((ROOT / "data" / "raw" / chamber).glob(cfg["glob"])):
            end = period_from_filename(src.name)[1].isoformat()
            meta = build_one(chamber, cfg, src, ROOT / "data" / chamber / "periods" / f"{end}.json")
            periods.append({
                "id": end, "file": f"data/{chamber}/periods/{end}.json",
                "start": meta["period"]["start"], "end": end, "sourceFile": meta["sourceFile"],
                "rowCount": meta["rowCount"], "totalActual": meta["totalActual"],
                "totalAllocated": meta["totalAllocated"],
            })
        periods.sort(key=lambda m: m["end"], reverse=True)  # newest first
        manifest.append({
            "id": chamber, "name": cfg["name"], "title": cfg["title"], "abbr": cfg["abbr"],
            "sourceUrl": cfg["sourceUrl"], "memberRule": cfg["memberRule"],
            "districts": f"data/{chamber}/districts.json", "periods": periods,
        })
    (ROOT / "data" / "chambers.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote data/chambers.json ({', '.join(c['name'] for c in manifest)})")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(__doc__)
    main()
