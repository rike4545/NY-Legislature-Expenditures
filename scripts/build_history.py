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


def main():
    for chamber, cfg in bd.CHAMBERS.items():
        periods, units = [], {}
        for i, f in enumerate(files(chamber)):
            start, end = bd.period_from_filename(f.name)
            rows, members = (read_assembly_lenient if chamber == "assembly" else cfg["read"])(f, start, end)
            tot = {"ps": 0.0, "mo": 0.0, "travel": 0.0, "allocated": 0.0}
            per = {}
            for r in rows:
                g = cfg["types"][r["type"]][1]
                tot[g] += r["amount"]
                u = per.setdefault(r["unit"], {"ps": 0.0, "mo": 0.0, "travel": 0.0, "allocated": 0.0, "staff": set()})
                u[g] += r["amount"]
                if g == "ps" and r["amount"] > 0:
                    u["staff"].add(r["payee"])
            periods.append({"id": end.isoformat(), "start": start.isoformat(), "end": end.isoformat(),
                            "actual": round(tot["ps"] + tot["mo"] + tot["travel"], 2), **{k: round(v, 2) for k, v in tot.items()},
                            "members": len(members), "rows": len(rows)})
            for name, u in per.items():
                e = units.setdefault(name, {"kind": "office", "s": []})
                if name in members:
                    e["kind"] = "member"
                e["s"].append([i, round(u["ps"] + u["mo"] + u["travel"], 2), round(u["ps"], 2), round(u["mo"], 2), round(u["travel"], 2), len(u["staff"])])
            print(f"{chamber} {start}..{end}: ${periods[-1]['actual']:,.0f} actual, {len(members)} members, {len(rows):,} lines")
        out = ROOT / f"data/{chamber}/history.json"
        out.write_text(json.dumps({"chamber": chamber, "fields": ["period", "actual", "ps", "mo", "travel", "staff"],
                                   "periods": periods, "units": units}, separators=(",", ":")))
        print(chamber, len(periods), "periods,", len(units), "offices ->", out.relative_to(ROOT), f"{out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
