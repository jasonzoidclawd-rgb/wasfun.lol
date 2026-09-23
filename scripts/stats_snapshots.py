#!/usr/bin/env python3
"""Daily statistics snapshots (v3 phase 0).

Carry-over, set debounce and patch deltas all need yesterday's numbers, which
the feeds overwrite. This keeps an append-only copy of each statistics feed per
UTC day under `data/internal/stats-snapshots/<YYYY-MM-DD>/<feed>.json.gz`:

- keyed by the provider's data date, not our fetch date, so a provider that
  stops updating produces no duplicate "new" days;
- write-once: a day that already has a snapshot is never overwritten, so the
  history cannot be rewritten by a re-run;
- the upstream's numbers are patch-to-date (cumulative), so consumers combine
  ONE snapshot with the carried-over prior and never chain snapshots;
- only the two most recent patches are kept (by patch version, not date);
- stored slim (ids and numbers; names are derivable) and gzipped, about
  80 KB a day, because the history lives in git.

Usage:
    python3 scripts/stats_snapshots.py            # snapshot the feeds' data date, then prune
    python3 scripts/stats_snapshots.py --date 2026-09-21
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
from pathlib import Path

from data_paths import INTERNAL_DATA_DIR

SNAPSHOT_DIR = INTERNAL_DATA_DIR / "stats-snapshots"
FEEDS = ("augment-stats-feed", "champion-build-feed")
KEEP_PATCHES = 2


def slim(feed: str, doc: dict) -> dict:
    """Drop display names; keep every id and number the model reads."""
    if feed == "augment-stats-feed":
        rows = [{k: r[k] for k in ("sourceSlug", "augmentId", "rarity", "availability", "winRate", "pickRate")}
                for r in doc["rows"]]
        return {**{k: v for k, v in doc.items() if k != "rows"}, "rows": rows}
    champions = {}
    for slug, champ in doc["champions"].items():
        champions[slug] = {
            **{k: v for k, v in champ.items() if k not in ("augments", "items")},
            "augments": [{k: r[k] for k in ("rarity", "sourceSlug", "augmentId", "listPosition",
                                             "appearanceRate", "winRate")} for r in champ["augments"]],
            "items": {section: [{"items": [i["sourceSlug"] for i in row["items"]],
                                 "pickRate": row["pickRate"], "winRate": row["winRate"]} for row in rows]
                      for section, rows in champ["items"].items()},
        }
    return {**{k: v for k, v in doc.items() if k != "champions"}, "champions": champions}


def read_snapshot(path: Path) -> dict:
    return json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))


def patch_key(patch: str) -> tuple[int, ...]:
    return tuple(int(p) for p in patch.split("."))


def take_snapshot(date: str, data_dir: Path = INTERNAL_DATA_DIR, snap_dir: Path = SNAPSHOT_DIR) -> list[str]:
    """Copy each feed into today's folder unless it is already there. Returns what was written."""
    written = []
    day = snap_dir / date
    for feed in FEEDS:
        src = data_dir / f"{feed}.json"
        dst = day / f"{feed}.json.gz"
        if not src.exists() or dst.exists():
            continue
        doc = json.loads(src.read_text(encoding="utf-8"))
        if not doc.get("patch"):
            raise ValueError(f"{feed} has no patch; refusing to snapshot an unlabelled feed")
        day.mkdir(parents=True, exist_ok=True)
        body = json.dumps({"snapshotDate": date, **slim(feed, doc)}, ensure_ascii=False, separators=(",", ":"))
        # mtime=0 keeps the bytes reproducible for the same input.
        dst.write_bytes(gzip.compress(body.encode("utf-8"), mtime=0))
        written.append(str(dst.relative_to(snap_dir)))
    return written


def index(snap_dir: Path = SNAPSHOT_DIR) -> dict[str, dict[str, str]]:
    """{date: {feed: patch}} for every snapshot on disk."""
    out: dict[str, dict[str, str]] = {}
    if not snap_dir.exists():
        return out
    for day in sorted(p for p in snap_dir.iterdir() if p.is_dir()):
        for feed in FEEDS:
            path = day / f"{feed}.json.gz"
            if path.exists():
                out.setdefault(day.name, {})[feed] = read_snapshot(path)["patch"]
    return out


def prune(snap_dir: Path = SNAPSHOT_DIR, keep: int = KEEP_PATCHES) -> list[str]:
    """Delete days whose snapshots all belong to patches older than the newest `keep`."""
    idx = index(snap_dir)
    patches = sorted({p for feeds in idx.values() for p in feeds.values()}, key=patch_key)
    kept = set(patches[-keep:])
    removed = []
    for day, feeds in idx.items():
        if not set(feeds.values()) & kept:
            shutil.rmtree(snap_dir / day)
            removed.append(day)
    return removed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="default: the champion-build feed's dataDate")
    args = ap.parse_args()
    if not args.date:
        feed = json.loads((INTERNAL_DATA_DIR / "champion-build-feed.json").read_text(encoding="utf-8"))
        if not feed.get("dataDate"):
            raise SystemExit("champion-build-feed has no dataDate; refusing to guess a snapshot date")
        args.date = feed["dataDate"]
    written = take_snapshot(args.date)
    removed = prune()
    print(f"stats snapshots: wrote {written or 'nothing (already snapshotted)'}; pruned {removed or 'nothing'}")


if __name__ == "__main__":
    main()
