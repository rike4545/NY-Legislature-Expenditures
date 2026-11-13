#!/usr/bin/env python3
"""Donations in depth for each Assembly and Senate candidate, 2025-26.

Usage:
    python3 scripts/build_donations.py     (after build_campaign_finance.py and build_zip_districts.py)

Source: NYS Board of Elections disclosure reports on data.ny.gov (e9ss-239a), monetary contributions
(schedules A, B and C) for election years 2025 and 2026, for the committees build_campaign_finance.py
linked to each registered candidate. The data is fetched grouped by donor; only totals are written,
so no individual donor's name is stored or published. Organizations (schedules B and C: corporations,
PACs, unions, LLCs and the like) are listed by name, since they are public entities.

In-district: a donor counts as in-district when their ZIP code's Census internal point falls inside
the candidate's district (data/geo/zip_districts.json); it's an estimate, since ZIPs can straddle
district lines.

Output: data/<chamber>/donations.json
    {asOf, years, buckets, districts: {district: [{name, filerId, donors, repeat, gifts, individuals,
      inDistrict: [donors, amount], restOfNy: [donors, amount], outOfState: [donors, amount],
      sizes: [[donors, amount] per bucket], types: {type: amount}, months: {YYYY-MM: amount},
      topOrgs: [[name, type, amount, gifts]]}]}}
"""
import json
import pathlib
import time
import urllib.parse
import urllib.request
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = "https://data.ny.gov/resource/e9ss-239a.json"
BASE = "election_year in ('2025','2026') AND filing_sched_abbrev in ('A','B','C') AND org_amt > 0"
BUCKETS = [(0, 100, "$100 or less"), (100, 250, "$101–$250"), (250, 1000, "$251–$1,000"), (1000, 5000, "$1,001–$5,000"), (5000, 1e12, "Over $5,000")]


def soql(query: str) -> list:
    url = API + "?" + urllib.parse.urlencode({"$query": query})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=600) as r:
                return json.loads(r.read())
        except Exception:
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))


def fetch_all(select: str, where: str, group: str, ids: list) -> list:
    out = []
    for i in range(0, len(ids), 60):
        chunk = ",".join(f"'{x}'" for x in ids[i:i + 60])
        off = 0
        while True:
            rows = soql(f"SELECT {select} WHERE {BASE} AND {where} AND filer_id in ({chunk}) GROUP BY {group} LIMIT 50000 OFFSET {off}")
            out += rows
            if len(rows) < 50000:
                break
            off += 50000
    return out


def zip5(z):
    z = (z or "").strip()[:5]
    return z if z.isdigit() and len(z) == 5 else ""


