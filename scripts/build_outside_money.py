"""Independent expenditures for and against Senate and Assembly candidates, 2025-26.

Input:  data/raw/campaign_finance/ie_support_oppose.json — the State Board of Elections
        "Independent Expenditure – Search Candidates to Support or Oppose" results for
        Jan 1, 2025 – Nov 13, 2026, saved from
        https://publicreporting.elections.ny.gov/IESchedRSupportOppose/IESchedRSupportOppose
        data/<chamber>/campaign_finance.json (to link a spending entry to a candidate row).
Output: data/<chamber>/outside_money.json
    {retrieved, source, districts: {district: [{candidate, filerId, support, oppose,
      committees: [[committee, filerId, "Support"|"Oppose", amount, entries, firstDate, lastDate]]}]}}

Identical entries (same committee, candidate, amount, date and description) are counted once:
they are usually the same notice filed again.
"""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OFFICE = {"Member of Assembly": "assembly", "State Senator": "senate"}
SUFFIX = {"jr", "sr", "ii", "iii", "iv"}


def tokens(name):
    return [w for w in re.split(r"[^a-z]+", name.lower()) if len(w) > 1 and w not in SUFFIX]


def same_person(a, b):
    la, lb = tokens(a), tokens(b)
    if not la or not lb:
        return False
    sur = la[-1] in lb or lb[-1] in la
    return sur and la[0][0] == lb[0][0]


def money(s):
    return float(re.sub(r"[^0-9.\-]", "", s or "0") or 0)


def iso(s):
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else None


def main():
    raw = json.load(open(os.path.join(ROOT, "data/raw/campaign_finance/ie_support_oppose.json")))
    seen = set()
    by = {"assembly": {}, "senate": {}}
    dupes = 0
    for r in raw["rows"]:
        _, comm, cid, cand, year, office, dist, so, desc, amt, date = r
        ch = OFFICE.get(office.strip())
        if not ch or not dist.strip():
            continue
        key = (comm, cid, cand, amt, date, desc, so)
        if key in seen:
            dupes += 1
            continue
        seen.add(key)
        d = str(int(dist))
        cand = re.sub(r"\s+", " ", cand).strip()
        c = by[ch].setdefault(d, {}).setdefault(cand, {})
        k = (comm.strip(), str(cid), so)
        e = c.setdefault(k, [0.0, 0, None, None])
        e[0] += money(amt); e[1] += 1
        dt = iso(date)
        e[2] = min(x for x in (e[2], dt) if x) if dt or e[2] else None
        e[3] = max(x for x in (e[3], dt) if x) if dt or e[3] else None
    for ch, dists in by.items():
        cf = json.load(open(os.path.join(ROOT, f"data/{ch}/campaign_finance.json")))
        out = {}
        for d, cands in dists.items():
            merged = {}
            for cand, comms in cands.items():
                hit = next((x for x in cf["districts"].get(d, []) if same_person(x["name"], cand)), None)
                m = merged.setdefault(hit["filerId"] if hit else "name:" + cand, {"candidate": hit["name"] if hit else cand, "filerId": hit["filerId"] if hit else None, "c": {}})
                for k, v in comms.items():
                    e = m["c"].setdefault(k, [0.0, 0, None, None])
                    e[0] += v[0]; e[1] += v[1]
                    e[2] = min(x for x in (e[2], v[2]) if x) if (e[2] or v[2]) else None
                    e[3] = max(x for x in (e[3], v[3]) if x) if (e[3] or v[3]) else None
            rows = []
            for m in merged.values():
                cl = sorted(([k[0], k[1], k[2], round(v[0], 2), v[1], v[2], v[3]] for k, v in m["c"].items()), key=lambda x: -x[3])
                rows.append({"candidate": m["candidate"], "filerId": m["filerId"],
                             "support": round(sum(x[3] for x in cl if x[2] == "Support"), 2),
                             "oppose": round(sum(x[3] for x in cl if x[2] == "Oppose"), 2), "committees": cl})
            rows.sort(key=lambda x: -(x["support"] + x["oppose"]))
            out[d] = rows
        json.dump({"retrieved": raw["retrieved"][:10], "source": raw["source"], "range": raw.get("query"),
                   "districts": out}, open(os.path.join(ROOT, f"data/{ch}/outside_money.json"), "w"), separators=(",", ":"))
        tot = sum(x["support"] + x["oppose"] for v in out.values() for x in v)
        linked = sum(1 for v in out.values() for x in v if x["filerId"])
        n = sum(len(v) for v in out.values())
        print(f"{ch}: {len(out)} districts, {n} candidates ({linked} linked), ${tot:,.0f}")
    print("identical entries skipped:", dupes)


if __name__ == "__main__":
    main()
