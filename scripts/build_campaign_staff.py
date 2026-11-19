#!/usr/bin/env python3
"""Campaign staff: people each candidate's committees paid in 2025-26, and whether they're on a legislative payroll.

Usage:
    python3 scripts/build_campaign_staff.py --fetch   (refresh the snapshot from data.ny.gov, then build)
    python3 scripts/build_campaign_staff.py           (build from the committed snapshot)
Run after build_campaign_finance.py, which links committees to candidates.

Source: NYS Board of Elections, Disclosure Reports: Expenditures (schedule F), data.ny.gov dataset ajsb-8pni,
    election years 2025 and 2026, for the committees in data/<chamber>/campaign_finance.json.
Snapshot: data/raw/campaign_finance/staff_payments.json (only the staff-type payments kept below)

Which payments count. A payment counts when it went to a person (not a business, payroll company or
government office, judged by the payee's name; for any payment but wages, the first name must also be
one that individual contributors in the 2025-26 filings use, data/raw/campaign_finance/given_names.json) and its purpose is Wages, Campaign Workers' Salaries,
Campaign Consultant, Petition Expenses or Professional Services, or "Other" with an explanation that
describes staff work (stipend, canvassing, field work, consulting...). Payments whose explanation says
they were for legal, accounting, photography, printing, design and similar services, or reimbursements,
are left out. Payments to payroll companies (Gusto, ADP, Paychex...) and payroll taxes are counted per
candidate as one total, since the filing doesn't name the workers.

Payroll match. Each person is looked up by name in
    the Senate biweekly payroll (data/senate/payroll.json, every report since 2010), and
    the Assembly's two latest expenditure reports (staff pay by office, data/assembly/periods/).
A match needs the same last name and the same first name (or a common short form: Chris/Christopher).
Spelling variants and short forms that differ more are kept as unverified, with no office shown.
Payroll records that ended before 2024 are ignored as likely a different person with the same name.
"Current" means on the latest Senate payroll report, or on the latest Assembly report's payroll and
still there at its end (status not I).

Output: data/<chamber>/campaign_staff.json
    {asOf, payrollAsOf: {senate, assembly}, source,
     districts: {district: {filerId: {processor, people: [[name, amount, payments, first, last, type, match]]}}}}
    match is null, or {v: verified (bool), ch, office, title, own (candidate's own office), cur, from, to, key}
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
SNAP = RAW / "staff_payments.json"
GIVEN = RAW / "given_names.json"
API = "https://data.ny.gov/resource/ajsb-8pni.json"
CONTRIB_API = "https://data.ny.gov/resource/4j2b-6a2j.json"
PURPOSES = ["Wages", "Campaign Workers' Salaries", "Campaign Consultant", "Petition Expenses",
            "Professional Services", "Other: Must Provide Explanation"]
KEEP = ["filer_id", "trans_number", "flng_ent_name", "flng_ent_first_name", "flng_ent_last_name",
        "sched_date", "org_amt", "purpose_code_desc", "trans_explntn"]

ORG = re.compile(r"\b(LLC|L\.L\.C|LLP|PLLC|INC|CORP|CO|COMPANY|GROUP|STRATEG\w*|CONSULT\w*|ASSOC\w*|PARTNERS?\w*|MEDIA|"
                 r"COMMUNICATIONS?|SOLUTIONS?|SERVICES?|GUSTO|ADP|PAYCHEX|ONPAY|PAYROLL|BANK|NYS|STATE|DEPARTMENT|DEPT|"
                 r"TREASUR\w*|COMMITTEE|PARTY|FUND|PAC|CAMPAIGNS?|NETWORK|AGENCY|CENT(ER|RE)|PC|ESQ|LAW|FIRM|"
                 r"ENTERPRISES?|PRINT\w*|DESIGNS?|DIGITAL|MARKETING|PUBLIC|AFFAIRS|PROMOTIONS?|PRODUCTIONS?|ADVIS\w*|"
                 r"COMPLIANCE|WORKS|STUDIOS?|HOLDINGS|VENTURES|INTERNATIONAL|AMERICA|OF|THE|AND|HOUSE|MANAGEMENT|"
                 r"FEDERAL|IRS|INSURANCE|UNION|LOCAL|CLUB|DEMOCRATIC|REPUBLICAN|CONSERVATIVE|FAMILIES|ACCOUNT\w*|TAX|"
                 r"BOOKKEEP\w*|ELECTIONS?|BOARD|INSTITUTE|FOUNDATION|LEAGUE|OFFICE|SYSTEMS?|TECH\w*|DATA|POLLING|"
                 r"RESEARCH|ANALYTICS|ACTION|COALITION|PROJECT|AMAZON|GOOGLE|PAYPAL|VENMO|SQUARE|STRIPE|ACTBLUE|"
                 r"WINRED|LOGIC|LABS?|SOCIAL|EVENTS?|PHOTO\w*|VIDEO|FILMS?|MUSIC|CATERING|INTERPRETATION|"
                 r"TRANSLATIONS?|CONSTRUCTION|REALTY|PROPERTIES|TRUST|SOCIETY|COUNCIL|CORPORATION|LTD|DEPOT|TIMES|NEWS|JOURNAL|"
                 r"EMBROIDERY|PHARMACY|READE|SUITE|PRESS|CREATIVE|FRAMES|CLEANERS|EXCHANGE|RESTAURANT|LINK|CONSUTLING|"
                 r"STORE|SHOP|SUPERMARKET|HARDWARE|AIRLINES?|AIRPORT|TRANSIT|CAUCUS|FEDERATION|AFL|CIO|GUARD|MUTUAL|"
                 r"FINANCIAL|SOFTWARE|SUBSCRIPTION|INDUSTRIES|ATHLETICS|ALLIANCE|SECURITY|GRAPHICS|APPAREL|INK|"
                 r"TO|FOR|FLORIST|CAR|AUDIO|CPA|ARTE|LIMITED|SALON|SPA|CAFE|DELI|PIZZA|GRILL|BAKERY|DINER|TAVERN)\b|[&\d@]", re.I)
PROC = re.compile(r"GUSTO|\bADP\b|PAYCHEX|ONPAY|PAYROLL|UNEMPLOYMENT|WORKERS COMP|INTERNAL REVENUE|\bIRS\b|EFTPS|"
                  r"DEPARTMENT OF TAX|DEPT OF TAX|TAXATION|NYS DTF", re.I)
STAFF_EXPL = re.compile(r"stipend|salar|wage|payroll|canvass|field|organiz|consult|manager|director|coordinator|petition|"
                        r"labor|compensation|services rendered|fellow|door ?knock|lit drop|phone bank|scheduler|driver|"
                        r"poll ?watch|election day|gotv|staff|campaign work", re.I)
NOT_STAFF = re.compile(r"attorney|legal|lawyer|\blaw\b|photograph|\bcpa\b|accountant|accounting|tax prep|audit|design|"
                       r"graphic|print|video|film|web ?site|web dev|translat|cater|\bdj\b|music|band|perform|entertain|"
                       r"rent|reimburs|lunch|dinner|meal|food|gift|party|holiday", re.I)
SFX = {"JR", "SR", "II", "III", "IV", "V", "ESQ", "MR", "MS", "MRS", "DR"}
NICK = {"CHRIS": "CHRISTOPHER", "MIKE": "MICHAEL", "JOE": "JOSEPH", "BILL": "WILLIAM", "WILL": "WILLIAM",
        "BOB": "ROBERT", "ROB": "ROBERT", "JIM": "JAMES", "TOM": "THOMAS", "DAN": "DANIEL", "DAVE": "DAVID",
        "STEVE": "STEVEN", "MATT": "MATTHEW", "NICK": "NICHOLAS", "TONY": "ANTHONY", "ALEX": "ALEXANDER",
        "KATIE": "KATHERINE", "KATE": "KATHERINE", "JEN": "JENNIFER", "LIZ": "ELIZABETH", "BETH": "ELIZABETH",
        "SAM": "SAMUEL", "BEN": "BENJAMIN", "ANDY": "ANDREW", "GREG": "GREGORY", "TIM": "TIMOTHY", "PAT": "PATRICK",
        "JON": "JONATHAN", "JAKE": "JACOB", "ED": "EDWARD", "RICH": "RICHARD", "RICK": "RICHARD", "KEN": "KENNETH",
        "RAY": "RAYMOND", "JEFF": "JEFFREY", "DOUG": "DOUGLAS", "PETE": "PETER", "PHIL": "PHILIP", "ABBY": "ABIGAIL",
        "MAGGIE": "MARGARET", "DEB": "DEBORAH", "SUE": "SUSAN", "ZACH": "ZACHARY"}


def up(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().upper()


def tokens_first_last(name: str) -> list:
    """'First M Last' or 'Last, First' -> [first, ..., last] without suffixes."""
    n = re.sub(r"[.]", " ", up(name))
    if "," in n:
        a, b = n.split(",", 1)
        n = b + " " + a
    return [w for w in n.split() if w not in SFX]


def payroll_name(name: str):
    """'LAST JR, FIRST M' -> (first tokens, last tokens)."""
    a, _, b = re.sub(r"[.]", " ", up(name)).partition(",")
    return [w for w in b.split() if w not in SFX], [w for w in a.split() if w not in SFX]


def is_person(name: str, given: set, wages: bool) -> bool:
    """A payee looks like a person: no business words, 2-5 name-like words, and (unless the payment was
    wages) a first name that individual contributors in the same filings use."""
    n = up(name).strip()
    if not n or ORG.search(n) or "'S " in n + " ":
        return False
    t = [w for w in re.split(r"[\s,]+", n) if w]
    if not (2 <= len(t) <= 5 and all(re.fullmatch(r"[A-Z][A-Z'.\-]*", w) for w in t)):
        return False
    first = tokens_first_last(name)[0]
    return wages or (len(first) > 1 and (first in given or first in NICK))


def payment_type(x):
    """The kind of staff payment, or None when it isn't one."""
    p, e = x.get("purpose_code_desc") or "", x.get("trans_explntn") or ""
    if p in ("Wages", "Campaign Workers' Salaries"):
        return "Wages"
    if NOT_STAFF.search(e):
        return None
    if p == "Campaign Consultant":
        return "Consultant"
    if p == "Petition Expenses":
        return "Petitioning"
    if p == "Professional Services":
        return "Professional services"
    if p in ("Other: Must Provide Explanation", "") and STAFF_EXPL.search(e):
        return "Other staff work"
    return None


