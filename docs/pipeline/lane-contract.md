# Data pipeline lane contract

Status: **active** · Introduced: 2026-09-10 (stabilization slice)

`scripts/update-data.sh` runs acquisition lanes in dependency order. Before this
contract existed the script was a flat `set -e` sequence, so *any* lane failure
discarded every lane that had already succeeded. A CommunityDragon shape change
in an advisory lane therefore stopped all publishing from 2026-07-12 to
2026-09-10 — 59 days — while lanes 1–11 succeeded and were thrown away daily.

Two rules follow from that:

1. **Isolation is between lanes, never inside one.** Each lane still promotes
   atomically (`promote_branch` acquires everything, validates, then writes).
   Partial promotion within a lane remains forbidden.
2. **A lane may only fail the run if its output is required for catalog
   coherence.** Everything else degrades and is reported.

## Clocks

Two clocks run independently and are never reconciled into a single "current
patch" number:

| Clock | Authority | Cadence | Lane |
|---|---|---|---|
| structural | Riot patch notes → CommunityDragon | per patch / hotfix | `riot-patch-metadata`, `cdragon-live` |
| statistics | arammayhem.com | daily, lags the live game | `statistics` |

Statistics trailing the structural clock by a patch is the **normal** steady
state, not an error. `check_data_freshness.py` reports it as
`statistics_behind` and exits 0. Only `structural_stale` — our catalog behind
Riot's live patch — exits non-zero.

## Lanes

| Lane | Inputs | Outputs | Atomicity group | Failure policy | Promotion policy |
|---|---|---|---|---|---|
| augment-base-catalog (2) | CDragon cherry-augments, stringtable | `augment-base-catalog.json` | catalog | **required** — explicit abort, keeps committed artifacts | all-or-nothing |
| augment-identity (3) | base catalog, wiki, tencent, statistics | `augment-identity-map.json` + reports | catalog | required | all-or-nothing |
| augment-wiki-feed (4) | LoL Wiki | `augment-wiki-feed.json` + reports | catalog | required — feeds availability resolution | all-or-nothing |
| tencent-feed (5) | Tencent notes | `augment-tencent-feed.json` | catalog | required | all-or-nothing |
| **statistics (6)** | arammayhem.com | `champions.json` (tier/WR/PR), `augment-winrate-feed.json`, `combos.json`, `meta.json` | statistics | **optional** — different clock | previous snapshot retained on failure |
| base-stats (7) | Data Dragon | champion identities, base stats | catalog | required | all-or-nothing |
| cdragon-entities (8) | CDragon | `abilities.json`, `items.json` | catalog | required | all-or-nothing |
| ability-stats-enrich (9) | CDragon ability stats | `abilities.json` (enrich) | enrichment | **optional** | previous values retained |
| item-passive-enrich (10) | LoL Wiki | `items.json` (enrich) | enrichment | **optional** | previous values retained |
| locale-name-enrich (10b) | Data Dragon | localized names | catalog | **required** — step 8 rebuilds abilities/items English-only, so previous values are NOT retained | run aborts; nothing published |
| **riot-patch-metadata (11)** | leagueoflegends.com patch notes | `patch-metadata.json` | structural | **required** — labels the catalog | all-or-nothing |
| **cdragon-live (12)** | CDragon `latest` | `cdragon-*-latest.json`, `patch-events.json` | structural | **required** | atomic per branch |
| pbe-preview (13) | CDragon `pbe` | `cdragon-*-pbe.json`, `pbe-preview.json` | preview | **optional** — advisory only | atomic per branch |
| tombstones (14) | patch notes | resolver input | catalog | required | all-or-nothing |
| assemble (15) | all catalog lanes | `augments.json` + `counts.availability` | catalog | required | all-or-nothing |
| classify (16–17) | assembled catalog | `kit_tags`, breaker gate | catalog | required (already `--allow-partial` internally) | all-or-nothing |
| pool-rules (17b) | catalog + events | `pool-rules.json` | catalog | required | all-or-nothing |
| combos (17c) | catalog | `combos.json` | catalog | required | all-or-nothing |
| status (18) | lane results | `pipeline-status.json` | — | always runs | — |
| export (19) | internal catalog | `public/data/*` | publish | required | all-or-nothing |
| roster-coverage (20) | Data Dragon | gate only | publish | required | — |

### Why `statistics` is optional but `cdragon-live` is required

The statistics lane writes a *parallel* dataset that the catalog does not depend
on for correctness — `assemble_augments.py` already tolerates a missing win rate
(coverage is 120/268 even on a good day). Losing a day of statistics leaves the
site accurate but slightly behind on rates.

`cdragon-live` writes the structural snapshots that the assembled catalog and
its availability verdicts are derived from. Publishing a catalog without it
would mean publishing augment availability for a patch we did not observe.

### Non-playable source rows

CommunityDragon's `champion-summary.json` includes derived champion variants
(`Jade_*`, ids 60001+) that have no `characters/<key>/<key>.bin.json`. They are
identified by Riot's own back-reference fields (`relatedPrimeContentId` /
`relatedPrimeItemId`), not by an id threshold, and are skipped structurally.

A missing bin for a *prime* champion is a structured skip. If base-stat coverage
across prime champions falls below `CHAMPION_BIN_COVERAGE_FLOOR` (95%), the lane
fails — a path-scheme change or partial CDragon publish must not silently
promote a gutted roster.

## Observability

`data/internal/pipeline-status.json` (mirrored to `public/data/`) records
`overall`, `degraded_lanes`, and both clocks. The website reads it via
`src/lib/data/clocks.ts` to render freshness state, so a degraded run is visible
to readers instead of only to an unread GitHub issue.
