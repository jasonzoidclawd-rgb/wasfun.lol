"""
Mayhem Oracle — arammayhem.com Scraper
=======================================
Fetches champion tier list, augments, and combos from arammayhem.com.
Outputs generated JSON to data/internal/ for decision runtime use.

Usage:
    python scripts/scrape_arammayhem.py

Output files:
    data/internal/champions.json            — tier list with win rates
    data/internal/augment-winrate-feed.json — augment win rates keyed by CDragon augmentNameId
    data/internal/combos.json               — champion × augment synergies
    data/internal/meta.json                 — patch version + scrape timestamp
"""

from __future__ import annotations
import os
import re
import json
import tempfile
import time
import html as html_module
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import urljoin

from augment_winrate_feed import (
    BASE_CATALOG_PATH,
    IDENTITY_MAP_PATH,
    WIN_RATE_FEED_PATH,
    build_arammayhem_win_rate_feed,
    load_json,
)
from data_paths import INTERNAL_DATA_DIR
from champion_slug_aliases import canonical_champion_name, canonical_champion_slug

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
OUT_DIR = INTERNAL_DATA_DIR


def resolve_url(path: str) -> str:
    return path if path.startswith(("http://", "https://")) else urljoin(BASE_URL, path)


def fetch(path: str) -> str:
    url = resolve_url(path)
    print(f"  Fetching {url} ...")
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def unescape(s: str) -> str:
    return html_module.unescape(s).strip()


def normalize_path_slug(s: str) -> str:
    return unescape(s).strip("/")


def normalize_combo_tier(tier: str) -> str:
    return tier.rstrip("+")


def normalize_lookup_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def slugify_search_name(value: str) -> str:
    value = unescape(value).lower().replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-")


def slug_from_href(href: str) -> str | None:
    m = re.search(r"/(?:build|champions)/([^/?#]+)", href)
    return normalize_path_slug(m.group(1)) if m else None


# ── Tier List ──────────────────────────────────────────────────────────────

def parse_tier_list(html: str) -> list[dict]:
    champions = []

    # Split into tier sections using data-tier attribute
    # Each section: <div ... data-tier="S+"> ... </div>
    section_pattern = re.compile(
        r'data-tier="([^"]+)">(.*?)(?=data-tier="|</main>)',
        re.DOTALL,
    )

    for m in section_pattern.finditer(html):
        tier = m.group(1)
        section_html = m.group(2)

        # Find all champion cards in this section
        card_pattern = re.compile(
            r'href="/(?:champions|build)/([^"]+)"[^>]*class="champion-card[^"]*"'
            r'\s+data-search="([^"]+)"\s+data-tags="([^"]*)"\s+title="([^"]*)"'
            r'.*?<img src="([^"]+)"',
            re.DOTALL,
        )

        for card in card_pattern.finditer(section_html):
            # Canonicalise to the Riot internal slug so the champion joins to its
            # CommunityDragon ability profile / base stats / pool / URL regardless
            # of whether arammayhem serves the display slug (e.g. wukong→monkeyking).
            slug = canonical_champion_slug(normalize_path_slug(card.group(1)))
            search_text = card.group(2)
            tags = [t.strip() for t in card.group(3).split(",") if t.strip()]
            title = unescape(card.group(4))
            img_url = card.group(5)

            # Parse title: "brandnRank: #1nWin Rate: 56.29%nPick Rate: 13.42%"
            name_match = re.match(r'^([^\n]+)', title)
            rank_match = re.search(r'Rank:\s*#(\d+)', title)
            wr_match = re.search(r'Win Rate:\s*([\d.]+)%', title)
            pr_match = re.search(r'Pick Rate:\s*([\d.]+)%', title)

            # Title-case from slug (e.g. "aurelion-sol" → "Aurelion Sol"), with a
            # curated override for slugs that compact spaces/punctuation
            # (e.g. "monkeyking" → "Wukong", "drmundo" → "Dr. Mundo").
            display_name = canonical_champion_name(
                slug, " ".join(w.capitalize() for w in slug.split("-"))
            )

            champions.append({
                "slug": slug,
                "name": display_name,
                "tier": tier,
                "rank": int(rank_match.group(1)) if rank_match else None,
                "win_rate": float(wr_match.group(1)) if wr_match else None,
                "pick_rate": float(pr_match.group(1)) if pr_match else None,
                "tags": tags,
                "icon": img_url,
            })

    return champions


