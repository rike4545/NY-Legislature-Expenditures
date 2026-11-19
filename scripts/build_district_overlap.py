#!/usr/bin/env python3
"""Which districts of the other chamber cover each district, and how much of it.

Usage:
    pip install shapely && python3 scripts/build_district_overlap.py   (after build_districts.py)

Input:  data/<chamber>/districts.json (district boundaries, 2024 lines)
Output: data/district_overlap.json
    {method, assembly: {district: [[senate district, share], ...]}, senate: {district: [[assembly district, share], ...]}}
share is the fraction of the district's land area that lies in the other district, rounded to
0.001; slivers under 1% (boundary noise along shared lines) are dropped. Area is measured in an
equal-area projection. Land area is a stand-in for people: a dense neighborhood can hold most of
a district's residents on a small share of its land.
"""
import json
import math
import pathlib

import numpy as np
import shapely
from shapely.geometry import shape
from shapely.strtree import STRtree

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIN_SHARE = 0.01


def equal_area(xy):
    # Lambert cylindrical equal-area, standard parallel 42N; fine for comparing shares within the state.
    k = math.cos(math.radians(42.0))
    r = 6371008.8
    return np.column_stack([np.radians(xy[:, 0]) * r * k, np.sin(np.radians(xy[:, 1])) * r / k])


def load(chamber):
    out = {}
    for d in json.loads((ROOT / f"data/{chamber}/districts.json").read_text()):
        g = shapely.transform(shape(d["geometry"]), equal_area)
        out[d["district"]] = g if g.is_valid else g.buffer(0)
    return out


def shares(a, b):
    ids = list(b)
    tree = STRtree([b[i] for i in ids])
    res = {}
    for da, ga in a.items():
        rows = []
        for j in tree.query(ga):
            share = ga.intersection(b[ids[j]]).area / ga.area
            if share >= MIN_SHARE:
                rows.append([ids[j], round(share, 3)])
        res[str(da)] = sorted(rows, key=lambda r: -r[1])
    return res


def main():
    asm, sen = load("assembly"), load("senate")
    out = {"method": "share of each district's land area inside each district of the other chamber (2024 lines); "
                     "overlaps under 1% dropped",
           "assembly": shares(asm, sen), "senate": shares(sen, asm)}
    (ROOT / "data/district_overlap.json").write_text(json.dumps(out, separators=(",", ":")))
    print("assembly:", sum(len(v) for v in out["assembly"].values()), "links; senate:",
          sum(len(v) for v in out["senate"].values()), "links")
    print("AD 1 ->", out["assembly"]["1"], "| SD 1 ->", out["senate"]["1"])


if __name__ == "__main__":
    main()