def lev1(a: str, b: str) -> bool:
    """Edit distance of at most 1."""
    if abs(len(a) - len(b)) > 1:
        return False
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] <= 1


def name_match(t: list, first: list, last: list):
    """'exact', 'variant' or None for campaign tokens t against a payroll name."""
    if len(t) < 2 or not first or not last:
        return None
    if not (t[-1] in last or " ".join(t[1:]) == " ".join(last)):
        return None
    a, b = t[0], first[0]
    if a == b or NICK.get(a, a) == NICK.get(b, b) or (len(first) > 1 and first[1] == a):
        return "exact"
    if (len(a) >= 4 and len(b) >= 4 and lev1(a, b)) or (min(len(a), len(b)) >= 3 and (a.startswith(b) or b.startswith(a))):
        return "variant"
    return None


def fetch(committees) -> None:
    ids = sorted(committees)
    rows = []
    for i in range(0, len(ids), 60):
        where = ("election_year in ('2025','2026') AND filer_id in (%s) AND purpose_code_desc in (%s)"
                 % (",".join(f"'{x}'" for x in ids[i:i + 60]), ",".join("'%s'" % p.replace("'", "''") for p in PURPOSES)))
        off = 0
        while True:
            q = {"$where": where, "$select": ",".join(KEEP), "$limit": "50000", "$offset": str(off), "$order": "filer_id,trans_number"}
            with urllib.request.urlopen(API + "?" + urllib.parse.urlencode(q), timeout=600) as r:
                got = json.load(r)
            rows += got
            off += len(got)
            if len(got) < 50000:
                break
    seen, keep = set(), []
    for x in rows:
        k = (x["filer_id"], x.get("trans_number"))
        if k in seen:
            continue
        seen.add(k)
        nm = (x.get("flng_ent_name") or " ".join(filter(None, [x.get("flng_ent_first_name"), x.get("flng_ent_last_name")]))).strip()
        x["name"] = re.sub(r"\s+", " ", nm)
        if payment_type(x) or (PROC.search(nm) and x.get("purpose_code_desc") in ("Wages", "Campaign Workers' Salaries", "Other: Must Provide Explanation")):
            keep.append({k2: x.get(k2) for k2 in ("filer_id", "trans_number", "name", "sched_date", "org_amt", "purpose_code_desc", "trans_explntn")})
    RAW.mkdir(parents=True, exist_ok=True)
    q = {"$query": "SELECT upper(flng_ent_first_name) as f, count(*) as n WHERE election_year in ('2025','2026') "
                   "AND filing_sched_abbrev='A' AND flng_ent_first_name IS NOT NULL GROUP BY f HAVING count(*) >= 3 LIMIT 100000"}
    with urllib.request.urlopen(CONTRIB_API + "?" + urllib.parse.urlencode(q), timeout=600) as r:
        names = sorted({re.sub(r"[^A-Z'\-]", "", up(x["f"])) for x in json.load(r)} - {""})
    GIVEN.write_text(json.dumps(names, separators=(",", ":")))
    SNAP.write_text(json.dumps({"asOf": date.today().isoformat(), "rows": keep}, separators=(",", ":")))


