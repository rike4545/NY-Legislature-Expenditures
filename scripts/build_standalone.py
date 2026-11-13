#!/usr/bin/env python3
"""Bundle index.html, CSS, JS and data into one self-contained HTML file.

Usage:
    python3 scripts/build_standalone.py dist/assembly-expenditures.html

The result opens directly from disk (no server needed) and can be emailed or shared.
"""
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / "dist" / "assembly-expenditures.html")

html = (root / "index.html").read_text(encoding="utf-8")
css = (root / "assets" / "styles.css").read_text(encoding="utf-8")
js = (root / "assets" / "app.js").read_text(encoding="utf-8")
import json
chambers = json.loads((root / "data" / "chambers.json").read_text(encoding="utf-8"))
files = ([p["file"] for c in chambers for p in c["periods"]] + [p["travel"] for c in chambers for p in c["periods"] if p.get("travel")]
         + [c["districts"] for c in chambers] + [f"data/{c['id']}/ballotpedia.json" for c in chambers])
bundle = {"chambers": chambers,
          "data": {f: json.loads((root / f).read_text(encoding="utf-8")) for f in files if (root / f).exists()}}
data = json.dumps(bundle, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")

html = html.replace('<link rel="stylesheet" href="assets/styles.css">', f"<style>\n{css}\n</style>")
html = html.replace('<script src="assets/app.js"></script>',
                    f"<script>window.__EXPENDITURE_BUNDLE__ = {data};</script>\n<script>\n{js}\n</script>")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"Wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")
