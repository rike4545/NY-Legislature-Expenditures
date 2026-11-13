#!/usr/bin/env python3
"""Campaign finance per district: 2025-2026 money raised and spent by Assembly and Senate candidates.

Usage:
    python3 scripts/build_campaign_finance.py --fetch   (refresh the snapshot from data.ny.gov, then build)
    python3 scripts/build_campaign_finance.py           (build from the committed snapshot)

Source: NYS Board of Elections campaign finance data published on data.ny.gov
    7x2g-h32p  Campaign Finance Filer Data (candidates carry office and district; committees don't)
    4j2b-6a2j  Disclosure Reports: Contributions (schedules A-D, G)
    ajsb-8pni  Disclosure Reports: Expenditures (schedule F)
Snapshot: data/raw/campaign_finance/*.json (aggregated by filer; election years 2025 and 2026)

Linking committees to candidates. The open data has no candidate-to-committee key, so a committee
is linked to a registered candidate when its name contains the candidate's surname and either the
candidate's first name or the chamber ("Senate" / "Assembly"). A committee that fits more than one
candidate is left unlinked, and every linked committee is listed by name so it can be checked on
publicreporting.elections.ny.gov. Committees on the State Board's Public Campaign Finance candidate
list (data/raw/campaign_finance/pcfb_candidate_list_2026.json) are linked to the candidate that list
names. Public matching funds paid by the Public Campaign Finance Board are not in these datasets.

Output: data/<chamber>/campaign_finance.json
    {asOf, source, districts: {district: [{name, filerId, member, committees: [[id, name, type]],
      raised: {A, B, C, D, G}, contributions, small: [count, amount], spent, payments}]}}
"""
import json
import pathlib
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data/raw/campaign_finance"
API = "https://data.ny.gov/resource/{}.json"
YEARS = "('2025','2026')"
QUERIES = {
    "filers": ("7x2g-h32p", {"$where": "office_desc in ('Member of Assembly','State Senator') AND filer_status='ACTIVE'", "$limit": "50000"}),
    "committees": ("7x2g-h32p", {"$where": "compliance_type_desc='COMMITTEE' AND filer_type_desc='State' AND committee_type_desc in ('Authorized Single Candidate Committee','Public Campaign Finance Committee')",
                                 "$select": "filer_id,filer_name,filer_status,committee_type_desc", "$limit": "50000"}),
    "contributions": ("4j2b-6a2j", {"$query": f"SELECT filer_id, filing_sched_abbrev, count(*) as n, sum(org_amt) as amt WHERE election_year in {YEARS} GROUP BY filer_id, filing_sched_abbrev LIMIT 100000"}),
    "small": ("4j2b-6a2j", {"$query": f"SELECT filer_id, count(*) as n, sum(org_amt) as amt WHERE election_year in {YEARS} AND filing_sched_abbrev='A' AND org_amt <= 250 GROUP BY filer_id LIMIT 100000"}),
    "expenditures": ("ajsb-8pni", {"$query": f"SELECT filer_id, count(*) as n, sum(org_amt) as amt WHERE election_year in {YEARS} GROUP BY filer_id LIMIT 100000"}),
}
STOP = {"friends", "of", "for", "the", "committee", "to", "elect", "re", "reelect", "citizens", "people", "team", "inc",
        "state", "senate", "assembly", "senator", "assemblyman", "assemblywoman", "assemblymember", "ny", "nys", "new", "york",
        "district", "campaign", "and", "with", "jr", "sr", "ii", "iii", "iv", "dr", "pcf", "neighbors", "supporters"}
SUFFIX = {"jr", "sr", "ii", "iii", "iv", "esq"}
PARTICLE = {"de", "del", "della", "di", "da", "van", "von", "la", "le", "mc", "st", "o"}
COMMON = {"brown", "smith", "johnson", "williams", "jones", "davis", "miller", "rivera", "rodriguez", "martinez", "garcia",
          "lee", "kim", "chan", "jackson", "murray", "ryan", "taylor", "thomas", "walker", "white", "young", "allen", "clark"}