# ── Augment win-rate feed ─────────────────────────────────────────────────

def parse_augments(html: str) -> list[dict]:
    rows = []

    # Two markups: rank rows (2026-06-12 redesign) and the older card grid.
    card_starts = [
        m.start()
        for m in re.finditer(
            r'href="/augments/[^"]+"\s+class="augment-(?:rank-row|card)', html
        )
    ]

    for i, start in enumerate(card_starts):
        end = card_starts[i + 1] if i + 1 < len(card_starts) else start + 4000
        block = html[start:end]

        slug_m = re.search(r'href="/augments/([^"]+)"', block)
        if not slug_m:
            continue

        win_rate, extraction = extract_augment_win_rate(block)

        rows.append({
            "sourceKey": normalize_path_slug(slug_m.group(1)),
            "win_rate": win_rate,
            "extraction": extraction,
            # Denominators the source does not publish. Recorded explicitly so
            # downstream code can tell "not disclosed" from "not yet wired up",
            # and so no consumer infers a sample size we never observed.
            "games": None,
            "sampleDisclosed": False,
        })

    return rows


# Win-rate extraction must never infer meaning from magnitude. The previous
# `max(percentages)` fallback silently published a pick rate as a win rate
# whenever the labelled markup changed. Ambiguity now quarantines the row.
_WR_BADGE_RE = re.compile(r'">([\d.]+)<!-- -->%')
_WR_LABELLED_RE = re.compile(r'Win\s*Rate[^\d%]{0,20}?([\d.]+)\s*%', re.IGNORECASE)
# Rank rows encode the two stats by emphasis, not by order or magnitude: the
# primary (`text-foreground`) cell is the win rate, the de-emphasized
# (`text-muted-foreground`) cell is the pick rate, which is also duplicated into
# a mobile-only badge. Verified against all 198 live rows on 2026-09-10.
_WR_PRIMARY_RE = re.compile(
    r'<div class="(?![^"]*\bmuted\b)[^"]*\btext-foreground\b[^"]*">\s*([\d.]+)\s*%\s*</div>'
)
_PR_MUTED_RE = re.compile(
    r'<div class="[^"]*\btext-muted-foreground\b[^"]*">\s*([\d.]+)\s*%\s*</div>'
)


def extract_augment_win_rate(block: str) -> tuple[float | None, str]:
    """Return (win_rate, extraction_method).

    Ordered by decreasing certainty. Every branch identifies the win rate by an
    explicit marker — never by magnitude. The previous `max(percentages)`
    fallback would publish a pick rate as a win rate the moment the markup
    changed, and would do so silently; ambiguity now quarantines the row.
      1. dedicated win-rate badge markup                 -> "badge"
      2. explicitly labelled "Win Rate: N%"              -> "labelled"
      3. primary emphasis cell, corroborated by a muted
         pick-rate cell in the same row                  -> "structural"
      4. exactly one distinct percentage in the block    -> "sole_percentage"
      5. anything else                                   -> quarantined, None
    """
    badge = _WR_BADGE_RE.search(block)
    if badge:
        return float(badge.group(1)), "badge"

    labelled = _WR_LABELLED_RE.search(block)
    if labelled:
        return float(labelled.group(1)), "labelled"

    primary = _WR_PRIMARY_RE.findall(block)
    if len(primary) == 1 and _PR_MUTED_RE.search(block):
        # Exactly one primary stat cell, plus the pick-rate cell we expect
        # beside it: the layout matches what we verified, so this is unambiguous.
        return float(primary[0]), "structural"

    percentages = {float(v) for v in re.findall(r"([\d.]+)\s*%", block) if float(v) <= 100}
    if len(percentages) == 1:
        # Nothing to confuse it with; the single value can only be the win rate.
        return percentages.pop(), "sole_percentage"
    if not percentages:
        return None, "quarantined_no_percentage"
    return None, "quarantined_ambiguous_percentages"


