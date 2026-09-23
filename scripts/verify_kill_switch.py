#!/usr/bin/env python3
"""Crawl a running build and prove the augment-statistics kill switch.

With WASFUN_AUGMENT_STATS=off the site must serve no augment statistic on any
page, static payload, script chunk or API response. This crawls:

- every URL in the sitemap (and nested sitemaps), rewritten onto --base;
- every /api/v1 resource and every public/data/*.json file;
- every /_next/static script the crawled pages reference;
- the augment-statistics APIs (decision evaluate / champion matrix, overlay
  bootstrap), which must answer 503 while the switch is off;

and runs three independent detectors on everything it fetches:

1. the `data-augment-stat` attribute every augment-number element carries;
2. JSON objects that name an augment and carry a numeric statistic;
3. a fingerprint: an augment's name followed within a short window by that
   augment's own current win rate, from data/internal/augment-stats-feed.json.
   It does not depend on markup conventions, so it catches a surface that
   forgot the marker.

--expect on inverts the verdict: at least one detection is required, which
proves the detectors see numbers when they are there.

Usage:
    python3 scripts/verify_kill_switch.py --base http://localhost:3000 --expect off [--max 0] [--report FILE]
"""

from __future__ import annotations

import argparse
import html as html_module
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
STATS_FEED = ROOT / "data" / "internal" / "augment-stats-feed.json"
CATALOG = ROOT / "data" / "internal" / "augments.json"
PUBLIC_DATA = ROOT / "public" / "data"

STAT_KEYS = {"win_rate", "winRate", "pick_rate", "pickRate", "appearanceRate", "lift", "letter", "grade",
             "score", "oracleScore"}
AUGMENT_KEYS = {"augmentId", "augmentSlug", "augment_id"}
WINDOW = 160
STATS_APIS = (
    ("POST", "/api/decision/evaluate"),
    ("POST", "/api/decision/champion-matrix"),
    ("GET", "/api/overlay/bootstrap"),
)


