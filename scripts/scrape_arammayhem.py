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
import collections
import math
import os
import re
import json
import tempfile
import time
import html as html_module
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple
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
#
# Failing closed on markup is not enough on its own: a marker can still be
# present while the cell behind it has been repurposed to carry something that
# is not a win rate. Every extraction path therefore routes its raw text through
# one numeric boundary, so no branch can publish a value the others would reject.
WIN_RATE_MIN = 0.0
WIN_RATE_MAX = 100.0

# Plausibility band, for REPORTING ONLY. Observed 2026-09-10: augment win rates
# span 46.6-65.2 and champion win rates 40.7-56.6. A value outside this band is
# arithmetically valid and is published, but is worth a look — we have no
# evidence that would justify discarding a real extreme, so it is never dropped.
WIN_RATE_PLAUSIBLE_MIN = 20.0
WIN_RATE_PLAUSIBLE_MAX = 90.0


# Plain decimal only. `float()` alone would also accept "1_0", "1e2", "nan" and
# full-width digits, i.e. publish tokens no page renders as a win rate.
_DECIMAL_TOKEN_RE = re.compile(r"([+-]?)(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)")
_NON_FINITE_TOKENS = frozenset({"nan", "inf", "infinity"})


def validated_win_rate(raw: object) -> tuple[float | None, str | None]:
    """Return (win_rate, quarantine_reason).

    The single numeric boundary for every extraction path. A reason is returned
    instead of a value whenever the token cannot be a win rate at all. Text is
    judged whole: a sign, "NaN" or "1.2.3" must reach this function intact.
    """
    signed = False
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        value = float(raw)
    else:
        text = str(raw).strip().rstrip("%").strip().replace("−", "-")
        decimal = _DECIMAL_TOKEN_RE.fullmatch(text)
        if not decimal:
            if text.lstrip("+-").lower() in _NON_FINITE_TOKENS:
                return None, "quarantined_non_finite_value"
            return None, "quarantined_unparseable_value"
        value = float(text)
        signed = bool(decimal.group(1))
    if not math.isfinite(value):
        return None, "quarantined_non_finite_value"
    if not (WIN_RATE_MIN <= value <= WIN_RATE_MAX):
        return None, "quarantined_out_of_range"
    if signed:
        # A win rate is never written with a sign; "+1.2%" is a delta, and
        # "-0%" is not zero evidence either.
        return None, "quarantined_signed_value"
    return value, None


def _accept(raw: object, method: str) -> tuple[float | None, str]:
    """Apply the shared boundary, keeping the method name only on success."""
    value, reason = validated_win_rate(raw)
    if reason:
        return None, reason
    return value, method


def is_implausible_win_rate(value: float | None) -> bool:
    """Valid but unusual. Reported, never silently discarded."""
    return value is not None and not (
        WIN_RATE_PLAUSIBLE_MIN <= value <= WIN_RATE_PLAUSIBLE_MAX
    )


# ── Tokenization ──
# The COMPLETE token in front of a "%": sign, digits, dots and letters alike.
# Capturing only `[\d.]+` is what read "-1%" as 1.0 and made "NaN%" invisible,
# which vacated the win-rate slot for a sibling pick rate to fill. Tokens are
# kept whole here and judged only by `validated_win_rate`.
_TOKEN = r"([\w.,+\-\u2212]+)"
_PERCENT_TOKEN_RE = re.compile(_TOKEN + r"\s*%")
_CELL_PERCENT_RE = re.compile(r"\s*" + _TOKEN + r"\s*%\s*")
_LEADING_PERCENT_RE = re.compile(r"\s*" + _TOKEN + r"\s*%")
# React server output separates adjacent text nodes with an empty comment, so
# `{value}%` arrives as `55.25<!-- -->%`. Comments are dropped before any text is
# read, so a split value is read as one token rather than two fragments.
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_REACT_SPLIT_PERCENT_RE = re.compile(r"<!--\s*-->\s*%")
# A leaf element: an open tag, text (plus React separators) only, its close tag.
_LEAF_CELL_RE = re.compile(
    r"<([a-zA-Z][\w-]*)\b([^>]*)>((?:[^<]|<!--.*?-->)*)</\1\s*>", re.DOTALL
)
_CLASS_ATTR_RE = re.compile(r'\bclass\s*=\s*"([^"]*)"')
# A label and the text right after it; only separators or tags may intervene,
# so a label with no value cannot reach across to the next label's number.
_LABEL_VALUE = r"(?:[\s:\uff1a=]|<[^>]*>)*([^<]*)"
_WR_LABEL_RE = re.compile(r"Win\s*Rate" + _LABEL_VALUE, re.IGNORECASE)
_PR_LABEL_RE = re.compile(r"Pick\s*Rate" + _LABEL_VALUE, re.IGNORECASE)

