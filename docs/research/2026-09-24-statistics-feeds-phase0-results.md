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
| Daily snapshots keyed by the provider's data date, last two patches | `data/internal/stats-snapshots/<data date>/*.json.gz` | `scripts/stats_snapshots.py` |
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
| Global augment pick rate | **Unconfirmed**: most likely a share of games, like the champion pick rate | Sums to 1,427% (gold, 72 live), 974% (prismatic, 67) and 1,046% (silver, 56): about 3,450% in all, or 3.4 augments per player across 10 players. That fits a share of games (not of player-games), but the provider doesn't say |
| Per-champion appearance rate | **Unconfirmed**: most likely the share of the champion's games holding the augment | The six listed rows sum to a median of 75% (gold), 43% (prismatic), 42% (silver) and up to 116% (gold), so several can be held per game |
| Counting basis (at pick, or held at game end) | **Unknown** | The provider publishes no definition. The evidence points both ways: Pandora's Box has no provider page (404), which fits game-end counting, but all three Transmute augments are listed, which fits pick-time counting unless the Transmute stays held |

The unlisted-pair subtraction therefore stays off (unit guard).

### 3. Coverage and identity

- Global table: **201 rows = 195 live + 6 retired**. This reconciles the "201 vs 195" open item in the lineage note.
- Live rows joined to a CDragon augmentNameId: **182 / 195**. The legacy resolver joined 118 / 201, because it only offered a match to augments the catalog already had a win rate for.
- Joins are by exact display name within the same rarity, or by a reviewed alias. A slug-only match is never accepted, because catalog slugs partly come from the same provider. Three codename-only joins (Void Immolation, Sonic Boom, Double Defense) were reviewed into the alias table.
- Champion rows joined: **3,012 / 3,114 (96.7%)**. The 102 unjoined rows belong to 10 augments.
- 14 live provider augments have **no CDragon registry entry under their name** in latest or PBE (for example Warlock Juicebox, Overloaded, Surge Field). The catalog marks them removed while the provider lists them live, and the 26.19 patch notes name two of them. They are recorded as deliberately unresolved rather than guessed. Terror is also unresolved: the provider says prismatic, the catalog gold, CDragon silver.

### 4. Kit tags

209 live augments. Each tag was derived from CDragon text, then **reviewed by the build agent (Claude), not a human**: it read every augment's text against its derived tag. 40 derivations were overridden, each with its reason in `augment-kit-tags.json`. **A human spot-check is still pending.** Each tag stores a hash of the text it was reviewed against. A text change, or a new augment, re-derives the tag and marks it unreviewed. Nothing marks a tag reviewed automatically, and an unreviewed tag counts as neutral. Final mix: 156 neutral, 32 ad, 11 ap, 10 tank. The champion side is Riot's `tacticalInfo.damageType`. Because provider rows carry no champion-specific win rate (finding 1), the kit slope β cannot be fitted from provider data either.

### 5. Changed augments, 26.19

8 augments: High Roller (balance), plus Clown College, Mad Scientist, Multishot, Skilled Sniper, Tooth Fairy (Bursting Teeth), King Me and Ultimate Awakening (bugfixes). No CDragon diff events carried the 26.19 label at parse time.

The entry is **provisional**, and is re-parsed every run, until the Mayhem section has been found and three days have passed since the patch notes were published, so that CDragon diffs have landed. While an entry is provisional, consumers treat every augment as changed. That way an incomplete list never reads as "unchanged".

### 6. Kill switch

What the crawl proves, and what it doesn't:

- **Public surfaces and APIs.** A production build served with `WASFUN_AUGMENT_STATS=off` was crawled (numbers in the PR). That covered every sitemap page, every `/api/v1` resource, every public data file, and the script chunks. The fingerprint detector reads rendered text and raw bodies, including RSC payloads, with or without a "%". All three statistics APIs answer 503. The same build with the switch unset answers them through their normal gates.
- **Member surfaces.** Today's augment numbers only exist on member pages and member APIs, which an anonymous crawl can't reach. So on this phase's build the crawl finds nothing either way. Member coverage comes from unit tests instead: the member data loader nulls every augment statistic, and the three APIs answer 503 before any gate or data load.
- **The crawler itself.** Run with `--expect on` against a fixture site, it detected an augment win rate in rendered HTML, in an RSC-style payload and in a JSON API row.
- **The real on/off control** (the same build crawled with the switch on and then off) becomes possible in phase 2, when public pages carry numbers.
- **Timing.** Killing the numbers takes effect on the next deploy, not instantly.

## Open

- Appearance-rate units and the counting basis: needs a provider definition or first-party data.
- A human spot-check of the kit tags.
- The 14 augments missing from the CDragon registry: find their codenames, or confirm they are CN-only.
