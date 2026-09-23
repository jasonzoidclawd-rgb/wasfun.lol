#!/usr/bin/env python3
"""
Mayhem statistics feeds (v3 phase 0)
====================================
Fetches the two statistics inputs the pooled model needs from arammayhem.com:

    data/internal/augment-stats-feed.json   one global row per augment: win rate AND pick rate
    data/internal/champion-build-feed.json  per champion: its listed augment rows (appearance
                                            and win rate, per rarity), item rows, and the
                                            champion's own win and pick rate

Both feeds keep the upstream's own labels ("pick rate", "appearance rate") and
record their units as UNCONFIRMED: the upstream never defines them, and the
global pick rates sum to far more than 100% per rarity, so they are not a share
of games (see `units` in each feed). Nothing downstream may treat them as a
share of games until `units.status` says "confirmed".

Per-field provenance travels in each feed's `fieldProvenance` block. The
provider (arammayhem.com) is recorded as a provider, never as the authority
(the 2026-09-20 statistics lineage note, a private project doc).

The legacy scraper (scrape_arammayhem.py) is untouched; this runs beside it.

Usage:
    python3 scripts/scrape_mayhem_stats.py [--limit N] [--delay SECONDS]
"""

from __future__ import annotations

import argparse
import collections
import html as html_module
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from augment_stats_identity import load_identity_context, resolve_augment
from champion_slug_aliases import canonical_champion_slug
from data_paths import INTERNAL_DATA_DIR

BASE_URL = "https://arammayhem.com"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

AUGMENT_STATS_PATH = INTERNAL_DATA_DIR / "augment-stats-feed.json"
CHAMPION_BUILD_PATH = INTERNAL_DATA_DIR / "champion-build-feed.json"
SCHEMA_VERSION = 1
RARITIES = ("prismatic", "gold", "silver")
ITEM_SECTIONS = {
    "Starting Items": "starting",
    "Boots": "boots",
    "Core Builds": "core",
    "Late-Game Builds": "late",
}

# Shared provenance. `authorityLineage` is the best-supported hypothesis, not a
# fact: the research note grades it "supported", and the provider states no source.
PROVENANCE = {
    "provider": "arammayhem.com",
    "providerSourceClaim": "unstated",
    "authorityLineage": "cn-mayhem-aggregate (hypothesis; provider states no source)",
    "transport": "html-scrape",
    "population": {"region": "CN (inferred, unverified)", "queue": "ARAM: Mayhem"},
    "sampleSize": None,
    "independentCorroboration": None,
}

UNITS_UNCONFIRMED = {
    "status": "unconfirmed",
    "note": (
        "The provider does not define 'pick rate' or 'appearance rate'. Global augment pick "
        "rates sum to about 3,450% over all live augments, which fits a share of GAMES (10 "
        "players, about 3.4 augments each) like the champion pick rate, but that is a "
        "hypothesis. Keep the unlisted-pair subtraction off (unit guard) until confirmed."
    ),
}


class ParseError(ValueError):
    """The page no longer has the structure this parser was written against."""


# ── fetching ────────────────────────────────────────────────────────────────


def fetch(path: str, retries: int = 2) -> str:
    url = path if path.startswith("http") else urljoin(BASE_URL, path)
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urlopen(Request(url, headers=HEADERS), timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except HTTPError as exc:
            if exc.code == 404:
                raise
            last = exc
        except URLError as exc:
            last = exc
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"fetch failed for {url}: {last}")


# ── parsing helpers ─────────────────────────────────────────────────────────

_PCT = r"([0-9]{1,3}(?:\.[0-9]{1,2})?)%"


def _text(fragment: str) -> str:
    return html_module.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def _pct(raw: str, label: str) -> float:
    value = float(raw)
    if not 0.0 <= value <= 100.0:
        raise ParseError(f"{label} out of range: {raw}")
    return value


def _strip_noise(page: str) -> str:
    return re.sub(r"<script.*?</script>|<style.*?</style>|<!--.*?-->", "", page, flags=re.S)


# ── global augment list (/augments/) ────────────────────────────────────────

_ROW_START = re.compile(r'<a href="/augments/([^"/]+)/?" class="augment-rank-row')


