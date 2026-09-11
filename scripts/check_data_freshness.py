#!/usr/bin/env python3
"""Compare published data against live upstream signals, per clock.

ARAM Mayhem runs two independent clocks and they must be judged by different
standards:

  structural  — what the game currently does (Riot patch notes / CDragon).
                Falling behind here is a real failure: the site would describe
                mechanics that no longer exist.
  statistics  — what has been observed and aggregated. Our provider routinely
                lags the live game by a patch. That is the NORMAL state, not an
                error, and must not fail the pipeline or block publishing.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scrape_arammayhem import extract_patch, fetch
import scrape_patch_notes


ROOT = Path(__file__).resolve().parent.parent
PUBLIC_META_PATH = ROOT / "public" / "data" / "meta.json"

# ── Bounded statistics-staleness policy ──────────────────────────────────────
# "Statistics may lag" is a tolerance, not a permission to be stale forever.
# Both bounds must hold for the statistics clock to count as healthy.
#
# Patch lag: our provider aggregates a patch after it ships, so trailing the
# live game by exactly one patch is the normal steady state. Two or more means
# the provider stopped following the game.
STATISTICS_MAX_PATCH_LAG = 1
#
# Observation age: `update-data` is scheduled twice daily (22:00 and 10:00 UTC),
# so a healthy system re-observes at least every 24h. 72h allows three
# consecutive days of total acquisition failure — enough to ride out a weekend
# upstream outage — while still catching real decay in days rather than months.
# The 2026-07-12 → 2026-09-10 outage was 59 days and must trip this immediately.
STATISTICS_MAX_OBSERVATION_AGE_HOURS = 72
#
# A stamp slightly ahead of us is ordinary clock skew between the scraper host
# and the checker; anything further means the timestamp cannot be trusted as an
# age at all. An unclamped negative age previously read as "extremely fresh",
# which would disable staleness detection indefinitely.
STATISTICS_MAX_CLOCK_SKEW_HOURS = 1

# Statuses that mean "publishable and healthy".
#
# NOTE ON NAMING: these describe the STATISTICS SOURCE relationship only —
# whether our published statistics match the newest statistics the provider has
# aggregated. They deliberately say nothing about whether the statistics patch
# equals the structural game patch; that is a separate relationship
# (`crossLaneAligned`) reported alongside. An earlier revision called the
# healthy case "aligned", which read as "the two clocks agree" while structural
# was 26.18 and statistics 26.17.
HEALTHY_STATUSES = frozenset(
    {"statistics_source_current", "statistics_recently_behind"}
)


def patch_key(patch: str) -> tuple[int, int]:
    parts = patch.split(".")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise ValueError(f"Unsupported patch format: {patch!r}")
    return int(parts[0]), int(parts[1])


def compare_patches(left: str, right: str) -> int:
    left_key = patch_key(left)
    right_key = patch_key(right)
    return (left_key > right_key) - (left_key < right_key)


def resolve_upstream_patch(search_index: dict[str, Any] | None, page_htmls: list[str]) -> str | None:
    candidates: list[str] = []
    search_patch = (search_index or {}).get("patch")
    if isinstance(search_patch, str) and search_patch:
        candidates.append(search_patch)
    page_patch = extract_patch(*page_htmls)
    if page_patch:
        candidates.append(page_patch)
    if not candidates:
        return None
    return max(candidates, key=patch_key)


def freshness_status(published_patch: str | None, upstream_patch: str | None) -> str:
    if not published_patch or not upstream_patch:
        return "unknown"
    return "stale" if compare_patches(published_patch, upstream_patch) < 0 else "fresh"


def load_published_structural_patch(public_dir: Path) -> str | None:
    """The structural patch we actually published, from the pipeline status."""
    path = public_dir / "pipeline-status.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    patch = (data.get("structural") or {}).get("patch")
    return patch if isinstance(patch, str) and patch else None


def fetch_upstream_structural_patch() -> str | None:
    """Riot's newest published patch — the structural authority."""
    paths = scrape_patch_notes.discover_patch_paths(1)
    if not paths:
        return None
    return scrape_patch_notes.patch_version(paths[0])


