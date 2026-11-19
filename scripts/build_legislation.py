"""Bills each legislator sponsored in the 2025-26 session and how far they got, compared with the
member's own prior term and with the previous member for the same district.

Input:  data/raw/legislation/bills_<session>.json (fetch_legislation.py), 2025 and any earlier sessions
Output: data/<chamber>/legislation.json
    {session, fetched, source, billUrl, history: [sessions available],
     districts: {district: [{memberId, name, shortName, introduced, reported, passedChamber, passedBoth,
       signed, vetoed, resolutions, signedBills: [[printNo, title]],
       prior: {session, district, <counts>} | null,
       predecessor: {session, district, memberId, name, <counts>} | null}]}}

Counted for each bill a member is the prime sponsor of (not resolutions, and not bills introduced
at the request of the Governor's budget or by the Rules Committee):
  reported      reached the floor calendar of the sponsor's chamber (out of committee)
  passedChamber passed the sponsor's chamber
  passedBoth    passed both houses (or was delivered to the Governor)
  signed        signed into law; vetoed: vetoed
When a bill was substituted by its same-as bill from the other house, the substitute's later steps
(passing both houses, the Governor's action) count for this bill too, since that's how most
two-house bills become law.

Comparisons, from the earlier sessions that have been fetched:
  prior        the member's own most recent earlier session in the same chamber (any district)
  predecessor  the most recent earlier session in which someone else was prime sponsor for this
               district number in this chamber; if several were (a vacancy mid-session), the one who
               introduced the most bills. District lines were redrawn for 2023 (and the Assembly's
               again for 2025), so the same number can cover a somewhat different area.
A person is the same member across sessions when Open Legislation's memberId matches, or their
full names match.
"""
import glob, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CURRENT = 2025
COUNTS = ("introduced", "reported", "passedChamber", "passedBoth", "signed", "vetoed")


def tally(raw):
    """{chamber: {district: {memberId: record}}} for one session's bills."""
    by_no = {b[0]: b for b in raw["bills"]}
    out = {"senate": {}, "assembly": {}}
    for b in raw["bills"]:
        no, chamber, reso, sp, title, ms, signed, vetoed, sub, budget, rules = b
        if not sp:
            continue
        ch = chamber.lower()
        steps = {m[0] for m in ms}
        if sub and sub in by_no:
            s2 = by_no[sub]
            steps |= {m[0] for m in s2[5]}
            signed = signed or s2[6]
            vetoed = vetoed or s2[7]
        rec = out[ch].setdefault(str(sp[3]), {}).setdefault(sp[0], {
            "memberId": sp[0], "name": sp[1], "shortName": sp[2], "introduced": 0, "reported": 0, "passedChamber": 0,
            "passedBoth": 0, "signed": 0, "vetoed": 0, "resolutions": 0, "signedBills": []})
        if reso:
            rec["resolutions"] += 1
            continue
        if budget or rules:
            continue
        own_floor, own_pass = ("SENATE_FLOOR", "PASSED_SENATE") if ch == "senate" else ("ASSEMBLY_FLOOR", "PASSED_ASSEMBLY")
        both = ("PASSED_SENATE" in steps and "PASSED_ASSEMBLY" in steps) or "DELIVERED_TO_GOV" in steps or signed or vetoed
        rec["introduced"] += 1
        rec["reported"] += own_floor in steps or own_pass in steps or both
        rec["passedChamber"] += own_pass in steps or both
        rec["passedBoth"] += bool(both)
        rec["signed"] += bool(signed)
        rec["vetoed"] += bool(vetoed)
        if signed:
            rec["signedBills"].append([no, title])
    return out


def norm(name):
    return re.sub(r"[^A-Z]+", " ", (name or "").upper()).strip()


def same(a, b):
    return a["memberId"] == b["memberId"] or (norm(a["name"]) and norm(a["name"]) == norm(b["name"]))


def brief(session, district, r, who=False):
    x = {"session": session, "district": int(district)}
    if who:
        x.update(memberId=r["memberId"], name=r["name"])
    x.update({k: r[k] for k in COUNTS})
    return x


def main():
    path = lambda s: os.path.join(ROOT, f"data/raw/legislation/bills_{s}.json")
    raw = json.load(open(path(CURRENT)))
    cur = tally(raw)
    earlier = sorted((int(re.search(r"bills_(\d{4})\.json$", p).group(1)) for p in glob.glob(path("*"))), reverse=True)
    earlier = [s for s in earlier if s < CURRENT]
    hist = {s: tally(json.load(open(path(s)))) for s in earlier}

    for ch, dists in cur.items():
        res = {}
        for d, members in dists.items():
            lst = sorted(members.values(), key=lambda r: -r["introduced"])
            for r in lst:
                r["signedBills"] = sorted(r["signedBills"], key=lambda x: (x[0][0], int("".join(c for c in x[0][1:] if c.isdigit()) or 0)))[:40]
                r["prior"] = r["predecessor"] = None
                for s in earlier:
                    sess = hist[s][ch]
                    if r["prior"] is None:
                        mine = [(dd, x) for dd, ms in sess.items() for x in ms.values() if same(x, r) and x["introduced"]]
                        if mine:
                            dd, x = max(mine, key=lambda t: t[1]["introduced"])
                            r["prior"] = brief(s, dd, x)
                    if r["predecessor"] is None:
                        others = [x for x in sess.get(d, {}).values() if not same(x, r) and x["introduced"]]
                        if others:
                            r["predecessor"] = brief(s, d, max(others, key=lambda x: x["introduced"]), who=True)
                    if r["prior"] and r["predecessor"]:
                        break
            res[d] = lst
        json.dump({"session": CURRENT, "fetched": raw["fetched"], "source": "https://legislation.nysenate.gov",
                   "billUrl": "https://www.nysenate.gov/legislation/bills/{session}/{printNo}", "history": earlier,
                   "districts": res},
                  open(os.path.join(ROOT, f"data/{ch}/legislation.json"), "w"), separators=(",", ":"))
        allm = [r for v in res.values() for r in v]
        print(ch, len(res), "districts,", len(allm), "sponsors,", sum(r["introduced"] for r in allm), "bills,",
              sum(r["signed"] for r in allm), "signed;", sum(bool(r["prior"]) for r in allm), "with a prior term,",
              sum(bool(r["predecessor"]) for r in allm), "with a predecessor; earlier sessions:", earlier)


if __name__ == "__main__":
    main()
