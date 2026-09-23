#!/usr/bin/env bash
# Mayhem Oracle — per-patch data refresh
#
# Lane failure policy
# -------------------
# Lanes marked `required` produce the catalog that must stay internally
# coherent (augments, champions, items, pool rules, public export). If one of
# them fails, nothing publishes — a half-built catalog is worse than an old one.
#
# Lanes marked `optional` are on a different clock or are pure enrichment. Their
# failure degrades the run but must never discard the other lanes' work. This is
# the failure-coupling fix: before it, one CDragon 404 in an optional lane threw
# away every successful acquisition, which stopped publishing for 59 days
# (2026-07-12 → 2026-09-10).
#
# Every lane still promotes atomically; isolation is between lanes, never inside
# one.
#
# Usage:
#   ./scripts/update-data.sh
#   npm run update-data

set -euo pipefail

cd "$(dirname "$0")/.."

# Overridable so an isolated run can be pointed at a scratch directory; the
# public projection is only written for the canonical directory.
DATA_DIR="${MAYHEM_DATA_DIR:-data/internal}"
export MAYHEM_DATA_DIR="$DATA_DIR"
export MAYHEM_PUBLISH_STATUS=$([ "$DATA_DIR" = "data/internal" ] && echo 1 || echo 0)
META=$DATA_DIR/meta.json
mkdir -p "$DATA_DIR"
OLD_PATCH=$(python3 -c "import json; print(json.load(open('$META'))['patch'])" 2>/dev/null || echo "unknown")
AUGMENT_SNAPSHOT=$(mktemp -t mayhem-augment-snapshot.XXXXXX)
PIPELINE_COMPLETED=0

step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$1"; }

DEGRADED_LANES=()

# run_lane <lane-name> <required|optional> <command...>
run_lane() {
  local lane="$1" policy="$2"; shift 2
  local code=0
  # `|| code=$?` keeps errexit from aborting here AND preserves the real exit
  # status (a bare `if cmd; then ... fi` resets $? to 0 once the block ends).
  "$@" || code=$?
  if [ "$code" -eq 0 ]; then
    return 0
  fi
  if [ "$policy" = "required" ]; then
    printf "\n\033[1;31m✗ required lane '%s' failed (exit %d); refusing to publish an incoherent catalog.\033[0m\n" \
      "$lane" "$code" >&2
    exit "$code"
  fi
  printf "\n\033[1;33m⚠ optional lane '%s' failed (exit %d); continuing with its previous data.\033[0m\n" \
    "$lane" "$code" >&2
  DEGRADED_LANES+=("$lane")
  return 0
}