def load_existing_rows(filename: str, key: str) -> dict[str, dict]:
    """Previous rows by slug so curated/enriched fields survive standalone scrapes."""
    path = OUT_DIR / filename
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {row["slug"]: row for row in data.get(key, []) if row.get("slug")}


# ── Combos ─────────────────────────────────────────────────────────────────

TIER_STRENGTH = {"S": 4, "A": 3, "B": 2, "C": 1}


def parse_search_index(data: dict) -> tuple[list[dict], list[dict]]:
    """Parse the stable search-index fallback for champion stats and combos."""
    champions = []
    champion_slug_by_id = {}
    for rank, row in enumerate(data.get("champions", []), start=1):
        name = (row.get("name") or {}).get("en") or row.get("id") or row.get("championId")
        if not name:
            continue
        # search-index slugs come from the display name (e.g. "Wukong",
        # "Nunu & Willump"), so canonicalise to the Riot internal slug to keep
        # the champion + combo joins stable downstream.
        slug = canonical_champion_slug(slugify_search_name(name))
        champion_id = row.get("championId") or row.get("id") or name
        champion_slug_by_id[normalize_lookup_key(champion_id)] = slug
        win_rate = row.get("winRate")
        try:
            parsed_win_rate = float(str(win_rate).rstrip("%"))
        except (TypeError, ValueError):
            parsed_win_rate = None
        champions.append({
            "slug": slug,
            "name": unescape(name),
            "tier": row.get("tier"),
            "rank": rank,
            "win_rate": parsed_win_rate,
            "pick_rate": None,
            "tags": [],
            "icon": resolve_url(row.get("icon") or ""),
        })

    augment_name_by_id = {}
    for row in data.get("augments", []):
        augment_id = row.get("id")
        name = (row.get("name") or {}).get("en")
        if augment_id and name:
            augment_name_by_id[normalize_lookup_key(augment_id)] = unescape(name)

    combos = []
    for row in data.get("combos", []):
        champion_id = row.get("championId")
        champion = champion_slug_by_id.get(normalize_lookup_key(champion_id or ""))
        tier = normalize_combo_tier(str(row.get("tier") or ""))
        combo_ref = row.get("slug")
        if not (champion and tier in TIER_STRENGTH and combo_ref):
            continue
        for augment_id in row.get("augmentIds", []):
            augment = augment_name_by_id.get(normalize_lookup_key(str(augment_id)))
            if augment:
                combos.append({
                    "champion": champion,
                    "augment": augment,
                    "tier": tier,
                    "ref": f"search-index:{combo_ref}",
                })
    return champions, dedupe_combos(combos)


def merge_champion_sources(primary: list[dict], fallback: list[dict]) -> list[dict]:
    fallback_by_slug = {
        canonical_champion_slug(row["slug"]): {**row, "slug": canonical_champion_slug(row["slug"])}
        for row in fallback
    }
    merged = []
    seen = set()
    for row in primary:
        slug = canonical_champion_slug(row["slug"])
        row = {**row, "slug": slug}
        fallback_row = fallback_by_slug.get(slug, {})
        merged.append({
            **fallback_row,
            **row,
            "tier": row.get("tier") or fallback_row.get("tier"),
            "win_rate": row.get("win_rate") if row.get("win_rate") is not None else fallback_row.get("win_rate"),
        })
        seen.add(slug)
    merged.extend(row for row in fallback_by_slug.values() if row["slug"] not in seen)
    return merged


def merge_combo_sources(primary: list[dict], fallback: list[dict]) -> list[dict]:
    primary_pairs = {
        (normalize_lookup_key(row["champion"]), normalize_lookup_key(row["augment"]))
        for row in primary
    }
    return dedupe_combos([
        *primary,
        *[
            row for row in fallback
            if (normalize_lookup_key(row["champion"]), normalize_lookup_key(row["augment"]))
            not in primary_pairs
        ],
    ])


def dedupe_combos(combos: list[dict]) -> list[dict]:
    order: list[tuple[str, str]] = []
    by_pair: dict[tuple[str, str], dict] = {}

    for combo in combos:
        key = (normalize_lookup_key(combo["champion"]), normalize_lookup_key(combo["augment"]))
        if key not in by_pair:
            by_pair[key] = combo
            order.append(key)
            continue

        current = by_pair[key]
        if TIER_STRENGTH.get(combo["tier"], 0) > TIER_STRENGTH.get(current["tier"], 0):
            by_pair[key] = combo

    return [by_pair[key] for key in order]