# Rank rows encode the two stats by emphasis, not by order or magnitude: the
# primary (`text-foreground`) cell is the win rate, the de-emphasized
# (`text-muted-foreground`) cell is the pick rate, which is also duplicated into
# a mobile-only (`sm:hidden`) badge. Verified against all 198 live rows on
# 2026-09-10. Muted and mobile-only cells are therefore evidence of a pick rate.
_MUTED_CLASS_RE = re.compile(r"\bmuted\b")
_MOBILE_ONLY_CLASS_RE = re.compile(r"(?:sm|md|lg|xl|2xl):hidden")


class _StatCell(NamedTuple):
    """A leaf element whose entire text is one percentage token."""
    token: str
    classes: tuple[str, ...]
    react_split: bool

    @property
    def muted(self) -> bool:
        return any(_MUTED_CLASS_RE.search(c) for c in self.classes)

    @property
    def primary(self) -> bool:
        return "text-foreground" in self.classes and not self.muted

    def marks_pick_rate(self, labelled_pick_rates: set[str]) -> bool:
        return (
            self.muted
            or any(_MOBILE_ONLY_CLASS_RE.fullmatch(c) for c in self.classes)
            or self.token in labelled_pick_rates
        )


def _stat_cells(block: str) -> list[_StatCell]:
    cells = []
    for match in _LEAF_CELL_RE.finditer(block):
        raw_text = match.group(3)
        text = html_module.unescape(_HTML_COMMENT_RE.sub("", raw_text))
        token = _CELL_PERCENT_RE.fullmatch(text)
        if not token:
            continue
        class_attr = _CLASS_ATTR_RE.search(match.group(2))
        cells.append(_StatCell(
            token=token.group(1),
            classes=tuple(class_attr.group(1).split()) if class_attr else (),
            react_split=bool(_REACT_SPLIT_PERCENT_RE.search(raw_text)),
        ))
    return cells


def _labelled_tokens(label_re: re.Pattern[str], text: str) -> list[str | None]:
    """The token after each label; None where the label has no percentage."""
    tokens: list[str | None] = []
    for match in label_re.finditer(text):
        lead = _LEADING_PERCENT_RE.match(html_module.unescape(match.group(1)))
        tokens.append(lead.group(1) if lead else None)
    return tokens


def _accept_all(tokens: list[str | None], method: str) -> tuple[float | None, str]:
    """Every explicit win-rate token must be present, valid, and agree."""
    if any(token is None for token in tokens):
        return None, "quarantined_win_rate_unavailable"
    accepted = [_accept(token, method) for token in tokens]
    for value, outcome in accepted:
        if value is None:
            return None, outcome
    if len({value for value, _ in accepted}) > 1:
        return None, "quarantined_ambiguous_percentages"
    return accepted[0]


