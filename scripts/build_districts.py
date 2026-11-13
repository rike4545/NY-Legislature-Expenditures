#!/usr/bin/env python3
"""Match Assembly and Senate district boundaries to member offices in the expenditure reports.

Usage:
    python3 scripts/build_districts.py

Inputs:  data/geo/assembly-districts.geojson, data/geo/senate-districts.geojson
         (NYS ITS Geospatial Services "NYS_Assembly_Districts" / "NYS_Senate_Districts" layers,
          2024 lines; member names and party as published by those layers)
         data/<chamber>/periods/*.json (from build_data.py)
Output:  data/<chamber>/districts.json — {district, member (as the GIS layer lists them), party,
         unitName (matching office name in the reports, or null), geometry}

Matching: the GIS layers use names like "Al Stirpe"; the Assembly report uses
"STIRPE, ALBERT A. JR." and the Senate report "SENATOR JOSEPH P. ADDABBO, JR.".
A district matches an office when the office's last name appears as whole word(s) in the
GIS name; if several offices share that last name, the first initial must also agree.
Cases the rules can't resolve are listed in OVERRIDES, checked by hand.
"""
import json
import pathlib
import re
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "dr"}

# (chamber, district) -> office name in the reports.
# AD 20 "Ari Brown" is Eric Ari Brown; AD 59 "Jaime R. Williams" appears as RIVAS-WILLIAMS.
OVERRIDES = {
    ("assembly", 20): "BROWN, ERIC G.",
    ("assembly", 59): "RIVAS-WILLIAMS, JAIME",
}


def words(s: str) -> list:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[-.]", " ", s)
    return [w for w in re.sub(r"[^a-z ]", "", s).split() if w not in SUFFIXES]


def parse_assembly(name: str):
    last, _, first = name.partition(",")
    return words(last), words(first)


def parse_senate(name: str):
    w = words(re.sub(r"^(SENATOR|SEN)\s+", "", name))
    return w[-1:], w[:1]


PARSERS = {"assembly": parse_assembly, "senate": parse_senate}


def build(chamber: str) -> None:
    geo = json.loads((ROOT / f"data/geo/{chamber}-districts.geojson").read_text())
    members = set()
    for f in sorted((ROOT / f"data/{chamber}/periods").glob("*.json")):
        members |= {u["name"] for u in json.loads(f.read_text())["units"] if u["kind"] == "member"}
    parsed = [(n, *PARSERS[chamber](n)) for n in members]

    out, unmatched = [], []
    for feat in sorted(geo["features"], key=lambda f: f["properties"]["DISTRICT"]):
        p = feat["properties"]
        gis = words(p["NAME"] or "")
        spans = {"".join(gis[i:j]) for i in range(len(gis)) for j in range(i + 1, len(gis) + 1)}
        cands = [n for n, last, first in parsed if last and "".join(last) in spans]
        if len(cands) > 1:
            cands = [n for n, last, first in parsed if n in cands and first and gis and first[0][0] == gis[0][0]]
        unit = cands[0] if len(cands) == 1 else None
        override = OVERRIDES.get((chamber, p["DISTRICT"]))
        if override and override in members:
            unit = override
        if unit is None:
            unmatched.append(f"{chamber} {p['DISTRICT']}: {p['NAME']} -> {cands or 'no match'}")
        out.append({"district": p["DISTRICT"], "member": p["NAME"], "party": p.get("PARTY") or "",
                    "unitName": unit, "geometry": feat["geometry"]})

    names = [d["unitName"] for d in out if d["unitName"]]
    if len(names) != len(set(names)):
        raise SystemExit(f"{chamber}: an office matched more than one district")
    (ROOT / f"data/{chamber}/districts.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"{chamber}: {len(out)} districts, {len(names)} matched")
    for u in unmatched:
        print("  unmatched", u)


def main() -> None:
    for chamber in PARSERS:
        build(chamber)


if __name__ == "__main__":
    main()
