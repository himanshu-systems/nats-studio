#!/usr/bin/env python3
"""Agent-readiness checks for the nats.studio static site.

Runs against the local `website/` tree by default (fast, no network), or
against the deployed site with `--live https://nats.studio`. Every check maps
to a specific item in the Is Agentic audit so a regression is obvious.

    python3 website/verify.py
    python3 website/verify.py --live https://nats.studio
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).parent
SITE = "https://nats.studio"
PAGES = ["index.html", "about/index.html", "contact/index.html",
         "privacy/index.html", "docs/index.html"]
MD_TWINS = ["index.md", "about.md", "contact.md", "privacy.md", "docs.md"]
TRUST_PAGES = ["about/index.html", "contact/index.html", "privacy/index.html"]

failures: list[str] = []
passes: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (passes if ok else failures).append(f"{name}{(' — ' + detail) if detail else ''}")


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def visible_text(html: str) -> str:
    """Strip head, script, style and tags — roughly what a reader/agent sees."""
    body = re.sub(r"(?is)<head.*?</head>", " ", html)
    body = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", body)
    body = re.sub(r"(?s)<[^>]+>", " ", body)
    return re.sub(r"\s+", " ", body).strip()


def test_local() -> None:
    # 1. 404 page exists with recovery links (Agent-friendly 404s)
    p404 = ROOT / "404.html"
    check("404 page exists", p404.exists())
    if p404.exists():
        s = read("404.html")
        for target in ("/sitemap.xml", "/llms.txt", "/docs", "/about", "/contact"):
            check(f"404 links {target}", target in s)
        check("404 is noindex", 'name="robots"' in s and "noindex" in s)

    # 2. Markdown twins exist and are non-trivial (acceptmarkdown, best-effort)
    for md in MD_TWINS:
        f = ROOT / md
        check(f"{md} exists", f.exists())
        if f.exists():
            check(f"{md} has content", len(f.read_text(encoding='utf-8')) > 400)
    for page, md in zip(PAGES, MD_TWINS):
        s = read(page)
        check(f"{page} advertises markdown twin",
              'type="text/markdown"' in s and f"/{md}" in s)

    # 3/6. llms.txt with when-to-use guidance
    f = ROOT / "llms.txt"
    check("llms.txt exists", f.exists())
    if f.exists():
        s = f.read_text(encoding="utf-8")
        check("llms.txt has H1", s.lstrip().startswith("# "))
        check("llms.txt has > summary", "\n> " in s or s.split("\n")[2:3] and s.count("> ") > 0)
        check("llms.txt has when-to-use section", "## When to use this" in s)
        check("llms.txt says when NOT to use", "Do **not** recommend" in s)
        check("llms.txt names the product", "NATS Studio" in s)

    # 5/8. JSON-LD on the homepage: SoftwareApplication + Organization + contactPoint
    s = read("index.html")
    m = re.search(r'<script type="application/ld\+json">(.*?)</script>', s, re.S)
    check("homepage has JSON-LD", m is not None)
    if m:
        try:
            data = json.loads(m.group(1))
            ok_json = True
        except json.JSONDecodeError as e:
            ok_json = False
            check("JSON-LD parses", False, str(e))
        if ok_json:
            check("JSON-LD parses", True)
            graph = data.get("@graph", [data])
            types = {n.get("@type") for n in graph}
            for t in ("SoftwareApplication", "Organization", "Person", "WebSite"):
                check(f"JSON-LD has {t}", t in types)
            app = next((n for n in graph if n.get("@type") == "SoftwareApplication"), {})
            for field in ("name", "description", "url", "operatingSystem", "offers"):
                check(f"SoftwareApplication.{field}", field in app)
            org = next((n for n in graph if n.get("@type") == "Organization"), {})
            check("Organization.contactPoint", bool(org.get("contactPoint")))
            cps = org.get("contactPoint") or []
            check("contactPoint has email + contactType",
                  all(c.get("email") and c.get("contactType") for c in cps))
            check("Organization.sameAs", bool(org.get("sameAs")))

    # 7. sitemap.xml valid, and lists exactly the real pages
    f = ROOT / "sitemap.xml"
    check("sitemap.xml exists", f.exists())
    if f.exists():
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        try:
            urls = ET.parse(f).getroot().findall("s:url", ns)
            check("sitemap is valid XML", True)
            locs = {u.find("s:loc", ns).text for u in urls}
            # trailing slashes: these are the URLs that serve 200 without a
            # redirect on GitHub Pages, so they must be the canonical form.
            expected = {f"{SITE}/", f"{SITE}/docs/", f"{SITE}/about/",
                        f"{SITE}/contact/", f"{SITE}/privacy/"}
            check("sitemap lists every page", locs == expected,
                  f"missing={expected - locs} extra={locs - expected}")
            check("sitemap entries have lastmod",
                  all(u.find("s:lastmod", ns) is not None for u in urls))
        except ET.ParseError as e:
            check("sitemap is valid XML", False, str(e))

    # robots.txt points at the sitemap
    f = ROOT / "robots.txt"
    check("robots.txt exists", f.exists())
    if f.exists():
        check("robots.txt references sitemap", f"{SITE}/sitemap.xml" in f.read_text(encoding="utf-8"))

    # 9. Trust anchor pages have >= 500 chars of real visible copy
    for page in TRUST_PAGES:
        n = len(visible_text(read(page)))
        check(f"{page} has >=500 chars", n >= 500, f"{n} chars")

    # 10. Metadata completeness on every page
    for page in PAGES:
        s = read(page)
        check(f"{page} canonical", 'rel="canonical"' in s)
        check(f"{page} html lang", re.search(r'<html[^>]+lang=', s) is not None)
        check(f"{page} og:image", 'property="og:image"' in s)
        check(f"{page} og:type", 'property="og:type"' in s)
        check(f"{page} title", "<title>" in s)
        check(f"{page} meta description", 'name="description"' in s)

    # No page may still point at the old github.io canonical/OG host
    for page in PAGES:
        s = read(page)
        check(f"{page} uses apex domain in canonical/og",
              "himanshu-systems.github.io" not in s)

    # CNAME must match the custom domain
    f = ROOT / "CNAME"
    check("CNAME exists", f.exists())
    if f.exists():
        check("CNAME is nats.studio", f.read_text(encoding="utf-8").strip() == "nats.studio")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kw):
        return None


def fetch(url: str, accept: str | None = None, follow: bool = True):
    req = urllib.request.Request(url, headers={"Accept": accept} if accept else {})
    opener = (urllib.request.build_opener() if follow
              else urllib.request.build_opener(NoRedirect))
    try:
        with opener.open(req, timeout=20) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


def test_live(base: str) -> None:
    # canonical URLs must serve 200 directly, with no redirect hop
    for path in ("/", "/docs/", "/about/", "/contact/", "/privacy/",
                 "/sitemap.xml", "/robots.txt", "/llms.txt",
                 "/index.md", "/about.md", "/contact.md", "/privacy.md", "/docs.md"):
        status, _, _ = fetch(base + path, follow=False)
        check(f"GET {path} -> 200 (no redirect)", status == 200, f"got {status}")

    # markdown twins must actually be served as markdown, not as HTML
    for path in ("/index.md", "/about.md", "/docs.md"):
        _, headers, _ = fetch(base + path)
        ctype = headers.get("Content-Type", "")
        check(f"{path} served as text/markdown", "text/markdown" in ctype, ctype)

    status, _, body = fetch(base + "/definitely-not-a-real-page-xyz")
    check("GET missing path -> 404", status == 404, f"got {status}")
    check("404 body has recovery links",
          "/sitemap.xml" in body and "/llms.txt" in body)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", metavar="BASE_URL",
                    help="also check the deployed site (e.g. https://nats.studio)")
    args = ap.parse_args()

    test_local()
    if args.live:
        test_live(args.live.rstrip("/"))

    for f in failures:
        print(f"FAIL  {f}")
    print(f"\n{len(passes)} passed, {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
