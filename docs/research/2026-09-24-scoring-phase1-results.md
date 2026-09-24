# Scoring: phase 1 results

**Date:** 2026-09-24 · **Status:** RECORDED RESULT
**Code:** `src/lib/score/` · **Tests:** `src/lib/__tests__/score-math.test.ts` (simulations) and `src/lib/__tests__/score-real-data.test.ts` (frozen provider snapshot, data date 2026-09-21)
**Builds on:** `docs/research/2026-09-24-statistics-feeds-phase0-results.md`

## What the provider's data can and can't support

The provider publishes one outcome row per augment. Its per-champion augment **win rates copy that global row** (3,114 of 3,114). Its per-champion **appearance rates are the champions' own**: none of the 3,114 equals the global pick rate, and every augment listed on five or more champions varies across them (Transmute: Prismatic runs 6.6–16.9% over 142 champions, against 64.6% globally).

So the engine:

1. **Never treats listed rows as a champion's own outcome data.**
   - The kit covariate is never fitted. On copies, a slope would learn champion baselines, not kit fit. It stays off until real per-champion outcomes exist.
   - The champion-specific effect ι stays at its prior.
   - The synergy flag ("Better on <champion>") is off, and so are "Best on" icons. On copies they would rank champions by their own baselines, not by the augment.
2. **Grades augments from the global row, takers-adjusted.** The augment's win rate is taken minus the pick-weighted mean win rate of the champions who take it. The weights come from the champions' real appearance rates. That adjustment is uncertain, so its uncertainty is part of the variance (see Sensitivities).
3. **Shrinks with CLOSE-NPMLE.** Location and scale are smooth in log pick rate, fitted by marginal likelihood. The prior shape is an NPMLE mixture fitted by EM. A spread floor applies, and a Morris variance floor stops the discrete-prior posteriors from collapsing.
4. **Grades with reliable tiers.** KRW dynamic programming with λ = 0.25, the 0.5 pp margin, and the lifts' pairwise covariance, on every surface. Letters are conservative.
5. **Treats champion decisions as uncertain for one champion.** The Pick verdict, close calls and reroll odds add a champion-specific spread τ = **2.0 pp** to each card's variance. The provider can't reveal that spread, so the promise that "a named pick holds at least 80% of the time" is kept up to a true spread of 2.0 pp.

## Noise scale: a lower bound

The provider publishes dated, cumulative snapshots of every champion's win rate, snapshotting all champions at once. On a cumulative window, each day-pair of snapshots estimates the games per day.

| Day-pair (patch) | Games per day |
| --- | --- |
| 08-13 → 08-21 (26.16) | 651k |
| 08-30 → 08-31 (26.17) | 1.85M |
| 08-31 → 09-07 (26.17) | 793k |
| 09-07 → 09-09 (26.17) | 1.13M |
| 09-12 → 09-15 (26.18) | 164k |
| 09-15 → 09-20 (26.18) | 228k |

The pairs disagree by a factor of 11, so the model doesn't pin the volume down. The engine therefore uses a **lower bound**: the smallest daily rate multiplied by the days since the current patch started (at least one). For this snapshot that's **164k games**. Fewer games means wider uncertainty, which is the direction that never overstates. An earlier draft pooled the pairs into "about 9.5M". The independent review showed that figure was inflated by short, overlapping windows, and it is withdrawn.

## Real-data backtests

| Backtest | Result | Consequence |
| --- | --- | --- |
| **Pooling:** hold out a champion's rows and predict them from the others | **Not runnable.** The champion win-rate rows are copies of the global row | The gated claim (champion-specific grades beat the global list) is made nowhere |
| **Carry-over:** early-patch grades predict end-of-patch rows better than the early raw values | **Failed.** Run on 344 champion-patches (26.16→26.17 and 26.17→26.18, plus one 26.15→26.18), measured as RMSE against each patch's last snapshot. The first snapshot alone scored **0.153 pp**. Carry-over scored **0.324 pp** at the spec's 0.5 pp drift, 0.192 at 1 pp and 0.164 at 1.5 pp. The last patch's value alone scored 1.295 pp | `CARRY_OVER_ENABLED = false`, and pages show patch-to-date data only. No patch-day performance claim is made. Caveats: this uses champion rows as a proxy (augment history doesn't reach back a patch), and the target includes the early snapshot's own games. Re-run on augment snapshots once they cover a full patch |

## Simulation acceptance tests

The simulation follows the spec's own scripts: a game yields about 1.33 picks of a rarity. With that convention, the typical and rich regimes reproduce the spec's reported misordering (7.6% and 3.6%).

