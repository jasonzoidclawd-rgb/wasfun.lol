#!/usr/bin/env python3
"""Acquire and promote isolated latest/PBE CDragon entity lineages.

Each branch is an independent transaction across augment, champion, and item
snapshots.  A failed or malformed source never falls back to the other branch
and never writes a partial branch update.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Union
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from cdragon_entity_adapters import (
    normalize_augment_entities,
    normalize_champion_entities,
    normalize_item_entities,
    extract_base_stats_from_bin,
)
from cdragon_snapshot_diff import (
    ENTITY_TYPES,
    SnapshotValidationError,
    advance_preview_lifecycle,
    atomic_write_many,
    build_snapshot,
    compare_snapshots,
    snapshot_filename,
    validate_snapshot,
)
from data_paths import INTERNAL_DATA_DIR
from safe_http import read_limited_response
from scrape_mayhem_augments_cdragon import (
    build_tooltip_index,
    extract_augments,
    load_json as load_augment_json,
    localized_name_index,
    registry_token_aliases_from_table,
)


HEADERS = {"User-Agent": "MayhemOracle/1.0 (CDragon patch pipeline)"}
LATEST_BASELINE_MAX_AGE_HOURS = 36
FetchJson = Callable[[str], Union[dict[str, Any], list[Any]]]

# Riot ships derived champion records (Jade_* variants, id 60001+) inside
# champion-summary.json.  They carry a prime-champion back-reference and have no
# `game/data/characters/<key>/<key>.bin.json`, so fetching their bin 404s.
# Riot's own back-reference fields are the discriminator — not an id threshold,
# which is a magic number that a future content drop can invalidate.
DERIVED_VARIANT_MARKERS = ("relatedPrimeContentId", "relatedPrimeItemId")

# Absence of a current observation is NOT evidence that a stat changed.
#
# A ratio floor was wrong here: it let a transient 404 drop a champion's base
# stats, and the snapshot diff then published that absence as a balance change
# ("base_stats.health: 690 -> gone"). Continuity is semantic, not statistical —
# for a champion we have seen before, a missing bin means "no new observation",
# so the previously observed stats are carried forward and the diff is empty.
#
# The ceiling below only guards against a SYSTEMIC outage: if CDragon stops
# serving a large share of bins, carrying everything forward would silently
# serve a whole stale roster under a new patch label, so the lane fails instead.
CHAMPION_BIN_RETENTION_CEILING = 0.05


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"malformed JSON snapshot: {path.name}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"malformed JSON snapshot: {path.name}")
    return value


def read_snapshot_lineage(internal_dir: Path, branch: str) -> dict[str, dict[str, Any]]:
    """Read one branch only; never substitute snapshots across lanes."""
    snapshots: dict[str, dict[str, Any]] = {}
    for entity_type in sorted(ENTITY_TYPES):
        value = _read_json(internal_dir / snapshot_filename(entity_type, branch))
        if value is None:
            continue
        try:
            validate_snapshot(value)
        except SnapshotValidationError as exc:
            raise ValueError(f"malformed {branch} snapshot {entity_type}: {exc}") from exc
        if value["branch"] != branch:
            raise ValueError(f"lane mismatch: {snapshot_filename(entity_type, branch)}")
        snapshots[entity_type] = value
    return snapshots


def _event_key(event: dict[str, Any]) -> str:
    return json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _build_latest_archive(
    previous_archive: dict[str, Any] | None,
    new_events: list[dict[str, Any]],
    source_patch_label: str,
    observed_at: str,
) -> dict[str, Any]:
    previous_events = (previous_archive or {}).get("events", [])
    events = [event for event in previous_events if isinstance(event, dict)]
    known = {_event_key(event) for event in events}
    for event in new_events:
        key = _event_key(event)
        if key not in known:
            events.append(event)
            known.add(key)
    events.sort(key=lambda event: (
        str(event.get("source_patch_label", "")),
        str(event.get("entity_type", "")),
        str(event.get("slug", "")),
        tuple(event.get("fields_changed", [])),
    ))
    return {
        "schema_version": 1,
        "branch": "latest",
        "lane": "live",
        "current_open_cycle": source_patch_label,
        "observed_at": observed_at,
        "status": "fresh",
        "events": events,
    }


def _flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key in sorted(value):
            child = f"{prefix}.{key}" if prefix else str(key)
            output.update(_flatten(value[key], child))
        return output
    return {prefix: value}


def _latest_landing_evidence(
    preview_archive: dict[str, Any] | None,
    latest_snapshots: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Prove landing from current latest source data, not time or prose."""
    evidence: list[dict[str, Any]] = []
    for preview in (preview_archive or {}).get("events", []):
        if not isinstance(preview, dict) or preview.get("lifecycle") != "upcoming":
            continue
        entity_type = preview.get("entity_type")
        canonical_id = preview.get("canonical_id")
        snapshot = latest_snapshots.get(str(entity_type))
        rows = {row.get("id"): row for row in (snapshot or {}).get("entities", []) if isinstance(row, dict)}
        live = rows.get(canonical_id)
        kind = preview.get("change_kind")
        landed = False
        if kind == "added":
            landed = live is not None
        elif kind == "removed":
            landed = live is None
        elif live is not None:
            fields = _flatten(live.get("fields", {}))
            landed = all(fields.get(key) == value for key, value in preview.get("after", {}).items())
        if landed:
            evidence.append({
                "entity_type": entity_type,
                "canonical_id": canonical_id,
                "slug": preview.get("slug"),
                "change_kind": kind,
                "after": copy.deepcopy(preview.get("after", {})),
            })
    return evidence


