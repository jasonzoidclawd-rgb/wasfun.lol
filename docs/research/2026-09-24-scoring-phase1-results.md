# Scoring: phase 1 results

**Date:** 2026-09-24 · **Status:** RECORDED RESULT
**Code:** `src/lib/score/` · **Tests:** `src/lib/__tests__/score-math.test.ts` (simulations), `src/lib/__tests__/score-real-data.test.ts` (frozen provider snapshot, data date 2026-09-21)
**Builds on:** `docs/research/2026-09-24-statistics-feeds-phase0-results.md`

## What the engine does with the data the provider actually publishes

The provider publishes one outcome row per augment. Its "per-champion" augment rows copy that global row (phase 0, finding 1). So the engine works like this:

1. **Global augment lift.** Each live augment gets a leave-one-out lift on takers-adjusted win rates. The noise uses the set's baseline rate and the volume fitted below, never the row's own rate.
2. **CLOSE-NPMLE posterior.** Location and scale are fitted by marginal likelihood as smooth functions of log pick rate. The prior shape is a nonparametric maximum-likelihood mixture, fitted by EM.
3. **Reliable tiers.** Tiers use the KRW dynamic programme (λ = 0.25, 0.5 pp margin, pairwise covariance) and get conservative letters.
4. **Champions.** Each champion's decision set is its own pool, valued at the global posteriors. The kit slope β and the interaction ι can't be fitted, so they stay at their prior (β = 0), and the synergy flag never fires.
5. **Champion-level decisions.** The Pick verdict, close calls and reroll odds add an assumed champion-specific variance τ² = (1.2 pp)² to each card. They never claim more certainty about one champion than the global data holds.

## Noise scale, fitted from the provider's own history

The provider publishes dated snapshots of every champion's win rate. Within a patch, successive snapshots of the same quantity differ by sampling noise, and the robust median of ΔW²·π / (μ(1−μ)) estimates 1/N.

| Quantity | Value |
| --- | --- |
| Same-patch snapshot pairs | 1,026 |
| Games behind a snapshot, N | about 9.5 million (5–95% bootstrap in the test log) |
| Implied augment noise at 2 / 10 / 35% pick rate | 0.11 / 0.05 / 0.03 pp |

Real within-patch drift can only inflate these differences, which means fewer games and wider uncertainty: the safe direction. The prototype's assumed 100,000 games was about 95 times too low.

## Real-data backtests

| Backtest | Result | Consequence |
| --- | --- | --- |
| **Pooling:** hold out a champion's rows, predict from the others, beat its raw rows and the global row | **Not runnable.** The champion rows equal the global rows in 3,114 of 3,114 cases, so there is nothing to hold out | The gated claim (champion-specific grades beat the global list) is not made anywhere. No synergy flags |
| **Carry-over:** early-patch grades predict end-of-patch better than early raw values | **Failed.** On 344 champion-patches (26.15–26.19), measured as RMSE against the patch's last snapshot, the first snapshot alone scored 0.153 pp. Carry-over with the spec's 0.5 pp drift scored 0.193 pp, and with 1.5 pp drift 0.154. Last patch alone scored 1.295 pp. Champions moved about 1.3 pp between patches | `CARRY_OVER_ENABLED = false`. Pages show patch-to-date data only. The test ties the switch to the backtest. Re-run on augment snapshots once they cover a full patch |

## Simulation acceptance tests (spec, phase 1)

