"""Bills each legislator sponsored in the 2025-26 session and how far they got.

Input:  data/raw/legislation/bills_2025.json (fetch_legislation.py)
Output: data/<chamber>/legislation.json
    {session, fetched, source, districts: {district: [{memberId, name, shortName, introduced, reported,
      passedChamber, passedBoth, signed, vetoed, resolutions, signedBills: [[printNo, title]]}]}}

Counted for each bill a member is the prime sponsor of (not resolutions, and not bills introduced
at the request of the Governor's budget or by the Rules Committee):
  reported      reached the floor calendar of the sponsor's chamber (out of committee)
  passedChamber passed the sponsor's chamber
  passedBoth    passed both houses (or was delivered to the Governor)
  signed        signed into law; vetoed: vetoed
When a bill was substituted by its same-as bill from the other house, the substitute's later steps
(passing both houses, the Governor's action) count for this bill too, since that's how most
two-house bills become law.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(session=2025):
    raw = json.load(open(os.path.join(ROOT, f"data/raw/legislation/bills_{session}.json")))
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
    for ch, dists in out.items():
        res = {d: sorted(m.values(), key=lambda r: -r["introduced"]) for d, m in dists.items()}
        for lst in res.values():
            for r in lst:
                r["signedBills"] = sorted(r["signedBills"], key=lambda x: (x[0][0], int("".join(c for c in x[0][1:] if c.isdigit()) or 0)))[:40]
        json.dump({"session": session, "fetched": raw["fetched"], "source": "https://legislation.nysenate.gov",
                   "billUrl": "https://www.nysenate.gov/legislation/bills/" + str(session) + "/{printNo}", "districts": res},
                  open(os.path.join(ROOT, f"data/{ch}/legislation.json"), "w"), separators=(",", ":"))
        allm = [r for v in res.values() for r in v]
        print(ch, len(res), "districts,", len(allm), "sponsors,", sum(r["introduced"] for r in allm), "bills,", sum(r["signed"] for r in allm), "signed")


if __name__ == "__main__":
    main()