def main() -> None:
    committees = {}
    for ch in ("senate", "assembly"):
        cf = json.loads((ROOT / f"data/{ch}/campaign_finance.json").read_text())
        for dist, cands in cf["districts"].items():
            for c in cands:
                for cid, _cname, _ctype in c["committees"]:
                    committees[cid] = (ch, dist, c["filerId"], c["name"])
    if "--fetch" in sys.argv:
        fetch(committees)
    snap = json.loads(SNAP.read_text())
    # First names of individual contributors (schedule A, 2025-26, used 3+ times) and of legislative staff.
    given = {n for n in json.loads(GIVEN.read_text()) if len(n) > 1}

    # Senate payroll: every report since 2010.
    pr = json.loads((ROOT / "data/senate/payroll.json").read_text())
    last = len(pr["reports"]) - 1
    sen_asof = pr["reports"][last][0]   # the latest report, named by its pay period end, as the site does
    sen = {}
    for pname, segs in pr["people"].items():
        f, l = payroll_name(pname)
        given.update(f[:1])
        for lw in {" ".join(l), *l}:
            sen.setdefault(lw, []).append((pname, f, l, segs))

    # Assembly payroll: staff pay lines in the two latest expenditure reports.
    chambers = json.loads((ROOT / "data/chambers.json").read_text())
    aper = sorted([p for c in chambers if c["id"] == "assembly" for p in c["periods"]], key=lambda p: p["end"])[-2:]
    asm_rec = {}
    asm_asof = ""
    for i, pm in enumerate(aper):
        d = json.loads((ROOT / pm["file"]).read_text())
        latest = i == len(aper) - 1
        if latest:
            asm_asof = d["meta"]["payWindow"][1]
        for s in d["salaries"]:
            asm_rec.setdefault(d["payees"][s[1]], []).append(
                {"unit": d["units"][s[0]]["name"], "title": s[2], "from": s[3], "to": s[4], "status": s[8], "latest": latest})
    asm = {}
    for pname, recs in asm_rec.items():
        f, l = payroll_name(pname)
        given.update(f[:1])
        for lw in {" ".join(l), *l}:
            asm.setdefault(lw, []).append((pname, f, l, recs))

    def lookups(t, idx):
        found = {}
        for lw in {t[-1], " ".join(t[1:]), " ".join(t[-2:])}:
            for c in idx.get(lw, []):
                found[c[0]] = c
        return found.values()

    def own_office(cand, office, chamber):
        last_name = re.sub(r"[^A-Z ]", "", up(cand)).split()[-1]
        o = re.sub(r"[^A-Z ]", " ", up(office)).split()
        return (o[:1] == ["SENATOR"] and last_name in o) if chamber == "senate" else o[:1] == [last_name]

    def best_match(t, cand):
        out = []
        for pname, f, l, segs in lookups(t, sen):
            how = name_match(t, f, l)
            if not how:
                continue
            g = max(segs, key=lambda s: s[5])
            office = pr["offices"][g[0]]
            to = pr["reports"][g[5]][0]
            frm = pr["reports"][min(s[4] for s in segs if s[0] == g[0])][0]
            out.append({"v": how == "exact", "ch": "senate", "office": office, "title": pr["titles"][g[1]],
                        "own": own_office(cand, office, "senate"), "cur": g[5] == last, "from": frm, "to": to, "key": pname})
        for pname, f, l, recs in lookups(t, asm):
            how = name_match(t, f, l)
            if not how:
                continue
            r = max(recs, key=lambda x: (x["latest"], x["to"]))
            frm = min(x["from"] for x in recs if x["unit"] == r["unit"])
            out.append({"v": how == "exact", "ch": "assembly", "office": r["unit"], "title": r["title"],
                        "own": own_office(cand, r["unit"], "assembly"),
                        "cur": r["latest"] and r["status"] != "I" and r["to"] >= asm_asof[:8] + "01", "from": frm, "to": r["to"], "key": pname})
        out = [m for m in out if m["to"] >= "2024-01-01"]
        if not out:
            return None
        return sorted(out, key=lambda m: (not m["v"], not m["cur"], not m["own"]))[0]

    agg = {}
    for x in snap["rows"]:
        if x["filer_id"] not in committees:
            continue
        ch, dist, fid, cand = committees[x["filer_id"]]
        c = agg.setdefault((ch, dist, fid, cand), {"processor": 0.0, "people": {}})
        amt = float(x.get("org_amt") or 0)
        nm = x["name"]
        if PROC.search(nm):
            if x.get("purpose_code_desc") in ("Wages", "Campaign Workers' Salaries", "Other: Must Provide Explanation"):
                c["processor"] += amt
            continue
        typ = payment_type(x)
        if not typ or not is_person(nm, given, typ == "Wages"):
            continue
        t = tokens_first_last(nm)
        p = c["people"].setdefault(" ".join(t), {"name": nm.title() if nm.isupper() or nm.islower() else nm,
                                                  "t": t, "amt": 0.0, "n": 0, "first": "", "last": "", "types": {}})
        p["amt"] += amt
        p["n"] += 1
        p["types"][typ] = p["types"].get(typ, 0) + amt
        d = (x.get("sched_date") or "")[:10]
        if d:
            p["first"] = min(p["first"] or d, d)
            p["last"] = max(p["last"], d)

    out = {"senate": {}, "assembly": {}}
    counts = {"senate": [0, 0], "assembly": [0, 0]}
    for (ch, dist, fid, cand), c in agg.items():
        people = []
        for p in c["people"].values():
            if p["amt"] <= 0:
                continue
            m = best_match(p["t"], cand)
            typ = max(p["types"], key=p["types"].get)
            people.append([p["name"], round(p["amt"], 2), p["n"], p["first"], p["last"], typ, m])
            counts[ch][0] += 1
            counts[ch][1] += bool(m and m["v"] and m["cur"])
        people.sort(key=lambda r: -r[1])
        if people or c["processor"]:
            out[ch].setdefault(str(int(dist)), {})[fid] = {"processor": round(c["processor"], 2), "people": people}

    for ch in ("senate", "assembly"):
        (ROOT / f"data/{ch}/campaign_staff.json").write_text(json.dumps({
            "asOf": snap["asOf"], "payrollAsOf": {"senate": sen_asof, "assembly": asm_asof},
            "source": "NYS Board of Elections, Disclosure Reports: Expenditures (data.ny.gov dataset ajsb-8pni); "
                      "NY Senate biweekly payroll; NYS Assembly expenditure reports",
            "districts": dict(sorted(out[ch].items(), key=lambda kv: int(kv[0])))}, separators=(",", ":")))
        print(f"{ch}: {counts[ch][0]} people paid, {counts[ch][1]} on a legislative payroll now (verified name)")


if __name__ == "__main__":
    main()
