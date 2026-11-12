#!/usr/bin/env python3
"""Match Assembly district boundaries to member offices in the expenditure reports.

Usage:
    python3 scripts/build_districts.py

Input:  data/geo/nys-assembly-districts-2024.geojson
        (NYS ITS GIS "NYS_Assembly_Districts" layer, 2024 Legislative Task Force lines;
         member names and party as published by that layer)
        data/periods/*.json (from build_data.py)
Output: data/districts.json  — {district, member (as listed by the GIS layer), party,
                                unitName (matching name in the reports, or null), geometry}

Matching: the GIS layer uses names like "Al Stirpe"; the reports use "STIRPE, ALBERT A. JR.".
A district matches a report unit when every word of the report's last name appears in the GIS
name; if several units share that last name, the first initial must also agree.
"""
import json
import pathlib
import re
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "dr"}

# Names the rules can't resolve, checked by hand against the reports:
# AD 20 "Ari Brown" is Eric Ari Brown; AD 59 "Jaime R. Williams" appears as RIVAS-WILLIAMS.
OVERRIDES = {20: "BROWN, ERIC G.", 59: "RIVAS-WILLIAMS, JAIME"}


def words(s: str) -> list:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[-.]", " ", s)
    return [w for w in re.sub(r"[^a-z ]", "", s).split() if w not in SUFFIXES]


def main() -> None:
    geo = json.loads((ROOT / "data/geo/nys-assembly-districts-2024.geojson").read_text())
    members = set()
    for f in sorted((ROOT / "data/periods").glob("*.json")):
        members |= {u["name"] for u in json.loads(f.read_text())["units"] if u["kind"] == "member"}

    parsed = []
    for name in members:
        last, _, first = name.partition(",")
        parsed.append((name, words(last), words(first)))

    out, unmatched = [], []
    for feat in sorted(geo["features"], key=lambda f: f["properties"]["DISTRICT"]):
        p = feat["properties"]
        gis = words(p["NAME"] or "")
        spans = {"".join(gis[i:j]) for i in range(len(gis)) for j in range(i + 1, len(gis) + 1)}
        cands = [n for n, last, first in parsed if last and "".join(last) in spans]
        if len(cands) > 1:
            cands = [n for n, last, first in parsed if n in cands and first and gis and first[0][0] == gis[0][0]]
        unit = cands[0] if len(cands) == 1 else None
        if p["DISTRICT"] in OVERRIDES and OVERRIDES[p["DISTRICT"]] in members:
            unit = OVERRIDES[p["DISTRICT"]]
        if unit is None:
            unmatched.append(f"AD {p['DISTRICT']}: {p['NAME']} -> {cands or 'no match'}")
        out.append({
            "district": p["DISTRICT"],
            "member": p["NAME"],
            "party": p.get("PARTY") or "",
            "unitName": unit,
            "geometry": feat["geometry"],
        })

    (ROOT / "data/districts.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"Wrote data/districts.json: {len(out)} districts, {len(out) - len(unmatched)} matched")
    for u in unmatched:
        print("  unmatched", u)


if __name__ == "__main__":
    main()
