#!/usr/bin/env python3
"""Schema and sanity gate for the v3 statistics feeds (phase 0).

Runs in scripts/update-data.sh before anything is committed. Exit 1 on any
error; warnings are printed but do not block. Hand-rolled on purpose: CI's
Python job installs only pytest, and these checks are few and exact.

Checks, per feed:
- augment-stats-feed / champion-build-feed: required keys and types, every rate
  in [0, 100], rarities from the known set, provenance and units present, units
  never marked confirmed without a recorded confirmation, no duplicate rows,
  coverage floors (live augments resolved, champions parsed);
- changed-augments: one entry per patch with evidence on every changed augment;
- augment-kit-tags: profiles from the fixed set, every override reasoned;
- stats-snapshots: each snapshot carries its date and patch.

Usage:
    python3 scripts/validate_stats_feeds.py
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

from data_paths import INTERNAL_DATA_DIR

RARITIES = {"prismatic", "gold", "silver"}
PROFILES = {"ad", "ap", "tank", "neutral"}
MIN_CHAMPIONS = 150
MIN_LIVE_RESOLVED_SHARE = 0.90
MAX_NEW_UNMATCHED = 5
PROVENANCE_KEYS = {"provider", "providerSourceClaim", "authorityLineage", "transport", "sampleSize"}


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def err(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def _rate(rep: Report, where: str, value) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 <= value <= 100:
        rep.err(f"{where}: rate {value!r} is not a number in [0, 100]")


def _common(rep: Report, name: str, doc: dict) -> None:
    for key in ("schemaVersion", "feed", "fetchedAt", "patch", "provenance", "fieldProvenance", "units"):
        if key not in doc:
            rep.err(f"{name}: missing {key}")
    missing = PROVENANCE_KEYS - set(doc.get("provenance", {}))
    if missing:
        rep.err(f"{name}: provenance missing {sorted(missing)}")
    if doc.get("provenance", {}).get("sampleSize") is not None:
        rep.err(f"{name}: sampleSize must stay null; the provider publishes no denominators")
    for field, unit in doc.get("units", {}).items():
        if unit.get("status") == "confirmed" and not unit.get("confirmation"):
            rep.err(f"{name}: units.{field} marked confirmed without a recorded confirmation")


def check_augment_stats(rep: Report, doc: dict) -> None:
    _common(rep, "augment-stats-feed", doc)
    seen = set()
    live = resolved = new_unmatched = 0
    for i, row in enumerate(doc.get("rows", [])):
        where = f"augment-stats-feed rows[{i}] {row.get('sourceSlug')}"
        for key in ("sourceSlug", "name", "rarity", "availability", "winRate", "pickRate", "augmentId", "identity"):
            if key not in row:
                rep.err(f"{where}: missing {key}")
        if row.get("rarity") not in RARITIES:
            rep.err(f"{where}: rarity {row.get('rarity')!r}")
        _rate(rep, where, row.get("winRate"))
        _rate(rep, where, row.get("pickRate"))
        if row.get("sourceSlug") in seen:
            rep.err(f"{where}: duplicate sourceSlug")
        seen.add(row.get("sourceSlug"))
        if row.get("availability") == "live":
            live += 1
            resolved += bool(row.get("augmentId"))
            identity = str(row.get("identity", ""))
            new_unmatched += identity == "unmatched" or identity.startswith(("ambiguous", "slug-candidate", "alias:rarity"))
    if live and resolved / live < MIN_LIVE_RESOLVED_SHARE:
        rep.err(f"augment-stats-feed: only {resolved}/{live} live augments resolved to a CDragon id")
    if new_unmatched > MAX_NEW_UNMATCHED:
        rep.err(f"augment-stats-feed: {new_unmatched} live rows neither matched nor reviewed in the alias table")
    elif new_unmatched:
        rep.warn(f"augment-stats-feed: {new_unmatched} live rows need an alias-table decision")


def check_champion_builds(rep: Report, doc: dict) -> None:
    _common(rep, "champion-build-feed", doc)
    champions = doc.get("champions", {})
    if len(champions) < MIN_CHAMPIONS:
        rep.err(f"champion-build-feed: {len(champions)} champions < {MIN_CHAMPIONS}")
    for slug, champ in champions.items():
        where = f"champion-build-feed {slug}"
        for key in ("winRate", "patch", "dataDate", "augments", "items"):
            if key not in champ:
                rep.err(f"{where}: missing {key}")
        _rate(rep, where, champ.get("winRate"))
        if champ.get("pickRate") is not None:
            _rate(rep, where, champ["pickRate"])
        pairs = set()
        for row in champ.get("augments", []):
            if row.get("rarity") not in RARITIES:
                rep.err(f"{where}: augment rarity {row.get('rarity')!r}")
            _rate(rep, f"{where} {row.get('sourceSlug')}", row.get("appearanceRate"))
            _rate(rep, f"{where} {row.get('sourceSlug')}", row.get("winRate"))
            key = (row.get("rarity"), row.get("sourceSlug"))
            if key in pairs:
                rep.err(f"{where}: duplicate augment row {key}")
            pairs.add(key)
        for row in champ.get("history", []):
            _rate(rep, f"{where} history {row.get('snapshot')}", row.get("winRate"))
            _rate(rep, f"{where} history {row.get('snapshot')}", row.get("pickRate"))
        for section, rows in champ.get("items", {}).items():
            for row in rows:
                _rate(rep, f"{where} items.{section}", row.get("pickRate"))
                _rate(rep, f"{where} items.{section}", row.get("winRate"))
                if not row.get("items"):
                    rep.err(f"{where} items.{section}: row with no items")
    semantics = doc.get("semantics", {}).get("augments[].winRate", {})
    if semantics.get("status") not in ("global-copy", "champion-specific", "mixed"):
        rep.err(f"champion-build-feed: semantics of augments[].winRate is {semantics.get('status')!r}, not established")
    elif semantics["status"] != "global-copy":
        rep.warn(f"champion-build-feed: champion augment win rates are now {semantics['status']} "
                 f"({semantics.get('rowsEqualToGlobal')}/{semantics.get('rowsCompared')} equal to global); "
                 "re-run scripts/model/interaction_spread.py and revisit the pooling fallback")
    # The champion pick rate's unit (share of games) is confirmed only while the
    # rates keep summing to 10 per game; re-check it on every run.
    pick_sum = sum(c.get("pickRate") or 0 for c in champions.values())
    if doc.get("units", {}).get("pickRate", {}).get("status") == "confirmed" and len(champions) >= MIN_CHAMPIONS \
            and abs(pick_sum - 1000.0) > 10.0:
        rep.err(f"champion-build-feed: champion pick rates sum to {pick_sum:.1f}%, not 1000%; the confirmed unit no longer holds")
    if not doc.get("dataDate"):
        rep.err("champion-build-feed: missing the provider's dataDate")
    failures = doc.get("failures", [])
    if failures:
        rep.warn(f"champion-build-feed: {len(failures)} build pages failed: {[f['slug'] for f in failures][:10]}")


def check_changed(rep: Report, doc: dict) -> None:
    for patch, entry in doc.get("patches", {}).items():
        if entry.get("patch") != patch:
            rep.err(f"changed-augments {patch}: entry labelled {entry.get('patch')!r}")
        if entry.get("status") not in ("complete", "provisional"):
            rep.err(f"changed-augments {patch}: status {entry.get('status')!r}")
        for change in entry.get("changed", []):
            if not change.get("augmentId") or not change.get("evidence"):
                rep.err(f"changed-augments {patch}: change without augmentId or evidence: {change}")


def check_kit_tags(rep: Report, doc: dict) -> None:
    for augment_id, tag in doc.get("tags", {}).items():
        if tag.get("profile") not in PROFILES:
            rep.err(f"augment-kit-tags {augment_id}: profile {tag.get('profile')!r}")
        if tag.get("profile") != tag.get("derived") and tag.get("reviewed") and not tag.get("override"):
            rep.err(f"augment-kit-tags {augment_id}: overridden without a reason")
        if not tag.get("textHash"):
            rep.err(f"augment-kit-tags {augment_id}: no textHash, so a text change could keep a stale review")
    unreviewed = [k for k, t in doc.get("tags", {}).items() if not t.get("reviewed")]
    if unreviewed:
        rep.warn(f"augment-kit-tags: {len(unreviewed)} unreviewed (count as neutral): {unreviewed[:8]}")


def check_snapshots(rep: Report, snap_dir: Path) -> None:
    if not snap_dir.exists():
        return
    for path in sorted(snap_dir.glob("*/*.json.gz")):
        doc = json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))
        if doc.get("snapshotDate") != path.parent.name or not doc.get("patch"):
            rep.err(f"snapshot {path.parent.name}/{path.name}: bad snapshotDate or patch")


def validate(data_dir: Path = INTERNAL_DATA_DIR) -> Report:
    rep = Report()
    checks = (
        ("augment-stats-feed.json", check_augment_stats),
        ("champion-build-feed.json", check_champion_builds),
        ("changed-augments.json", check_changed),
        ("augment-kit-tags.json", check_kit_tags),
    )
    for filename, check in checks:
        path = data_dir / filename
        if not path.exists():
            rep.err(f"{filename}: missing")
            continue
        check(rep, json.loads(path.read_text(encoding="utf-8")))
    check_snapshots(rep, data_dir / "stats-snapshots")
    return rep


def main() -> int:
    rep = validate()
    for w in rep.warnings:
        print(f"  ⚠ {w}")
    for e in rep.errors:
        print(f"  ✗ {e}")
    print(f"stats feeds: {len(rep.errors)} error(s), {len(rep.warnings)} warning(s)")
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
