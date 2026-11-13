"""Download every bill of the 2025-26 session from NY Open Legislation (legislation.nysenate.gov).

Needs a free API key in the NYSENATE_API_KEY environment variable (never commit the key).
Writes a compact snapshot to data/raw/legislation/bills_<session>.json:
    {session, fetched, bills: [[printNo, chamber, resolution, sponsor, title, milestones, signed, vetoed,
                                substitutedBy, budget, rules]]}
where sponsor = [memberId, fullName, shortName, districtCode] or null, and milestones =
[[statusType, actionDate]].

    NYSENATE_API_KEY=... python3 scripts/fetch_legislation.py [session]
"""
import json, os, sys, time, urllib.parse, urllib.request
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://legislation.nysenate.gov/api/3"


def get(path, **params):
    key = os.environ.get("NYSENATE_API_KEY")
    if not key:
        sys.exit("Set NYSENATE_API_KEY (free key from https://legislation.nysenate.gov)")
    url = f"{API}/{path}?" + urllib.parse.urlencode({**params, "key": key})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                d = json.load(r)
            if not d.get("success", True):
                raise RuntimeError(d.get("message"))
            return d
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{path}: {err}")


def main():
    session = int(sys.argv[1]) if len(sys.argv) > 1 else 2025
    bills, offset, total = [], 1, None
    while total is None or offset <= total:
        d = get(f"bills/{session}", limit=1000, offset=offset)
        total = d["total"]
        for b in d["result"]["items"]:
            sp = b.get("sponsor") or {}
            m = sp.get("member")
            bills.append([
                b["basePrintNo"], b["billType"]["chamber"], bool(b["billType"].get("resolution")),
                [m["memberId"], m["fullName"], m["shortName"], m["districtCode"]] if m else None,
                b.get("title") or "",
                [[x["statusType"], x["actionDate"]] for x in (b.get("milestones") or {}).get("items", [])],
                bool(b.get("signed")), bool(b.get("vetoed")),
                (b.get("substitutedBy") or {}).get("basePrintNo"),
                bool(sp.get("budget")), bool(sp.get("rules")),
            ])
        print(f"{len(bills):,} / {total:,}", flush=True)
        offset += 1000
    out = os.path.join(ROOT, f"data/raw/legislation/bills_{session}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump({"session": session, "fetched": date.today().isoformat(), "source": "https://legislation.nysenate.gov",
               "fields": ["printNo", "chamber", "resolution", "sponsor[memberId,fullName,shortName,district]", "title",
                          "milestones[[statusType,date]]", "signed", "vetoed", "substitutedBy", "budget", "rules"],
               "bills": bills}, open(out, "w"), separators=(",", ":"))
    print("wrote", out, len(bills), "bills")


if __name__ == "__main__":
    main()