NICK = {"joseph": {"joe", "joey"}, "christopher": {"chris"}, "patrick": {"pat"}, "patricia": {"pat", "patty", "trish"},
        "jacob": {"jake"}, "michael": {"mike"}, "william": {"bill", "billy", "will"}, "robert": {"bob", "rob", "bobby"},
        "james": {"jim", "jimmy"}, "thomas": {"tom", "tommy"}, "anthony": {"tony", "anthony"}, "richard": {"rich", "rick", "dick"},
        "edward": {"ed", "eddie", "ted"}, "elizabeth": {"liz", "beth", "betsy"}, "katherine": {"kathy", "kate", "katie"},
        "kathleen": {"kathy", "kate"}, "stephen": {"steve"}, "steven": {"steve"}, "daniel": {"dan", "danny"}, "david": {"dave"},
        "jonathan": {"jon"}, "john": {"jack"}, "nicholas": {"nick"}, "matthew": {"matt"}, "andrew": {"andy", "drew"},
        "alexander": {"alex"}, "alexandra": {"alex"}, "jennifer": {"jen", "jenny"}, "rebecca": {"becky"}, "samuel": {"sam"},
        "samantha": {"sam"}, "benjamin": {"ben"}, "gregory": {"greg"}, "timothy": {"tim"}, "kenneth": {"ken"}, "ronald": {"ron"},
        "donald": {"don"}, "charles": {"charlie", "chuck"}, "margaret": {"peg", "maggie"}, "deborah": {"deb", "debbie"},
        "susan": {"sue"}, "victoria": {"vicki", "tori"}, "philip": {"phil"}, "phillip": {"phil"}, "peter": {"pete"},
        "gerald": {"jerry"}, "lawrence": {"larry"}, "frederick": {"fred"}, "raymond": {"ray"}, "douglas": {"doug"},
        "jeffrey": {"jeff"}, "harold": {"harry"}, "henry": {"hank"}, "albert": {"al"}, "alfred": {"al"}, "zellnor": {"zellnor"}}


def words(s: str) -> list:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return [w for w in re.split(r"[^a-z0-9]+", s.replace("'", "")) if w]


def fetch() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for name, (ds, params) in QUERIES.items():
        url = API.format(ds) + "?" + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=600) as r:
            (RAW / f"{name}.json").write_bytes(r.read())
    (RAW / "as_of.txt").write_text(date.today().isoformat())


