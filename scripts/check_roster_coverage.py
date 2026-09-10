#!/usr/bin/env python3
"""Fail publication when the public champion roster misses Riot's active roster.

Data Dragon is the authoritative active-roster source. CommunityDragon's
champion summary is fetched as a corroborating signal, but it is allowed to
contain additional historical entries because the authoritative comparison is
ID-based and deliberately follows Data Dragon.

The pure ``build_roster_report`` function accepts fixture payloads so the
publication invariant can be tested without network access.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.request import Request, urlopen

from champion_slug_aliases import canonical_champion_slug


ROOT = Path(__file__).resolve().parent.parent
PUBLIC_CHAMPIONS_PATH = ROOT / "public" / "data" / "champions.json"
DDRAGON_VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json"
DDRAGON_CHAMPION_URL = "https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/champion.json"
CDRAGON_SUMMARY_URL = (
    "https://raw.communitydragon.org/latest/plugins/"
    "rcp-be-lol-game-data/global/default/v1/champion-summary.json"
)
HEADERS = {"User-Agent": "MayhemOracle/1.0 (roster-coverage-gate)"}
ICON_ID_RE = re.compile(r"/champion-icons/(\d+)\.png(?:$|[?#])")
GENERIC_ICON_ID_RE = re.compile(r"/(\d+)\.png(?:$|[?#])")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def fetch_json(url: str) -> Any:
    request = Request(url, headers=HEADERS)
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def normalize_slug(value: Any) -> str:
    raw = str(value or "").strip().lower()
    raw = re.sub(r"[^a-z0-9]+", "-", raw).strip("-")
    return canonical_champion_slug(raw)


def numeric_id(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text if text.isdigit() else None


def ddragon_entries(payload: Any) -> List[Dict[str, str]]:
    data = payload.get("data", payload) if isinstance(payload, dict) else {}
    if not isinstance(data, dict):
        raise ValueError("Data Dragon champion payload must contain an object-valued data field")

    entries: List[Dict[str, str]] = []
    for key, row in data.items():
        if not isinstance(row, dict):
            continue
        champion_id = numeric_id(row.get("key"))
        if not champion_id:
            continue
        slug = normalize_slug(row.get("id") or key or row.get("name"))
        if not slug:
            continue
        entries.append({"id": champion_id, "slug": slug})
    return entries


def cdragon_entries(payload: Any) -> List[Dict[str, str]]:
    rows: Any = payload
    if isinstance(payload, dict):
        rows = payload.get("champions", payload.get("data", []))
    if not isinstance(rows, list):
        raise ValueError("CommunityDragon champion summary must be a list")

    entries: List[Dict[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        champion_id = numeric_id(row.get("id") or row.get("key"))
        slug = normalize_slug(row.get("alias") or row.get("idName") or row.get("name"))
        if champion_id and slug:
            entries.append({"id": champion_id, "slug": slug})
    return entries


def published_entries(payload: Any) -> List[Dict[str, Any]]:
    rows: Any = payload.get("champions", []) if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("published champion payload must contain a champions list")

    entries: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        champion_id = next(
            (
                numeric_id(row.get(field))
                for field in ("champion_key", "id", "championId", "key")
                if numeric_id(row.get(field))
            ),
            None,
        )
        icon = str(row.get("icon") or "")
        icon_match = ICON_ID_RE.search(icon) or GENERIC_ICON_ID_RE.search(icon)
        if not champion_id and icon_match:
            champion_id = icon_match.group(1)
        raw_slug = row.get("slug") or row.get("id") or row.get("name")
        entries.append(
            {
                "id": champion_id,
                "slug": normalize_slug(raw_slug),
                "raw_slug": str(raw_slug or ""),
                "win_rate": row.get("win_rate"),
                "pick_rate": row.get("pick_rate"),
            }
        )
    return entries


def duplicate_values(entries: Iterable[Dict[str, Any]], field: str) -> Dict[str, int]:
    counts = Counter(
        str(entry[field])
        for entry in entries
        if entry.get(field) not in (None, "")
    )
    return dict(sorted((value, count) for value, count in counts.items() if count > 1))


def alias_collisions(entries: Iterable[Dict[str, Any]]) -> Dict[str, List[str]]:
    aliases: Dict[str, List[str]] = defaultdict(list)
    for entry in entries:
        alias = entry.get("slug")
        raw_slug = entry.get("raw_slug") or alias
        if alias and raw_slug and raw_slug not in aliases[alias]:
            aliases[alias].append(raw_slug)
    return {
        alias: sorted(raw_slugs)
        for alias, raw_slugs in sorted(aliases.items())
        if len(raw_slugs) > 1
    }


def build_roster_report(
    ddragon_payload: Any,
    published_payload: Any,
    cdragon_payload: Optional[Any] = None,
) -> Dict[str, Any]:
    authority = ddragon_entries(ddragon_payload)
    published = published_entries(published_payload)
    corroboration = cdragon_entries(cdragon_payload) if cdragon_payload is not None else []

    authority_ids = {entry["id"] for entry in authority}
    published_ids = {
        entry["id"] for entry in published if entry.get("id") is not None
    }
    corroboration_ids = {entry["id"] for entry in corroboration}
    missing_ids = sorted(authority_ids - published_ids, key=int)
    authority_count = len(authority_ids)
    identified_published = len(authority_ids & published_ids)
    statistical_rows = {
        entry["id"]
        for entry in published
        if entry.get("id") in authority_ids
        and isinstance(entry.get("win_rate"), (int, float))
        and isinstance(entry.get("pick_rate"), (int, float))
    }

    report: Dict[str, Any] = {
        "ddragon_version": ddragon_payload.get("version")
        if isinstance(ddragon_payload, dict)
        else None,
        "upstream_active_champion_count": authority_count,
        "published_champion_count": len(published),
        "published_identified_champion_count": len(published_ids),
        "roster_coverage_ratio": round(
            identified_published / authority_count if authority_count else 0.0,
            6,
        ),
        "missing_active_champion_count": len(missing_ids),
        "missing_active_champion_ids": missing_ids,
        "duplicate_upstream_ids": duplicate_values(authority, "id"),
        "duplicate_published_ids": duplicate_values(published, "id"),
        "alias_collisions": alias_collisions(published),
        "statistical_coverage_ratio": round(
            len(statistical_rows) / authority_count if authority_count else 0.0,
            6,
        ),
        "communitydragon_champion_count": len(corroboration_ids),
        "communitydragon_missing_authority_ids": sorted(
            authority_ids - corroboration_ids, key=int
        ),
        "communitydragon_extra_ids": sorted(
            corroboration_ids - authority_ids, key=int
        ),
    }
    return report


def load_upstream_payload(path: Optional[Path]) -> Any:
    if path:
        return load_json(path)
    versions = fetch_json(DDRAGON_VERSIONS_URL)
    if not isinstance(versions, list) or not versions:
        raise ValueError("Data Dragon versions response did not contain a latest version")
    version = str(versions[0])
    payload = fetch_json(DDRAGON_CHAMPION_URL.format(version=version))
    if isinstance(payload, dict):
        payload.setdefault("version", version)
    return payload


def load_corroboration_payload(path: Optional[Path]) -> Any:
    return load_json(path) if path else fetch_json(CDRAGON_SUMMARY_URL)


def report_errors(report: Dict[str, Any]) -> List[str]:
    errors = []
    if report["missing_active_champion_count"]:
        errors.append(
            "missing active champion IDs: "
            + ", ".join(report["missing_active_champion_ids"])
        )
    if report["duplicate_upstream_ids"]:
        errors.append(f"duplicate upstream IDs: {report['duplicate_upstream_ids']}")
    if report["duplicate_published_ids"]:
        errors.append(f"duplicate published IDs: {report['duplicate_published_ids']}")
    if report["alias_collisions"]:
        errors.append(f"alias collisions: {report['alias_collisions']}")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--published-file", type=Path, default=PUBLIC_CHAMPIONS_PATH)
    parser.add_argument("--ddragon-file", type=Path)
    parser.add_argument("--cdragon-file", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    try:
        ddragon_payload = load_upstream_payload(args.ddragon_file)
        published_payload = load_json(args.published_file)
        cdragon_payload = load_corroboration_payload(args.cdragon_file)
        report = build_roster_report(ddragon_payload, published_payload, cdragon_payload)
    except Exception as exc:
        if args.json:
            print(json.dumps({"status": "error", "error": str(exc)}, sort_keys=True))
        else:
            print(f"roster coverage check unavailable: {exc}", file=sys.stderr)
        raise SystemExit(1)

    errors = report_errors(report)
    if args.json:
        print(json.dumps({**report, "status": "pass" if not errors else "fail"}, sort_keys=True))
    else:
        print(f"ddragon_version = {report['ddragon_version'] or 'fixture'}")
        print(f"upstream_active_champion_count = {report['upstream_active_champion_count']}")
        print(f"published_champion_count = {report['published_champion_count']}")
        print(f"roster_coverage_ratio = {report['roster_coverage_ratio']}")
        print(f"missing_active_champion_count = {report['missing_active_champion_count']}")
        print(f"statistical_coverage_ratio = {report['statistical_coverage_ratio']}")
        print(
            "communitydragon_missing_authority_ids = "
            f"{report['communitydragon_missing_authority_ids']}"
        )
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)

    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
