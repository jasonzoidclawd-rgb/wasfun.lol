#!/usr/bin/env python3
"""Public/presentation projections for CDragon patch-event archives."""

from __future__ import annotations

import copy
import html
import re
from typing import Any

from generate_pool_rules import comparison_is_patch_adjacent


SECTION_BY_ENTITY = {
    "champion": "champions",
    "item": "new_items",
    "augment": "augments",
}
_TAG_RE = re.compile(r"<[^>]+>")
_TOKEN_RE = re.compile(r"@[^@]+@|%[^%]+%")
PUBLIC_EVENT_FIELDS = (
    "entity_type",
    "canonical_id",
    "slug",
    "names",
    "branch",
    "lane",
    "change_kind",
    "fields_changed",
    "before",
    "after",
    "detected_at",
    "source_patch_label",
    "landed",
    "is_hotfix",
    "known",
    "href",
)


def _locale_names(names: dict[str, Any]) -> dict[str, str]:
    return {
        "en": str(names.get("en") or ""),
        "zh-tw": str(names.get("zh-TW") or names.get("zh-tw") or names.get("en") or ""),
        "zh-cn": str(names.get("zh-CN") or names.get("zh-cn") or names.get("en") or ""),
        "ja-jp": str(names.get("ja") or names.get("ja-jp") or names.get("en") or ""),
        "ko-kr": str(names.get("ko") or names.get("ko-kr") or names.get("en") or ""),
    }


def _display(value: Any) -> str:
    if isinstance(value, str):
        text = _TOKEN_RE.sub(
            " ",
            _TAG_RE.sub(
                " ",
                html.unescape(value).replace("<br>", " ").replace("<br/>", " "),
            ),
        )
        return re.sub(r"\s+", " ", text).strip()
    return repr(value)


def _change_text(event: dict[str, Any]) -> str:
    kind = event.get("change_kind")
    if kind == "added":
        return "Added in the CommunityDragon snapshot."
    if kind == "removed":
        return "Removed in the CommunityDragon snapshot."
    fields = event.get("fields_changed", [])
    before = event.get("before", {})
    after = event.get("after", {})
    return "; ".join(
        f"{field}: {_display(before.get(field))} → {_display(after.get(field))}"
        for field in fields
    ) or "Changed in the CommunityDragon snapshot."


def _kind(event: dict[str, Any]) -> str:
    if event.get("change_kind") in {"added", "removed"}:
        return str(event["change_kind"])
    return "changed"


def _href(event: dict[str, Any], known: dict[str, set[str]]) -> tuple[bool, str | None]:
    entity_type = str(event.get("entity_type") or "")
    slug = str(event.get("slug") or "")
    canonical_id = str(event.get("canonical_id") or "")
    key = canonical_id if entity_type == "item" else slug
    if key not in known.get(entity_type, set()):
        return False, None
    route = {"champion": "champions", "item": "items", "augment": "augments"}.get(entity_type)
    return (True, f"/{route}/{key}") if route else (False, None)


def _event_to_change(event: dict[str, Any], known: dict[str, set[str]]) -> dict[str, Any]:
    entity_type = str(event.get("entity_type") or "unknown")
    names = _locale_names(event.get("names", {}))
    is_known, href = _href(event, known)
    target = {
        "type": entity_type,
        "slug": str(event.get("slug") or ""),
        "name": names["en"],
        "known": is_known,
        "names": {key: value for key, value in names.items() if key != "en" and value},
    }
    if href:
        target["href"] = href
    return {
        "subject": {key: value for key, value in names.items() if value},
        "text": {"en": _change_text(event)},
        "kind": _kind(event),
        "detectedAt": event.get("detected_at"),
        "isHotfix": bool(event.get("is_hotfix")),
        "landedFromPbe": bool(event.get("landed_from_pbe")),
        "targets": [target],
        "relatedEntities": [],
        "metrics": [
            {
                "label": field,
                "before": _display(event.get("before", {}).get(field)),
                "after": _display(event.get("after", {}).get(field)),
            }
            for field in event.get("fields_changed", [])
        ],
        "labels": list(event.get("fields_changed", [])),
        "impact": {"damageRelevant": False, "modelSignals": [], "engineRefs": []},
    }


def _empty_summary() -> dict[str, Any]:
    return {
        "totalChanges": 0,
        "byKind": {},
        "byEntityType": {},
        "byLabel": {},
        "damageRelevant": 0,
    }


def _summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    summary = _empty_summary()
    summary["totalChanges"] = len(events)
    for event in events:
        kind = _kind(event)
        entity_type = str(event.get("entity_type") or "unknown")
        summary["byKind"][kind] = summary["byKind"].get(kind, 0) + 1
        summary["byEntityType"][entity_type] = summary["byEntityType"].get(entity_type, 0) + 1
    return summary


def structured_diff_available(patch_events: dict[str, Any], cycle: str) -> bool:
    """True only when a patch-adjacent snapshot comparison covers `cycle`.

    A count of zero means two incompatible things, and publishing them the same
    way is what let the site render "0 changes" as if it had checked. This
    separates them:

      available   — an adjacent comparison ran, so the count is a verified
                    fact. Zero then means "verified: nothing changed".
      unavailable — no adjacent comparison covers this patch (a multi-patch
                    tracking gap like 16.13 -> 16.18, a lane that never ran, or
                    a history entry we only ever had prose for). Nothing is
                    known, so nothing may be counted.

    Adjacency is decided by the same rule that governs dating an individual
    change. The archive's `comparisons` record is the authority; the per-event
    comparisons are a fallback for archives written before that record existed.
    """
    for record in patch_events.get("comparisons", []):
        if not isinstance(record, dict):
            continue
        if str(record.get("source_patch_label") or "") != cycle:
            continue
        if comparison_is_patch_adjacent(record):
            return True
    return any(
        isinstance(event, dict)
        and event.get("source_patch_label") == cycle
        and comparison_is_patch_adjacent(event.get("comparison"))
        for event in patch_events.get("events", [])
    )