def main() -> None:
    if "--fetch" in sys.argv:
        fetch()
    load = lambda n: json.loads((RAW / f"{n}.json").read_text())
    filers, comms = load("filers"), load("committees")
    active_ids = {x["filer_id"] for x in load("contributions")} | {x["filer_id"] for x in load("expenditures")}
    comms = [c for c in comms if c["filer_id"] in active_ids]

    cands = []
    for f in filers:
        if not f.get("district"):
            continue
        w = [x for x in words(f["filer_name"]) if x not in SUFFIX]
        if len(w) < 2:
            continue
        given = {x for x in w[:-1] if len(x) > 1}
        for g in list(given):
            given |= NICK.get(g, set())
        lasts = {w[-1]}
        if len(w) >= 3 and w[-2] in PARTICLE:          # De Stefano, Van Wuyckhuyse
            lasts.add(w[-2] + w[-1])
        if "-" in f["filer_name"]:                     # hyphenated surnames: either part, or both joined
            hy = words(f["filer_name"].split()[-1])
            lasts |= set(hy) | {"".join(hy)}
        cands.append({"f": f, "given": given, "lasts": lasts,
                      "chamber": "senate" if f["office_desc"] == "State Senator" else "assembly"})

    def fits(k, cw):
        hit = next((l for l in k["lasts"] if l in cw), None)
        if not hit:
            return False
        rest = cw - {hit} - STOP - k["given"] - {p for p in PARTICLE}
        rest = {x for x in rest if not x.isdigit() and len(x) > 1 and x not in k["lasts"]}
        if rest:                                       # another first name or office word: someone else's committee
            return False
        weak = len(hit) < 3 or hit in STOP or hit in COMMON
        return not weak or bool(k["given"] & cw)

    links = {}
    for c in comms:
        cw = set(words(c["filer_name"]))
        chamber_word = "senate" if cw & {"senate", "senator"} else "assembly" if cw & {"assembly", "assemblyman", "assemblywoman", "assemblymember"} else None
        found = [k for k in cands if fits(k, cw)]
        if len(found) > 1:
            found = [k for k in found if k["given"] & cw] or found
        if len(found) > 1 and chamber_word:
            found = [k for k in found if k["chamber"] == chamber_word] or found
        if len(found) == 1:
            links.setdefault(found[0]["f"]["filer_id"], []).append(c)

    # The State Board's Public Campaign Finance candidate list names each participating candidate's
    # committee, so it's an official link: it overrides name matching for the committees it covers.
    pcfb = RAW / "pcfb_candidate_list_2026.json"
    official = 0
    if pcfb.exists():
        raw = json.loads(pcfb.read_text())
        col = {h: i for i, h in enumerate(raw["header"])}
        comm_by_id = {c["filer_id"]: c for c in comms}
        office_ch = {"Member of Assembly": "assembly", "State Senator": "senate"}
        for r in raw["rows"]:
            ch, dist, cid = office_ch.get(r[col["Office"]]), r[col["District"]], str(r[col["Filer ID"]])
            c = comm_by_id.get(cid)
            if not ch or not dist or not c:
                continue
            nw = [x for x in words(r[col["Candidate Name"]]) if x not in SUFFIX and len(x) > 1]
            if not nw:
                continue
            match = [k for k in cands if k["chamber"] == ch and str(int(k["f"]["district"])) == str(int(dist))
                     and (k["lasts"] & set(nw) or "".join(nw[-2:]) in k["lasts"]) and any(g[0] == nw[0][0] for g in k["given"] | k["lasts"])]
            if len(match) != 1:
                continue
            fid = match[0]["f"]["filer_id"]
            for other, cs in links.items():
                if other != fid and c in cs:
                    cs.remove(c)
            if c not in links.setdefault(fid, []):
                links[fid].append(c)
                official += 1
    print(f"committees linked from the public campaign finance list: {official}")

    by = {}
    for r in load("contributions"):
        by.setdefault(r["filer_id"], {}).setdefault("raised", {})[r["filing_sched_abbrev"]] = (float(r["amt"] or 0), int(r["n"]))
    for r in load("small"):
        by.setdefault(r["filer_id"], {})["small"] = (int(r["n"]), float(r["amt"] or 0))
    for r in load("expenditures"):
        by.setdefault(r["filer_id"], {})["spent"] = (float(r["amt"] or 0), int(r["n"]))

    as_of = (RAW / "as_of.txt").read_text().strip() if (RAW / "as_of.txt").exists() else ""
    stats = {}
    for chamber in ("assembly", "senate"):
        out = {}
        for k in cands:
            if k["chamber"] != chamber:
                continue
            cs = links.get(k["f"]["filer_id"], [])
            raised = {s: 0.0 for s in "ABCDG"}
            n = 0; small = [0, 0.0]; spent = 0.0; pays = 0
            for c in cs:
                b = by.get(c["filer_id"], {})
                for s, (amt, cnt) in b.get("raised", {}).items():
                    raised[s] = raised.get(s, 0) + amt
                    if s in "ABC":
                        n += cnt
                if "small" in b:
                    small[0] += b["small"][0]; small[1] += b["small"][1]
                if "spent" in b:
                    spent += b["spent"][0]; pays += b["spent"][1]
            out.setdefault(str(int(k["f"]["district"])), []).append({
                "name": re.sub(r"\s+", " ", k["f"]["filer_name"]).strip(), "filerId": k["f"]["filer_id"],
                "committees": [[c["filer_id"], re.sub(r"\s+", " ", c["filer_name"]).strip(), c["committee_type_desc"]] for c in cs],
                "raised": {s: round(v, 2) for s, v in raised.items()}, "contributions": n,
                "small": [small[0], round(small[1], 2)], "spent": round(spent, 2), "payments": pays,
            })
        for d in out.values():
            d.sort(key=lambda x: -(sum(x["raised"].values())))
        (ROOT / f"data/{chamber}/campaign_finance.json").write_text(json.dumps({
            "asOf": as_of, "years": [2025, 2026],
            "source": "NYS Board of Elections campaign finance disclosure data (data.ny.gov datasets 7x2g-h32p, 4j2b-6a2j, ajsb-8pni)",
            "districts": out}, ensure_ascii=False, separators=(",", ":")))
        allc = [x for v in out.values() for x in v]
        stats[chamber] = (len(out), len(allc), sum(1 for x in allc if x["committees"]), round(sum(sum(x["raised"].values()) for x in allc)))
    for ch, (nd, nc, linked, total) in stats.items():
        print(f"{ch}: {nd} districts, {nc} registered candidates, {linked} with a linked committee, ${total:,} raised 2025-26")
    print(f"committees with 2025-26 activity: {len(comms)}, linked: {sum(len(v) for v in links.values())}")


if __name__ == "__main__":
    main()