def parse_augment_list(page: str) -> list[dict]:
    """Every row of the global augment table: slug, name, rarity, availability,
    win rate and pick rate. Both rates are read from their own labelled columns;
    a row missing either one fails the parse rather than guessing."""
    page = _strip_noise(page)
    starts = [m.start() for m in _ROW_START.finditer(page)]
    if not starts:
        raise ParseError("no augment-rank-row anchors found")
    rows = []
    for i, start in enumerate(starts):
        end = page.find("</a>", start)
        block = page[start : end if end > 0 else start + 6000]
        slug = _ROW_START.match(block).group(1)
        rarity = re.search(r'data-rarity="(\w+)"', block)
        availability = re.search(r'data-availability="(\w+)"', block)
        name = re.search(r'<img [^>]*alt="([^"]*)"', block)
        win = re.search(r'sm:text-lg">' + _PCT + r"</div>", block)
        pick = re.search(r'sm:block">' + _PCT + r"</div>", block)
        if not (rarity and availability and name and win and pick):
            raise ParseError(f"augment row {slug!r} is missing a labelled field")
        rows.append({
            "sourceSlug": slug,
            "name": html_module.unescape(name.group(1)),
            "rarity": rarity.group(1),
            "availability": availability.group(1),
            "winRate": _pct(win.group(1), f"{slug} win rate"),
            "pickRate": _pct(pick.group(1), f"{slug} pick rate"),
        })
    return rows


# ── champion build page (/build/<slug>/) ────────────────────────────────────


def _section(page: str, start_marker: str, end_markers: tuple[str, ...]) -> str:
    i = page.find(start_marker)
    if i < 0:
        raise ParseError(f"section {start_marker!r} not found")
    ends = [j for m in end_markers if (j := page.find(m, i + len(start_marker))) > 0]
    return page[i : min(ends) if ends else len(page)]



def parse_build_header(page: str) -> dict:
    """Champion win rate, pick rate, patch and data date from the page's header.
    The header is the part of <main> before the augment section."""
    page = _strip_noise(page)
    main = page[page.find("<main") :]
    head = main[: main.find("Best Augments for")] if "Best Augments for" in main else main[:20000]
    text = re.sub(r"\s+", " ", html_module.unescape(re.sub(r"<[^>]+>", " ", head)))
    win = re.search(r"Win Rate " + _PCT, text)
    pick = re.search(r"Pick Rate " + _PCT, text)
    patch = re.search(r"Patch: ([0-9]+\.[0-9]+)", text)
    date = re.search(r"Data date ([0-9]{4}-[0-9]{2}-[0-9]{2})", text)
    if not (win and patch and date):
        raise ParseError("build header is missing win rate, patch or data date")
    return {
        "winRate": _pct(win.group(1), "champion win rate"),
        "pickRate": _pct(pick.group(1), "champion pick rate") if pick else None,
        "patch": patch.group(1),
        "dataDate": date.group(1),
    }


def parse_build_augments(page: str) -> list[dict]:
    """The champion's listed augment rows, per rarity, in the provider's order."""
    page = _strip_noise(page)
    section = _section(page, "Best Augments for", ("Augment Combos for", "Build &amp; Augments", "Build & Augments"))
    rows: list[dict] = []
    # Each rarity column opens with a header div coloured by rarity.
    heads = list(re.finditer(r'text-rarity-(prismatic|gold|silver)"[^>]*>(Prismatic|Gold|Silver)</div>', section))
    if not heads:
        raise ParseError("no rarity columns in the augment section")
    for k, head in enumerate(heads):
        rarity = head.group(1)
        column = section[head.end() : heads[k + 1].start() if k + 1 < len(heads) else len(section)]
        for pos, m in enumerate(re.finditer(r'<a href="/augments/([^"/]+)/?"(.*?)</a>', column, re.S), start=1):
            body = m.group(2)
            name = re.search(r'title="([^"]*)"', body)
            appear = re.search(r"Appearance rate:\s*<span[^>]*>" + _PCT, body)
            win = re.search(r"Win rate:\s*<span[^>]*>" + _PCT, body)
            if not (name and appear and win):
                raise ParseError(f"augment row {m.group(1)!r} ({rarity}) is missing a labelled field")
            rows.append({
                "rarity": rarity,
                "sourceSlug": m.group(1),
                "name": html_module.unescape(name.group(1)),
                "listPosition": pos,
                "appearanceRate": _pct(appear.group(1), "appearance rate"),
                "winRate": _pct(win.group(1), "augment win rate"),
            })
    return rows