| Test | Result |
| --- | --- |
| Misordered split pairs, thin (5,000 games, 18 options) | **14.9%** (limit 15%), 300 seeded sets |
| Misordered split pairs, typical (20,000 games) | **8.6%** (limit 12%) |
| Misordered split pairs, rich (80,000 games) | **3.9%** (limit 8%) |
| Well-measured options with a letter stronger (more extreme) than their own estimate | **0** of 800+ |
| Close call exactly when P(θ₁ > θ₂ + 0.5 pp) < 0.8 | pass |
| Verdicts shown without a close call hold ≥ 80% in every certainty bin, typical day and patch day | pass |
| Posterior calibration, share of truths outside ±1.96 sd after the grading multiplier | 2–6% (nominal 5%) |
| Set debounce: letters never out of order; a lasting new grouping shows on day 2 | pass |
| Patch deltas on unchanged truths | under 1% |
| Synergy flag with no real interaction | under 1% (and never without champion-specific rows) |
| Gambles: grants subtracted before pick rates are used (game-end counting); Pandora's Box moves with holdings | pass |
| Noise uses the baseline rate (a 3–0 row carries about 29 pp of noise) | pass |
| Unit guard: the unlisted-pair subtraction stays off until units are confirmed and listed ≤ global share | pass |
| Snapshot combined once, never chained | pass |

## Changes from the spec's math, and why

1. **Posterior variance floor (section 5).** The NPMLE prior is discrete. With few noisy options, posteriors collapsed onto single grid points with near-zero variance: before the fix, simulated |z| had a 99th percentile of 14. Each posterior variance is now floored at Morris's empirical-Bayes variance for a normal prior. That floor includes the fitted location's own uncertainty, plus a term that grows with distance from the location.
2. **Scale fitted by marginal likelihood.** The first version fitted the scale by moment regression, which floors at zero when noise dominates. Marginal likelihood replaces it.
3. **Grading multiplier.** Grading uses `GRADE_INFLATE = 1.4` on variances and covariances. It is the smallest value that brings simulated coverage back to nominal, which is the calibration the spec asks for until the test passes.
4. **Pairwise covariance.** The pairwise tests use the section-1 lift covariance, scaled by each posterior's own-data weight.
5. **Up to 12 raw tiers, merged by letter (section 6).** With five tiers, large, precise sets (62 augments of a rarity, 173 champions) were forced into wide tiers. Every top tier reached toward zero, so no S and no champion A could ever appear. Raw tiers are now capped at 12, and adjacent tiers with the same letter merge, so at most five letter groups show. The simulation tests above pass with this.

## Real letters (data date 2026-09-21)

| Set | S | A | B | C | D |
| --- | --- | --- | --- | --- | --- |
| Prismatic augments (62) | 7 | 6 | 16 | 21 | 12 |
| Gold augments (69) | 6 | 7 | 10 | 19 | 27 |
| Silver augments (51) | 3 | 6 | 20 | 13 | 9 |
| Champions (173) | 12 | 13 | 85 | 43 | 20 |

The top of each list: High Roller, Draw Your Sword and Infinite Recursion (prismatic); Transmute: Prismatic, Shrink Engine and Recursion (gold); Blunt Force, Heavy Hitter and Escape Plan (silver). Lifts are measured against the pick-weighted mean of the other augments of the same rarity. That mean is high, because the most-picked augments are strong, so many augments sit below it.

## Sensitivities

- **Unlisted takers.** The takers adjustment has to weight champions that don't list an augment. Their share is unknown, bounded by their least-picked listed augment; the engine uses half the bound. Against 0.25 and 0.75 of the bound, letters changed on 1–4 (prismatic), 0–4 (gold) and 1–11 (silver) augments. At the extreme of 0 (ignore unlisted takers), 7–21 changed. Median takers shift: 0.08–0.23 pp; the largest was 1.23 pp.
- **Assumed champion spread τ, measured as the share of random three-card offers showing "Close call":**

| τ | Prismatic | Gold | Silver |
| --- | --- | --- | --- |
| 0 (global only) | 12.0% | 10.9% | 14.6% |
| 0.6 pp | 23.8% | 23.1% | 30.6% |
| **1.2 pp (used)** | **34.4%** | **34.4%** | **44.4%** |
| 2.5 pp | 54.8% | 52.6% | 71.0% |

Close calls are frequent because the provider can't tell one champion's value from the global one. That is the honest reading. Champion-specific data (first-party) is the only way to narrow it.
