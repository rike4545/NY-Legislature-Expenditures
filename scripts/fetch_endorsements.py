"""Read the endorsements page of each sitting legislator's 2026 campaign website.

Input:  data/raw/endorsements/sites.tsv  (Ballotpedia page slug, campaign website from that page)
Output: data/raw/endorsements/pages/<slug>.json  {site, page, fetched, text: [...], images: [...]}
        The raw words and logo labels found on the page; build_endorsements.py turns them into the
        site's data. Pages are fetched once each, with an identifying User-Agent.
"""
import html, json, os, re, sys, time, urllib.parse, urllib.request
from datetime import date
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "data/raw/endorsements")
UA = "NY-Legislature-Expenditures endorsement reader (+https://github.com/rike4545/NY-Legislature-Expenditures)"


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self.blocks, self.images = [], [], []
        self._skip = 0
        self._buf = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style", "noscript", "svg"):
            self._skip += 1
        if tag == "a" and a.get("href"):
            self.links.append((a["href"], ""))
        if tag == "img":
            src = a.get("src") or a.get("data-src") or ""
            self.images.append({"alt": (a.get("alt") or "").strip(), "src": src.rsplit("/", 1)[-1][:120]})
        if tag in ("p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "div", "figcaption", "span", "br", "td"):
            self._flush()

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self._skip:
            self._skip -= 1
        if tag in ("p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "div", "figcaption", "td", "a"):
            self._flush()

    def handle_data(self, data):
        if not self._skip:
            self._buf.append(data)

    def _flush(self):
        t = re.sub(r"\s+", " ", "".join(self._buf)).strip()
        if t and (not self.blocks or self.blocks[-1] != t):
            self.blocks.append(t)
        self._buf = []


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")


def parse(body):
    p = Page()
    p.feed(body)
    p._flush()
    return p


def main():
    os.makedirs(os.path.join(DIR, "pages"), exist_ok=True)
    rows = [l.rstrip("\n").split("\t") for l in open(os.path.join(DIR, "sites.tsv")) if l.strip()]
    for slug, site, *_ in rows:
        out = os.path.join(DIR, "pages", slug.replace("/", "_") + ".json")
        if site == "NONE" or (os.path.exists(out) and "--refresh" not in sys.argv):
            continue
        rec = {"slug": slug, "site": site, "fetched": date.today().isoformat(), "page": None, "text": [], "images": [], "error": None}
        try:
            final, body = get(site)
            home = parse(body)
            cands = []
            for href, _ in home.links:
                u = urllib.parse.urljoin(final, href)
                if re.search(r"endors", u, re.I) and urllib.parse.urlparse(u).netloc == urllib.parse.urlparse(final).netloc:
                    cands.append(u.split("#")[0])
            page, p = None, None
            if cands:
                page = sorted(set(cands), key=len)[0]
                _, b2 = get(page)
                p = parse(b2)
            else:  # endorsements may be on the home page itself
                if any(re.search(r"endors", t, re.I) for t in home.blocks):
                    page, p = final, home
            if p:
                rec["page"] = page
                rec["text"] = p.blocks[:800]
                rec["images"] = [i for i in p.images if i["alt"] or i["src"]][:300]
        except Exception as e:  # noqa: BLE001
            rec["error"] = str(e)[:200]
        json.dump(rec, open(out, "w"), ensure_ascii=False)
        print(slug, rec["page"] or rec["error"] or "no endorsements page", flush=True)
        time.sleep(0.5)


if __name__ == "__main__":
    main()