def fetch(url: str, method: str = "GET") -> tuple[int, str, str]:
    req = Request(url, method=method, data=b"{}" if method == "POST" else None,
                  headers={"User-Agent": "wasfun-kill-switch-crawl", "Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=60) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", ""), exc.read().decode("utf-8", errors="replace")


# ── detectors ───────────────────────────────────────────────────────────────


def load_fingerprints() -> list[tuple[str, list[str]]]:
    """(lower-cased display name, [win-rate strings]) per live augment with an id.
    Names in every locale the catalog carries, so localized pages are covered."""
    feed = json.loads(STATS_FEED.read_text(encoding="utf-8"))
    catalog = {a.get("augmentId"): a for a in json.loads(CATALOG.read_text(encoding="utf-8"))["augments"]}
    out = []
    for row in feed["rows"]:
        if row["availability"] != "live":
            continue
        wr = row["winRate"]
        values = sorted({f"{wr:.2f}", f"{wr:.1f}"})
        names = {row["name"]}
        aug = catalog.get(row.get("augmentId")) or {}
        names |= {v for v in (aug.get("names") or {}).values() if isinstance(v, str)}
        for name in names:
            if len(name) >= 4:
                out.append((name.lower(), values))
    return out


def detect_marker(body: str) -> list[str]:
    return ["data-augment-stat attribute"] if "data-augment-stat" in body else []


def detect_json(body: str) -> list[str]:
    try:
        doc = json.loads(body)
    except ValueError:
        return []
    hits: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            if AUGMENT_KEYS & node.keys():
                for key in STAT_KEYS & node.keys():
                    if isinstance(node[key], (int, float)) and not isinstance(node[key], bool):
                        hits.append(f"json {key} on {node.get('augmentId') or node.get('augmentSlug')}")
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(doc)
    return hits


def page_text(body: str, content_type: str) -> str:
    if "html" in content_type:
        body = re.sub(r"<script\b[^>]*>(?!\s*self\.__next_f)", " ", body)  # keep RSC payload text
        body = html_module.unescape(re.sub(r"<[^>]+>", " ", body))
    return re.sub(r"\s+", " ", body).lower()


def detect_fingerprint(text: str, fingerprints) -> list[str]:
    hits = []
    for name, values in fingerprints:
        start = 0
        while (i := text.find(name, start)) >= 0:
            window = text[i : i + len(name) + WINDOW]
            for value in values:
                if re.search(re.escape(value) + r"\s*%", window):
                    hits.append(f"fingerprint {name!r} {value}%")
                    break
            start = i + len(name)
    return hits


# ── crawl ───────────────────────────────────────────────────────────────────


def sitemap_urls(base: str) -> list[str]:
    seen, queue, pages = set(), [urljoin(base, "/sitemap.xml")], []
    while queue:
        url = queue.pop()
        if url in seen:
            continue
        seen.add(url)
        status, _, body = fetch(url)
        if status != 200:
            continue
        for loc in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", body):
            path = urlparse(loc).path or "/"
            target = urljoin(base, path)
            (queue if path.endswith(".xml") else pages).append(target)
    return sorted(set(pages))


def api_urls(base: str) -> list[str]:
    status, _, body = fetch(urljoin(base, "/api/v1"))
    urls = [urljoin(base, "/api/v1")]
    if status == 200:
        try:
            index = json.loads(body)
        except ValueError:
            index = {}
        resources = index.get("resources") or index.get("available") or []
        names = resources.keys() if isinstance(resources, dict) else resources
        urls += [urljoin(base, f"/api/v1/{name}") for name in names if isinstance(name, str)]
    urls += [urljoin(base, f"/data/{p.name}") for p in sorted(PUBLIC_DATA.glob("*.json"))]
    return urls


def scan(url: str, fingerprints) -> dict:
    status, ctype, body = fetch(url)
    hits = detect_marker(body) + detect_json(body) + detect_fingerprint(page_text(body, ctype), fingerprints)
    scripts = re.findall(r'src="(/_next/static/[^"]+\.js)"', body) if "html" in ctype else []
    return {"url": url, "status": status, "hits": hits, "scripts": scripts}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--expect", choices=("off", "on"), required=True)
    ap.add_argument("--max", type=int, default=0, help="cap the number of sitemap pages (0 = all)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--report", type=Path)
    args = ap.parse_args(argv)

    fingerprints = load_fingerprints()
    pages = sitemap_urls(args.base)
    if args.max:
        pages = pages[: args.max]
    targets = pages + api_urls(args.base)
    with ThreadPoolExecutor(args.workers) as pool:
        results = list(pool.map(lambda u: scan(u, fingerprints), targets))
    scripts = sorted({urljoin(args.base, s) for r in results for s in r["scripts"]})
    with ThreadPoolExecutor(args.workers) as pool:
        results += list(pool.map(lambda u: scan(u, fingerprints), scripts))

    api_checks = []
    for method, path in STATS_APIS:
        status, _, body = fetch(urljoin(args.base, path), method)
        api_checks.append({"api": f"{method} {path}", "status": status, "body": body[:120]})

    hits = [r for r in results if r["hits"]]
    failed_fetch = [r for r in results if r["status"] >= 500]
    report = {
        "base": args.base, "expect": args.expect,
        "fetched": {"pages": len(pages), "apiAndData": len(targets) - len(pages), "scripts": len(scripts)},
        "detections": [{"url": r["url"], "hits": r["hits"][:5]} for r in hits],
        "statsApis": api_checks,
        "serverErrors": [r["url"] for r in failed_fetch],
    }
    ok = True
    if args.expect == "off":
        ok = not hits and all(c["status"] == 503 for c in api_checks)
    else:
        ok = bool(hits)
    report["verdict"] = "pass" if ok else "fail"
    if args.report:
        args.report.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("fetched", "statsApis", "verdict")}, indent=1))
    for r in hits[:20]:
        print(f"  hit: {r['url']} {r['hits'][:3]}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