def parse_build_items(page: str) -> dict[str, list[dict]]:
    """Item rows per section. Each row is an ordered item path (one item for the
    single-item sections) with the provider's pick and win rate."""
    page = _strip_noise(page)
    out: dict[str, list[dict]] = {}
    for label, key in ITEM_SECTIONS.items():
        marker = re.search(r'<div class="font-semibold mb-3"[^>]*>' + re.escape(label) + "</div>", page)
        if not marker:
            out[key] = []
            continue
        start = marker.start()
        end = page.find("</section>", start)
        section = page[start:end]
        rows = []
        for block in re.split(r'(?=<div class="flex flex-col gap-2 rounded-md)', section)[1:]:
            items = [
                {"sourceSlug": slug, "name": html_module.unescape(title)}
                for slug, title in re.findall(r'<a href="/items/([^"/]+)/?"[^>]*title="([^"]*)"', block)
            ]
            pick = re.search(r"Pick Rate\s*<span[^>]*>" + _PCT, block)
            win = re.search(r"Win Rate\s*<span[^>]*>" + _PCT, block)
            if not (items and pick and win):
                raise ParseError(f"item row in {label!r} is missing items or a labelled rate")
            rows.append({
                "items": items,
                "pickRate": _pct(pick.group(1), "item pick rate"),
                "winRate": _pct(win.group(1), "item win rate"),
            })
        out[key] = rows
    return out


def parse_build_history(page: str) -> list[dict]:
    """The provider's own dated snapshots of this champion's win and pick rate
    ("Snapshot details"), newest first. Used to estimate the noise scale: how far
    successive estimates of the same quantity move within a patch."""
    page = _strip_noise(page)
    i = page.find("Snapshot details")
    if i < 0:
        return []
    text = re.sub(r"\s+", " ", html_module.unescape(re.sub(r"<[^>]+>", " ", page[i : i + 40000])))
    rows = []
    for m in re.finditer(r"(\d{8})_(\d{6}) • Patch: ([0-9]+\.[0-9]+) .*?Win: " + _PCT + r" Pick: " + _PCT, text):
        date = f"{m.group(1)[:4]}-{m.group(1)[4:6]}-{m.group(1)[6:]}"
        rows.append({"snapshot": f"{m.group(1)}_{m.group(2)}", "date": date, "patch": m.group(3),
                     "winRate": _pct(m.group(4), "history win rate"), "pickRate": _pct(m.group(5), "history pick rate")})
    return rows


def parse_build_page(page: str) -> dict:
    return {
        **parse_build_header(page),
        "augments": parse_build_augments(page),
        "items": parse_build_items(page),
        "history": parse_build_history(page),
    }


def parse_champion_slugs(tier_page: str) -> list[str]:
    """Champion slugs as the provider spells them, from its tier list."""
    slugs = re.findall(r'href="/(?:build|champions)/([^"/?#]+)/?"', tier_page)
    seen: dict[str, None] = {}
    for slug in slugs:
        seen.setdefault(slug)
    return list(seen)


# ── feed assembly ───────────────────────────────────────────────────────────


def _resolve(row: dict, ctx) -> dict:
    augment_id, method = resolve_augment(row["sourceSlug"], row["name"], row["rarity"], ctx)
    return {**row, "augmentId": augment_id, "identity": method}


def build_augment_stats_feed(rows: list[dict], ctx, *, patch: str | None, fetched_at: str,
                             data_date: str | None = None) -> dict:
    resolved = [_resolve(r, ctx) for r in rows]
    live = [r for r in resolved if r["availability"] == "live"]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "feed": "augment-stats-feed",
        "fetchedAt": fetched_at,
        "patch": patch,
        "dataDate": data_date,
        "provenance": PROVENANCE,
        "fieldProvenance": {
            "rows[].augmentId": "CDragon augmentNameId via scripts/augment_stats_identity.py",
            "rows[].winRate": "provider global augment table, 'Win Rate' column",
            "rows[].pickRate": "provider global augment table, 'Pick Rate' column (units unconfirmed)",
            "rows[].availability": "provider data-availability attribute",
        },
        "units": {"pickRate": UNITS_UNCONFIRMED},
        "counts": {
            "rows": len(resolved),
            "live": len(live),
            "liveResolved": sum(1 for r in live if r["augmentId"]),
        },
        "rows": resolved,
    }


CHAMPION_PICK_RATE_CONFIRMED = {
    "status": "confirmed",
    "meaning": "share of games the champion appears in",
    "confirmation": "champion pick rates sum to 1000% across all champions (10 players per game); "
                    "scripts/validate_stats_feeds.py re-checks the sum on every run",
}


def win_rate_semantics(pages: dict[str, dict], global_rows: list[dict]) -> dict:
    """Whether a champion's listed augment win rates are its own or copies of the
    augment's global row. On 2026-09-24 every row equalled the global value, so
    these rows carry no champion-specific outcome information."""
    glob = {r["sourceSlug"]: r["winRate"] for r in global_rows}
    rows = [r for page in pages.values() for r in page["augments"] if r["sourceSlug"] in glob]
    same = sum(1 for r in rows if abs(r["winRate"] - glob[r["sourceSlug"]]) < 0.005)
    if not rows:
        status = "unknown"  # nothing to compare: never assume the rows are the champions' own
    else:
        status = "global-copy" if same == len(rows) else "champion-specific" if same == 0 else "mixed"
    return {"status": status, "rowsEqualToGlobal": same, "rowsCompared": len(rows)}


