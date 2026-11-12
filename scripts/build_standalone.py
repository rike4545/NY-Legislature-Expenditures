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
manifest = json.loads((root / "data" / "periods.json").read_text(encoding="utf-8"))
bundle = {"manifest": manifest,
          "data": {m["id"]: json.loads((root / m["file"]).read_text(encoding="utf-8")) for m in manifest}}
data = json.dumps(bundle, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")

html = html.replace('<link rel="stylesheet" href="assets/styles.css">', f"<style>\n{css}\n</style>")
html = html.replace('<script src="assets/app.js"></script>',
                    f"<script>window.__EXPENDITURE_PERIODS__ = {data};</script>\n<script>\n{js}\n</script>")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"Wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")
