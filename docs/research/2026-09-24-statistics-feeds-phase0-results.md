# Statistics feeds: phase 0 results

**Date:** 2026-09-24 · **Status:** RECORDED RESULT (data facts, not a design decision)
**Data:** provider snapshot fetched 2026-09-24, provider patch label 26.19, data date 2026-09-21.
**Governed by:** the data-claim-integrity principle (never strengthen a claim while transforming data). Extends the 2026-09-20 statistics lineage note. Both are private project docs, not in this repo.

## What was built

| Feed / artifact | File | Producer |
| --- | --- | --- |
| Global augment rows with win **and** pick rate | `data/internal/augment-stats-feed.json` | `scripts/scrape_mayhem_stats.py` |
| Every champion's listed augment rows, item rows, champion win and pick rate | `data/internal/champion-build-feed.json` | same |
| Reviewed identity decisions for rows the exact match can't settle | `data/internal/augment-stats-aliases.json` | hand review, read by `scripts/augment_stats_identity.py` |
| Augment scaling profiles (ad / ap / tank / neutral) for the kit-fit covariate | `data/internal/augment-kit-tags.json` | `scripts/augment_kit_tags.py` + hand review |
| Changed augments per patch | `data/internal/changed-augments.json` | `scripts/changed_augments.py` |
| Daily snapshots, last two patches | `data/internal/stats-snapshots/<date>/*.json.gz` | `scripts/stats_snapshots.py` |
| Schema gate | — | `scripts/validate_stats_feeds.py` |
| Kill switch | `WASFUN_AUGMENT_STATS` | `src/lib/stats/kill-switch.ts`, crawl `scripts/verify_kill_switch.py` |
| Interaction-spread measurement | — | `scripts/model/interaction_spread.py` |

All of it runs daily as the optional `statistics-v3` lane of `scripts/update-data.sh`. Nothing in it is exported to `public/data/`.

## Findings

### 1. Per-champion augment win rates are the global win rates

Every champion's listed augment rows carry a win rate. In **3,114 of 3,114** rows (173 champions × 18 rows) that win rate equals the augment's global win rate to the hundredth. A two-way additive model (champion level + augment value) fits the listed rows with a residual of about 3 × 10⁻¹⁴ pp in every rarity.

Consequences:

- The provider publishes **no champion-specific augment outcome**. Only the appearance rate is champion-specific.
- The champion × augment interaction spread τ is **not identifiable** from provider data. `interaction_spread.py` detects this and reports `not-identifiable` instead of fitting noise. On simulated data the same estimator recovers a known τ (0.5 → 0.48–0.57, 1.5 → 1.49–1.54, 3.0 → 2.99–3.03 with no selection), so the result reflects the data, not the estimator.
- A win rate shown next to a champion's augment is the augment's rate across all champions and must be labelled so. Presenting it as the champion's own would be a provider → authority strengthening.
- The feed records this as `semantics["augments[].winRate"].status = "global-copy"`. The schema gate warns if it ever changes, and τ should then be re-measured.

### 2. Units

| Field | Status | Evidence |
| --- | --- | --- |
| Champion pick rate | **Confirmed**: share of games the champion appears in | Sums to 1000.0% over 173 champions (10 players per game) |
| Global augment pick rate | **Unconfirmed**: not a share of games | Sums to 1,427% (gold, 72 live), 974% (prismatic, 67), 1,046% (silver, 56). Consistent with a rate conditional on being offered |
| Per-champion appearance rate | **Unconfirmed**: most likely the share of the champion's games holding the augment | The six listed rows sum to a median of 75% (gold), 43% (prismatic), 42% (silver) and up to 116% (gold), so several can be held per game |
| Counting basis (at pick, or held at game end) | **Unknown** | The provider publishes no definition. Pandora's Box has no provider page (404) |

The unlisted-pair subtraction therefore stays off (unit guard).

### 3. Coverage and identity

- Global table: **201 rows = 195 live + 6 retired**. This reconciles the "201 vs 195" open item in the lineage note.
- Live rows joined to a CDragon augmentNameId: **182 / 195** (was 118 / 201 through the legacy resolver, which only offered a match to augments the catalog already had a win rate for).
- Champion rows joined: **3,012 / 3,114 (96.7%)**. The 102 unjoined rows belong to 10 augments.
- 14 live provider augments have **no CDragon registry entry under their name** in latest or PBE (for example Warlock Juicebox, Overloaded, Surge Field). The catalog marks them removed while the provider lists them live, and the 26.19 patch notes name two of them. They are recorded as deliberately unresolved rather than guessed. Terror is also unresolved: the provider says prismatic, the catalog gold, CDragon silver.

### 4. Kit tags

209 live augments, each tag derived from CDragon text and read by hand. 40 derivations were overridden, each with its reason in `augment-kit-tags.json`. Final mix: 156 neutral, 32 ad, 11 ap, 10 tank. The champion side is Riot's `tacticalInfo.damageType`. Because provider rows carry no champion-specific win rate (finding 1), the kit slope β cannot be fitted from provider data either.

### 5. Changed augments, 26.19

8 augments: High Roller (balance), plus Clown College, Mad Scientist, Multishot, Skilled Sniper, Tooth Fairy (Bursting Teeth), King Me and Ultimate Awakening (bugfixes). No CDragon diff events carried the 26.19 label at parse time.

### 6. Kill switch

A production build served with `WASFUN_AUGMENT_STATS=off` was crawled. It covered 5,465 sitemap pages, 11 API and static-data resources, and 21 script chunks. There were 0 detections across all three detectors (marker, JSON rows, name + own-win-rate fingerprint). All three statistics APIs answered 503. The same build with the switch unset answered those APIs through their normal gates (400 without a session).

## Open

- Appearance-rate units and the counting basis: needs a provider definition or first-party data.
- The 14 augments missing from the CDragon registry: find their codenames, or confirm they are CN-only.
