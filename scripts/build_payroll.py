#!/usr/bin/env python3
"""Senate biweekly payroll history: every published payroll report, as each person's pay segments.

Usage:
    python3 scripts/build_payroll.py

Input:
    data/raw/senate/payroll/senate_payroll_reports.csv.gz
        Every "Payroll Report - End Date ..." CSV from nysenate.gov/open-data, stacked, with a
        SOURCE_FILE and REPORT_TITLE column in front of the Senate's own 11 columns:
        EMPLOYEE_NAME, OFFICE, CITY, EMPLOYEE_TITLE, BIWEEKLY/HOURLY_RATE, PAYROLL_TYPE, PAY_PERIOD,
        PAY_PERIOD_BEGIN_DATE, PAY_PERIOD_END_DATE, CHECK_DATE, LEGISLATIVE_ENTITY
Output:
    data/senate/payroll.json
        {source, reports: [[periodEnd, checkDate, people]], offices: [...], titles: [...],
         people: {name: [[office, title, rate, type, firstReport, lastReport, reportsPaid], ...]},
         years: {year: {reports, salary, ra, sa, people, ra_people, sa_people, te_people, te_lines, te_median_rate}},
         officeYears: {office index: {year: [salary, people]}},
         reportTotals: per report [ra, sa, raPeople, saPeople, tePeople, joined, left] (joined/left vs the previous report),
         officeReports: {office index: [[report, salary, salaried, hourly]]} for the last three years of reports}
        Years go by check date. salary = the sum of the biweekly rates of RA and SA lines on that year's
        reports, i.e. salaried payroll at listed rates; TE (hourly) lines have a rate but no hours, so
        they are counted, not summed.
        A segment is a run of reports with the same office, title, rate and pay type; a gap in
        the reports a person appears in is kept inside the segment and counted by reportsPaid.
        rate is the biweekly rate for RA/SA and the hourly rate for TE, as published.
"""
import csv
import gzip
import io
import json
import pathlib
import re
from datetime import date, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "data/raw/senate/payroll/senate_payroll_reports.csv.gz"
OUT = ROOT / "data/senate/payroll.json"