def extract_augment_win_rate(block: str) -> tuple[float | None, str]:
    """Return (win_rate, extraction_method).

    Ordered by decreasing certainty. Every branch identifies the win rate by an
    explicit marker — never by magnitude. The previous `max(percentages)`
    fallback would publish a pick rate as a win rate the moment the markup
    changed, and would do so silently; ambiguity now quarantines the row.
      1. explicitly labelled "Win Rate: N%"              -> "labelled"
      2. React-split `N<!-- -->%` badge that carries no
         pick-rate evidence                              -> "badge"
      3. primary emphasis cell, corroborated by a muted
         pick-rate cell in the same row                  -> "structural"
      4. exactly one percentage occurrence in a block
         with no pick-rate evidence                      -> "sole_percentage"
      5. anything else                                   -> quarantined, None

    An explicit marker whose token is invalid or absent quarantines the row
    right there. Falling through instead would let the next branch promote
    whatever percentage is left — in practice, the pick rate.
    """
    text = _HTML_COMMENT_RE.sub("", block)
    labelled_pick_rates = {t for t in _labelled_tokens(_PR_LABEL_RE, text) if t}

    labelled = _labelled_tokens(_WR_LABEL_RE, text)
    if labelled:
        return _accept_all(labelled, "labelled")

    cells = _stat_cells(block)
    badges = [
        cell for cell in cells
        if cell.react_split and not cell.marks_pick_rate(labelled_pick_rates)
    ]
    if badges:
        # Split markup is how React renders ANY `{value}%`, the mobile
        # pick-rate badge included, so a badge counts only once pick-rate
        # evidence has excluded it — never merely by appearing first.
        return _accept_all([cell.token for cell in badges], "badge")

    primary = [cell for cell in cells if cell.primary]
    if len(primary) == 1 and any(cell.muted for cell in cells):
        # Exactly one primary stat cell, plus the pick-rate cell we expect
        # beside it: the layout matches what we verified, so this is unambiguous.
        return _accept(primary[0].token, "structural")

    # Candidates are collected WITHOUT a magnitude filter. Discarding
    # out-of-range siblings here would let the count fall to one and turn a
    # genuinely ambiguous row into a confident answer — magnitude reasoning by
    # the back door.
    tokens = _PERCENT_TOKEN_RE.findall(text)
    if not tokens:
        return None, "quarantined_no_percentage"
    pick_rate_tokens = labelled_pick_rates | {
        cell.token for cell in cells if cell.marks_pick_rate(labelled_pick_rates)
    }
    if pick_rate_tokens:
        # The row demonstrably carries a pick rate, yet no win-rate marker
        # resolved. Whatever is left cannot be told apart from it: a missing
        # win rate beside the desktop + mobile pick-rate pair looks exactly so.
        if all(token in pick_rate_tokens for token in tokens):
            return None, "quarantined_pick_rate_only"
        return None, "quarantined_ambiguous_percentages"
    if len(tokens) == 1:
        # One occurrence, not one distinct value: the only stat this source
        # duplicates is the pick rate, so collapsing duplicates is precisely
        # how a pick rate beside a missing win rate became a "sole" value.
        return _accept(tokens[0], "sole_percentage")
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
        reasons = collections.Counter(r["extraction"] for r in quarantined)
        print(
            f"  ⚠ {len(quarantined)} row(s) quarantined {dict(reasons)}: "
            + ", ".join(sorted(r["sourceKey"] for r in quarantined)[:8])
        )
    implausible = [
        r for r in augment_win_rate_rows if is_implausible_win_rate(r.get("win_rate"))
    ]
    if implausible:
        # Valid arithmetic, unusual value. Published, but surfaced so a
        # repurposed cell that still lands inside 0-100 does not pass unnoticed.
        print(
            f"  ⚠ {len(implausible)} row(s) outside the plausible win-rate band "
            f"({WIN_RATE_PLAUSIBLE_MIN}-{WIN_RATE_PLAUSIBLE_MAX}%): "
            + ", ".join(f"{r['sourceKey']}={r['win_rate']}" for r in implausible[:8])
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
