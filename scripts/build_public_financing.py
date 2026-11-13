"""Which legislative candidates took part in New York's public campaign finance program.

Input:  data/raw/campaign_finance/pcfb_candidate_list_2026.json — the State Board of
        Elections "Public Campaign Finance Candidate List" (election year 2026), saved
        from https://publicreporting.elections.ny.gov/PCFBCandidateRegList/PCFBCandidateRegList
        data/<chamber>/campaign_finance.json (to link list entries to candidates).
Output: data/<chamber>/public_financing.json
"""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OFFICE = {"Member of Assembly": "assembly", "State Senator": "senate"}
SUFFIX = {"jr", "sr", "ii", "iii", "iv"}


def money(s):
    if not s:
        return 0.0
    return float(re.sub(r"[^0-9.\-]", "", s) or 0)


def day(s):
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s or "")
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None


def tokens(name):
    t = [w for w in re.split(r"[^a-z]+", name.lower()) if w and w not in SUFFIX]
    return t


def same_person(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return False
    la = [w for w in ta if len(w) > 1]
    lb = [w for w in tb if len(w) > 1]
    if not la or not lb:
        return False
    # surname (last long token) must appear in the other name, and first names agree on initial
    sur_ok = la[-1] in lb or lb[-1] in la or (la[-1] + (la[-2] if len(la) > 1 else "")) in "".join(lb)
    return sur_ok and la[0][0] == lb[0][0]


def main():
    raw = json.load(open(os.path.join(ROOT, "data/raw/campaign_finance/pcfb_candidate_list_2026.json")))
    H = raw["header"]
    col = {h: i for i, h in enumerate(H)}
    def g(r, h):
        return r[col[h]]
    for office, chamber in OFFICE.items():
        cf = json.load(open(os.path.join(ROOT, f"data/{chamber}/campaign_finance.json")))
        people = {}
        for r in raw["rows"]:
            if g(r, "Office") != office or not g(r, "District"):
                continue
            d = str(int(g(r, "District")))
            cid = str(g(r, "Filer ID"))
            p = people.setdefault((d, cid), {"name": re.sub(r"\s+", " ", g(r, "Candidate Name")).strip(),
                                            "committee": g(r, "Committee Name").strip(), "committeeId": cid,
                                            "registered": day(g(r, "Registration Date")), "certified": None,
                                            "elections": {}, "received": 0.0, "qce": 0.0})
            cert = day(g(r, "Certified Date"))
            if cert and (not p["certified"] or cert < p["certified"]):
                p["certified"] = cert
            rec = money(g(r, "Public Funds ReceivedUnsorted"))
            q = money(g(r, "Qualified Campaign ExpendituresUnsorted"))
            p["elections"][g(r, "Election Type")] = {"status": g(r, "Candidate Status"), "received": rec,
                                                     "terminated": day(g(r, "Termination Date") or "")}
            p["received"] += rec
            p["qce"] += q
        districts, linked = {}, 0
        for (d, cid), p in people.items():
            cands = cf["districts"].get(d, [])
            hit = next((c for c in cands if any(x[0] == cid for x in c["committees"])), None)
            if not hit:
                hit = next((c for c in cands if same_person(c["name"], p["name"])), None)
            p["filerId"] = hit["filerId"] if hit else None
            linked += bool(hit)
            p["received"] = round(p["received"], 2)
            p["qce"] = round(p["qce"], 2)
            districts.setdefault(d, []).append(p)
        for v in districts.values():
            v.sort(key=lambda p: -p["received"])
        out = {"retrieved": raw["retrieved"][:10], "source": raw["source"], "electionYear": 2026,
               "fields": {"received": "public matching funds received, all 2026 elections (primary, general, special)",
                          "qce": "qualified campaign expenditures reported to the PCFB",
                          "elections": "status as listed by the State Board for each election type"},
               "districts": districts}
        json.dump(out, open(os.path.join(ROOT, f"data/{chamber}/public_financing.json"), "w"), separators=(",", ":"))
        n = sum(len(v) for v in districts.values())
        tot = sum(p["received"] for v in districts.values() for p in v)
        print(chamber, n, "registered candidates,", linked, "linked to a candidate row,", f"${tot:,.0f} received")


if __name__ == "__main__":
    main()
