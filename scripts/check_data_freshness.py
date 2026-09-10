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
from pathlib import Path
from typing import Any

from scrape_arammayhem import extract_patch, fetch
import scrape_patch_notes


ROOT = Path(__file__).resolve().parent.parent
PUBLIC_META_PATH = ROOT / "public" / "data" / "meta.json"


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


def overall_status(structural: str, statistics: str) -> str:
    """Structural drift is a failure; statistics lag is expected."""
    if structural == "stale":
        return "structural_stale"
    if structural == "unknown" or statistics == "unknown":
        return "unknown"
    if statistics == "stale":
        return "statistics_behind"
    return "fresh"


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

    statistics_status = freshness_status(published_statistics, upstream_statistics)
    structural_status = freshness_status(published_structural, upstream_structural)
    status = overall_status(structural_status, statistics_status)

    result = {
        "status": status,
        "structural": {
            "published_patch": published_structural,
            "upstream_patch": upstream_structural,
            "status": structural_status,
        },
        "statistics": {
            "published_patch": published_statistics,
            "upstream_patch": upstream_statistics,
            "status": statistics_status,
        },
        # Back-compat keys for existing consumers/log scrapers.
        "published_patch": published_statistics,
        "upstream_patch": upstream_statistics,
    }
    result.update(errors)

    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(
            f"{status}: STRUCTURAL published={published_structural or 'unknown'} "
            f"upstream={upstream_structural or 'unknown'} | "
            f"STATISTICS published={published_statistics or 'unknown'} "
            f"upstream={upstream_statistics or 'unknown'}"
        )

    # Statistics lagging the live game is the expected steady state and must
    # never fail the run — that is what made the gate block its own fix.
    if status == "structural_stale":
        raise SystemExit(2)
    if status == "unknown":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
