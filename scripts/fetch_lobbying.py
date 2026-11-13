"""Fetch who reported lobbying each sitting legislator, 2025-26, from the state ethics commission data.

Source: Commission on Ethics and Lobbying in Government, "Lobbyist Bi-Monthly Reports: Beginning 2019"
        (data.ny.gov t9kf-dqbc). Each report lists the parties lobbied ("Senator ...",
        "Assembly Member ..."), the client, and the subjects.
The dataset is very large, so it is queried one member at a time (surname match within the
Senate/Assembly bodies) and the raw aggregates are cached in data/raw/lobbying/<chamber>/<district>.json.
build_lobbying.py turns the cache into the site's data.

    python3 scripts/fetch_lobbying.py [--workers 8] [--refresh | --max-age DAYS] [--like]
"""
import json, os, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://data.ny.gov/resource/t9kf-dqbc.json"
YEARS = "('2025','2026')"
BODIES = {"senate": "('NYS Senate','Senate Committee','NYS Legislature')", "assembly": "('NYS Assembly','Assembly Committee','NYS Legislature')"}
SUFFIX = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv"}


def surname(full):
    w = [x for x in full.replace(",", " ").split() if x.lower() not in SUFFIX]
    return w[-1] if w else full


PREFIX = {"senate": "Senator ", "assembly": "Assembly member "}


def variants(chamber, member, extra=()):
    """Exact party_name values used in the filings: '<prefix><name>' and its staff-member forms."""
    out = set()
    for m in {member, *extra}:
        out |= _variants(chamber, m)
    return sorted(out)


def _variants(chamber, member):
    names = {member}
    w = member.split()
    core = [x for x in w if not (len(x.rstrip(".")) == 1 and x.endswith("."))]  # drop middle initials
    names.add(" ".join(core))
    if w and w[-1].lower().rstrip(".") in ("jr", "sr", "ii", "iii"):
        names.add(" ".join(w[:-1]))
        names.add(" ".join(w[:-1]) + ", " + w[-1])
    out = set()
    for n in names:
        base = PREFIX[chamber] + n
        out |= {base, base + ", staff member", base + ", Staff Member", base + " - staff member", base + ", Staff"}
    return out


def same_person(a, b):
    ta = [x for x in a.lower().replace(".", " ").split() if len(x) > 1 and x not in SUFFIX]
    tb = [x for x in b.lower().replace(".", " ").split() if len(x) > 1 and x not in SUFFIX]
    if not ta or not tb:
        return False
    sa, sb = ta[-1].replace("-", ""), tb[-1].replace("-", "")
    return (sa == sb or sa in "".join(tb) or sb in "".join(ta))


def other_names(chamber, d, member):
    """Fuller spellings of the member's name from the campaign finance and public financing files."""
    names = set()
    for f, key in ((f"data/{chamber}/campaign_finance.json", "name"), (f"data/{chamber}/public_financing.json", "name")):
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            for c in json.load(open(p))["districts"].get(str(d), []):
                if same_person(c[key], member):
                    names.add(re.sub(r"\s+", " ", c[key]).strip())
    return names


def run(q):
    url = API + "?" + urllib.parse.urlencode({"$query": q})
    err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=200) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(err)


def fetch(chamber, d, member):
    out = os.path.join(ROOT, f"data/raw/lobbying/{chamber}/{d}.json")
    if os.path.exists(out) and "--refresh" not in sys.argv:
        try:
            fetched = json.load(open(out)).get("fetched", "1970-01-01")
            age = (time.time() - time.mktime(time.strptime(fetched, "%Y-%m-%d"))) / 86400
        except Exception:  # noqa: BLE001
            age = 1e9
        if "--max-age" not in sys.argv or age < float(sys.argv[sys.argv.index("--max-age") + 1]):
            return chamber, d, "cached"
    names = ", ".join("'" + v.replace("'", "''") + "'" for v in variants(chamber, member, other_names(chamber, d, member)))
    sel = f"SELECT party_name, contractual_client_name, lobbying_subjects, count(*) AS n WHERE reporting_year in {YEARS} AND "
    grp = " GROUP BY party_name, contractual_client_name, lobbying_subjects LIMIT 50000"
    try:
        rows = run(sel + f"party_name in ({names})" + grp)
        how = "exact"
        if not rows and "--like" in sys.argv:  # name spelled differently in the filings: slower surname search
            s = surname(member).replace("'", "''")
            rows = run(sel + f"government_body in {BODIES[chamber]} AND party_name like '%{s}%'" + grp)
            how = "surname"
    except RuntimeError as e:
        return chamber, d, f"failed: {e}"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump({"member": member, "match": how, "fetched": time.strftime("%Y-%m-%d"), "rows": rows}, open(out, "w"))
    return chamber, d, how, len(rows)


def main():
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 8
    jobs = []
    for chamber in ("senate", "assembly"):
        for x in json.load(open(os.path.join(ROOT, f"data/{chamber}/districts.json"))):
            if x.get("member") and x["member"] != "VACANT":
                jobs.append((chamber, x["district"], x["member"]))
    t0 = time.time()
    with ThreadPoolExecutor(workers) as ex:
        for f in as_completed([ex.submit(fetch, *j) for j in jobs]):
            print(*f.result(), f"{time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