def parse_combos(html: str) -> list[dict]:
    combos = []

    manifest_m = re.search(r'data-combo-manifest-url="([^"]+)"', html)
    if manifest_m:
        manifest = json.loads(fetch(unescape(manifest_m.group(1))))
        for card in manifest.get("cards", []):
            champion = canonical_champion_slug(
                slug_from_href(card.get("championHref", "")) or card.get("championId") or ""
            )
            augment = card.get("augmentName") or card.get("augmentId")
            combo_ref = card.get("comboRef")
            tier = card.get("tier")
            if not (champion and augment and combo_ref and tier):
                continue

            combos.append({
                "champion": champion,
                "augment": unescape(augment),
                "tier": normalize_combo_tier(tier),
                "ref": unescape(combo_ref),
            })
        if combos:
            return dedupe_combos(combos)

    article_pattern = re.compile(
        r'<article\s+class="combo-card[^"]*"\s+'
        r'data-tier="([^"]+)"\s+'
        r'data-champion-id="([^"]+)"'
        r'.*?data-combo-ref="([^"]+)"'
        r'.*?</article>',
        re.DOTALL,
    )

    for m in article_pattern.finditer(html):
        block = m.group(0)
        augment_m = re.search(r'<img[^>]+alt="([^"]+)"', block)
        if not augment_m:
            continue

        combos.append({
            "champion": canonical_champion_slug(unescape(m.group(2))),
            "augment": unescape(augment_m.group(1)),
            "tier": normalize_combo_tier(m.group(1)),
            "ref": unescape(m.group(3)),
        })

    if combos:
        return dedupe_combos(combos)

    # <div class="combo-card ..." data-tier="S" data-champion="shaco"
    #      data-augment="executioner" data-combo-ref="curated:shaco-executioner">
    card_pattern = re.compile(
        r'class="combo-card[^"]*"\s+'
        r'data-tier="([^"]+)"\s+'
        r'data-champion="([^"]+)"\s+'
        r'data-augment="([^"]+)"\s+'
        r'data-combo-ref="([^"]+)"',
        re.DOTALL,
    )

    seen = set()
    for m in card_pattern.finditer(html):
        tier = normalize_combo_tier(m.group(1))
        champion = canonical_champion_slug(m.group(2))
        augment = m.group(3)
        combo_ref = m.group(4)
        key = (champion, augment)
        if key in seen:
            continue
        seen.add(key)

        combos.append({
            "champion": champion,
            "augment": augment,
            "tier": tier,
            "ref": combo_ref,
        })

    return dedupe_combos(combos)


# ── Atomic write ──────────────────────────────────────────────────────────