def parse_day(s: str):
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%y", "%m/%d/%Y", "%d-%b-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").replace("`", "'")).strip()


def main() -> None:
    rows = list(csv.DictReader(io.TextIOWrapper(gzip.open(SRC), encoding="utf-8", newline="")))
    reports = {}
    for r in rows:
        end = parse_day(r["PAY_PERIOD_END_DATE"])
        if not end or not clean(r["EMPLOYEE_NAME"]):
            continue
        r["_end"] = end
        rep = reports.setdefault(end, {"check": parse_day(r["CHECK_DATE"]), "people": set(), "file": r["SOURCE_FILE"]})
        rep["people"].add(clean(r["EMPLOYEE_NAME"]))
    order = sorted(reports)
    ri = {d: i for i, d in enumerate(order)}

    offices, titles = {}, {}
    def idx(t, v):
        return t.setdefault(v, len(t))

    lines = {}  # name -> {report index: (office, title, rate, type)}
    for r in rows:
        if "_end" not in r:
            continue
        name = clean(r["EMPLOYEE_NAME"])
        try:
            rate = round(float(r["BIWEEKLY/HOURLY_RATE"]), 2)
        except ValueError:
            continue
        key = (idx(offices, clean(r["OFFICE"])), idx(titles, clean(r["EMPLOYEE_TITLE"])), rate, clean(r["PAYROLL_TYPE"]))
        lines.setdefault(name, {})[ri[r["_end"]]] = key  # one line per person per report; a repeat keeps the last

    people = {}
    for name, by_rep in lines.items():
        segs = []
        for i in sorted(by_rep):
            k = by_rep[i]
            if segs and tuple(segs[-1][:4]) == k:
                segs[-1][5] = i
                segs[-1][6] += 1
            else:
                segs.append([*k, i, i, 1])
        people[name] = segs

    import statistics
    years, office_years = {}, {}
    for r in rows:
        if "_end" not in r:
            continue
        chk = reports[r["_end"]]["check"] or r["_end"]
        y = str(chk.year)
        Y = years.setdefault(y, {"reports": set(), "salary": 0.0, "ra": 0.0, "sa": 0.0, "people": set(), "ra_people": set(),
                                 "sa_people": set(), "te_people": set(), "te_lines": 0, "te_rates": []})
        Y["reports"].add(r["_end"])
        name = clean(r["EMPLOYEE_NAME"]); t = clean(r["PAYROLL_TYPE"])
        try:
            rate = float(r["BIWEEKLY/HOURLY_RATE"])
        except ValueError:
            continue
        Y["people"].add(name)
        oi = offices[clean(r["OFFICE"])]
        if t in ("RA", "SA"):
            Y["salary"] += rate; Y[t.lower()] += rate; Y[t.lower() + "_people"].add(name)
            o = office_years.setdefault(oi, {}).setdefault(y, [0.0, set()])
            o[0] += rate; o[1].add(name)
        elif t == "TE":
            Y["te_lines"] += 1; Y["te_people"].add(name); Y["te_rates"].append(rate)
    years_out = {y: {"reports": len(Y["reports"]), "salary": round(Y["salary"], 2), "ra": round(Y["ra"], 2), "sa": round(Y["sa"], 2),
                     "people": len(Y["people"]), "ra_people": len(Y["ra_people"]), "sa_people": len(Y["sa_people"]),
                     "te_people": len(Y["te_people"]), "te_lines": Y["te_lines"],
                     "te_median_rate": round(statistics.median(Y["te_rates"]), 2) if Y["te_rates"] else None}
                 for y, Y in sorted(years.items())}
    office_out = {str(oi): {y: [round(v[0], 2), len(v[1])] for y, v in ys.items()} for oi, ys in office_years.items()}

    # Report by report: salaried payroll at listed rates, headcounts, and who joined or left since the
    # previous report; and the same per office for the last RECENT reports.
    RECENT = 78  # three years of biweekly reports
    per_rep = [[0.0, 0.0, 0, 0, 0, set()] for _ in order]
    office_rep = {}
    for name, by_rep in lines.items():
        for i, (oi, _ti, rate, t) in by_rep.items():
            R = per_rep[i]
            R[5].add(name)
            if t in ("RA", "SA"):
                R[0 if t == "RA" else 1] += rate
                R[2 if t == "RA" else 3] += 1
            elif t == "TE":
                R[4] += 1
            if i >= len(order) - RECENT:
                o = office_rep.setdefault(oi, {}).setdefault(i, [0.0, 0, 0])
                if t in ("RA", "SA"):
                    o[0] += rate; o[1] += 1
                elif t == "TE":
                    o[2] += 1
    report_totals = []
    for i, R in enumerate(per_rep):
        prev = per_rep[i - 1][5] if i else set()
        joined = len(R[5] - prev) if i else 0
        left = len(prev - R[5]) if i else 0
        report_totals.append([round(R[0], 2), round(R[1], 2), R[2], R[3], R[4], joined, left])
    office_reports = {str(oi): [[i, round(v[0], 2), v[1], v[2]] for i, v in sorted(d.items())] for oi, d in office_rep.items()}

    OUT.write_text(json.dumps({
        "source": "NY Senate biweekly payroll reports, nysenate.gov/open-data",
        "reports": [[d.isoformat(), reports[d]["check"].isoformat() if reports[d]["check"] else "", len(reports[d]["people"])] for d in order],
        "offices": list(offices), "titles": list(titles), "people": people,
        "years": years_out, "officeYears": office_out,
        "reportFields": ["ra", "sa", "raPeople", "saPeople", "tePeople", "joined", "left"], "reportTotals": report_totals,
        "officeReportFields": ["report", "salary", "salaried", "hourly"], "officeReports": office_reports,
    }, ensure_ascii=False, separators=(",", ":")))
    nseg = sum(len(v) for v in people.values())
    print(f"senate payroll: {len(order)} reports {order[0]} .. {order[-1]}, {len(rows):,} lines, "
          f"{len(people):,} people, {nseg:,} pay segments, {OUT.stat().st_size / 1e6:.1f} MB")
    for y, v in years_out.items():
        print(f"  {y}: {v['reports']:>2} reports  salaried ${v['salary']:>14,.2f}  people {v['people']:>5}  hourly {v['te_people']:>4} (median ${v['te_median_rate']}/hr)")


if __name__ == "__main__":
    main()
