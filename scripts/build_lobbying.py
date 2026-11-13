"""Who reported lobbying each sitting legislator in 2025-26, and which of them also donated.

Input:  data/raw/lobbying/<chamber>/<district>.json (from fetch_lobbying.py)
        data/raw/campaign_finance/org_donors.json (from build_donations.py)
Output: data/<chamber>/lobbying.json
    {source, years, fetched, districts: {district: {member, clients, staffOnly, top: [[client, subjects]],
      subjects: [[subject, clients]], donors: [[client, amount]]}}}

A filing lists every legislator or staff member a lobbyist communicated with, so "reported lobbying"
means the legislator (or their staff) appears among the parties lobbied on at least one bi-monthly
report for that client. The dataset repeats rows for each expense and subject on a report, so row
counts are only used to order clients, not shown.
"""
import glob, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORP = {"inc", "llc", "llp", "pllc", "corp", "corporation", "co", "company", "ltd", "the", "pc", "lp", "of", "and"}


def key(name):
    return " ".join(w for w in re.split(r"[^a-z0-9]+", (name or "").lower()) if w and w not in CORP)


def surname_hit(member, cand):
    m = [w for w in re.split(r"[^a-z]+", member.lower()) if len(w) > 2 and w not in ("jr", "sr")]
    return bool(m) and m[-1] in cand.lower()


def main():
    donors = {}
    p = os.path.join(ROOT, "data/raw/campaign_finance/org_donors.json")
    if os.path.exists(p):
        for o in json.load(open(p)).values():
            donors.setdefault(key(o["name"]), []).append(o)
    for chamber in ("senate", "assembly"):
        files = glob.glob(os.path.join(ROOT, f"data/raw/lobbying/{chamber}/*.json"))
        out, fetched = {}, set()
        for f in files:
            d = os.path.splitext(os.path.basename(f))[0]
            raw = json.load(open(f))
            fetched.add(raw.get("fetched", ""))
            clients, subjects, staff_only = {}, {}, set()
            direct = set()
            for r in raw["rows"]:
                c = (r.get("contractual_client_name") or "").strip()
                if not c:
                    continue
                ck = key(c)
                e = clients.setdefault(ck, {"name": c, "n": 0, "subjects": set()})
                e["n"] += int(r.get("n") or 1)
                if "staff" not in (r.get("party_name") or "").lower():
                    direct.add(ck)
                s = (r.get("lobbying_subjects") or "").strip()
                if s:
                    for part in [x.strip() for x in s.split(";") if x.strip()]:
                        e["subjects"].add(part)
                        subjects.setdefault(part, set()).add(ck)
            staff_only = [k for k in clients if k not in direct]
            top = sorted(clients.values(), key=lambda e: -e["n"])
            gave = []
            for ck, e in clients.items():
                for o in donors.get(ck, []):
                    amt = sum(v for k, v in o["to"].items() if k.startswith(f"{chamber}:{d}:") and surname_hit(raw["member"], k.split(":", 2)[2]))
                    if amt:
                        gave.append([e["name"], round(amt, 2)])
            out[d] = {"member": raw["member"], "clients": len(clients), "staffOnly": len(staff_only),
                      "top": [[e["name"], sorted(e["subjects"])[:6]] for e in top[:25]],
                      "subjects": sorted(([s, len(v)] for s, v in subjects.items()), key=lambda x: -x[1])[:15],
                      "donors": sorted(gave, key=lambda x: -x[1])}
        json.dump({"source": "https://data.ny.gov/d/t9kf-dqbc", "dataset": "Lobbyist Bi-Monthly Reports: Beginning 2019 (NYS Commission on Ethics and Lobbying in Government)",
                   "years": [2025, 2026], "fetched": max(fetched) if fetched else None, "districts": out},
                  open(os.path.join(ROOT, f"data/{chamber}/lobbying.json"), "w"), separators=(",", ":"))
        print(chamber, len(out), "legislators,", sum(x["clients"] for x in out.values()), "client links,",
              sum(len(x["donors"]) for x in out.values()), "lobbying clients that also donated to the member")


if __name__ == "__main__":
    main()