# Writes to the internal dir AND to public/data when it exists, so the
# externally consumed status is the one produced by the FINAL write rather than
# a snapshot taken before the remaining required gates had run.
write_pipeline_status() {
  local overall="$1" detail="${2:-}"
  DEGRADED_LIST="$(IFS=,; echo "${DEGRADED_LANES[*]:-}")" \
  PIPELINE_OVERALL="$overall" \
  PIPELINE_DETAIL="$detail" \
  python3 - <<'PY'
import json, os
from datetime import datetime, timezone
from pathlib import Path

data_dir = Path(os.environ["MAYHEM_DATA_DIR"])
degraded = [lane for lane in os.environ.get("DEGRADED_LIST", "").split(",") if lane]


def read(name):
    path = data_dir / name
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


# Carry-forward is a real loss of freshness even though the lane exits 0: base
# stats that were not observed this run are still published under the new patch
# label. It must not be reported as a fully current structural lane.
champion_snapshot = read("cdragon-champion-latest.json")
snapshot_degraded = champion_snapshot.get("degraded") or {}
carried = snapshot_degraded.get("base_stats_retained") or []
bootstrapped = snapshot_degraded.get("bootstrapped_without_base_stats") or []
if carried and "cdragon-live" not in degraded:
    degraded = [*degraded, "cdragon-live"]

status = {
    "schema_version": 1,
    "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "overall": os.environ["PIPELINE_OVERALL"],
    "degraded_lanes": degraded,
    "structural_lane": {
        "status": "degraded" if carried else "ok",
        "carriedForward": len(carried),
        "missingCurrentObservation": carried,
        "bootstrappedWithoutBaseStats": bootstrapped,
    },
    # The two clocks, recorded separately and never reconciled into one number.
    "structural": {
        "patch": read("patch-metadata.json").get("patch"),
        "source": "riot_patch_notes",
    },
    "statistics": {
        "patch": read("meta.json").get("patch"),
        "observed_at": read("meta.json").get("scraped_at"),
        "source": read("meta.json").get("source"),
    },
}
detail = os.environ.get("PIPELINE_DETAIL", "")
if detail:
    status["detail"] = detail

# The shell chose ok/degraded from lane exit codes alone; carry-forward is only
# visible here, so it downgrades the verdict rather than being lost.
if status["overall"] == "ok" and degraded:
    status["overall"] = "degraded"

payload = json.dumps(status, ensure_ascii=False, indent=2) + "\n"
(data_dir / "pipeline-status.json").write_text(payload, encoding="utf-8")

# Publish the same status directly. The export step runs before the final
# required gates, so copying this file through the export would freeze an
# optimistic "ok" that later failures could not correct.
public_dir = Path("public/data")
if os.environ.get("MAYHEM_PUBLISH_STATUS") == "1" and public_dir.is_dir():
    (public_dir / "pipeline-status.json").write_text(payload, encoding="utf-8")
print(
    f"  structural={status['structural']['patch']} "
    f"statistics={status['statistics']['patch']} "
    f"overall={status['overall']} degraded={degraded or 'none'}"
)
PY
}

# Any exit before the final gate — a required lane, the export, the roster
# gate, or a kill — must leave a status that says so. Previously the status was
# written mid-run, so an "ok" artifact survived later required failures.
on_pipeline_exit() {
  local code=$1
  rm -f "$AUGMENT_SNAPSHOT"
  if [ "$PIPELINE_COMPLETED" -ne 1 ]; then
    write_pipeline_status failed "exited with code ${code} before completing required gates" || true
  fi
}
trap 'on_pipeline_exit $?' EXIT

# Mark the run in-flight immediately: a consumer reading during the run must
# never see a stale "ok" from the previous run.
write_pipeline_status running

step "1/19  snapshot augment classifications"
AUGMENT_SNAPSHOT="$AUGMENT_SNAPSHOT" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["MAYHEM_DATA_DIR"]) / "augments.json"
data = json.loads(path.read_text(encoding="utf-8"))
snapshot = {
    a["slug"]: {k: a[k] for k in ("kit_tags", "set", "flags") if k in a}
    for a in data.get("augments", [])
}
Path(os.environ["AUGMENT_SNAPSHOT"]).write_text(
    json.dumps(snapshot, ensure_ascii=False),
    encoding="utf-8",
)
print(f"Snapshotted {sum(1 for v in snapshot.values() if v.get('kit_tags'))} classified augments")
PY

step "2/19  CommunityDragon  →  authoritative augment base catalog"
if ! python3 scripts/scrape_mayhem_augments_cdragon.py --base-catalog-only; then
  printf "\n\033[1;31m✗ CDragon augment base fetch failed; keeping committed augment artifacts and aborting rebuild.\033[0m\n" >&2
  exit 1
fi

step "3/19  CDragon/Wiki/Tencent/arammayhem  →  augment identity map"
python3 scripts/augment_identity_resolver.py

step "4/19  LoL Wiki augment feed  →  internal augment-wiki-feed/reports"
python3 scripts/augment_wiki_feed.py

step "5/19  Tencent 26.12 official notes  →  augment-tencent-feed"
python3 scripts/build_tencent_feed.py

