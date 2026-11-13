#!/usr/bin/env python3
"""Vendors the Legislature pays that also gave to legislative candidates' campaigns.

Usage:
    python3 scripts/build_vendor_donors.py     (after build_data.py and build_donations.py)

Vendors: every payee on a non-payroll line (maintenance & operations, travel) in every Assembly and
Senate expenditure report on the site. Donors: every organization (schedules B and C) that gave to a
2025-26 Assembly or Senate candidate's linked committee (data/raw/campaign_finance/org_donors.json).

A vendor and a donor match when their names are the same after normalizing case, punctuation and
business suffixes (Inc, LLC, Corp, Co, LLP, PLLC, PC, Ltd, The), or when the donor is the vendor's own
PAC ("<vendor> PAC" / "<vendor> Political Action Committee"). Nothing fuzzier is matched, so some real
links are missed and every match listed can be checked by name.

Output: data/vendor_donors.json
    {asOf, matches: [{vendor, donors: [names], how, paid: {assembly, senate}, offices: [[chamber, office, amount]],
      donated, gifts, recipients: [[chamber, district, candidate, amount, ownOffice]], ownOffice}]}
    ownOffice: the candidate is the member whose own office paid the vendor (surname in the office name).
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SUFFIX = r"\b(INCORPORATED|INC|LLC|L L C|LLP|PLLC|PC|P C|CORPORATION|CORP|CO|COMPANY|LTD|LIMITED|THE|NA|N A)\b"
PAC = r"\b(PAC|POLITICAL ACTION COMMITTEE|POLITICAL ACTION FUND|EMPLOYEES? PAC|EMPLOYEES)\b"


def norm(s: str) -> str:
    s = s.upper().replace("&", " AND ")
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)
    s = re.sub(SUFFIX, " ", s)
    return re.sub(r"\s+", " ", s).strip()


def main():
    chambers = json.loads((ROOT / "data/chambers.json").read_text())
    vendors = {}
    for ch in chambers:
        for pm in ch["periods"]:
            d = json.loads((ROOT / pm["file"]).read_text())
            types = d["types"]; units = d["units"]; payees = d["payees"]
            for r in d["rows"]:
                if types[r[1]]["group"] not in ("mo", "travel") or r[8] <= 0:
                    continue
                name = payees[r[4]]
                k = norm(name)
                if len(k) < 4:
                    continue
                v = vendors.setdefault(k, {"name": name, "paid": {"assembly": 0.0, "senate": 0.0}, "offices": {}})
                v["paid"][ch["id"]] += r[8]
                ok = (ch["id"], units[r[0]]["name"])
                v["offices"][ok] = v["offices"].get(ok, 0) + r[8]
    donors = json.loads((ROOT / "data/raw/campaign_finance/org_donors.json").read_text())
    byvendor = {}
    for dkey, dn in donors.items():
        n = norm(dn["name"])
        how, vk = None, None
        if n in vendors:
            how, vk = "same name", n
        else:
            stripped = re.sub(r"\s+", " ", re.sub(PAC, " ", n)).strip()
            if stripped != n and len(stripped) >= 4 and stripped in vendors:
                how, vk = "vendor's PAC", stripped
        if not vk:
            continue
        m = byvendor.setdefault(vk, {"vendor": vendors[vk]["name"], "donors": [], "how": set(), "donated": 0.0, "gifts": 0, "to": {}})
        m["donors"].append(dn["name"]); m["how"].add(how); m["donated"] += dn["amount"]; m["gifts"] += dn["gifts"]
        for k, amt in dn["to"].items():
            m["to"][k] = round(m["to"].get(k, 0) + amt, 2)
    matches = []
    for vk, m in byvendor.items():
        v = vendors[vk]
        offices = sorted(([c, o, round(a, 2)] for (c, o), a in v["offices"].items()), key=lambda x: -x[2])
        recips = []
        for k, amt in sorted(m["to"].items(), key=lambda x: -x[1]):
            chamber, district, cand = k.split(":", 2)
            sur = [w for w in re.split(r"[^A-Z]+", cand.upper()) if len(w) > 2]
            # the member whose own office paid this vendor also received its donation
            own = any(c == chamber and any(w in o.upper() for w in sur[-1:]) for c, o, _ in offices)
            recips.append([chamber, int(district), cand, amt, own])
        matches.append({"vendor": v["name"], "donors": sorted(set(m["donors"])), "how": " and ".join(sorted(m["how"])),
                        "paid": {k: round(x, 2) for k, x in v["paid"].items()}, "offices": offices[:6],
                        "donated": round(m["donated"], 2), "gifts": m["gifts"], "recipients": recips,
                        "ownOffice": any(r[4] for r in recips)})
    matches.sort(key=lambda m: -(m["paid"]["assembly"] + m["paid"]["senate"]))
    as_of = json.loads((ROOT / "data/senate/donations.json").read_text())["asOf"]
    (ROOT / "data/vendor_donors.json").write_text(json.dumps({"asOf": as_of, "matches": matches}, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(vendors):,} vendors, {len(donors):,} organizational donors, {len(matches)} vendors also donated; "
          f"{sum(1 for m in matches if m['ownOffice'])} gave to a member whose own office paid them")
    for m in matches:
        print(f"  {m['vendor'][:36]:36} A ${m['paid']['assembly']:>10,.0f} S ${m['paid']['senate']:>10,.0f} | gave ${m['donated']:>8,.0f} to {len(m['recipients'])} ({m['how']}){' OWN OFFICE' if m['ownOffice'] else ''}")


if __name__ == "__main__":
    main()
