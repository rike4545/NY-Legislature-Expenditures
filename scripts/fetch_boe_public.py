"""Refresh the two State Board of Elections lists the site reads from publicreporting.elections.ny.gov.

    data/raw/campaign_finance/pcfb_candidate_list_2026.json  Public Campaign Finance candidate list (2026)
    data/raw/campaign_finance/ie_support_oppose.json         Independent expenditures for/against candidates

Both pages load their tables from a JSON endpoint; this calls the same endpoints with the same
search the page's form sends, once each. Run from GitHub Actions (scheduled refresh).
"""
import json, os, sys, urllib.parse, urllib.request
from datetime import date, datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://publicreporting.elections.ny.gov"
UA = "NY-Legislature-Expenditures data refresh (+https://github.com/rike4545/NY-Legislature-Expenditures)"


def post(path, form):
    req = urllib.request.Request(BASE + path, data=urllib.parse.urlencode(form).encode(),
                                 headers={"User-Agent": UA, "X-Requested-With": "XMLHttpRequest",
                                          "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def save(name, payload, min_rows):
    if len(payload["rows"]) < min_rows:
        sys.exit(f"{name}: only {len(payload['rows'])} rows; keeping the previous file")
    p = os.path.join(ROOT, "data/raw/campaign_finance", name)
    json.dump(payload, open(p, "w"))
    print(name, len(payload["rows"]), "rows")


def main():
    now = datetime.now(timezone.utc).isoformat()
    old = json.load(open(os.path.join(ROOT, "data/raw/campaign_finance/pcfb_candidate_list_2026.json")))
    d = post("/PCFBCandidateRegList/GetPCFBCandidateRegListData", {"strElectYearId": "47", "strOfficeId": "", "strDistrict": ""})
    save("pcfb_candidate_list_2026.json", {"retrieved": now, "source": BASE + "/PCFBCandidateRegList/PCFBCandidateRegList",
                                           "header": old["header"], "rows": d["aaData"]}, int(len(old["rows"]) * 0.9))
    old = json.load(open(os.path.join(ROOT, "data/raw/campaign_finance/ie_support_oppose.json")))
    to = date.today().strftime("%m/%d/%Y")
    d = post("/IESchedRSupportOppose/BindIndExpData/", {"txtCandidateNameSO": "", "txtDateFrom": "01/01/2025", "txtDateTo": to})
    save("ie_support_oppose.json", {"retrieved": now, "source": BASE + "/IESchedRSupportOppose/IESchedRSupportOppose",
                                    "query": {"from": "01/01/2025", "to": to}, "header": old["header"], "rows": d["aaData"]},
         int(len(old["rows"]) * 0.9))


if __name__ == "__main__":
    main()