def patch_lag(published: str | None, upstream: str | None) -> int | None:
    """How many patches the published data trails upstream. None if unknowable.

    Across a season rollover (26.24 -> 27.01) the minor number resets, so a
    cross-major gap cannot be measured by subtraction; it is reported as
    unbounded rather than as a small, reassuring number.
    """
    if not published or not upstream:
        return None
    try:
        pub, up = patch_key(published), patch_key(upstream)
    except ValueError:
        return None
    if pub >= up:
        return 0
    if pub[0] == up[0]:
        return up[1] - pub[1]
    return sys.maxsize


def observation_age_hours(observed_at: str | None, now: datetime | None = None) -> float | None:
    """Age of the statistics observation. None when the source gave no stamp."""
    if not isinstance(observed_at, str) or not observed_at.strip():
        return None
    try:
        stamp = datetime.fromisoformat(observed_at.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    reference = now or datetime.now(timezone.utc)
    age = (reference - stamp).total_seconds() / 3600.0
    if age < -STATISTICS_MAX_CLOCK_SKEW_HOURS:
        # Materially in the future: not an age we can reason about.
        return None
    return max(age, 0.0)


def overall_status(
    structural: str,
    statistics: str,
    *,
    stats_patch_lag: int | None = None,
    stats_age_hours: float | None = None,
    stats_structural_lag: int | None = None,
) -> str:
    """Classify both clocks under the bounded policy.

    Structural drift is always a failure. Statistics lag is tolerated only
    within BOTH bounds; beyond either one the statistics clock is stale, which
    is the condition that previously went undetected for 59 days because any
    lag whatsoever was reported as an expected steady state.

    The patch bound applies twice: to the provider (`stats_patch_lag`) AND to
    the live game (`stats_structural_lag`, statistics vs published structural).
    Matching a provider that has itself stopped following the game is not
    currency — statistics 26.17 against a 26.21 game is four patches stale.
    """
    if structural == "stale":
        return "structural_stale"
    if structural == "unknown" or statistics == "unknown":
        return "unknown"

    # An unmeasurable observation age cannot be asserted healthy.
    if stats_age_hours is None:
        return "unknown"
    if stats_age_hours > STATISTICS_MAX_OBSERVATION_AGE_HOURS:
        return "statistics_stale"

    # Nor can an unmeasurable distance from the live game.
    if stats_structural_lag is None:
        return "unknown"
    if stats_structural_lag > STATISTICS_MAX_PATCH_LAG:
        return "statistics_stale"

    if statistics == "stale":
        if stats_patch_lag is None:
            return "unknown"
        if stats_patch_lag > STATISTICS_MAX_PATCH_LAG:
            return "statistics_stale"
        return "statistics_recently_behind"
    return "statistics_source_current"


def load_published_observed_at(meta_path: Path) -> str | None:
    """When the published statistics were observed."""
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    value = data.get("scraped_at")
    return value if isinstance(value, str) and value else None


def load_published_patch(meta_path: Path) -> str | None:
    data = json.loads(meta_path.read_text(encoding="utf-8"))
    patch = data.get("patch")
    return patch if isinstance(patch, str) else None


def fetch_upstream_patch() -> str | None:
    search_index = json.loads(fetch("/search-index.json"))
    tier_html = fetch("/tier-list/")
    augments_html = fetch("/augments/")
    return resolve_upstream_patch(search_index, [tier_html, augments_html])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--published-meta", type=Path, default=PUBLIC_META_PATH)
    parser.add_argument("--public-dir", type=Path, default=PUBLIC_META_PATH.parent)
    parser.add_argument("--published-patch")
    parser.add_argument("--upstream-patch")
    parser.add_argument("--published-structural-patch")
    parser.add_argument("--upstream-structural-patch")
    parser.add_argument("--published-observed-at")
    parser.add_argument("--now", help="ISO timestamp used as 'now' (testing)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    errors: dict[str, str] = {}

    def attempt(name, fn, override=None):
        if override:
            return override
        try:
            with contextlib.redirect_stdout(sys.stderr):
                return fn()
        except Exception as exc:
            errors[name] = str(exc)
            return None

    published_statistics = attempt(
        "published_error",
        lambda: load_published_patch(args.published_meta),
        args.published_patch,
    )
    upstream_statistics = attempt(
        "upstream_error", fetch_upstream_patch, args.upstream_patch
    )
    published_structural = attempt(
        "published_structural_error",
        lambda: load_published_structural_patch(args.public_dir),
        args.published_structural_patch,
    )
    upstream_structural = attempt(
        "upstream_structural_error",
        fetch_upstream_structural_patch,
        args.upstream_structural_patch,
    )
    observed_at = args.published_observed_at or load_published_observed_at(
        args.published_meta
    )

    now = None
    if args.now:
        try:
            now = datetime.fromisoformat(args.now.replace("Z", "+00:00"))
        except ValueError:
            errors["now_error"] = f"unparseable --now: {args.now}"
    age_hours = observation_age_hours(observed_at, now)
    lag = patch_lag(published_statistics, upstream_statistics)
    # Statistics vs structural truth: the one number both gates and reports.
    cross_lane_delta = patch_lag(published_statistics, published_structural)

    statistics_status = freshness_status(published_statistics, upstream_statistics)
    structural_status = freshness_status(published_structural, upstream_structural)
    status = overall_status(
        structural_status,
        statistics_status,
        stats_patch_lag=lag,
        stats_age_hours=age_hours,
        stats_structural_lag=cross_lane_delta,
    )

    # Both relationships, named so neither can be mistaken for the other.
    cross_lane_aligned = bool(
        published_structural
        and published_statistics
        and published_structural == published_statistics
    )
    statistics_predate_structural = bool(
        published_structural
        and published_statistics
        and compare_patches(published_statistics, published_structural) < 0
    )

    result = {
        "status": status,
        "healthy": status in HEALTHY_STATUSES,
        "relationships": {
            # our published stats == newest stats the provider has aggregated
            "statisticsSourceCurrent": statistics_status == "fresh",
            # our published catalog == Riot's newest published patch
            "structuralCurrent": structural_status == "fresh",
            # structural patch == statistics patch (expected false in normal use)
            "crossLaneAligned": cross_lane_aligned,
            "statisticsPredateStructural": statistics_predate_structural,
            "crossLanePatchDelta": cross_lane_delta,
        },
        "policy": {
            "maxPatchLag": STATISTICS_MAX_PATCH_LAG,
            "maxObservationAgeHours": STATISTICS_MAX_OBSERVATION_AGE_HOURS,
        },
        "structural": {
            "published_patch": published_structural,
            "upstream_patch": upstream_structural,
            "status": structural_status,
        },
        "statistics": {
            "published_patch": published_statistics,
            "upstream_patch": upstream_statistics,
            "status": statistics_status,
            "patch_lag": None if lag is None else min(lag, 999),
            "observed_at": observed_at,
            "observation_age_hours": None if age_hours is None else round(age_hours, 2),
        },
        # Back-compat keys for existing consumers/log scrapers.
        "published_patch": published_statistics,
        "upstream_patch": upstream_statistics,
    }
    result.update(errors)

    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        age = "unknown" if age_hours is None else f"{age_hours:.1f}h"
        print(
            f"{status}: STRUCTURAL published={published_structural or 'unknown'} "
            f"upstream={upstream_structural or 'unknown'} | "
            f"STATISTICS published={published_statistics or 'unknown'} "
            f"upstream={upstream_statistics or 'unknown'} "
            f"lag={'unknown' if lag is None else min(lag, 999)} age={age}"
        )

    # Distinct exit codes so the workflow can tell the failure modes apart.
    # None of these block publishing: the gate runs AFTER the commit step.
    if status == "structural_stale":
        raise SystemExit(2)
    if status == "statistics_stale":
        raise SystemExit(3)
    if status == "unknown":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
