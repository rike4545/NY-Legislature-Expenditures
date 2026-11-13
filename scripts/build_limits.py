"""2026 contribution limits for Senate and Assembly candidates, from the State Board of Elections.

Input:  data/raw/elections/2026-contribution-limits.pdf
        (https://elections.ny.gov/system/files/documents/2026/04/2026-contribution-limits.pdf)
Output: data/limits_2026.json
    {source, year, notes, senate|assembly: {nonFamily: {primary, general}, familyPrimaryDefault,
      familyPrimary: {district: {party: amount}}, familyGeneral: {district: amount}}}
Needs `pdftotext` (poppler-utils).
"""
import json, os, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, "data/raw/elections/2026-contribution-limits.pdf")
URL = "https://elections.ny.gov/system/files/documents/2026/04/2026-contribution-limits.pdf"


def amt(s):
    return float(s.replace("$", "").replace(",", ""))


def main():
    text = subprocess.run(["pdftotext", "-layout", PDF, "-"], capture_output=True, text=True, check=True).stdout
    out = {"source": URL, "page": "https://elections.ny.gov/contribution-limits", "year": 2026,
           "notes": ["Limits apply to all candidates, whether or not they take part in the Public Campaign Finance Program.",
                     "Each primary, general or special election has its own limit; candidates get one primary non-family limit regardless of the number of primary contests.",
                     "Family means the candidate's child, parent, grandparent, brother or sister and their spouses; the family limit is shared among them.",
                     "Corporations and LLCs may give no more than $5,000 in all per calendar year."]}
    chamber = section = None
    for line in text.splitlines():
        u = line.upper()
        if "SENATE CONTRIBUTION LIMITS" in u:
            chamber = "senate"
        elif "ASSEMBLY CONTRIBUTION LIMITS" in u:
            chamber = "assembly"
        elif "SUPREME COURT" in u or "STATEWIDE CONTRIBUTION LIMITS" in u:
            chamber = None
        if not chamber:
            continue
        c = out.setdefault(chamber, {"nonFamily": {}, "familyPrimaryDefault": None, "familyPrimary": {}, "familyGeneral": {}})
        if "PRIMARY ELECTION" in u:
            section = "primary"
        elif "GENERAL/SPECIAL ELECTION LIMITS" in u:
            section = "general"
        m = re.search(r"NON-FAMILY\**\s+(\$[\d,]+(?:\.\d+)?)", line)
        if m and section:
            c["nonFamily"][section] = amt(m.group(1))
            continue
        m = re.search(r"family limit for an? \w+ Primary is (\$[\d,]+)", line, re.I)
        if m:
            c["familyPrimaryDefault"] = amt(m.group(1))
            continue
        m = re.match(r"\s*(\d{1,3})\s+(\$[\d,]+\.\d\d)\s*(Democratic|Republican|Conservative|Working Families)?\s*$", line)
        if m and section:
            d, a, party = m.group(1), amt(m.group(2)), m.group(3)
            if section == "primary" and party:
                c["familyPrimary"].setdefault(d, {})[party] = a
            elif section == "general" and not party:
                c["familyGeneral"][d] = a
    for ch, n in (("senate", 63), ("assembly", 150)):
        c = out[ch]
        assert len(c["familyGeneral"]) == n, (ch, len(c["familyGeneral"]))
        assert c["nonFamily"].get("primary") and c["nonFamily"].get("general") and c["familyPrimaryDefault"]
        print(ch, c["nonFamily"], "primary family default", c["familyPrimaryDefault"],
              len(c["familyPrimary"]), "districts with higher primary family limits")
    json.dump(out, open(os.path.join(ROOT, "data/limits_2026.json"), "w"), separators=(",", ":"))


if __name__ == "__main__":
    main()
