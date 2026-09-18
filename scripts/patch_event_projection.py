#!/usr/bin/env python3
"""Public/presentation projections for CDragon patch-event archives."""

from __future__ import annotations

import copy
import html
import re
from typing import Any

from generate_pool_rules import (
    comparison_crosses_patch_boundary,
    comparison_is_patch_adjacent,
)


SECTION_BY_ENTITY = {
    "champion": "champions",
    "item": "new_items",
    "augment": "augments",
}
# A patch's change list is only complete if every structural lane was observed
# across its boundary. These are exactly `cdragon_snapshot_diff.ENTITY_TYPES`;
# they are restated rather than imported so that adding a fourth acquisition
# lane is a deliberate decision about what "fully observed" means, not a
# silent tightening of every published patch card.
REQUIRED_STRUCTURAL_LANES = frozenset({"augment", "champion", "item"})
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


def patch_boundary_lanes(patch_events: dict[str, Any], cycle: str) -> set[str]:
    """Structural lanes whose transition INTO `cycle` was actually observed.

    Only a boundary-crossing comparison counts — see
    `comparison_crosses_patch_boundary`. A same-patch refresh and a cross-gap
    diff both contribute nothing here, however recent or however many.

    Two sources of evidence, unioned, both per-lane:

      archive `comparisons` — the authority. Written by the pipeline for every
          snapshot pair it diffed, so a lane that was compared and found
          unchanged still proves its own coverage.
      per-event `comparison` — a fallback for archives written before that
          record existed. An event only exists where something changed, so this
          systematically UNDER-reports (a quiet lane leaves no trace). It can
          therefore only ever add real evidence, never manufacture it.
    """
    lanes: set[str] = set()
    for record in patch_events.get("comparisons", []):
        if not isinstance(record, dict):
            continue
        if str(record.get("source_patch_label") or "") != cycle:
            continue
        if comparison_crosses_patch_boundary(record):
            lanes.add(str(record.get("entity_type") or ""))
    for event in patch_events.get("events", []):
        if not isinstance(event, dict):
            continue
        if str(event.get("source_patch_label") or "") != cycle:
            continue
        if comparison_crosses_patch_boundary(event.get("comparison")):
            lanes.add(str(event.get("entity_type") or ""))
    return lanes


def whole_patch_diff_available(patch_events: dict[str, Any], cycle: str) -> bool:
    """True only when EVERY required structural lane crossed `cycle`'s boundary.

    A count of zero means two incompatible things, and publishing them the same
    way is what let the site render "0 changes" as if it had checked:

      available   — the previous-patch -> this-patch boundary was observed for
                    champion, augment AND item. The count is then a verified
                    fact, and zero means "verified: nothing changed".
      unavailable — anything less. A multi-patch tracking gap (16.13 -> 16.18),
                    a same-patch refresh (16.18.a -> 16.18.b), coverage of only
                    one or two lanes, or a history entry we only ever had prose
                    for. Nothing is known, so nothing may be counted.

    Partial coverage fails closed on purpose: two observed lanes out of three
    cannot bound what happened in the third, so a summary built from them would
    understate the patch while looking measured.
    """
    return REQUIRED_STRUCTURAL_LANES.issubset(patch_boundary_lanes(patch_events, cycle))


def _metadata_patch(metadata: dict[str, Any]) -> dict[str, Any]:
    """The prose shell of a card, before any structural evidence is applied.

    It starts unavailable with no summary: a card that never reaches the
    evidence check must not be able to publish a count by omission.
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


def _dated_events(
    patch_events: dict[str, Any],
    cycle: str,
    landed_preview_keys: set[tuple[Any, ...]],
) -> list[dict[str, Any]]:
    """Events attributable to `cycle`, by the UNCHANGED event-dating rule.

    A matching label is not evidence of WHEN a change happened: a diff across a
    tracking gap (16.13 -> 16.18) is labelled with its target patch but may hold
    any of the intervening patches' changes. Only an adjacent comparison dates a
    change, by the same rule the augment lifecycle path applies — and adjacency
    deliberately still admits a same-patch hotfix, which did happen in this
    patch. Whether the patch as a WHOLE was observed is a separate question,
    answered by `whole_patch_diff_available`.
    """
    events = [
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
        for event in patch_events.get("events", [])
        if isinstance(event, dict)
        and event.get("source_patch_label") == cycle
        and comparison_is_patch_adjacent(event.get("comparison"))
    ]
    events.sort(key=lambda event: (
        str(event.get("entity_type", "")),
        str(event.get("slug", "")),
        tuple(event.get("fields_changed", [])),
    ))
    return events


def _apply_structural_evidence(
    card: dict[str, Any],
    patch_events: dict[str, Any],
    cycle: str,
    landed_preview_keys: set[tuple[Any, ...]],
    known: dict[str, set[str]],
) -> dict[str, Any]:
    """Attach sections and a summary to a card, but only with the evidence.

    Without whole-patch coverage the card publishes neither: a partial change
    list beside an "unavailable" marker still reads as "here is what changed",
    which is the claim we cannot make. The underlying events stay in the
    internal archive and stay individually dateable either way.
    """
    if not whole_patch_diff_available(patch_events, cycle):
        card["structuredDiff"] = "unavailable"
        card["sections"] = []
        card.pop("summary", None)
        return card

    events = _dated_events(patch_events, cycle, landed_preview_keys)
    groups: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        section = SECTION_BY_ENTITY.get(event.get("entity_type"), "general")
        groups.setdefault(section, []).append(_event_to_change(event, known))
    card["structuredDiff"] = "available"
    card["sections"] = [
        {"id": section, "title": section.replace("_", " ").title(), "changes": changes}
        for section, changes in sorted(groups.items())
    ]
    card["summary"] = _summary(events)
    return card


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
    current_metadata = next(
        (entry for entry in metadata.get("patches", []) if entry.get("version") == current_cycle),
        {},
    )
    current = _metadata_patch(current_metadata)
    current.update({
        "version": current_cycle,
        "title": current_metadata.get("articleTitle") or f"League of Legends Patch {current_cycle}",
        "released": str(current_metadata.get("publishedAt") or patch_events.get("observed_at") or "")[:10],
        "publishedAt": current_metadata.get("publishedAt") or patch_events.get("observed_at") or "",
    })
    _apply_structural_evidence(
        current, patch_events, current_cycle, landed_preview_keys, known,
    )
    # A patch does not become unmeasured by scrolling off the top. The archive
    # keeps every comparison and event under its own patch label, so a patch
    # whose boundary WAS observed keeps its verified count after rollover, and
    # one that was only ever prose stays unavailable.
    history = [
        _apply_structural_evidence(
            _metadata_patch(entry),
            patch_events,
            str(entry.get("version") or ""),
            landed_preview_keys,
            known,
        )
        for entry in metadata.get("patches", [])
        if entry.get("version") != current_cycle
    ]
    return {
        # v3: `structuredDiff` is required on every card, and `summary` is
        # present only when it is "available". `summary` was already optional in
        # v2 (see `PatchNote` in src/lib/types.ts and the `summary?.byKind ?? {}`
        # reads in src/lib/patch-notes/seo.ts), so no consumer breaks — but its
        # ABSENCE is now load-bearing rather than merely tolerated, and that is
        # worth a detectable marker.
        "schema_version": 3,
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