step "6/19  arammayhem.com  →  internal champions/augment win-rate feed/combos/meta"
# Statistics run on their own clock; a stats-provider outage must not block
# publishing current structural truth.
run_lane statistics optional python3 scripts/scrape_arammayhem.py

step "7/19  Data Dragon  →  active champion identities + base stats"
python3 scripts/scrape_base_stats.py

step "8/19  CommunityDragon  →  internal abilities/items"
python3 scripts/scrape_community_dragon.py

step "9/19  CommunityDragon ability stats  →  internal abilities.json (enrich)"
run_lane ability-stats-enrich optional npx --yes tsx scripts/scrape_ability_stats.ts

step "10/19 LoL Wiki item passives  →  internal items.json (enrich)"
run_lane item-passive-enrich optional python3 scripts/enrich_wiki.py

step "10b/19 Data Dragon  →  localized champion, ability & item names (enrich)"
# Required, not enrichment: step 8 has just rebuilt abilities/items with English
# fields only, and this lane is what puts their translations back. The locale
# coverage gate below checks champions/augments only, so a failure here would
# otherwise publish de-localized abilities and items as a merely degraded run.
run_lane locale-name-enrich required python3 scripts/enrich_locale_names.py

step "11/19 Riot prose  →  patch title/date/canonical metadata only"
# Structural patch authority: labels the catalog. Required.
run_lane riot-patch-metadata required python3 scripts/scrape_patch_notes.py

# CommunityDragon is the structural source of truth for all three entities.
# Each lane promotes only after its full branch transaction validates; PBE never
# falls back to latest and latest is never relabeled as preview.
step "12/19 CommunityDragon latest  →  live snapshots + patch/hotfix events"
run_lane cdragon-live required python3 scripts/cdragon_patch_pipeline.py --branch latest

step "13/19 CommunityDragon pbe  →  preview snapshots + lifecycle reconciliation"
# Preview is advisory; a PBE outage must never block the live catalog.
run_lane pbe-preview optional python3 scripts/cdragon_patch_pipeline.py --branch pbe

step "14/19 patch-note removed augment tombstones  →  augment resolver input"
python3 scripts/apply_removed_augment_tombstones.py

step "15/19 assemble augments.json  →  resolved availability"
python3 scripts/assemble_augments.py

step "16/19 restore augment classifications"
AUGMENT_SNAPSHOT="$AUGMENT_SNAPSHOT" python3 - <<'PY'
import json
import os
from pathlib import Path

snapshot = json.loads(Path(os.environ["AUGMENT_SNAPSHOT"]).read_text(encoding="utf-8"))
path = Path(os.environ["MAYHEM_DATA_DIR"]) / "augments.json"
data = json.loads(path.read_text(encoding="utf-8"))
restored = 0
for aug in data.get("augments", []):
    saved = snapshot.get(aug["slug"])
    if not saved:
        continue
    if "kit_tags" in saved:
        aug["kit_tags"] = saved["kit_tags"]
    if saved.get("set") and not aug.get("set"):
        aug["set"] = saved["set"]
    if "flags" in saved:
        saved_flags = {
            k: v for k, v in saved["flags"].items()
            if k not in {
                "lifecycle",
                "availability_override",
                "availability_label",
                "availability_source",
                "availability_observed_at",
            }
        }
        aug.setdefault("flags", {}).update(saved_flags)
    restored += 1
path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
missing = sum(1 for a in data["augments"] if not a.get("kit_tags"))
print(f"Restored {restored} augments. Unclassified or universal: {missing}")
PY

step "17/19 classify internal champions/augments  →  kit_tags"
# --allow-partial: a handful of champions that fail deterministic derivation (and
# can't reach the optional LLM in CI) must NOT abort the whole refresh — an
# untagged champion degrades to a universal augment pool, which is far better
# than freezing all data (and blocking hotfix propagation). Mirrors augments.
python3 scripts/classify_champions.py --allow-partial
python3 scripts/classify_augments.py --skip-classified --allow-partial
python3 - <<'PY'
import json
from pathlib import Path

