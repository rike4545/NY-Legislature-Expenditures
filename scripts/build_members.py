#!/usr/bin/env python3
"""Attach offices, contact details, posts and linked central offices to member offices.

Usage:
    python3 scripts/build_members.py     (after build_data.py and build_districts.py)

Inputs:
    data/geo/<chamber>-district-contacts.json  NYS GIS district layer attributes: member's Albany
                                               phone and email, district office address and phone
    data/roles/<chamber>.csv                   current leadership, committee and caucus posts
                                               (Assembly: nyassembly.gov/comm and Wikipedia;
                                               Senate: Wikipedia, 2025-2026 session)
    data/roles/office_links.csv                posts that direct a central office in the reports
                                               (e.g. Ways and Means chair -> ASSEMBLY WAYS AND
                                               MEANS COMMITTEE)
    data/ballotpedia/<chamber>.csv             "assumed office" date (Ballotpedia: date the member took
                                               the current district number)
    data/elections/2026.csv, sources.csv       Nov 3, 2026 outcome per seat that changes hands or is
                                               close, from the listed sources (unofficial results)
Output:
    data/<chamber>/members.json  {office name: {district, contact, roles: [{role, kind}], offices: [...],
                                  assumedOffice, election: {status, note, successor, successorParty, sources}}}

Names in the role lists are matched to member offices by surname (any part of a compound
surname), with the first initial breaking ties. Unmatched names are reported.
"""
import csv
import json
import pathlib
import re
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP = {"jr", "sr", "ii", "iii", "iv", "dr", "senator", "sen", "mr", "ms", "mrs"}


def words(s: str) -> list:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return [w for w in re.sub(r"[-.,']", " ", s).split() if w not in SKIP and len(w) > 1]


def match(name: str, members: list):
    w = words(name)
    first, lasts = w[0], w[1:]
    cands = [m for m in members if any(x in words(m) for x in lasts)]
    if len(cands) > 1:
        cands = [m for m in cands if any(x[0] == first[0] for x in words(m) if x not in lasts)]
    return cands[0] if len(cands) == 1 else None


def build(chamber: str) -> None:
    periods = sorted((ROOT / f"data/{chamber}/periods").glob("*.json"))
    latest = json.loads(periods[-1].read_text())
    current = [u["name"] for u in latest["units"] if u["kind"] == "member"]
    districts = json.loads((ROOT / f"data/{chamber}/districts.json").read_text())
    by_district = {d["district"]: d["unitName"] for d in districts}

    out = {}
    contacts = json.loads((ROOT / f"data/geo/{chamber}-district-contacts.json").read_text())["features"]
    for f in contacts:
        a = f["attributes"]
        unit = by_district.get(a["DISTRICT"])
        if not unit:
            continue
        addr = ", ".join(x for x in [a.get("ADDRESS"), a.get("ADDRESS2")] if x)
        out.setdefault(unit, {})["district"] = a["DISTRICT"]
        out[unit]["contact"] = {
            "albanyPhone": a.get("PHONE") or "", "email": a.get("EMAIL") or "",
            "districtPhone": a.get("DIST_PHONE") or "",
            "districtOffice": ", ".join(x for x in [addr, a.get("CITY"), f"{a.get('STATE') or ''} {a.get('ZIP') or ''}".strip()] if x),
        }

    links = {}
    for r in csv.DictReader(open(ROOT / "data/roles/office_links.csv", encoding="utf-8")):
        if r["chamber"] == chamber:
            links.setdefault(r["role"], []).append(r["office"])
    unmatched = []
    for r in csv.DictReader(open(ROOT / f"data/roles/{chamber}.csv", encoding="utf-8")):
        unit = match(r["name"], current)
        if not unit:
            unmatched.append(r["name"])
            continue
        m = out.setdefault(unit, {})
        m.setdefault("roles", []).append({"role": r["role"], "kind": r["kind"]})
        for office in links.get(r["role"], []):
            if office not in m.setdefault("offices", []):
                m["offices"].append(office)

    for r in csv.DictReader(open(ROOT / f"data/ballotpedia/{chamber}.csv", encoding="utf-8")):
        unit = by_district.get(int(r["district"]))
        if not unit or not any(w in words(unit) for w in words(r["name"])[1:]):
            unit = match(r["name"], current)
        if unit:
            out.setdefault(unit, {})["assumedOffice"] = r["assumed_office"]
        else:
            unmatched.append("ballotpedia: " + r["name"])

    for r in csv.DictReader(open(ROOT / "data/elections/2026.csv", encoding="utf-8")):
        if r["chamber"] != chamber:
            continue
        unit = match(r["incumbent"], current)
        if not unit:
            unmatched.append("election: " + r["incumbent"])
            continue
        out.setdefault(unit, {})["election"] = {
            "status": r["status"], "note": r["note"], "successor": r["successor"],
            "successorParty": r["successor_party"], "sources": r["source"].split(";"),
        }

    (ROOT / f"data/{chamber}/members.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    n_roles = sum(len(v.get("roles", [])) for v in out.values())
    print(f"{chamber}: {sum(1 for v in out.values() if 'contact' in v)} offices with contacts, {n_roles} posts, "
          f"{sum(len(v.get('offices', [])) for v in out.values())} linked central offices")
    for n in unmatched:
        print("  no current member office for", n)


if __name__ == "__main__":
    for c in ("assembly", "senate"):
        build(c)
    src = {r["key"]: r for r in csv.DictReader(open(ROOT / "data/elections/sources.csv", encoding="utf-8"))}
    (ROOT / "data/election_sources.json").write_text(json.dumps(src, ensure_ascii=False, indent=1))
