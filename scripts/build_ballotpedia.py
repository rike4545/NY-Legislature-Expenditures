#!/usr/bin/env python3
"""Attach Ballotpedia profile links to member offices.

Usage:
    python3 scripts/build_ballotpedia.py      (run after build_data.py and build_districts.py)

Input:  data/ballotpedia/<chamber>.csv — district, name, party, url, taken from the "Current members"
        tables on https://ballotpedia.org/New_York_State_Assembly and
        https://ballotpedia.org/New_York_State_Senate (retrieved 2026-11-12)
        data/<chamber>/districts.json, data/<chamber>/periods/*.json
Output: data/<chamber>/ballotpedia.json — {office name in the reports: profile url}

A Ballotpedia row is tied to the office matched to its district when the last names agree;
otherwise to the one member office anywhere in the reports whose name contains that last name
(any part of a compound surname counts; the first initial breaks ties). Members who aren't on Ballotpedia's current-members list
(for example, those who left during a report period) get no entry; the site links them to a
Ballotpedia search instead.
"""
import csv
import json
import pathlib
import re
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "dr", "senator", "sen"}


def words(s: str) -> list:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[-.,']", " ", s)
    return [w for w in s.split() if w not in SUFFIXES]


def build(chamber: str) -> None:
    rows = list(csv.DictReader(open(ROOT / f"data/ballotpedia/{chamber}.csv", encoding="utf-8")))
    districts = {d["district"]: d for d in json.loads((ROOT / f"data/{chamber}/districts.json").read_text())}
    members = set()
    for f in sorted((ROOT / f"data/{chamber}/periods").glob("*.json")):
        members |= {u["name"] for u in json.loads(f.read_text())["units"] if u["kind"] == "member"}

    out, unmatched = {}, []
    for r in rows:
        bw = words(r["name"])
        first, lasts = bw[0], [w for w in bw[1:] if len(w) > 1]  # any part of a compound surname
        d = districts.get(int(r["district"]))
        unit = d and d["unitName"]
        has_last = lambda name: any(w in words(name) for w in lasts)
        if not (unit and has_last(unit)):
            cands = [m for m in members if has_last(m)]
            if len(cands) > 1:
                cands = [m for m in cands if any(w[0] == first[0] for w in words(m) if w not in lasts)]
            unit = cands[0] if len(cands) == 1 else None
        if unit is None:
            unmatched.append(f"{r['district']} {r['name']}")
            continue
        if unit in out:
            raise SystemExit(f"{chamber}: {unit} matched twice")
        out[unit] = r["url"]
    (ROOT / f"data/{chamber}/ballotpedia.json").write_text(json.dumps(out, indent=0, ensure_ascii=False))
    print(f"{chamber}: {len(out)} of {len(rows)} Ballotpedia profiles linked to offices")
    for u in unmatched:
        print("  no office in the reports for", u)


if __name__ == "__main__":
    for c in ("assembly", "senate"):
        build(c)