def _reset_pbe_archive(
    previous_archive: dict[str, Any] | None,
    source_patch_label: str,
    observed_at: str,
) -> dict[str, Any]:
    events = []
    for event in (previous_archive or {}).get("events", []):
        if not isinstance(event, dict):
            continue
        next_event = copy.deepcopy(event)
        if next_event.get("lifecycle") == "upcoming":
            next_event["lifecycle"] = "aged_out"
        events.append(next_event)
    return {
        "schema_version": 1,
        "branch": "pbe",
        "lane": "preview",
        "source_patch_label": source_patch_label,
        "observed_at": observed_at,
        "status": "fresh",
        "events": events,
    }


def _latest_baseline_is_fresh(archive: dict[str, Any] | None, now: str) -> bool:
    if not isinstance(archive, dict) or archive.get("status") != "fresh":
        return False
    observed_at = archive.get("observed_at")
    if not isinstance(observed_at, str) or not observed_at:
        return False
    try:
        observed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        current = datetime.fromisoformat(now.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (current - observed).total_seconds() <= LATEST_BASELINE_MAX_AGE_HOURS * 3600


def build_branch_update(
    *,
    branch: str,
    source_version: str,
    source_patch_label: str,
    observed_at: str,
    entities_by_type: dict[str, list[dict[str, Any]]],
    previous_snapshots: dict[str, dict[str, Any]],
    latest_snapshots: dict[str, dict[str, Any]],
    previous_archive: dict[str, Any] | None,
    latest_baseline_confirmed: bool = True,
) -> dict[str, Any]:
    """Build a complete in-memory branch transaction before writing any file."""
    snapshots: dict[str, dict[str, Any]] = {}
    for entity_type in sorted(ENTITY_TYPES):
        rows = entities_by_type.get(entity_type)
        if not isinstance(rows, list):
            raise SnapshotValidationError(f"missing {branch} {entity_type} payload")
        snapshots[entity_type] = build_snapshot(
            entity_type=entity_type,
            branch=branch,
            source_version=source_version,
            source_patch_label=source_patch_label,
            observed_at=observed_at,
            entities=rows,
        )

    reset = False
    for entity_type, current in snapshots.items():
        previous = previous_snapshots.get(entity_type)
        if not previous:
            continue
        try:
            validate_snapshot(current, previous=previous)
        except SnapshotValidationError as exc:
            if branch == "pbe" and "version regression" in str(exc):
                reset = True
                break
            raise

    if reset:
        return {
            "snapshots": snapshots,
            "new_events": [],
            "archive": _reset_pbe_archive(previous_archive, source_patch_label, observed_at),
            "reset": True,
        }

    if branch == "latest":
        events = []
        for entity_type in sorted(ENTITY_TYPES):
            previous = previous_snapshots.get(entity_type)
            if previous:
                events.extend(compare_snapshots(previous, snapshots[entity_type], detected_at=observed_at))
        archive = _build_latest_archive(previous_archive, events, source_patch_label, observed_at)
    elif branch == "pbe":
        preview_events = []
        has_latest_baseline = latest_baseline_confirmed and all(
            entity_type in latest_snapshots for entity_type in ENTITY_TYPES
        )
        if has_latest_baseline:
            for entity_type in sorted(ENTITY_TYPES):
                baseline = latest_snapshots[entity_type]
                preview_events.extend(compare_snapshots(
                    baseline,
                    snapshots[entity_type],
                    detected_at=observed_at,
                    comparison_base={
                        "branch": "latest",
                        "source_version": baseline["source_version"],
                    },
                ))
            archive = advance_preview_lifecycle(
                previous_archive,
                preview_events,
                _latest_landing_evidence(previous_archive, latest_snapshots),
                source_patch_label,
                observed_at,
            )
        else:
            archive = {
                "schema_version": 1,
                "branch": "pbe",
                "lane": "preview",
                "source_patch_label": source_patch_label,
                "observed_at": observed_at,
                "status": "not_yet_confirmed",
                # Keep the prior internal lineage for recovery/debugging while
                # withholding it from the public projection until live data is
                # confirmed again.
                "events": copy.deepcopy((previous_archive or {}).get("events", [])),
            }
            preview_events = []
        events = preview_events
    else:
        raise SnapshotValidationError(f"unsupported branch: {branch}")

    return {"snapshots": snapshots, "new_events": events, "archive": archive, "reset": False}


def _cdragon_base(branch: str) -> str:
    if branch not in {"latest", "pbe"}:
        raise ValueError(f"unsupported CDragon branch: {branch}")
    return f"https://raw.communitydragon.org/{branch}"


def _fetch_json(url: str) -> dict[str, Any] | list[Any]:
    request = Request(url, headers=HEADERS)
    with urlopen(request, timeout=60) as response:
        return json.loads(read_limited_response(response).decode("utf-8", errors="replace"))


def _metadata_version(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise SnapshotValidationError("malformed CDragon content-metadata payload")
    for key in ("version", "buildVersion", "patchVersion", "gameVersion"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key, value in payload.items():
        if "version" in key.lower() and isinstance(value, str) and value.strip():
            return value.strip()
    raise SnapshotValidationError("CDragon content-metadata has no source version")


def _champion_bin_key(alias: str) -> str:
    return re.sub(r"[^a-z0-9]", "", alias.lower())


def is_derived_champion_variant(detail: dict[str, Any]) -> bool:
    """True when CDragon marks this record as derived from a prime champion.

    Verified against CDragon `latest` on 2026-09-10: present on 63/63 `Jade_*`
    rows and 0/173 playable champions.
    """
    return any(detail.get(marker) for marker in DERIVED_VARIANT_MARKERS)


def _is_missing_asset(exc: BaseException) -> bool:
    """A 404 is 'this asset does not exist', not 'the source is broken'."""
    return isinstance(exc, HTTPError) and exc.code == 404


def previous_base_stats(internal_dir: Path, branch: str) -> dict[str, dict[str, Any]]:
    """Base stats from the last trusted snapshot of this lane, by canonical id."""
    snapshot = _read_json(internal_dir / snapshot_filename("champion", branch))
    if not isinstance(snapshot, dict):
        return {}
    stats: dict[str, dict[str, Any]] = {}
    for row in snapshot.get("entities", []):
        if not isinstance(row, dict):
            continue
        base = (row.get("fields") or {}).get("base_stats")
        if isinstance(base, dict) and base:
            stats[str(row.get("id"))] = base
    return stats


def fetch_branch_entities(
    branch: str,
    *,
    fetch_json: FetchJson = _fetch_json,
    known_base_stats: dict[str, dict[str, Any]] | None = None,
    report: dict[str, Any] | None = None,
) -> tuple[str, dict[str, list[dict[str, Any]]], dict[str, str]]:
    """Fetch all source inputs for one lane before normalization/promotion."""
    base = _cdragon_base(branch)
    api = f"{base}/plugins/rcp-be-lol-game-data/global/default/v1"
    metadata = fetch_json(f"{base}/content-metadata.json")
    source_version = _metadata_version(metadata)
    roster = fetch_json(f"{api}/cherry-augments.json")
    stringtable = fetch_json(f"{base}/game/en_us/data/menu/en_us/lol.stringtable.json")
    summary = fetch_json(f"{api}/champion-summary.json")
    items = fetch_json(f"{api}/items.json")
    if not isinstance(summary, list) or not isinstance(items, list):
        raise SnapshotValidationError("malformed champion-summary or items CDragon payload")

    champion_rows = []
    for row in summary:
        if not isinstance(row, dict):
            continue
        raw_id = row.get("id")
        if not isinstance(raw_id, (int, str)) or str(raw_id) in {"", "0", "-1"}:
            continue
        champion_rows.append(row)

    def fetch_champion(row: dict[str, Any]) -> tuple[str, dict[str, Any] | None, dict[str, Any] | None, str | None]:
        """Return (id, detail, base_stats, skip_reason).

        A skip_reason means "this row is legitimately not a playable champion,
        or its optional asset is absent" — it never aborts the lane.  Malformed
        payloads still raise, because those indicate a broken source.
        """
        raw_id = row["id"]
        detail = fetch_json(f"{api}/champions/{raw_id}.json")
        if not isinstance(detail, dict):
            raise SnapshotValidationError(f"malformed champion detail for {raw_id}")
        if is_derived_champion_variant(detail):
            return str(raw_id), None, None, "derived_variant"
        alias = str(row.get("alias") or detail.get("alias") or "")
        if not alias:
            raise SnapshotValidationError(f"champion {raw_id} is missing alias for bin lookup")
        key = _champion_bin_key(alias)
        try:
            bin_payload = fetch_json(f"{base}/game/data/characters/{key}/{key}.bin.json")
        except Exception as exc:
            if _is_missing_asset(exc):
                return str(raw_id), detail, None, "missing_character_bin"
            raise
        if not isinstance(bin_payload, dict):
            raise SnapshotValidationError(f"malformed champion bin for {raw_id}")
        return str(raw_id), detail, extract_base_stats_from_bin(bin_payload), None

    details: dict[str, dict[str, Any]] = {}
    base_stats: dict[str, dict[str, Any]] = {}
    skipped: dict[str, list[str]] = {"derived_variant": [], "missing_character_bin": []}
    with ThreadPoolExecutor(max_workers=8) as pool:
        fetched = list(pool.map(fetch_champion, champion_rows))
    for canonical_id, detail, stats, skip_reason in fetched:
        if skip_reason:
            skipped[skip_reason].append(canonical_id)
            if skip_reason == "derived_variant":
                continue
        if detail is not None:
            details[canonical_id] = detail
        if stats is not None:
            base_stats[canonical_id] = stats

    prime_count = len(champion_rows) - len(skipped["derived_variant"])
    if prime_count == 0:
        raise SnapshotValidationError(
            f"champion coverage collapse: 0 prime champions in {len(champion_rows)} source rows"
        )

    # Semantic continuity. A champion we have observed before that has no bin
    # this run has not lost its stats — we simply have no new observation, so
    # the last trusted values are carried forward and the diff stays empty.
    # A champion we have never observed has nothing to carry forward; it is
    # bootstrapped without base stats, which is an addition, not a change.
    known = known_base_stats if known_base_stats is not None else {}
    retained: list[str] = []
    bootstrapped: list[str] = []
    for canonical_id in skipped["missing_character_bin"]:
        carried = known.get(canonical_id)
        if carried:
            base_stats[canonical_id] = copy.deepcopy(carried)
            retained.append(canonical_id)
        else:
            bootstrapped.append(canonical_id)

    # Systemic guard: carrying a large share of the roster forward would serve a
    # stale roster under a new patch label without any diff to reveal it.
    retention_ratio = len(retained) / prime_count
    if retention_ratio > CHAMPION_BIN_RETENTION_CEILING:
        raise SnapshotValidationError(
            f"champion base-stat acquisition collapse: {len(retained)}/{prime_count} "
            f"({retention_ratio:.1%}) would be carried forward, above the "
            f"{CHAMPION_BIN_RETENTION_CEILING:.0%} ceiling; "
            f"missing bins: {sorted(retained)[:10]}"
        )

    acquisition = {
        "prime_champions": prime_count,
        "derived_variants_skipped": sorted(skipped["derived_variant"]),
        "base_stats_observed": sorted(set(base_stats) - set(retained)),
        "base_stats_retained": sorted(retained),
        "bootstrapped_without_base_stats": sorted(bootstrapped),
    }
    if report is not None:
        report["champion_acquisition"] = acquisition

    if skipped["derived_variant"] or skipped["missing_character_bin"]:
        print(
            f"[CDragon:{branch}] skipped {len(skipped['derived_variant'])} derived variants; "
            f"{len(retained)} base-stat set(s) carried forward (no new observation), "
            f"{len(bootstrapped)} new champion(s) without bins; "
            f"promoted {len(base_stats)}/{prime_count} prime champions",
            file=sys.stderr,
        )

    # Only prime champions with a detail record reach normalization; derived
    # variants must never enter the champion catalog.
    playable_summary = [row for row in champion_rows if str(row.get("id")) in details]

    aliases = registry_token_aliases_from_table(load_augment_json(INTERNAL_DATA_DIR / "augment-identity-aliases.json") or {})
    augments = normalize_augment_entities(extract_augments(
        roster,
        build_tooltip_index(stringtable if isinstance(stringtable, dict) else {}),
        localized_name_index(),
        stringtable=stringtable if isinstance(stringtable, dict) else {},
        registry_token_aliases=aliases,
    ))
    champions = normalize_champion_entities(playable_summary, details, base_stats)
    normalized_items = normalize_item_entities(items)
    return source_version, {
        "augment": augments,
        "champion": champions,
        "item": normalized_items,
    }, {
        "augment": f"{api}/cherry-augments.json",
        "champion": f"{api}/champion-summary.json",
        "item": f"{api}/items.json",
    }


def _latest_patch_label(internal_dir: Path, source_version: str) -> str:
    """Structural patch label for the live lane.

    Riot's own patch-note feed (`patch-metadata.json`) is the structural
    authority.  The statistics scrape (`meta.json`) tracks a *different clock* —
    it reports whichever patch our statistics provider has finished aggregating,
    which routinely lags the live game by a patch.  Labelling a CDragon snapshot
    with it silently backdates current game mechanics to an older patch.
    """
    riot = _read_json(internal_dir / "patch-metadata.json") or {}
    patch = riot.get("patch")
    return str(patch) if isinstance(patch, str) and patch else source_version


def promote_branch(
    branch: str,
    *,
    internal_dir: Path = INTERNAL_DATA_DIR,
    fetch_json: FetchJson = _fetch_json,
    observed_at: str | None = None,
) -> dict[str, Any]:
    """Acquire one lane, then atomically promote every output for that lane."""
    now = observed_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    report: dict[str, Any] = {}
    source_version, entities, _sources = fetch_branch_entities(
        branch,
        fetch_json=fetch_json,
        # Continuity is measured against this lane's own last trusted snapshot.
        known_base_stats=previous_base_stats(internal_dir, branch),
        report=report,
    )
    source_patch_label = (
        _latest_patch_label(internal_dir, source_version)
        if branch == "latest"
        else f"pbe-cycle-{source_version}"
    )
    previous = read_snapshot_lineage(internal_dir, branch)
    latest = read_snapshot_lineage(internal_dir, "latest") if branch == "pbe" else {}
    archive_name = "patch-events.json" if branch == "latest" else "pbe-preview.json"
    archive = _read_json(internal_dir / archive_name)
    latest_archive = _read_json(internal_dir / "patch-events.json") if branch == "pbe" else None
    update = build_branch_update(
        branch=branch,
        source_version=source_version,
        source_patch_label=source_patch_label,
        observed_at=now,
        entities_by_type=entities,
        previous_snapshots=previous,
        latest_snapshots=latest,
        previous_archive=archive,
        latest_baseline_confirmed=(
            branch != "pbe" or _latest_baseline_is_fresh(latest_archive, now)
        ),
    )
    values: dict[Path, Any] = {
        internal_dir / snapshot_filename(entity_type, branch): snapshot
        for entity_type, snapshot in update["snapshots"].items()
    }
    values[internal_dir / archive_name] = update["archive"]

    # Degradation travels with the data it describes, so any consumer of the
    # snapshot can see that some base stats were carried forward rather than
    # observed this run.
    acquisition = report.get("champion_acquisition") or {}
    retained = acquisition.get("base_stats_retained") or []
    bootstrapped = acquisition.get("bootstrapped_without_base_stats") or []
    champion_path = internal_dir / snapshot_filename("champion", branch)
    if champion_path in values and (retained or bootstrapped):
        values[champion_path] = {
            **values[champion_path],
            "degraded": {
                "reason": "champion_bin_unavailable",
                "base_stats_retained": retained,
                "bootstrapped_without_base_stats": bootstrapped,
            },
        }
    update["acquisition"] = acquisition
    update["degraded"] = bool(retained or bootstrapped)

    atomic_write_many(values)
    return update


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", choices=("latest", "pbe", "all"), default="all")
    parser.add_argument("--internal-dir", type=Path, default=INTERNAL_DATA_DIR)
    args = parser.parse_args()
    branches = ("latest", "pbe") if args.branch == "all" else (args.branch,)
    failures = []
    for branch in branches:
        try:
            update = promote_branch(branch, internal_dir=args.internal_dir)
        except Exception as exc:  # diagnostics only; no values have been promoted
            failures.append(f"{branch}: {exc}")
            print(f"[CDragon:{branch}] skipped without promotion: {exc}", file=sys.stderr)
            # An `all` run must not promote a preview against a stale live
            # baseline after the live transaction failed.
            break
        print(
            f"[CDragon:{branch}] promoted {len(update['snapshots'])} snapshots, "
            f"{len(update['new_events'])} events"
            + (" [DEGRADED: base stats carried forward]" if update.get("degraded") else "")
            + (" (fresh PBE lineage)" if update["reset"] else ""),
        )
    if failures:
        raise SystemExit("; ".join(failures))


if __name__ == "__main__":
    main()
