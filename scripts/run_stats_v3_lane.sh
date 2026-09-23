#!/usr/bin/env bash
# v3 statistics lane (phase 0), run by scripts/update-data.sh as an optional lane.
# scrape → changed-augment list → kit-tag refresh → schema gate → daily snapshot.
# A feed that fails the schema gate is rolled back to the committed version, so
# a bad scrape can never be published or snapshotted; the lane then exits 1 and
# the run is marked degraded while the rest of the catalog still publishes.
set -euo pipefail
cd "$(dirname "$0")/.."
DATA_DIR="${MAYHEM_DATA_DIR:-data/internal}"
FEEDS=("$DATA_DIR/augment-stats-feed.json" "$DATA_DIR/champion-build-feed.json")

rollback() {
  for f in "${FEEDS[@]}"; do
    git checkout --quiet -- "$f" 2>/dev/null || true
  done
}

python3 scripts/scrape_mayhem_stats.py
python3 scripts/changed_augments.py
python3 scripts/augment_kit_tags.py
if ! python3 scripts/validate_stats_feeds.py; then
  rollback
  echo "✗ v3 statistics feeds failed the schema gate; kept the committed feeds" >&2
  exit 1
fi
python3 scripts/stats_snapshots.py
