"""Registered voters per district from the NYS Board of Elections enrollment reports.

Input:  data/raw/elections/boe_enrollment_{ad,sd}_YYYY-MM-DD.xlsx
        (elections.ny.gov "Enrollment by Assembly/Senate District"), plus
        data/elections/boe_2026_{assembly,senate}.json for votes cast.
Output: data/<chamber>/enrollment.json
"""
import glob, json, os, re
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARTIES = ["DEM", "REP", "CON", "WOR", "OTH", "BLANK"]
SRC = {
    "assembly": ("ad", "https://elections.ny.gov/enrollment-assembly-district"),
    "senate": ("sd", "https://elections.ny.gov/enrollment-senate-district"),
}


def read(path):
    ws = openpyxl.load_workbook(path, read_only=True).active
    header, out = None, {}
    for r in ws.iter_rows(values_only=True):
        if r and r[0] == "DISTRICT":
            header = list(r)
            continue
        if not header or not r or r[0] is None or str(r[1]).strip() != "District Total":
            continue
        row = dict(zip(header, r))
        d = str(int(row["DISTRICT"]))
        status = str(row["STATUS"]).strip().lower()
        rec = out.setdefault(d, {})
        rec[status] = {p: int(row.get(p) or 0) for p in PARTIES + ["TOTAL"]}
    return out


def main():
    for chamber, (code, url) in SRC.items():
        files = sorted(glob.glob(os.path.join(ROOT, f"data/raw/elections/boe_enrollment_{code}_*.xlsx")))
        if not files:
            print(chamber, "no enrollment file"); continue
        path = files[-1]
        as_of = re.search(r"(\d{4}-\d{2}-\d{2})", path).group(1)
        raw = read(path)
        votes = {}
        bp = os.path.join(ROOT, f"data/elections/boe_2026_{chamber}.json")
        if os.path.exists(bp):
            boe = json.load(open(bp))
            for row in boe["districts"]:
                d, eds, edt, cands, total = row
                votes[str(d)] = [total, eds, edt]
        districts = {}
        for d, rec in raw.items():
            act, ina, tot = rec.get("active"), rec.get("inactive"), rec.get("total")
            if not (act and tot):
                continue
            districts[d] = {
                "active": act["TOTAL"], "inactive": ina["TOTAL"] if ina else 0, "total": tot["TOTAL"],
                "party": [act[p] for p in PARTIES],  # active voters by enrollment
                **({"votes2026": votes[d]} if d in votes else {}),
            }
        out = {"asOf": as_of, "source": url, "parties": ["Democratic", "Republican", "Conservative", "Working Families", "Other parties", "No party (blank)"],
               "fields": {"party": "active registered voters by party enrollment", "votes2026": "[votes cast in the 2026 general for this seat, election districts reporting, total]"},
               "districts": districts}
        dst = os.path.join(ROOT, f"data/{chamber}/enrollment.json")
        json.dump(out, open(dst, "w"), separators=(",", ":"))
        t = sum(x["total"] for x in districts.values())
        print(chamber, len(districts), "districts", f"{t:,} registered", "as of", as_of)


if __name__ == "__main__":
    main()
