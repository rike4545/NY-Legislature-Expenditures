#!/usr/bin/env python3
"""ZIP code -> Assembly and Senate district, for estimating in-district campaign donors.

Usage:
    python3 scripts/build_zip_districts.py <Census ZCTA gazetteer .txt>

Each New York ZIP Code Tabulation Area is placed in the district that contains its internal point
(Census INTPTLAT/INTPTLONG). A ZIP that straddles a district line counts entirely toward the district
holding its internal point, so in-district shares built on this are estimates.

Input:  Census Bureau Gazetteer, ZCTA national file (e.g. 2023_Gaz_zcta_national.txt)
        data/geo/{assembly,senate}-districts.geojson
Output: data/geo/zip_districts.json  {zip: [assemblyDistrict, senateDistrict]}
"""
import csv
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def rings(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return polys


def inside(pt, polys):
    x, y = pt
    for poly in polys:
        hit = False
        for ring in poly:  # outer ring and holes: even-odd rule
            n = len(ring)
            j = n - 1
            for i in range(n):
                xi, yi = ring[i][0], ring[i][1]
                xj, yj = ring[j][0], ring[j][1]
                if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                    hit = not hit
                j = i
        if hit:
            return True
    return False


def load(chamber):
    out = []
    for f in json.loads((ROOT / f"data/geo/{chamber}-districts.geojson").read_text())["features"]:
        polys = rings(f["geometry"])
        xs = [p[0] for poly in polys for p in poly[0]]; ys = [p[1] for poly in polys for p in poly[0]]
        out.append((int(f["properties"]["DISTRICT"]), (min(xs), min(ys), max(xs), max(ys)), polys))
    return out


def main():
    gaz = pathlib.Path(sys.argv[1])
    asm, sen = load("assembly"), load("senate")
    rows = csv.DictReader(open(gaz, encoding="utf-8"), delimiter="\t")
    out = {}
    for r in rows:
        r = {k.strip(): v.strip() for k, v in r.items()}
        lat, lon = float(r["INTPTLAT"]), float(r["INTPTLONG"])
        if not (40.4 <= lat <= 45.1 and -79.9 <= lon <= -71.7):
            continue
        hit = []
        for layer in (asm, sen):
            d = next((d for d, (x0, y0, x1, y1), polys in layer if x0 <= lon <= x1 and y0 <= lat <= y1 and inside((lon, lat), polys)), None)
            hit.append(d)
        if hit[0] or hit[1]:
            out[r["GEOID"]] = hit
    (ROOT / "data/geo/zip_districts.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(out)} New York ZIP codes placed; {sum(1 for v in out.values() if v[0])} in an Assembly district, "
          f"{sum(1 for v in out.values() if v[1])} in a Senate district")


if __name__ == "__main__":
    main()
