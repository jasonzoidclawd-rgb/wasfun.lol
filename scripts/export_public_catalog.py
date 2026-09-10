#!/usr/bin/env python3
"""Export sanitized public catalogs from full internal generated data."""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
from pathlib import Path

from data_paths import INTERNAL_DATA_DIR, ROOT
from patch_event_projection import build_patch_notes_projection, build_preview_projection

PUBLIC_DATA_DIR = ROOT / "public" / "data"
COPY_FILES = ("abilities.json", "champions.json", "meta.json")
LOCALIZED_AUGMENT_DESCRIPTION_FIELDS = {
    "zh_tw": "description_zh_TW",
    "zh_cn": "description_zh_CN",
    "ja": "description_ja",
    "ko": "description_ko",
}
TAG_RE = re.compile(r"<[^>]+>")
BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
WHITESPACE_RE = re.compile(r"\s+")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def copy_json(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def write_sanitized_json(source: Path, destination: Path, forbidden: set[str]) -> None:
    original = read_json(source)
    sanitized = strip_keys(original, forbidden)
    if sanitized == original:
        copy_json(source, destination)
    else:
        write_json(destination, sanitized)


def strip_keys(value, forbidden: set[str]):
    if isinstance(value, list):
        return [strip_keys(entry, forbidden) for entry in value]
    if isinstance(value, dict):
        return {
            key: strip_keys(entry, forbidden)
            for key, entry in value.items()
            if key not in forbidden
        }
    return value


def sanitized_description(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = BR_RE.sub(" ", value)
    text = TAG_RE.sub("", text)
    text = html.unescape(text)
    text = WHITESPACE_RE.sub(" ", text).strip()
    return text or None


def add_public_localized_augment_descriptions(augment: dict) -> None:
    by_locale = augment.get("effectTextByLocale")
    if not isinstance(by_locale, dict):
        return

    for locale_key, public_field in LOCALIZED_AUGMENT_DESCRIPTION_FIELDS.items():
        localized = by_locale.get(locale_key)
        if not isinstance(localized, dict):
            continue
        description = sanitized_description(localized.get("desc"))
        if description:
            augment[public_field] = description


def build_public_augments(internal_dir: Path, forbidden: set[str]) -> dict:
    augments = read_json(internal_dir / "augments.json")
    pool_rules = read_json(internal_dir / "pool-rules.json")
    lifecycle = pool_rules.get("lifecycle", {}) if isinstance(pool_rules, dict) else {}
    removed_patches = lifecycle.get("removed", {}) if isinstance(lifecycle, dict) else {}
    added_patches = lifecycle.get("added", {}) if isinstance(lifecycle, dict) else {}

    for augment in augments.get("augments", []):
        slug = augment.get("slug")
        if not slug:
            continue
        add_public_localized_augment_descriptions(augment)
        patch = removed_patches.get(slug) or added_patches.get(slug)
        if patch:
            # `lifecycle_from_events` records the patch at which we FIRST
            # OBSERVED this state, which is not the same claim as "Riot changed
            # it in this patch" — the catalog bootstrap recorded every
            # pre-existing removal at whatever patch was current that day. The
            # field name has to carry that weaker meaning, because the UI was
            # rendering it as a removal date.
            augment.setdefault("flags", {})["lifecycle_observed_patch"] = patch

    return strip_keys(augments, forbidden)


PUBLIC_COMBO_TIERS = {"S"}
MAX_TEASER_PER_CHAMPION = 3


def build_combo_teaser(combos: list[dict]) -> list[dict]:
    """Top S-tier combos per champion, names + tier only (no internal ref)."""
    teaser: list[dict] = []
    per_champion: dict[str, int] = {}
    for combo in combos:
        if combo.get("tier") not in PUBLIC_COMBO_TIERS:
            continue
        champion = combo.get("champion")
        augment = combo.get("augment")
        if not (champion and augment):
            continue
        if per_champion.get(champion, 0) >= MAX_TEASER_PER_CHAMPION:
            continue
        per_champion[champion] = per_champion.get(champion, 0) + 1
        teaser.append({
            "champion": champion,
            "augment": augment,
            "tier": combo["tier"],
        })
    return teaser


def build_public_hotfixes(hotfixes: dict) -> dict:
    events = []
    for event in hotfixes.get("events", []):
        changes = [
            change for change in event.get("changes", [])
            if change.get("type") != "mechanism" and change.get("status") != "bug_mechanism"
        ]
        if changes:
            events.append({**event, "changes": changes})
    return {**hotfixes, "events": events}


def build_live_entity_lookup(internal_dir: Path) -> dict[str, set[str]]:
    """PBE cards may link only to entities already present in the live catalog."""
    champions = read_json(internal_dir / "champions.json")
    augments = read_json(internal_dir / "augments.json")
    items = read_json(internal_dir / "items.json")
    return {
        "champion": {
            str(row["slug"])
            for row in champions.get("champions", [])
            if isinstance(row, dict) and row.get("slug")
        },
        "augment": {
            str(row["slug"])
            for row in augments.get("augments", [])
            if isinstance(row, dict) and row.get("slug")
        },
        "item": {
            str(row["id"])
            for row in items.get("items", [])
            if isinstance(row, dict) and row.get("id") is not None
        },
    }


def export_public_catalog(
    internal_dir: Path = INTERNAL_DATA_DIR,
    public_dir: Path = PUBLIC_DATA_DIR,
) -> None:
    for filename in COPY_FILES:
        copy_json(internal_dir / filename, public_dir / filename)

    forbidden_telemetry = {
        "win_rate",
        "winRate",
        "oracleScore",
        "modelWeights",
        "scoreBreakdown",
        # `availability` is deliberately NOT stripped: its resolved `status` is
        # the catalog's most useful public fact and the only thing that lets a
        # reader tell a temporarily disabled augment from one deleted patches
        # ago. The raw multi-source `signals` tree underneath it stays private —
        # stripping it recursively leaves exactly {"status": ...}.
        "signals",
        "provenance",
        "dataValues",
        "calculations",
        "wikiAvailabilityNotes",
        "wikiFetchedAt",
        "cdragon",
        "cdragonIcon",
        "cdragonRarity",
        "canonicalTooltip",
        "effectText",
        "effectTextByLocale",
        "definitionPlaceholder",
        "legacyCatalogRow",
    }
    forbidden_augment_telemetry = forbidden_telemetry | {"wikiNotes"}
    write_json(
        public_dir / "augments.json",
        build_public_augments(internal_dir, forbidden_augment_telemetry),
    )
    write_sanitized_json(
        internal_dir / "items.json",
        public_dir / "items.json",
        forbidden_telemetry,
    )
    # One explicit projection boundary for patch data.  The browser consumes
    # these bounded presentation files, never internal CDragon snapshots or
    # event-history/provenance archives.
    known_entities = build_live_entity_lookup(internal_dir)
    patch_events = read_json(internal_dir / "patch-events.json")
    patch_metadata = read_json(internal_dir / "patch-metadata.json")
    write_json(
        public_dir / "patch-notes.json",
        build_patch_notes_projection(
            patch_events,
            patch_metadata,
            known=known_entities,
            pbe_archive=read_json(internal_dir / "pbe-preview.json"),
        ),
    )
    pbe_archive = read_json(internal_dir / "pbe-preview.json")
    write_json(
        public_dir / "pbe-preview.json",
        build_preview_projection(pbe_archive, known_entities),
    )

    # Freemium combo teaser: publish a small slice of the headline S-tier
    # "strong combos" (champion/augment/tier only) for SEO + AI-citability and
    # as a conversion hook. The full 575-combo set, C-tier traps, oracle scores,
    # and the curated internal `ref` stay member-only.
    combos = read_json(internal_dir / "combos.json")
    combos["combos"] = build_combo_teaser(combos.get("combos", []))
    write_json(public_dir / "combos.json", combos)

    pool_rules = read_json(internal_dir / "pool-rules.json")
    # `disabled` is published: which augments are currently switched off is a
    # plain fact about the live game (the League wiki publishes it too), and
    # emptying it made the site unable to distinguish disabled from removed.
    # The curated exclusion/synergy rules remain member-only.
    for field in ("mutually_exclusive", "item_exclusions", "ally_exclusions"):
        pool_rules[field] = []
    pool_rules["lifecycle"] = {"added": {}, "removed": {}}
    pool_rules.pop("availability", None)
    pool_rules.pop("availability_overrides", None)
    write_json(public_dir / "pool-rules.json", pool_rules)

    # Lane/clock status drives the public degraded banner. Without it the site
    # cannot tell a reader that its data is behind, which is how 59 days of
    # stale data were presented as current.
    status = read_json(internal_dir / "pipeline-status.json") if (
        internal_dir / "pipeline-status.json"
    ).exists() else {}
    if status:
        write_json(public_dir / "pipeline-status.json", strip_keys(status, forbidden_telemetry))

    # `patch-events.json` is the authoritative hotfix feed.  The legacy
    # mayhem-hotfixes file is intentionally not exported or consumed here.


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--internal-dir", type=Path, default=INTERNAL_DATA_DIR)
    parser.add_argument("--public-dir", type=Path, default=PUBLIC_DATA_DIR)
    args = parser.parse_args()

    export_public_catalog(args.internal_dir, args.public_dir)
    print(f"Exported sanitized public catalogs from {args.internal_dir} to {args.public_dir}")


if __name__ == "__main__":
    main()
