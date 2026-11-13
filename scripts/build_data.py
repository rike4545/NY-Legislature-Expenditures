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

    data/raw/senate/nysenate_member_travel_YYYYMMDD.csv   Senate per-trip member travel detail

Outputs:
    data/chambers.json                 list of chambers and their periods
    data/<chamber>/periods/<end>.json  one compact, dictionary-encoded file per report
    data/senate/travel/<end>.json      Senate trips, each tied to its office (see build_senate_travel)

Both chambers are normalised to the same row layout:
    [unit, type, date, voucher, payee, serviceDates, desc, status, amount]
Each period file also carries "salaries": one row per person per office with their
regular pay annualized (see annualize_people()).
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


# New York State pays biweekly: 26 pay periods = 364 days. A member's $70,999.98 for
# 09/25/25-03/25/26 (182 days) annualizes to exactly $142,000, the legislative base salary.
PAY_PERIOD_DAYS = 14
YEAR_DAYS = 26 * PAY_PERIOD_DAYS
ONE_TIME = re.compile(r"LUMP SUM|DEFERRAL|STIPEND|ALLOWANCE|PAYMENT FOR SERVICES RENDERED|RETRO", re.I)


def service_range(svc: str):
    s = svc.strip()
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2})-(\d{1,2})/(\d{1,2})/(\d{2})", s)  # Assembly 09/11/25-03/11/26
    if m:
        a = list(map(int, m.groups()))
        return date(2000 + a[2], a[0], a[1]), date(2000 + a[5], a[3], a[4])
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2}) – (\d{4}-\d{2}-\d{2})", s)  # Senate 2025-09-11 – 2026-03-11
    if m:
        return date.fromisoformat(m.group(1)), date.fromisoformat(m.group(2))
    return None  # a single date: a one-time payment, or a line without a start date


def annualize_people(rows, types_cfg):
    """One row per person per office: regular pay scaled to a full year of biweekly pay.

    A person's regular payroll lines in an office (those with a service-date range) are added
    up and divided by the number of days those ranges cover, then scaled to 364 days. Pooling
    matters: some offices split one person's pay into date segments whose amounts don't follow
    the segment lengths, so a line-by-line rate would be wrong. Lump sums, deferral payments,
    stipends, allowances and back pay are one-time amounts and are left out; so are people
    covered for less than one pay period. Output rows:
      [unit, payee, titles, first day, last day, days covered, regular pay, annualized, status]
    """
    people = {}
    for r in rows:
        if types_cfg[r["type"]][1] != "ps" or ONE_TIME.search(r["desc"]):
            continue
        rng = service_range(r["svc"])
        if not rng:
            continue
        p = people.setdefault((r["unit"], r["payee"]), {"days": set(), "paid": 0.0, "titles": [], "status": "", "last": rng[1]})
        d = rng[0]
        while d <= rng[1]:
            p["days"].add(d.toordinal())
            d = date.fromordinal(d.toordinal() + 1)
        p["paid"] += r["amount"]
        if r["desc"] not in p["titles"]:
            p["titles"].append(r["desc"])
        if rng[1] >= p["last"]:
            p["last"], p["status"] = rng[1], r["status"]
    out = []
    for (unit, payee), p in people.items():
        days = len(p["days"])
        if days < PAY_PERIOD_DAYS or p["paid"] <= 0:
            continue
        out.append([unit, payee, " → ".join(p["titles"]), date.fromordinal(min(p["days"])).isoformat(),
                    date.fromordinal(max(p["days"])).isoformat(), days, round(p["paid"], 2),
                    round(p["paid"] * YEAR_DAYS / days, 2), p["status"]])
    return out


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
    salaries = [[idx("units", u), idx("payees", pay), *rest] for u, pay, *rest in annualize_people(rows, cfg["types"])]

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
        "salaryFields": ["unit", "payee", "titles", "from", "to", "daysCovered", "regularPay", "annualized", "status"],
        "salaries": salaries,
        "rows": out_rows,
    }
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{chamber:8s} {start}..{end}: {len(out_rows):,} rows, {len(salaries)} people annualized, {len(members)} members, "
          f"actual ${actual:,.2f}, allocated ${by_group['allocated']:,.2f}")
    return meta


