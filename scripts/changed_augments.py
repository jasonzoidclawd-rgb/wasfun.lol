#!/usr/bin/env python3
"""Changed-augment list per patch (v3 phase 0).

The carry-over prior (The math, section 3) gives an augment extra doubt on the
patch that changed it. This builds that list once per patch and persists it in
`data/internal/changed-augments.json`, from two independent signals:

- Riot's patch notes, "ARAM: Mayhem" section: augments named under the Augments
  heading (balance) and the augment each Bugfixes bullet is about;
- CDragon diffs already recorded in `data/internal/patch-events.json` for that
  patch label (numeric, text, rarity and added events).

An entry is "provisional" until both signals have had time to land: the patch
notes' Mayhem section was found, and at least SETTLE_DAYS have passed since the
patch notes were published (CDragon diffs arrive after release). A provisional
entry is re-parsed on every run; consumers must treat EVERY augment as changed
while it is provisional, so an incomplete list never reads as "unchanged". A
complete entry is never re-parsed unless --force is passed, so the list a
patch's grades were built on stays fixed. Names that match no catalog augment
are kept with augmentId null, never dropped.

Usage:
    python3 scripts/changed_augments.py --patch 26.19 [--force] [--html FILE]
"""

from __future__ import annotations

import argparse
import html as html_module
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

from augment_stats_identity import norm
from data_paths import INTERNAL_DATA_DIR

OUT_PATH = INTERNAL_DATA_DIR / "changed-augments.json"
CATALOG_PATH = INTERNAL_DATA_DIR / "augments.json"
PATCH_EVENTS_PATH = INTERNAL_DATA_DIR / "patch-events.json"
PATCH_METADATA_PATH = INTERNAL_DATA_DIR / "patch-metadata.json"
CDRAGON_KINDS = {"numeric", "text", "rarity", "added"}
SETTLE_DAYS = 3
MIN_TOKEN = 5  # shorter tokens match too much prose


