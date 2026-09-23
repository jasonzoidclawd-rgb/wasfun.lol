#!/usr/bin/env python3
"""Join provider augment rows to CDragon augmentNameIds (v3 phase 0).

The legacy resolver only sees augments the internal catalog already carries a
win rate for, so an augment the provider adds is never offered a match (83 of
201 provider rows went unmatched on 2026-09-23). This resolver matches the
scraped rows themselves, in order:

1. the persisted alias table `data/internal/augment-stats-aliases.json`
   (hand-reviewed; each entry states its reason), which also records rows that
   are deliberately left unresolved;
2. an exact normalized display-name match to exactly one catalog augment of the
   same rarity.

A slug-only match is NOT accepted: the catalog's slugs partly come from the same
provider, so a slug agreeing is not independent evidence, and it has hidden
renamed augments. It is reported as a candidate for the alias table instead.

No substring or fuzzy matching: "siphon" must never resolve to Soul Siphon.

Usage:
    python3 scripts/augment_stats_identity.py --report   # coverage report for the current feeds
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from data_paths import INTERNAL_DATA_DIR

ALIASES_PATH = INTERNAL_DATA_DIR / "augment-stats-aliases.json"
CATALOG_PATH = INTERNAL_DATA_DIR / "augments.json"


def norm(value: str | None) -> str:
    value = (value or "").lower().replace("&", "and")
    value = re.sub(r"^quest[:\s-]*", "", value)
    return re.sub(r"[^a-z0-9]+", "", value)


@dataclass
class IdentityContext:
    by_name: dict[tuple[str, str], set[str]] = field(default_factory=dict)
    by_slug: dict[tuple[str, str], set[str]] = field(default_factory=dict)
    known_ids: set[str] = field(default_factory=set)
    rarity_of: dict[str, str] = field(default_factory=dict)
    aliases: dict[str, dict] = field(default_factory=dict)


def build_context(catalog: dict, alias_table: dict) -> IdentityContext:
    ctx = IdentityContext()
    for aug in catalog.get("augments", []):
        augment_id = aug.get("augmentId")
        rarity = aug.get("rarity")
        if not augment_id or not rarity:
            continue
        ctx.known_ids.add(augment_id)
        ctx.rarity_of[augment_id] = rarity
        names = {aug.get("name"), aug.get("displayName")}
        if isinstance(aug.get("names"), dict):
            names.add(aug["names"].get("en"))
        for name in names:
            if norm(name):
                ctx.by_name.setdefault((norm(name), rarity), set()).add(augment_id)
        if norm(aug.get("slug")):
            ctx.by_slug.setdefault((norm(aug["slug"]), rarity), set()).add(augment_id)
    for entry in alias_table.get("aliases", []):
        source = entry["sourceSlug"]
        target = entry.get("augmentId")
        if target is not None and target not in ctx.known_ids:
            raise ValueError(f"alias {source!r} points at unknown augmentId {target!r}")
        if not entry.get("reason"):
            raise ValueError(f"alias {source!r} has no reason")
        ctx.aliases[source] = entry
    return ctx


def load_identity_context(
    catalog_path: Path = CATALOG_PATH, aliases_path: Path = ALIASES_PATH
) -> IdentityContext:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    aliases = json.loads(aliases_path.read_text(encoding="utf-8")) if aliases_path.exists() else {}
    return build_context(catalog, aliases)


def resolve_augment(source_slug: str, name: str, rarity: str, ctx: IdentityContext) -> tuple[str | None, str]:
    """Return (augmentId or None, method)."""
    if source_slug in ctx.aliases:
        entry = ctx.aliases[source_slug]
        target = entry.get("augmentId")
        if not target:
            return None, "alias:unresolved"
        # An alias settles identity, not rarity: a rarity disagreement needs its own review.
        if ctx.rarity_of.get(target) != rarity and not entry.get("rarityReviewed"):
            return None, "alias:rarity-mismatch"
        return target, "alias"
    hits = ctx.by_name.get((norm(name), rarity), set())
    if len(hits) == 1:
        return next(iter(hits)), "name"
    if len(hits) > 1:
        return None, "ambiguous:name"
    candidates = ctx.by_slug.get((norm(source_slug), rarity), set())
    if len(candidates) == 1:
        return None, f"slug-candidate:{next(iter(candidates))}"
    return None, "unmatched"


def coverage_report(stats_feed: dict, build_feed: dict | None) -> dict:
    live = [r for r in stats_feed["rows"] if r["availability"] == "live"]
    unresolved = [
        {k: r[k] for k in ("sourceSlug", "name", "rarity", "identity")}
        for r in stats_feed["rows"]
        if not r["augmentId"]
    ]
    report = {
        "globalLive": len(live),
        "globalLiveResolved": sum(1 for r in live if r["augmentId"]),
        "unresolved": unresolved,
    }
    if build_feed:
        rows = [r for c in build_feed["champions"].values() for r in c["augments"]]
        report["championRows"] = len(rows)
        report["championRowsResolved"] = sum(1 for r in rows if r["augmentId"])
        missing = sorted({(r["sourceSlug"], r["rarity"], r["identity"]) for r in rows if not r["augmentId"]})
        report["championRowsUnresolved"] = [dict(zip(("sourceSlug", "rarity", "identity"), m)) for m in missing]
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()
    if args.report:
        stats = json.loads((INTERNAL_DATA_DIR / "augment-stats-feed.json").read_text(encoding="utf-8"))
        build_path = INTERNAL_DATA_DIR / "champion-build-feed.json"
        build = json.loads(build_path.read_text(encoding="utf-8")) if build_path.exists() else None
        print(json.dumps(coverage_report(stats, build), indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