def words(s: str) -> set:
    return set(re.findall(r"[a-z]+", s.lower())) - {"senator", "sen", "jr", "sr", "ii", "iii"}


def build_senate_travel(src: pathlib.Path, period_file: pathlib.Path, dst: pathlib.Path) -> dict:
    """Tie each trip in the Senate member-travel file to an office in the expenditure report.

    Every trip is paid by one MEMBER TRAVEL voucher in the expenditure report, so a trip is
    matched on its check date and amount; the traveller's name only breaks ties. The match
    must be one-to-one and the totals must agree, or the build stops.
    """
    period = json.loads(period_file.read_text(encoding="utf-8"))
    U, T = period["units"], period["types"]
    vouchers = {}  # (date, amount) -> [unit index, ...] remaining to match
    for r in period["rows"]:
        if T[r[1]]["code"] == "MEMBER TRAVEL":
            vouchers.setdefault((r[2], round(r[8], 2)), []).append(r[0])
    with open(src, encoding="latin-1", newline="") as f:
        rows = list(csv.DictReader(f))
    fixed = ("Check Date", "Member Name", "Begin Travel", "End Travel", "Destination", "Purpose", "Total")
    cats = [k for k in rows[0] if k not in fixed]
    trips, unmatched = [], []
    for r in rows:
        total = round(float(r["Total"] or 0), 2)
        key = (clean(r["Check Date"]), total)
        cands = vouchers.get(key, [])
        if len(set(cands)) > 1:
            name = words(r["Member Name"])
            best = [u for u in cands if words(U[u]["name"]) & name]
            cands = best or cands
        if not cands:
            unmatched.append(f"{r['Member Name']} {key}")
            continue
        unit = cands[0]
        vouchers[key].remove(unit)
        trips.append([unit, clean(r["Check Date"]), clean(r["Begin Travel"]), clean(r["End Travel"]),
                      clean(r["Destination"]).title(), clean(r["Purpose"]),
                      [round(float(r[c] or 0), 2) for c in cats], total])
    if unmatched:
        raise SystemExit(f"{src.name}: {len(unmatched)} trips without a matching voucher: {unmatched[:5]}")
    trips_total = round(sum(t[-1] for t in trips), 2)
    report_total = round(sum(r[8] for r in period["rows"] if T[r[1]]["code"] == "MEMBER TRAVEL"), 2)
    if trips_total != report_total:
        raise SystemExit(f"{src.name}: trips total {trips_total} != report member travel {report_total}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps({"categories": [c.replace("_", " ") for c in cats], "trips": trips},
                              separators=(",", ":")), encoding="utf-8")
    print(f"senate   travel {src.name}: {len(trips)} trips matched, ${trips_total:,.2f} (= report member travel)")
    return {"file": f"data/senate/travel/{dst.name}", "trips": len(trips)}


def main() -> None:
    manifest = []
    for chamber, cfg in CHAMBERS.items():
        periods = []
        for src in sorted((ROOT / "data" / "raw" / chamber).glob(cfg["glob"])):
            end = period_from_filename(src.name)[1].isoformat()
            meta = build_one(chamber, cfg, src, ROOT / "data" / chamber / "periods" / f"{end}.json")
            extra = {}
            if chamber == "senate":
                tsrc = src.with_name(src.name.replace("nysenate_expenditures_", "nysenate_member_travel_"))
                if tsrc.exists():
                    extra["travel"] = build_senate_travel(
                        tsrc, ROOT / "data" / chamber / "periods" / f"{end}.json",
                        ROOT / "data" / chamber / "travel" / f"{end}.json")["file"]
            periods.append({
                **extra,
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
