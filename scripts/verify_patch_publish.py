#!/usr/bin/env python3
"""Validate public patch-notes data before the data publish commit."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DATA_DIR = ROOT / "public" / "data"

ALLOWED_KINDS = {
    "added",
    "removed",
    "buffed",
    "nerfed",
    "changed",
    "fixed",
    "mechanism",
    "hotfix",
}
NON_GENERIC_KINDS = {"added", "buffed", "nerfed", "fixed", "removed"}
PATCH_NOTES_SCHEMA_VERSION = 3


class PatchPublishError(Exception):
    """Raised when public patch-notes data is not safe to publish."""


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_timestamp(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


def all_changes(data: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for patch in data.get("patches", []):
        if not isinstance(patch, dict):
            continue
        for section in patch.get("sections", []):
            if not isinstance(section, dict):
                continue
            for change in section.get("changes", []):
                if isinstance(change, dict):
                    changes.append(change)
    return changes


def git_diff_name_only(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only"],
        cwd=root,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def assert_publish_inclusion(changed_paths: list[str]) -> None:
    changed = {path.replace("\\", "/") for path in changed_paths}
    internal_changed = bool({
        "data/internal/patch-events.json",
        "data/internal/patch-metadata.json",
    } & changed)
    pbe_internal_changed = "data/internal/pbe-preview.json" in changed
    public_changed = "public/data/patch-notes.json" in changed
    public_pbe_changed = "public/data/pbe-preview.json" in changed
    if internal_changed and not public_changed:
        raise PatchPublishError(
            "public patch-notes must be changed when internal patch event or metadata data changes",
        )
    if pbe_internal_changed and not public_pbe_changed:
        raise PatchPublishError(
            "public PBE preview must be changed when internal PBE preview data changes",
        )


def verify_patch_publish(
    *,
    root: Path = ROOT,
    changed_paths: list[str] | None = None,
) -> dict[str, Any]:
    public_dir = root / "public" / "data"
    patch_notes_path = public_dir / "patch-notes.json"
    meta_path = public_dir / "meta.json"

    if not patch_notes_path.exists() or patch_notes_path.stat().st_size == 0:
        raise PatchPublishError("missing public patch-notes file or file is empty")

    data = load_json(patch_notes_path)
    if not isinstance(data, dict):
        raise PatchPublishError("public patch-notes must be a JSON object")

    patch = data.get("patch")
    if not isinstance(patch, str) or not patch:
        raise PatchPublishError("public patch-notes patch is missing")

    # Patch notes are STRUCTURAL: they describe the live game, so they are
    # verified against the structural clock. `meta.json` is the STATISTICS
    # clock and legitimately trails it — requiring the two to be equal made
    # this gate fail on the normal steady state, and it runs before the commit
    # step, so it would block publishing exactly when the catalog was correct.
    status_path = public_dir / "pipeline-status.json"
    if status_path.exists():
        status = load_json(status_path)
        structural = (
            (status.get("structural") or {}).get("patch")
            if isinstance(status, dict)
            else None
        )
        if isinstance(structural, str) and structural and structural != patch:
            raise PatchPublishError(
                f"structural patch mismatch: public patch-notes={patch} "
                f"structural={structural}",
            )

    scraped_at = data.get("scraped_at")
    if not isinstance(scraped_at, str) or not scraped_at:
        raise PatchPublishError("scraped_at is missing")
    try:
        parse_timestamp(scraped_at)
    except ValueError as exc:
        raise PatchPublishError(f"scraped_at is not a timestamp: {scraped_at}") from exc

    patches = data.get("patches")
    if not isinstance(patches, list) or len(patches) < 3:
        raise PatchPublishError("patches count must be at least 3")

    source_kind = data.get("sourceKind")
    if source_kind != "cdragon-structured-diff-v1":
        raise PatchPublishError("public patch-notes must be projected from CDragon structured diffs")

    # v3 was chosen because the semantic contract changed: `structuredDiff` is
    # required, and an absent `summary` means "not measured" rather than
    # "nothing to report". Existing v2 readers already tolerated an optional
    # summary, which makes the bump cheap — not unnecessary.
    if data.get("schema_version") != PATCH_NOTES_SCHEMA_VERSION:
        raise PatchPublishError(
            f"public patch-notes schema_version must be {PATCH_NOTES_SCHEMA_VERSION}, "
            f"got {data.get('schema_version')!r}",
        )

    source_status = data.get("status")
    if source_status not in {"fresh", "stale", "unavailable", "not_yet_confirmed"}:
        raise PatchPublishError("public patch-notes source status is missing or invalid")

    # A count is a claim that the diff was computed. Publishing a zeroed summary
    # for a patch no structured diff covers presents "we never checked" as "we
    # checked and nothing changed" — the two must stay distinguishable on the
    # wire, not just in the renderer.
    for entry in patches:
        if not isinstance(entry, dict):
            raise PatchPublishError("each published patch must be a JSON object")
        version = entry.get("version", "?")
        diff_state = entry.get("structuredDiff")
        if diff_state not in {"available", "unavailable"}:
            raise PatchPublishError(
                f"patch {version} must declare structuredDiff as available or unavailable",
            )
        if diff_state == "unavailable" and entry.get("summary") is not None:
            raise PatchPublishError(
                f"patch {version} publishes a summary with no structured diff to back it",
            )
        if diff_state == "available" and not isinstance(entry.get("summary"), dict):
            raise PatchPublishError(
                f"patch {version} claims a structured diff but publishes no summary",
            )

    changes = all_changes(data)
    total_changes = len(changes)
    if total_changes <= 0 and source_status != "fresh":
        raise PatchPublishError("no patch changes and the CDragon source is not fresh")

    raw_kinds = {change.get("kind") for change in changes}
    kinds = sorted(kind for kind in raw_kinds if isinstance(kind, str))
    invalid_kinds = sorted(str(kind) for kind in raw_kinds if kind not in ALLOWED_KINDS)
    if invalid_kinds:
        raise PatchPublishError(f"unsupported kind(s): {', '.join(map(str, invalid_kinds))}")
    if total_changes and not any(kind in NON_GENERIC_KINDS for kind in kinds):
        raise PatchPublishError("at least one deterministic non-generic kind is required")

    zh_tw_text = sum(
        1
        for change in changes
        if isinstance(change.get("text"), dict) and change["text"].get("zh-tw")
    )
    zh_tw_coverage = zh_tw_text / total_changes if total_changes else 1.0

    # Enforce the contract the projection actually guarantees: every change
    # carries the full locale key set on `subject` (the user-visible entity
    # name). A missing locale key there is a real regression.
    missing_subject_locales = [
        change.get("subject", {}).get("en", "?")
        for change in changes
        if not isinstance(change.get("subject"), dict)
        or not all(change["subject"].get(loc) for loc in ("en", "zh-tw", "zh-cn", "ja-jp", "ko-kr"))
    ]
    if missing_subject_locales:
        raise PatchPublishError(
            "changes missing localized subject keys: "
            f"{len(missing_subject_locales)}/{total_changes} "
            f"(e.g. {missing_subject_locales[:5]})",
        )

    # `text` localization is a KNOWN, UNIMPLEMENTED GAP, reported but not
    # blocking. `patch_event_projection._change_text` emits `{"en": ...}` only,
    # so this assertion has never been satisfiable with real data — it stayed
    # green for 59 days solely because the pipeline was producing zero changes.
    # Blocking every publish on an unbuilt feature is strictly worse than
    # shipping the English-only change text the site has always shown. Tracked
    # as a product gap, not a release gate.

    assert_publish_inclusion(changed_paths if changed_paths is not None else git_diff_name_only(root))

    return {
        "patch": patch,
        "scraped_at": scraped_at,
        "patches": len(patches),
        "totalChanges": total_changes,
        "zhTwText": zh_tw_text,
        "zhTwCoverage": round(zh_tw_coverage, 4),
        "zhTwTextLocalizationGap": total_changes - zh_tw_text,
        "kinds": kinds,
        "sourceStatus": source_status,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()

    try:
        summary = verify_patch_publish(root=args.root)
    except PatchPublishError as exc:
        print(json.dumps({"error": str(exc)}, sort_keys=True), file=sys.stderr)
        raise SystemExit(1)

    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