def atomic_write(path: Path, data: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── Patch version ──────────────────────────────────────────────────────────

def extract_patch(*htmls: str) -> str | None:
    """Highest patch version across the given pages — the tier list can lag the augment catalog."""
    versions = set()
    for html in htmls:
        for m in re.finditer(r'[Pp]atch\s+([\d.]+)', html):
            v = m.group(1).rstrip(".")
            parts = v.split(".")
            if len(parts) == 2 and all(p.isdigit() for p in parts):
                versions.add((int(parts[0]), int(parts[1]), v))
    if not versions:
        return None
    return max(versions)[2]


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Scraping arammayhem.com...")

    # Stable search index fallback
    print("\n[1/8] Search index fallback")
    search_patch = None
    search_champions: list[dict] = []
    search_combos: list[dict] = []
    try:
        search_index = json.loads(fetch("/search-index.json"))
        search_patch = search_index.get("patch")
        search_champions, search_combos = parse_search_index(search_index)
        print(f"  → {len(search_champions)} champions, {len(search_combos)} combos")
    except Exception as e:
        print(f"  Skipped: {e}")

    # Tier list
    print("\n[2/8] Champion tier list")
    tier_html = fetch("/tier-list/")
    tier_list_rows = parse_tier_list(tier_html)
    champions = merge_champion_sources(tier_list_rows, search_champions)
    print(f"  → {len(champions)} champions")
    if not tier_list_rows:
        # The structured search index still carries tier + win rate, so the run
        # is not wrong — but a primary parser that silently returns nothing is
        # how a field disappears without anyone noticing. Say so loudly.
        print(
            "  ⚠ tier-list HTML parser matched 0 champion cards; "
            "serving tier/win-rate from the search index only. "
            "Fields unique to the HTML card (e.g. pick rate) will be null."
        )
    missing_pick_rate = sum(1 for row in champions if row.get("pick_rate") is None)
    if missing_pick_rate:
        print(f"  ⚠ {missing_pick_rate}/{len(champions)} champions have no pick rate from source")

    # Augment win rates
    print("\n[3/5] Augment win rates")
    time.sleep(1)
    aug_html = fetch("/augments/")
    augment_win_rate_rows = parse_augments(aug_html)
    patch = extract_patch(tier_html, aug_html) or search_patch
    quarantined = [r for r in augment_win_rate_rows if str(r.get("extraction", "")).startswith("quarantined")]
    print(f"  → {len(augment_win_rate_rows)} source rows, patch {patch}")
    if quarantined:
        # Loud but non-fatal: an extraction regression must be visible in the
        # run log rather than silently degrading every downstream win rate.
        print(
            f"  ⚠ {len(quarantined)} row(s) quarantined (ambiguous win-rate markup): "
            + ", ".join(sorted(r["sourceKey"] for r in quarantined)[:8])
        )

    existing_champions = load_existing_rows("champions.json", "champions")
    for i, champ in enumerate(champions):
        old = existing_champions.get(champ["slug"], {})
        champions[i] = {**old, **champ}

    # Combos
    print("\n[4/5] Combos")
    time.sleep(1)
    combo_html = fetch("/combo/")
    combos = merge_combo_sources(parse_combos(combo_html), search_combos)
    print(f"  → {len(combos)} combos")

    # Sanity checks — abort before touching existing data if counts look wrong
    MIN_CHAMPIONS = 50
    MIN_COMBOS    = 1
    errors = []
    if len(champions) < MIN_CHAMPIONS:
        errors.append(f"champions={len(champions)} < {MIN_CHAMPIONS} (source markup may have changed)")
    if len(combos) < MIN_COMBOS:
        errors.append(f"combos={len(combos)} < {MIN_COMBOS}")
    if errors:
        for e in errors:
            print(f"  ✗ SANITY FAIL: {e}")
        raise SystemExit("Aborting — parsed counts too low; existing data NOT overwritten")

    # Atomic writes — each file is written to a temp then renamed so partial
    # failures never leave a truncated JSON on disk.
    scraped_at = datetime.now(timezone.utc).isoformat()
    identity_map = load_json(IDENTITY_MAP_PATH)
    base_catalog = load_json(BASE_CATALOG_PATH) if BASE_CATALOG_PATH.exists() else None
    win_rate_feed = build_arammayhem_win_rate_feed(
        rows=augment_win_rate_rows,
        identity_map=identity_map,
        base_catalog=base_catalog,
        generated_at=scraped_at,
    )

    atomic_write(OUT_DIR / "champions.json",
                 {"patch": patch, "scraped_at": scraped_at, "champions": champions})
    atomic_write(WIN_RATE_FEED_PATH, win_rate_feed)
    atomic_write(OUT_DIR / "combos.json",
                 {"patch": patch, "scraped_at": scraped_at, "combos": combos})
    atomic_write(OUT_DIR / "meta.json",
                 {"patch": patch, "scraped_at": scraped_at, "source": BASE_URL})

    print(f"\nDone. Files written to {OUT_DIR}/")
    print(f"  champions.json  ({len(champions)} entries)")
    print(f"  {WIN_RATE_FEED_PATH.name}  ({win_rate_feed['counts']['matchedAugmentIds']} win rates; "
          f"{win_rate_feed['counts']['unmatchedSourceRows']} unmatched)")
    print(f"  combos.json     ({len(combos)} entries)")
    print(f"  meta.json")


if __name__ == "__main__":
    main()
