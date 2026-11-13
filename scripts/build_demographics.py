#!/usr/bin/env python3
"""District demographics from the Census Bureau's American Community Survey, 2020-2024 5-year estimates.

Usage:
    python3 scripts/build_demographics.py

Input:  data/raw/census/acs2024_5yr_ny_legislative_districts.csv, extracted from the ACS table-based
        summary files (www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/), tables
        B01003 (total population), B19013 (median household income) and B17001 (poverty status), for
        New York's State Senate (summary level 610) and Assembly (620) districts.
Output: data/<chamber>/demographics.json  {district: {pop, popMoe, income, incomeMoe, poverty: [below, universe]}}
"""
import csv
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def num(v):
    try:
        x = float(v)
        return None if x < 0 else x  # the summary files use large negative codes for "not available"
    except ValueError:
        return None


def main():
    out = {"senate": {}, "assembly": {}}
    for r in csv.DictReader(open(ROOT / "data/raw/census/acs2024_5yr_ny_legislative_districts.csv")):
        g = r["GEO_ID"]
        chamber = "senate" if g.startswith("610U") else "assembly"
        d = str(int(g[-3:]))
        out[chamber][d] = {"pop": num(r["B01003_E001"]), "popMoe": num(r["B01003_M001"]), "income": num(r["B19013_E001"]),
                           "incomeMoe": num(r["B19013_M001"]), "poverty": [num(r["B17001_E002"]), num(r["B17001_E001"])]}
    for chamber, d in out.items():
        (ROOT / f"data/{chamber}/demographics.json").write_text(json.dumps({
            "source": "U.S. Census Bureau, American Community Survey 2020-2024 5-year estimates (tables B01003, B19013, B17001)",
            "vintage": "2024 ACS 5-year", "districts": d}, separators=(",", ":")))
        print(chamber, len(d), "districts")


if __name__ == "__main__":
    main()