def _text(fragment: str) -> str:
    return re.sub(r"\s+", " ", html_module.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def catalog_tokens(catalog: dict) -> list[tuple[str, str]]:
    """(normalized token, augmentId) for every catalog augment: display names and
    the CDragon codename, which patch notes sometimes use (e.g. Bursting Teeth)."""
    out: dict[str, str] = {}
    for aug in catalog.get("augments", []):
        augment_id = aug.get("augmentId")
        if not augment_id:
            continue
        for value in (aug.get("name"), aug.get("displayName"), augment_id.removeprefix("ARAM_")):
            token = norm(value)
            if len(token) >= MIN_TOKEN:
                out.setdefault(token, augment_id)
    return sorted(out.items(), key=lambda kv: -len(kv[0]))


def _first_augment(text: str, tokens: list[tuple[str, str]]) -> tuple[str, str] | None:
    """The augment named earliest in `text` (longest token wins at a position)."""
    flat = norm(text)
    best: tuple[int, int, str, str] | None = None
    for token, augment_id in tokens:
        i = flat.find(token)
        if i >= 0 and (best is None or (i, -len(token)) < (best[0], best[1])):
            best = (i, -len(token), token, augment_id)
    return (best[3], best[2]) if best else None


def parse_mayhem_section(article_html: str, tokens: list[tuple[str, str]]) -> list[dict]:
    start = re.search(r'<h2[^>]*id="patch-aram:?-mayhem"[^>]*>', article_html)
    if not start:
        return []
    end = article_html.find("<h2", start.end())
    section = article_html[start.end() : end if end > 0 else len(article_html)]
    found: list[dict] = []
    for part in re.split(r"(?=<h4[^>]*>)", section):
        heading = re.match(r"<h4[^>]*>(.*?)</h4>", part, re.S)
        title = _text(heading.group(1)) if heading else ""
        if title.lower().startswith("bugfix"):
            for li in re.findall(r"<li[^>]*>(.*?)</li>", part, re.S):
                hit = _first_augment(_text(li), tokens)
                if hit:
                    found.append({"augmentId": hit[0], "evidence": "patch-notes:bugfix", "text": _text(li)[:160]})
        elif title.lower().startswith("augment"):
            # Each changed augment is a bold paragraph; bold list items are field names.
            for name in re.findall(r"<p[^>]*>\s*<strong>(.*?)</strong>\s*</p>", part, re.S):
                name = _text(name)
                hit = next((aid for tok, aid in tokens if tok == norm(name)), None)
                found.append({"augmentId": hit, "name": name, "evidence": "patch-notes:balance"})
    return found


def cdragon_changes(patch_events: dict, patch: str) -> list[dict]:
    out = []
    for event in patch_events.get("events", []):
        if event.get("entity_type") != "augment" or event.get("source_patch_label") != patch:
            continue
        kind = event.get("change_kind")
        if kind in CDRAGON_KINDS:
            out.append({"augmentId": event.get("canonical_id"), "evidence": f"cdragon-diff:{kind}"})
    return out


def build_patch_entry(patch: str, article_html: str | None, source_url: str | None,
                      catalog: dict, patch_events: dict, *, published_at: str | None = None,
                      now: datetime | None = None) -> dict:
    tokens = catalog_tokens(catalog)
    notes = parse_mayhem_section(article_html, tokens) if article_html else []
    diffs = cdragon_changes(patch_events, patch)
    by_id: dict[str, dict] = {}
    unknown = []
    for rec in notes + diffs:
        if not rec.get("augmentId"):
            unknown.append(rec)
            continue
        entry = by_id.setdefault(rec["augmentId"], {"augmentId": rec["augmentId"], "evidence": []})
        if rec["evidence"] not in entry["evidence"]:
            entry["evidence"].append(rec["evidence"])
    now = now or datetime.now(timezone.utc)
    section_found = bool(article_html and re.search(r'<h2[^>]*id="patch-aram:?-mayhem"', article_html))
    settled = False
    if published_at:
        published = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
        settled = (now - published).days >= SETTLE_DAYS
    return {
        "patch": patch,
        "parsedAt": now.isoformat(),
        "status": "complete" if section_found and settled else "provisional",
        "policyWhileProvisional": "treat every augment as changed",
        "sources": {
            "patchNotes": source_url if article_html else None,
            "patchNotesPublishedAt": published_at,
            "patchNotesMayhemSection": section_found,
            "cdragonDiffEvents": len(diffs),
        },
        "changed": sorted(by_id.values(), key=lambda e: e["augmentId"]),
        "unmatchedNames": unknown,
    }


def _patch_notes_meta(patch: str) -> tuple[str | None, str | None]:
    try:
        doc = json.loads(PATCH_METADATA_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, None
    meta = next((p for p in doc.get("patches", []) if p.get("version") == patch), {})
    return meta.get("sourceUrl"), meta.get("publishedAt")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--patch", help="default: the structural patch in patch-metadata.json")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--html", help="read the article from a file instead of fetching it")
    args = ap.parse_args()

    if not args.patch:
        args.patch = json.loads(PATCH_METADATA_PATH.read_text(encoding="utf-8"))["patch"]
    doc = json.loads(OUT_PATH.read_text(encoding="utf-8")) if OUT_PATH.exists() else {"schemaVersion": 1, "patches": {}}
    existing = doc["patches"].get(args.patch)
    if existing and existing.get("status") == "complete" and not args.force:
        print(f"changed-augments: {args.patch} complete; keeping it")
        return
    url, published_at = _patch_notes_meta(args.patch)
    article = None
    if args.html:
        article = Path(args.html).read_text(encoding="utf-8")
    elif url:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0 (wasfun.lol data pipeline)"})
        with urlopen(req, timeout=30) as resp:
            article = resp.read().decode("utf-8", errors="replace")
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    events = json.loads(PATCH_EVENTS_PATH.read_text(encoding="utf-8"))
    entry = build_patch_entry(args.patch, article, url, catalog, events, published_at=published_at)
    doc["patches"][args.patch] = entry
    OUT_PATH.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"changed-augments {args.patch}: {len(entry['changed'])} changed, "
          f"{len(entry['unmatchedNames'])} unmatched names, sources {entry['sources']}")


if __name__ == "__main__":
    main()
