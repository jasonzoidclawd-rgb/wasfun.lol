#!/usr/bin/env python3
"""
generate_pool_rules.py — Reconcile pool lifecycle from CDragon patch events.

Reads data/internal/patch-events.json and accumulates source-versioned lifecycle
changes that affect
champion augment pool composition:
  - item_exclusions: augment not offered if player owns specific item
  - mutually_exclusive: augment pairs that can never both be offered
  - ally_exclusions: chain-heal/buff sources that skip targets with specific augment
  - disabled / availability: augments explicitly non-offerable under resolved availability
  - lifecycle: augments added or removed per patch

Writes: data/internal/pool-rules.json (current-patch snapshot)

Usage:
  python3 scripts/generate_pool_rules.py [--dry-run]
"""

import argparse
import json
import re
from pathlib import Path

from data_paths import INTERNAL_DATA_DIR

DATA_DIR = INTERNAL_DATA_DIR
PATCH_EVENTS_PATH = DATA_DIR / "patch-events.json"
AUGMENTS_PATH    = DATA_DIR / "augments.json"
ITEMS_PATH       = DATA_DIR / "items.json"
OUTPUT_PATH      = DATA_DIR / "pool-rules.json"

# ─── Regex patterns (Layer A) ─────────────────────────────────────────────────

# "X is no longer offered if you have Y."
ITEM_EXCL_RE = re.compile(
    r"([A-Za-z ''\-]+?) is no longer offered if you have ([A-Za-z ''\-]+?)\.",
    re.I,
)

# "X and Y are now mutually exclusive"
MUTUAL_EXCL_RE = re.compile(
    r"([A-Za-z ''\-]+?) and ([A-Za-z ''\-]+?) are now mutually exclusive",
    re.I,
)

# "X no longer targets champions with Y" (chain-heal carve-outs)
ALLY_EXCL_RE = re.compile(
    r"([A-Za-z ''\-]+?) no longer targets? (?:champions?|allied champions?) with ([A-Za-z ''\-]+?)\.",
    re.I,
)

# ─── Name → slug normalization ────────────────────────────────────────────────