| Test | Result |
| --- | --- |
| Misordered split pairs, thin (5,000 games, 18 options) | **13.9%** pooled over 750 sets (limit 15%). Single 150-set batches range from 11.7% to 16.0% |
| Misordered split pairs, typical (20,000 games) | **7.5%** (limit 12%) |
| Misordered split pairs, rich (80,000 games) | **3.6%** (limit 8%) |
| Large, precise sets (60 and 173 options) | 1.0% and 2.7% |
| Well-measured options shown with a letter stronger (more extreme) than their own estimate | 0. This holds by construction of conservative letters, so it checks the code, not the statistics |
| Close call exactly when P(θ₁ > θ₂ + 0.5 pp) < 0.8 | pass |
| Verdicts without a close call hold ≥ 80% in every certainty bin, for a true champion spread of 2.0 pp, on a typical day and on patch day, both plainly and by the 0.5 pp margin | pass |
| Posterior coverage after the grading multiplier (`GRADE_INFLATE` = 1.4), share of truths outside ±1.96 sd | 2.9–4.6% per regime. The multiplier was tuned on the same data-generating process, so this is not out-of-sample validation |
| Set debounce: letters never out of order; a lasting new grouping shows on day 2 | pass |
| Patch deltas on unchanged truths | under 1%; a delta never reads "+0" |
| Synergy flag with no real interaction | under 1%. It never fires without champion-specific rows, or while rows are copies |
| Gambles: grants subtracted before pick rates are used (game-end counting); Pandora's Box moves with holdings | pass. Off for real data: the counting basis is unknown |
| Noise uses the baseline rate (a 3–0 row carries about 29 pp of noise); unit guard; combine once | pass |

**Calibration across the true champion spread.** Worst certainty bin, typical day:

| True spread | Held (plain) | Held (0.5 pp margin) |
| --- | --- | --- |
| 1.2 pp, verdicts at τ = 1.2 | 90% | 83% |
| 2.0 pp, verdicts at τ = 1.2 | 78% (fails) | 71% (fails) |
| 2.5 pp, verdicts at τ = 1.2 | 72% (fails) | 67% (fails) |

This is why the engine uses τ = 2.0: it keeps the promise up to 2.0 pp. Above that, the promise is unverified until the spread can be measured, which needs first-party data.

## Changes from the spec's math, and why

1. **Morris variance floor on CLOSE-NPMLE posteriors.** Before it, simulated |z| had a 99th percentile of 14.
2. **Scale by marginal likelihood**, not moment regression, which floored at zero.
3. **Grading multiplier `GRADE_INFLATE = 1.4`**: the smallest value that restores nominal coverage.
4. **Pairwise covariance** in every grading call, simulated and real.
5. **Uncapped tier DP, merged by letter for display (at most five groups).**
   - Any fixed cap (the spec's 5, or a draft's 12) made the real letter table a function of that constant.
   - The λ-objective alone now decides every split, which in the limit of precise data gives each option its own band.
   - Plan eligibility is decided per raw tier, before merging.
6. **Takers adjustment with mass-constrained unlisted shares and systematic variance** (Sensitivities).
7. **Volume as a lower bound** (above).
8. **τ = 2.0 pp** for champion decisions (above).

## Real letters (data date 2026-09-21)

| Set | S | A | B | C | D | Outlined (thin) |
| --- | --- | --- | --- | --- | --- | --- |
| Prismatic augments (62) | 8 | 5 | 17 | 19 | 13 | 7 |
| Gold augments (69) | 7 | 4 | 29 | 0 | 29 | 15 |
| Silver augments (51) | 3 | 0 | 26 | 12 | 10 | 2 |
| Champions (173) | 18 | 18 | 86 | 43 | 8 | 10 |

Letters measure lift against the pick-weighted mean of the other augments of the same rarity. That mean is high, because the most-picked augments are strong.

## How often the Pick screen names a pick

The share of random three-card screens that get a named pick rather than "Close call":

| τ | Prismatic | Gold | Silver |
| --- | --- | --- | --- |
| 0 (global only) | 75.9% | 75.2% | 76.4% |
| 1.2 pp | 62.8% | 60.8% | 53.3% |
| **2.0 pp (used)** | **50.1%** | **50.3%** | **37.6%** |
| 2.5 pp | 42.6% | 43.6% | 28.8% |

Half the screens get a named pick. The rest say "Close call", because the provider can't tell one champion's value from the global one. First-party data is the only way to narrow that.

## Sensitivities

- **Takers adjustment.** The median shift is 0.12–0.35 pp, and the largest is 1.87 pp.
  - Unlisted takers are set to half their bound, capped so a champion's unlisted augments share only the mass its listed ones leave. The per-champion total is the global pick rates' sum ÷ 10, which rests on the unit hypothesis.
  - Across the envelope (unlisted share 0.25–0.75 × total ×0.5–×1.5), half the range enters the variance: a median sd of 0.21–0.46 pp and a largest of 1.26 pp.
  - Moving only the central total to ×0.5 still changes 17 prismatic, 40 gold and 3 silver letters, and moving it to ×1.5 changes 0, 0 and 6. So the letters rest on that unit hypothesis, and they would move if the units turn out otherwise.
- **Volume.** At the lower bound, the median posterior sd is about 0.3 pp.