def build_champion_build_feed(pages: dict[str, dict], failures: list[dict], ctx, *, fetched_at: str,
                              global_rows: list[dict] | None = None) -> dict:
    champions = {}
    for slug, page in sorted(pages.items()):
        champions[slug] = {
            **{k: v for k, v in page.items() if k not in ("augments",)},
            "augments": [_resolve(r, ctx) for r in page["augments"]],
        }
    rows = [r for c in champions.values() for r in c["augments"]]
    patch_counts = collections.Counter(c["patch"] for c in champions.values())
    dates = sorted(c["dataDate"] for c in champions.values())
    return {
        "schemaVersion": SCHEMA_VERSION,
        "feed": "champion-build-feed",
        "fetchedAt": fetched_at,
        # The label most champions carry, so one odd page cannot relabel the feed.
        "patch": patch_counts.most_common(1)[0][0] if patch_counts else None,
        "patchesSeen": dict(sorted(patch_counts.items())),
        # The provider's observation date (newest champion page), not our fetch time.
        "dataDate": dates[-1] if dates else None,
        "provenance": PROVENANCE,
        "fieldProvenance": {
            "champions.*.winRate": "provider build page header, 'Win Rate'",
            "champions.*.pickRate": "provider build page header, 'Pick Rate' (share of games; see units)",
            "champions.*.dataDate": "provider build page header, 'Data date' (observation date)",
            "champions.*.augments[].appearanceRate": "provider 'Appearance rate' (units unconfirmed)",
            "champions.*.augments[].winRate": "provider 'Win rate' on the champion's listed row; see semantics",
            "champions.*.augments[].augmentId": "CDragon augmentNameId via scripts/augment_stats_identity.py",
            "champions.*.items": "provider item sections; win rate counts only games that completed the path",
            "champions.*.history": "provider 'Snapshot details': its own dated snapshots of the champion's win and pick rate",
        },
        "units": {"appearanceRate": UNITS_UNCONFIRMED, "pickRate": CHAMPION_PICK_RATE_CONFIRMED},
        # Downstream must read this before treating augments[].winRate as the champion's own.
        "semantics": {"augments[].winRate": win_rate_semantics(pages, global_rows or [])},
        "counts": {
            "champions": len(champions),
            "failures": len(failures),
            "augmentRows": len(rows),
            "augmentRowsResolved": sum(1 for r in rows if r["augmentId"]),
        },
        "failures": failures,
        "champions": champions,
    }


def atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only fetch the first N champions")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    args = ap.parse_args(argv)

    ctx = load_identity_context()
    fetched_at = datetime.now(timezone.utc).isoformat()

    print("[1/3] Global augment table")
    aug_rows = parse_augment_list(fetch("/augments/"))
    time.sleep(args.delay)

    print("[2/3] Champion list")
    slugs = parse_champion_slugs(fetch("/tier-list/"))
    if args.limit:
        slugs = slugs[: args.limit]
    if len(slugs) < 50 and not args.limit:
        raise SystemExit(f"only {len(slugs)} champions on the tier list; markup may have changed")

    print(f"[3/3] {len(slugs)} champion build pages")
    pages: dict[str, dict] = {}
    failures: list[dict] = []
    for i, source_slug in enumerate(slugs, start=1):
        time.sleep(args.delay)
        slug = canonical_champion_slug(source_slug)
        try:
            page = parse_build_page(fetch(f"/build/{source_slug}/"))
            pages[slug] = {"sourceSlug": source_slug, **page}
        except (ParseError, RuntimeError, HTTPError) as exc:
            failures.append({"slug": slug, "sourceSlug": source_slug, "reason": str(exc)[:200]})
            print(f"  ✗ {source_slug}: {exc}")
        if i % 25 == 0:
            print(f"  … {i}/{len(slugs)}")

    if len(failures) > max(5, len(slugs) // 10):
        raise SystemExit(f"{len(failures)} build pages failed; existing feeds NOT overwritten")

    build_feed = build_champion_build_feed(pages, failures, ctx, fetched_at=fetched_at, global_rows=aug_rows)
    stats_feed = build_augment_stats_feed(aug_rows, ctx, patch=build_feed["patch"], fetched_at=fetched_at,
                                          data_date=build_feed["dataDate"])
    atomic_write(AUGMENT_STATS_PATH, stats_feed)
    atomic_write(CHAMPION_BUILD_PATH, build_feed)
    print(f"augment-stats-feed: {stats_feed['counts']}")
    print(f"champion-build-feed: {build_feed['counts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