def _slugify(name: str) -> str:
    """Best-effort: lowercase, strip apostrophes/quotes, replace spaces with hyphens."""
    s = name.strip().lower()
    s = re.sub(r"[''`]", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def _lookup_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def build_augment_name_map(augments: list) -> dict:
    """Map lowercase name variants → slug."""
    m = {}
    for a in augments:
        slug = a["slug"]
        m[a["name"].lower()] = slug
        m[slug] = slug  # slug maps to itself
        # Also add slugified version of name
        m[_slugify(a["name"])] = slug
        m[_lookup_key(a["name"])] = slug
        m[_lookup_key(slug)] = slug
    return m


def build_item_name_map(items_raw) -> dict:
    if isinstance(items_raw, dict) and "items" in items_raw:
        items = items_raw["items"]
    elif isinstance(items_raw, list):
        items = items_raw
    else:
        return {}
    m = {}
    for item in items:
        name = item.get("name") or ""
        slug = item.get("slug") or _slugify(name)
        m[name.lower()] = slug
        m[_slugify(name)] = slug
        m[_lookup_key(name)] = slug
        m[_lookup_key(slug)] = slug
    return m


def resolve_name(name: str, name_map: dict, fallback_slug: bool = True) -> str:
    """Resolve a raw name to a slug. Falls back to slugification."""
    key = name.strip().lower()
    if key in name_map:
        return name_map[key]
    slg = _slugify(name)
    if slg in name_map:
        return name_map[slg]
    lookup = _lookup_key(name)
    if lookup in name_map:
        return name_map[lookup]
    return slg if fallback_slug else ""


# ─── Main extraction ──────────────────────────────────────────────────────────

def extract_rules(patches: list, aug_map: dict, item_map: dict) -> dict:
    """
    Scan all patches and accumulate pool-shaping rules.
    Rules are additive — once introduced they remain unless explicitly reverted.
    (Reversions are not currently tracked; assumed not to exist in the dataset.)
    """
    item_exclusions   = {}   # (aug_slug, item_slug) → True
    mutual_exclusive  = set()  # frozenset of (a, b) pairs
    ally_exclusions   = {}   # (source_slug, target_aug_slug) → True
    disabled          = set()
    lifecycle_added   = {}   # slug → patch_version
    lifecycle_removed = {}   # slug → patch_version

    for patch in patches:
        pv = patch["version"]
        for sec in patch["sections"]:
            for ch in sec["changes"]:
                text = ch["text"].get("en", "").strip()
                subj = ch["subject"].get("en", "").strip()

                # ── Item exclusions ──
                m = ITEM_EXCL_RE.search(text)
                if m:
                    aug_slug  = resolve_name(m.group(1), aug_map, fallback_slug=False)
                    item_slug = resolve_name(m.group(2), item_map, fallback_slug=False)
                    if aug_slug and item_slug:
                        item_exclusions[(aug_slug, item_slug)] = True
                    else:
                        print(f"  [pool-rules] unresolved item-exclusion: {m.group(1)!r}/{m.group(2)!r} (patch {pv})")

                # ── Mutual exclusions ──
                m = MUTUAL_EXCL_RE.search(text)
                if m:
                    a = resolve_name(m.group(1), aug_map, fallback_slug=False)
                    b = resolve_name(m.group(2), aug_map, fallback_slug=False)
                    if a and b:
                        mutual_exclusive.add(frozenset([a, b]))
                    else:
                        print(f"  [pool-rules] unresolved mutual-exclusion: {m.group(1)!r}/{m.group(2)!r} (patch {pv})")

                # ── Ally exclusions (chain-heal carve-outs) ──
                m = ALLY_EXCL_RE.search(text)
                if m:
                    source = resolve_name(subj or m.group(1), aug_map, fallback_slug=False)
                    target = resolve_name(m.group(2), aug_map, fallback_slug=False)
                    if source and target:
                        ally_exclusions[(source, target)] = True
                    else:
                        print(f"  [pool-rules] unresolved ally-exclusion: {subj or m.group(1)!r}/{m.group(2)!r} (patch {pv})")

                # ── Lifecycle: NEW augments ──
                if text.startswith("• NEW:") or text.startswith("NEW:"):
                    if subj:
                        slug = resolve_name(subj, aug_map, fallback_slug=False)
                        if slug:
                            lifecycle_added.setdefault(slug, pv)
                        else:
                            print(f"  [pool-rules] unresolved NEW augment: {subj!r} (patch {pv})")

                # ── Lifecycle: REMOVED augments ──
                text_l = text.lower()
                if subj and any([
                    text_l.startswith("• removed:") or text_l.startswith("removed:"),
                    re.search(r"(?:has been|have been|is|are)\s+(?:permanently\s+)?removed\b", text_l),
                    re.search(r"no longer (?:available|offered)\b", text_l),
                    "removed from the pool" in text_l,
                ]):
                    slug = resolve_name(subj, aug_map, fallback_slug=False)
                    if slug:
                        lifecycle_removed.setdefault(slug, pv)

                # ── Disabled (temporarily removed from pool) ──
                if subj and re.search(r"\bdisabled\b|temporarily\s+(?:removed|unavailable)", text_l):
                    slug = resolve_name(subj, aug_map, fallback_slug=False)
                    if slug:
                        disabled.add(slug)

    return {
        "item_exclusions":  [
            {"augment": aug, "blocked_by_item": item}
            for (aug, item) in sorted(item_exclusions)
        ],
        "mutually_exclusive": [
            sorted(pair) for pair in sorted(mutual_exclusive)
        ],
        "ally_exclusions": [
            {"source": src, "skips_allies_with": tgt}
            for (src, tgt) in sorted(ally_exclusions)
        ],
        "disabled": sorted(disabled),
        "lifecycle": {
            "added":   dict(sorted(lifecycle_added.items())),
            "removed": dict(sorted(lifecycle_removed.items())),
        },
    }


_CDRAGON_VERSION_RE = re.compile(r"^(\d+)\.(\d+)")


def _source_version_key(version: object) -> tuple[int, int] | None:
    """Major/minor of a CDragon source version (e.g. '16.18.8159717+...')."""
    match = _CDRAGON_VERSION_RE.match(str(version or ""))
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def comparison_is_patch_adjacent(comparison: object) -> bool:
    """True when a diff compares consecutive (or identical) game patches.

    A snapshot diff proves "absent then present". That is only evidence of an
    addition IN a specific patch when the two snapshots are one patch apart.
    After a multi-patch blind interval — e.g. the 16.13 -> 16.18 comparison the
    first run after the 2026-07/09 outage produced — it proves only "exists in
    the first observation after the gap", and the entity may have arrived in any
    of the intervening patches. Attributing it to the target patch fabricates a
    specific, checkable claim, which is the same defect previously fixed for
    removals.

    Adjacency is decided on the CDragon source versions carried by the event,
    never on timestamps. A season rollover keeps the minor number small, so a
    single-major step into an early minor counts as adjacent; anything wider is
    treated as a gap, which fails safe by withholding the date.
    """
    if not isinstance(comparison, dict):
        return False
    base = _source_version_key(comparison.get("base_version"))
    target = _source_version_key(comparison.get("target_version"))
    if base is None or target is None:
        return False
    if base == target:
        return True
    if base[0] == target[0]:
        return 0 <= target[1] - base[1] <= 1
    if target[0] - base[0] == 1:
        return target[1] <= 1
    return False


def comparison_crosses_patch_boundary(comparison: object) -> bool:
    """True only when the diff spans the transition INTO the target patch.

    This answers a strictly different question from
    `comparison_is_patch_adjacent`, and conflating the two is a live defect:

      adjacency — "can this single observation be attributed to the target
                  patch?" A same-patch refresh (16.18.a -> 16.18.b) qualifies,
                  because a hotfix shipped inside 26.18 IS a 26.18 change.
      boundary  — "was the transition from the previous patch into this one
                  observed?" A same-patch refresh proves nothing of the kind:
                  it sees only what moved after the patch already landed.

    Reading adjacency as boundary coverage means that after the historical
    16.13 -> 16.18 gap, tomorrow's routine 16.18.a -> 16.18.b refresh would
    "prove" patch 26.18 was fully observed, and its 275 undatable cross-gap
    changes would be published as a verified zero. Boundary crossing is
    therefore adjacency MINUS the same-patch case — strictly narrower, so it
    can never admit a pair adjacency rejects.
    """
    if not comparison_is_patch_adjacent(comparison):
        return False
    # Adjacency already rejected every non-dict and every unparseable version,
    # so the only case left to exclude is base and target being the same patch.
    base = _source_version_key(comparison["base_version"])  # type: ignore[index]
    target = _source_version_key(comparison["target_version"])  # type: ignore[index]
    return base != target


def comparison_crosses_cycle_boundary(comparison: object, cycle: object) -> bool:
    """True when the diff crosses the boundary INTO `cycle` specifically.

    `comparison_crosses_patch_boundary` proves a diff crossed SOME patch
    boundary; it cannot say which patch it arrived at. That gap matters because
    a record's label and its versions come from different systems: the label is
    Riot's patch-notes feed (`_latest_patch_label` reads patch-metadata.json)
    while the versions come from the CDragon lineage. When the two feeds are out
    of step — Riot publishing the next article before CDragon ships the build —
    a perfectly valid 16.16 -> 16.17 comparison can be stamped "26.18", and it
    would otherwise contribute a lane to a patch it never observed.

    A game patch and its CDragon lineage share the patch number WITHIN the
    season (26.18 <-> 16.18.x, verified across the live archive, snapshots and
    Riot metadata), which is the whole correspondence needed here. The season
    majors (26 vs 16) are deliberately NOT compared: their difference is a
    numbering offset that a season rollover can change, and pinning it would be
    exactly the hardcoded patch number AGENTS.md forbids. Season-rollover
    adjacency therefore keeps working unchanged — 16.24 -> 17.0 labelled "27.0"
    still matches on 0.

    Fails closed on an unparseable cycle ("unknown", "", a PBE cycle tag) and on
    an unparseable version, so malformed archive evidence can never widen
    coverage.
    """
    if not comparison_crosses_patch_boundary(comparison):
        return False
    target = _source_version_key(comparison["target_version"])  # type: ignore[index]
    claimed = _source_version_key(cycle)
    if target is None or claimed is None:
        return False
    return target[1] == claimed[1]


def lifecycle_from_events(events: list[dict]) -> dict:
    """Only CDragon additions/removals may alter augment lifecycle state.

    A date is recorded only when the event's own comparison proves the two
    snapshots were one patch apart. Events observed across a gap still exist in
    the archive; they simply carry no patch attribution.
    """
    added: dict[str, str] = {}
    removed: dict[str, str] = {}
    undated: dict[str, str] = {}
    for event in events:
        if event.get("entity_type") != "augment" or not event.get("slug"):
            continue
        kind = event.get("change_kind")
        if kind not in {"added", "removed"}:
            continue
        slug = event["slug"]
        if not comparison_is_patch_adjacent(event.get("comparison")):
            undated.setdefault(slug, kind)
            continue
        patch = str(event.get("source_patch_label") or "unknown")
        if kind == "added":
            added.setdefault(slug, patch)
        else:
            removed.setdefault(slug, patch)
    # A slug with a dated event anywhere is dated; the rest are first-observed.
    undated = {
        slug: kind for slug, kind in undated.items()
        if slug not in added and slug not in removed
    }
    return {
        "added": dict(sorted(added.items())),
        "removed": dict(sorted(removed.items())),
        "first_observed_across_gap": dict(sorted(undated.items())),
    }


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    event_raw = json.loads(PATCH_EVENTS_PATH.read_text("utf-8"))
    current_patch = event_raw.get("current_open_cycle", "unknown")
    scraped_at = event_raw.get("observed_at", "")

    aug_raw  = json.loads(AUGMENTS_PATH.read_text("utf-8"))
    augments = aug_raw["augments"] if isinstance(aug_raw, dict) and "augments" in aug_raw else aug_raw
    aug_map  = build_augment_name_map(augments)

    item_raw = json.loads(ITEMS_PATH.read_text("utf-8"))
    item_map = build_item_name_map(item_raw)

    # Interaction policy is a separate curated compatibility artifact. It is
    # retained from the previous generated state, not re-derived from brittle
    # article prose. CDragon events own all addition/removal lifecycle changes.
    existing_rules = json.loads(OUTPUT_PATH.read_text("utf-8")) if OUTPUT_PATH.exists() else {}
    rules = {
        "item_exclusions": existing_rules.get("item_exclusions", []),
        "mutually_exclusive": existing_rules.get("mutually_exclusive", []),
        "ally_exclusions": existing_rules.get("ally_exclusions", []),
        # `disabled` is NOT carried forward. It used to be seeded from its own
        # previous output and then unioned with the availability resolver, which
        # made it monotonic: an augment could enter the list but never leave it.
        # Riot re-enabled Clown College in 26.18 and the resolver correctly moved
        # it to `confirmed_live`, yet the carried-forward list still called it
        # disabled — two authorities for one current-state fact.
        # It is now derived, every run, from the availability resolver alone.
        "disabled": [],
        "lifecycle": lifecycle_from_events(event_raw.get("events", [])),
    }

    # 26.12+: resolved availability is the offerability source. The legacy
    # lifecycle map remains as a compatibility fallback for older consumers, but
    # the availability map carries the exact non-offerable reason.
    disabled: set[str] = set()
    offerable: dict[str, str] = {}
    non_offerable: dict[str, str] = {}
    for aug in augments:
        slug = aug["slug"]
        status = ((aug.get("availability") or {}).get("status") or "").strip()
        if status == "confirmed_live":
            offerable[slug] = status
        elif status:
            non_offerable[slug] = status
            if status == "disabled":
                disabled.add(slug)
        elif aug.get("name") == "???":
            non_offerable[slug] = "placeholder"

        # `lifecycle.added` / `lifecycle.removed` carry DATES, so they may only
        # be written by an observed CDragon transition (`lifecycle_from_events`).
        # They used to be back-filled with the generation patch for every
        # non-offerable augment, which stamped a specific, checkable, false
        # claim ("removed in 26.13", then "removed in 26.18" a run later) onto
        # entities that had simply always been absent. Being non-offerable is a
        # STATE; when it started is a separate fact we usually do not know.
    rules["disabled"] = sorted(disabled)

    # Single-authority invariant: the disabled list IS the set of augments the
    # resolver marked disabled. Assert it here so a future second derivation
    # path fails generation instead of silently diverging downstream.
    resolver_disabled = {
        aug["slug"]
        for aug in augments
        if ((aug.get("availability") or {}).get("status") or "").strip() == "disabled"
    }
    if set(rules["disabled"]) != resolver_disabled:
        raise SystemExit(
            "pool-rules.disabled diverged from availability resolver: "
            f"only_in_rules={sorted(set(rules['disabled']) - resolver_disabled)} "
            f"only_in_resolver={sorted(resolver_disabled - set(rules['disabled']))}"
        )
    rules["lifecycle"]["added"] = dict(sorted(rules["lifecycle"]["added"].items()))
    rules["lifecycle"]["removed"] = dict(sorted(rules["lifecycle"]["removed"].items()))
    availability = {
        "offerable": dict(sorted(offerable.items())),
        "non_offerable": dict(sorted(non_offerable.items())),
    }

    output = {
        "patch":      current_patch,
        "scraped_at": scraped_at,
        "availability": availability,
        **rules,
    }

    print(f"Pool rules extracted for patch {current_patch}:")
    print(f"  item_exclusions:    {len(rules['item_exclusions'])}")
    print(f"  mutually_exclusive: {len(rules['mutually_exclusive'])}")
    print(f"  ally_exclusions:    {len(rules['ally_exclusions'])}")
    print(f"  disabled:           {len(rules['disabled'])}")
    print(f"  lifecycle.added:    {len(rules['lifecycle']['added'])}")
    print(f"  availability.offerable:     {len(availability['offerable'])}")
    print(f"  availability.non_offerable: {len(availability['non_offerable'])}")

    print("\nItem exclusions:")
    for r in rules["item_exclusions"]:
        print(f"  {r['augment']} ← blocked if owns {r['blocked_by_item']}")

    print("\nMutual exclusions:")
    for pair in rules["mutually_exclusive"]:
        print(f"  {pair[0]} ↔ {pair[1]}")

    print("\nAlly exclusions (chain-heal carve-outs):")
    for r in rules["ally_exclusions"]:
        print(f"  {r['source']} skips allies with {r['skips_allies_with']}")

    if args.dry_run:
        print("\n[DRY RUN — nothing written]")
        return

    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2), "utf-8")
    print(f"\nWrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