def _metadata_patch(metadata: dict[str, Any]) -> dict[str, Any]:
    """A prose-only card. No structural diff was ever computed for it, so it
    carries the unavailable marker and NO summary — never a summary of zeroes.
    """
    return {
        "version": metadata.get("version", "unknown"),
        "title": metadata.get("articleTitle", ""),
        "released": str(metadata.get("publishedAt", ""))[:10],
        "sourceUrl": metadata.get("sourceUrl", ""),
        "publishedAt": metadata.get("publishedAt", ""),
        "authors": metadata.get("authors", []),
        "intro": metadata.get("intro", ""),
        "structuredDiff": "unavailable",
        "sections": [],
    }


def build_patch_notes_projection(
    patch_events: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    *,
    known: dict[str, set[str]] | None = None,
    pbe_archive: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build legacy-compatible cards solely from current CDragon live events."""
    patch_events = patch_events or {}
    metadata = metadata or {}
    known = known or {"champion": set(), "item": set(), "augment": set()}
    current_cycle = str(patch_events.get("current_open_cycle") or metadata.get("patch") or "unknown")
    landed_preview_keys = {
        (
            event.get("entity_type"),
            event.get("canonical_id"),
            event.get("slug"),
            event.get("change_kind"),
            repr(event.get("after", {})),
        )
        for event in (pbe_archive or {}).get("events", [])
        if isinstance(event, dict) and event.get("lifecycle") == "landed"
    }
    # A matching label is not evidence of WHEN a change happened: a diff across a
    # tracking gap (16.13 -> 16.18) is labelled with its target patch but may hold
    # any of the intervening patches' changes. Only an adjacent comparison dates
    # a change, by the same rule the augment lifecycle path applies.
    current_events = [
        event for event in patch_events.get("events", [])
        if isinstance(event, dict)
        and event.get("source_patch_label") == current_cycle
        and comparison_is_patch_adjacent(event.get("comparison"))
    ]
    current_events = [
        {
            **event,
            "landed_from_pbe": (
                event.get("entity_type"),
                event.get("canonical_id"),
                event.get("slug"),
                event.get("change_kind"),
                repr(event.get("after", {})),
            ) in landed_preview_keys,
        }
        for event in current_events
    ]
    current_events.sort(key=lambda event: (
        str(event.get("entity_type", "")),
        str(event.get("slug", "")),
        tuple(event.get("fields_changed", [])),
    ))
    current_metadata = next(
        (entry for entry in metadata.get("patches", []) if entry.get("version") == current_cycle),
        {},
    )
    groups: dict[str, list[dict[str, Any]]] = {}
    for event in current_events:
        section = SECTION_BY_ENTITY.get(event.get("entity_type"), "general")
        groups.setdefault(section, []).append(_event_to_change(event, known))
    current = _metadata_patch(current_metadata)
    current.update({
        "version": current_cycle,
        "title": current_metadata.get("articleTitle") or f"League of Legends Patch {current_cycle}",
        "released": str(current_metadata.get("publishedAt") or patch_events.get("observed_at") or "")[:10],
        "publishedAt": current_metadata.get("publishedAt") or patch_events.get("observed_at") or "",
        "sections": [
            {"id": section, "title": section.replace("_", " ").title(), "changes": changes}
            for section, changes in sorted(groups.items())
        ],
    })
    # The summary is a claim that the diff was computed. Publish it only with
    # the evidence to back it; otherwise the card says "unavailable" and counts
    # nothing.
    if structured_diff_available(patch_events, current_cycle):
        current["structuredDiff"] = "available"
        current["summary"] = _summary(current_events)
    else:
        current["structuredDiff"] = "unavailable"
        current.pop("summary", None)
    history = [
        _metadata_patch(entry)
        for entry in metadata.get("patches", [])
        if entry.get("version") != current_cycle
    ]
    return {
        "schema_version": 2,
        "patch": current_cycle,
        "source": "CommunityDragon snapshot diffs",
        "sourceKind": "cdragon-structured-diff-v1",
        "status": patch_events.get("status", "unavailable"),
        "sourceUrl": current.get("sourceUrl", ""),
        "scraped_at": patch_events.get("observed_at", ""),
        "patches": [current, *history],
    }


def build_preview_projection(
    archive: dict[str, Any] | None,
    known: dict[str, set[str]],
) -> dict[str, Any]:
    """Expose only active PBE entries, with links restricted to live entities."""
    if not archive:
        return {"schema_version": 1, "branch": "pbe", "lane": "preview", "status": "unavailable", "events": []}
    events = []
    for event in archive.get("events", []):
        if not isinstance(event, dict) or event.get("landed") or event.get("lifecycle") in {"landed", "aged_out"}:
            continue
        if event.get("source_patch_label") != archive.get("source_patch_label"):
            continue
        projection = {field: copy.deepcopy(event[field]) for field in PUBLIC_EVENT_FIELDS if field in event}
        is_known, href = _href(event, known)
        projection["known"] = is_known
        if href:
            projection["href"] = href
        events.append(projection)
    events.sort(key=lambda event: (
        str(event.get("entity_type", "")), str(event.get("slug", "")), tuple(event.get("fields_changed", [])),
    ))
    return {
        "schema_version": 1,
        "branch": "pbe",
        "lane": "preview",
        "status": archive.get("status", "unavailable"),
        "source_patch_label": archive.get("source_patch_label", ""),
        "observed_at": archive.get("observed_at", ""),
        "events": events,
    }
