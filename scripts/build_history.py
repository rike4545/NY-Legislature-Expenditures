"""Spending over the years: a compact summary of every expenditure report on file, per chamber and office.

Input:  Assembly: data/raw/assembly/history/YYYYMMDD.csv (older reports from nyassembly.gov/expenditure)
                  plus the current reports in data/raw/assembly/
        Senate:   data/raw/senate/nysenate_expenditures_YYYYMMDD.csv
Output: data/<chamber>/history.json
    {periods: [{id, start, end, actual, ps, mo, travel, allocated, members, rows}],
     units: {name: {kind, s: [[periodIndex, actual, ps, mo, travel, staff]]}}}

The full line-by-line data for the periods shown in the report-period selector stays in
data/<chamber>/periods/; this file only carries totals, so the site can draw trend lines
without loading every report.
"""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_data as bd  # noqa: E402


def read_assembly_lenient(path, start, end):
    """Older Assembly files carry a few blank rows; drop rows with every field empty, then parse as usual."""
    import csv, tempfile
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.reader(f) if any(x.strip() for x in r)]
    with tempfile.NamedTemporaryFile("w", suffix=path.name, delete=False, newline="", encoding="utf-8") as t:
        csv.writer(t).writerows(rows)
    try:
        return bd.read_assembly(pathlib.Path(t.name), start, end)
    finally:
        pathlib.Path(t.name).unlink()


def files(chamber):
    if chamber == "assembly":
        fs = list((ROOT / "data/raw/assembly/history").glob("*.csv")) + list((ROOT / "data/raw/assembly").glob("*.csv"))
    else:
        fs = list((ROOT / "data/raw/senate").glob("nysenate_expenditures_*.csv"))
    by_end = {}
    for f in fs:
        m = re.search(r"(\d{8})\.csv$", f.name)
        if m:
            by_end[m.group(1)] = f  # one file per period end
    return [by_end[k] for k in sorted(by_end)]


def parse_svc(svc: str):
    """Service dates on a pay line: '01/02/25-03/12/25' (Assembly), '2024-09-12 – 2025-03-12' or a
    single '2025-03-26' (Senate). Returns (first, last) dates, or None."""
    from datetime import date as _d
    found = []
    for m in re.finditer(r"(\d{4})-(\d{2})-(\d{2})|(\d{2})/(\d{2})/(\d{2,4})", svc or ""):
        try:
            if m.group(1):
                found.append(_d(int(m.group(1)), int(m.group(2)), int(m.group(3))))
            else:
                y = int(m.group(6))
                found.append(_d(y + 2000 if y < 100 else y, int(m.group(4)), int(m.group(5))))
        except ValueError:
            pass
    return (min(found), max(found)) if found else None


def months_open(spans, start, end, period_months):
    """Months of the period an office was open: from the earliest to the latest service date on its
    pay lines, clipped to the period, to the nearest half month (an office with no dated pay counts
    as open the whole period)."""
    if not spans:
        return period_months
    a = max(min(x[0] for x in spans), start)
    b = min(max(x[1] for x in spans), end)
    if b < a:
        return 0.5
    m = round(((b - a).days + 1) / 30.44 * 2) / 2
    return max(0.5, min(period_months, m))


def main():
    for chamber, cfg in bd.CHAMBERS.items():
        periods, units = [], {}
        for i, f in enumerate(files(chamber)):
            start, end = bd.period_from_filename(f.name)
            rows, members = (read_assembly_lenient if chamber == "assembly" else cfg["read"])(f, start, end)
            tot = {"ps": 0.0, "mo": 0.0, "travel": 0.0, "allocated": 0.0}
            per = {}
            period_months = round(((end - start).days + 1) / 30.44)
            for r in rows:
                g = cfg["types"][r["type"]][1]
                tot[g] += r["amount"]
                u = per.setdefault(r["unit"], {"ps": 0.0, "mo": 0.0, "travel": 0.0, "allocated": 0.0, "staff": set()})
                u[g] += r["amount"]
                if g == "ps" and r["amount"] > 0:
                    u["staff"].add(r["payee"])
                    sp = parse_svc(r.get("svc"))
                    if sp:
                        u.setdefault("spans", []).append(sp)
            periods.append({"id": end.isoformat(), "start": start.isoformat(), "end": end.isoformat(), "months": period_months,
                            "actual": round(tot["ps"] + tot["mo"] + tot["travel"], 2), **{k: round(v, 2) for k, v in tot.items()},
                            "members": len(members), "rows": len(rows)})
            for name, u in per.items():
                e = units.setdefault(name, {"kind": "office", "s": []})
                if name in members:
                    e["kind"] = "member"
                e["s"].append([i, round(u["ps"] + u["mo"] + u["travel"], 2), round(u["ps"], 2), round(u["mo"], 2), round(u["travel"], 2), len(u["staff"]),
                                months_open(u.get("spans"), start, end, period_months)])
            print(f"{chamber} {start}..{end}: ${periods[-1]['actual']:,.0f} actual, {len(members)} members, {len(rows):,} lines")
        out = ROOT / f"data/{chamber}/history.json"
        out.write_text(json.dumps({"chamber": chamber, "fields": ["period", "actual", "ps", "mo", "travel", "staff", "months"],
                                   "periods": periods, "units": units}, separators=(",", ":")))
        print(chamber, len(periods), "periods,", len(units), "offices ->", out.relative_to(ROOT), f"{out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