def main():
    zips = json.loads((ROOT / "data/geo/zip_districts.json").read_text())
    cands = {}
    for chamber in ("assembly", "senate"):
        cf = json.loads((ROOT / f"data/{chamber}/campaign_finance.json").read_text())
        for d, rows in cf["districts"].items():
            for c in rows:
                for cm in c["committees"]:
                    cands[cm[0]] = (chamber, int(d), c["name"], c["filerId"])
    ids = sorted(cands)
    print(f"{len(ids)} linked committees")

    ind = fetch_all("filer_id, flng_ent_last_name, flng_ent_first_name, flng_ent_zip, flng_ent_state, count(*) as n, sum(org_amt) as amt",
                    "filing_sched_abbrev='A'", "filer_id, flng_ent_last_name, flng_ent_first_name, flng_ent_zip, flng_ent_state", ids)
    org = fetch_all("filer_id, flng_ent_name, cntrbr_type_desc, count(*) as n, sum(org_amt) as amt",
                    "filing_sched_abbrev in ('B','C')", "filer_id, flng_ent_name, cntrbr_type_desc", ids)
    typ = fetch_all("filer_id, cntrbr_type_desc, sum(org_amt) as amt", "true", "filer_id, cntrbr_type_desc", ids)
    mon = fetch_all("filer_id, date_trunc_ym(sched_date) as m, sum(org_amt) as amt", "true", "filer_id, date_trunc_ym(sched_date)", ids)
    print(f"fetched: {len(ind):,} donor groups, {len(org):,} organization groups, {len(typ):,} type rows, {len(mon):,} month rows")

    # Candidate-level accumulation (a candidate may have several committees; a donor giving to two of
    # them is one donor).
    acc = {}
    def A(fid):
        ch, d, name, cid = cands[fid]
        return acc.setdefault(cid, {"chamber": ch, "district": d, "name": name, "donors": {}, "orgs": {}, "types": {}, "months": {}})
    for r in ind:
        a = A(r["filer_id"])
        key = ((r.get("flng_ent_last_name") or "").strip().lower(), (r.get("flng_ent_first_name") or "").strip().lower(), zip5(r.get("flng_ent_zip")))
        v = a["donors"].setdefault(key, {"n": 0, "amt": 0.0, "state": (r.get("flng_ent_state") or "").strip().upper()})
        v["n"] += int(r["n"]); v["amt"] += float(r["amt"] or 0)
    for r in org:
        a = A(r["filer_id"])
        k = ((r.get("flng_ent_name") or "").strip(), (r.get("cntrbr_type_desc") or "Other").strip())
        v = a["orgs"].setdefault(k, [0.0, 0])
        v[0] += float(r["amt"] or 0); v[1] += int(r["n"])
    for r in typ:
        a = A(r["filer_id"])
        t = (r.get("cntrbr_type_desc") or "Not specified").strip()
        a["types"][t] = a["types"].get(t, 0) + float(r["amt"] or 0)
    for r in mon:
        if not r.get("m"):
            continue
        a = A(r["filer_id"])
        m = r["m"][:7]
        a["months"][m] = a["months"].get(m, 0) + float(r["amt"] or 0)

    out = {"assembly": {}, "senate": {}}
    for cid, a in acc.items():
        col = 0 if a["chamber"] == "assembly" else 1
        geo = {"in": [0, 0.0], "ny": [0, 0.0], "out": [0, 0.0], "unknown": [0, 0.0]}
        sizes = [[0, 0.0] for _ in BUCKETS]
        repeat = gifts = 0
        for (last, first, z), v in a["donors"].items():
            gifts += v["n"]
            if v["n"] > 1:
                repeat += 1
            st = v["state"]
            if z and z in zips:
                g = "in" if zips[z][col] == a["district"] else "ny"
            elif st == "NY" or (z[:1] in ("1",) and not st):
                g = "ny"
            elif st:
                g = "out"
            else:
                g = "unknown"
            geo[g][0] += 1; geo[g][1] += v["amt"]
            for i, (lo, hi, _) in enumerate(BUCKETS):
                if lo < v["amt"] <= hi or (i == 0 and v["amt"] <= hi):
                    sizes[i][0] += 1; sizes[i][1] += v["amt"]
                    break
        top = sorted(((n, t, round(v[0], 2), v[1]) for (n, t), v in a["orgs"].items() if n), key=lambda x: -x[2])[:10]
        out[a["chamber"]].setdefault(str(a["district"]), []).append({
            "name": a["name"], "filerId": cid, "donors": len(a["donors"]), "repeat": repeat, "gifts": gifts,
            "individuals": round(sum(v["amt"] for v in a["donors"].values()), 2),
            "inDistrict": [geo["in"][0], round(geo["in"][1], 2)], "restOfNy": [geo["ny"][0], round(geo["ny"][1], 2)],
            "outOfState": [geo["out"][0], round(geo["out"][1], 2)], "unknown": [geo["unknown"][0], round(geo["unknown"][1], 2)],
            "sizes": [[s[0], round(s[1], 2)] for s in sizes],
            "types": {k: round(v, 2) for k, v in sorted(a["types"].items(), key=lambda x: -x[1])},
            "months": {k: round(v, 2) for k, v in sorted(a["months"].items())},
            "topOrgs": top,
        })
    for chamber, dists in out.items():
        for rows in dists.values():
            rows.sort(key=lambda x: -(x["individuals"] + sum(o[2] for o in x["topOrgs"])))
        (ROOT / f"data/{chamber}/donations.json").write_text(json.dumps({
            "asOf": date.today().isoformat(), "years": [2025, 2026], "buckets": [b[2] for b in BUCKETS],
            "source": "NYS Board of Elections disclosure reports, data.ny.gov e9ss-239a (schedules A-C)",
            "districts": dists}, ensure_ascii=False, separators=(",", ":")))
        n = sum(len(v) for v in dists.values())
        print(f"{chamber}: {len(dists)} districts, {n} candidates with itemized contributions")


if __name__ == "__main__":
    main()
