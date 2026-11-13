"""Where to find each 2026 candidate's endorsements: Ballotpedia profile, campaign site, endorsements page.

Input:  data/raw/endorsements/candidates.json   every candidate on the 2026 ballot, with Ballotpedia link
        data/raw/endorsements/sites.tsv          campaign websites (from Ballotpedia) for sitting members
        data/raw/endorsements/pages/*.json       what fetch_endorsements.py found on those sites
Output: data/<chamber>/endorsement_links.json
    {retrieved, districts: {district: [{name, ballotpedia, site, page, years}]}}
`years` lists the election years the endorsements page mentions, so a page still showing an
earlier campaign's endorsements can be labeled. Endorser names are not extracted: campaigns
mostly show logos, often from several years, so the page is linked rather than summarized.
"""
import json, os, re
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "data/raw/endorsements")


def main():
    cands = json.load(open(os.path.join(DIR, "candidates.json")))
    sites = {}
    for line in open(os.path.join(DIR, "sites.tsv")):
        if line.strip():
            slug, site, *_ = line.rstrip("\n").split("\t")
            sites[slug] = None if site == "NONE" else site
    pages, fetched = {}, set()
    pdir = os.path.join(DIR, "pages")
    for f in os.listdir(pdir) if os.path.isdir(pdir) else []:
        r = json.load(open(os.path.join(pdir, f)))
        fetched.add(r.get("fetched", ""))
        if r.get("page") and r["page"].rstrip("/") != r["site"].rstrip("/"):
            text = " ".join(r["text"]) + " " + " ".join(i["alt"] + " " + i["src"] for i in r["images"])
            years = sorted({int(y) for y in re.findall(r"\b(20[12]\d)\b", text) if 2018 <= int(y) <= 2026}, reverse=True)
            pages[r["slug"]] = {"page": r["page"], "years": years}
    out = {"senate": defaultdict(list), "assembly": defaultdict(list)}
    for c in cands:
        slug = c["ballotpedia"].rsplit("/", 1)[-1] if c.get("ballotpedia") else None
        p = pages.get(slug, {})
        out[c["chamber"]][str(c["district"])].append({
            "name": c["name"], "member": c["member"], "ballotpedia": c.get("ballotpedia"),
            "site": sites.get(slug), "page": p.get("page"), "years": p.get("years", [])})
    for ch, d in out.items():
        json.dump({"retrieved": max(fetched) if fetched else None,
                   "note": "Campaign sites come from each candidate's Ballotpedia profile; they were looked up for sitting members only.",
                   "districts": d}, open(os.path.join(ROOT, f"data/{ch}/endorsement_links.json"), "w"), separators=(",", ":"))
        rows = [x for v in d.values() for x in v]
        print(ch, len(rows), "candidates;", sum(1 for x in rows if x["site"]), "campaign sites;", sum(1 for x in rows if x["page"]), "endorsements pages;",
              sum(1 for x in rows if x["page"] and 2026 in x["years"]), "mention 2026")


if __name__ == "__main__":
    main()