data_dir = Path("data/internal")
champions = json.loads((data_dir / "champions.json").read_text())["champions"]
augments = json.loads((data_dir / "augments.json").read_text())["augments"]

champion_tagged = sum(1 for c in champions if c.get("kit_tags"))
augment_tagged = sum(1 for a in augments if a.get("kit_tags"))
missing_breakers = [
    slug
    for slug in {
        "draw-your-sword", "jeweled-gauntlet", "master-of-duality",
        "mystic-punch", "tap-dancer", "marksmage",
        "slow-and-steady", "vulnerability",
    }
    if not next((a for a in augments if a.get("slug") == slug and a.get("flags", {}).get("system_breaker") is True), None)
]
locale_failures = []
for suffix in ("zh_TW", "zh_CN", "ja", "ko"):
    champion_field = f"name_{suffix}"
    augment_field = f"name_{suffix}"
    champion_count = sum(1 for c in champions if str(c.get(champion_field) or "").strip())
    augment_count = sum(1 for a in augments if str(a.get(augment_field) or "").strip())
    champion_coverage = champion_count / len(champions) if champions else 0
    augment_coverage = augment_count / len(augments) if augments else 0
    if champion_coverage < 0.9:
        locale_failures.append(f"champion {champion_field}={champion_count}/{len(champions)}")
    if augment_coverage < 0.8:
        locale_failures.append(f"augment {augment_field}={augment_count}/{len(augments)}")

if champion_tagged == 0 or augment_tagged == 0 or missing_breakers or locale_failures:
    raise SystemExit(
        "classification validation failed: "
        f"champion kit_tags={champion_tagged}/{len(champions)}, "
        f"augment kit_tags={augment_tagged}/{len(augments)}, "
        f"missing system breakers={missing_breakers}, "
        f"locale coverage failures={locale_failures}"
    )
PY

step "17b/19 generate internal pool rules  →  pool-rules.json"
python3 scripts/generate_pool_rules.py

step "17c/19 generate current internal combos  →  combos.json"
npx --yes tsx scripts/generate_internal_combos.ts

step "18/19 v3 statistics  →  augment-stats/champion-build feeds, changed augments, snapshots"
# Internal only: nothing here is exported to public/data. Optional: a failure
# keeps yesterday's feeds (rolled back inside the lane) and marks the run degraded.
run_lane statistics-v3 optional ./scripts/run_stats_v3_lane.sh

step "19/19 export bounded public catalogs + patch/PBE presentation projections"
python3 scripts/export_public_catalog.py

step "20/20 Data Dragon  →  active champion roster coverage gate"
python3 scripts/check_roster_coverage.py

step "21/21 finalize lane + clock status"
# Last write wins, and it happens only after every required gate has passed.
PIPELINE_COMPLETED=1
if [ ${#DEGRADED_LANES[@]} -eq 0 ]; then
  write_pipeline_status ok
else
  write_pipeline_status degraded
fi

STRUCTURAL_PATCH=$(python3 -c "import json; print(json.load(open('$DATA_DIR/patch-metadata.json')).get('patch') or 'unknown')" 2>/dev/null || echo unknown)
NEW_PATCH=$(python3 -c "import json; print(json.load(open('$META'))['patch'])")

# Clear Next.js cache — large data rewrites corrupt HMR state if the dev server was running.
rm -rf .next

printf "\n\033[1;32m✓ Data refresh complete\033[0m\n"
printf "  STRUCTURAL: %s (Riot patch notes)\n" "$STRUCTURAL_PATCH"
printf "  STATISTICS: %s (%s → %s)\n" "$NEW_PATCH" "$OLD_PATCH" "$NEW_PATCH"
if [ ${#DEGRADED_LANES[@]} -gt 0 ]; then
  printf "\033[1;33m  DEGRADED lanes: %s\033[0m\n" "${DEGRADED_LANES[*]}"
fi
printf "  Next: review 'git diff data/internal public/data/', run 'npm run build', commit.\n"
