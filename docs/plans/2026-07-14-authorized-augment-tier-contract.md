# Authorized global augment tier contract — unblocks the frame goal

Paste this into Codex as the continuation of the blocked goal. It is the
owner-approved canonical tier contract the previous three audits were missing.
Blocker 2 (GitHub runner billing) is external: proceed to completion on local
gates plus Vercel, record CI as pending-external, and do not hold the goal
blocked on it.

---

<authorized_tier_contract>
The product owner authorizes the following global augment quality-tier
contract. It intentionally reuses two existing approved structures — the
champion `Tier` vocabulary and the advisor `GRADE_BANDS` percentile boundaries
— so no new product semantics are invented.

Source and scope:
- Input: `win_rate` from `data/internal/augments.json` (internal-only, never
  published). Augments without a numeric `win_rate` receive NO tier and render
  the neutral frame. Do not backfill from rarity, Oracle score, lifecycle, or
  advisor grades.

Ranking and banding:
- Rank all augments that have `win_rate`, descending; break ties by slug
  ascending so output is deterministic.
- Percentile = rank position / ranked count, in [0, 1).
- Map percentile through the existing `GRADE_BANDS` boundaries
  (`src/lib/decision/grade.ts`) onto the existing `Tier` vocabulary:
  - percentile < 0.10  → `god`      (displays S+)
  - 0.10 – 0.30        → `strong`   (displays S)
  - 0.30 – 0.60        → `good`     (displays A)
  - 0.60 – 0.85        → `average`  (displays B)
  - 0.85 – 1.00        → `weak`     (displays C)
- Keep this mapping in ONE reviewed, exported constant in source (scripts or
  shared lib), documented with a comment pointing at this contract. Do not
  scatter thresholds.

Publication boundary:
- Export a label-only field (e.g. `quality_tier`) through the existing
  `scripts/export_public_catalog.py` process into the public augment payloads
  used by the frame component. Publish the label ONLY — extend
  `public-data-boundary.test.ts` to assert `win_rate` and any raw telemetry
  never appear in public output.
- The display/frame layer maps `god/strong/good/average/weak` to the S+/S/A/B/C
  form the `data-tier` frame expects, using the existing semantic tier colors
  (`--color-accent-god` … `--color-accent-weak`) at the already-corrected 1px
  solid width. Rarity remains a separate dimension.

Determinism and regression:
- Same internal snapshot in → byte-identical labels out; rerunning the export
  twice produces identical public files.
- Fixtures: at least one augment per tier, one tie case, one no-win_rate
  (neutral) case. Assert both the pipeline label decision and the rendered
  computed border color per tier.
- Completion report must include the tier distribution actually produced
  (count per tier out of the ranked set, currently expected ≈ 120 ranked of
  268) and the win-rate cut values at each band edge so the owner can retune
  the bands later by editing the single constant.
</authorized_tier_contract>

<ci_blocker_disposition>
GitHub Actions failing at runner start is an account billing issue only the
owner can resolve in GitHub settings; no repository change can fix it. Treat
local gates (`npm test`, eslint, build, boundary, completeness, fixture
idempotence, browser computed-style checks) plus Vercel as the acceptance
evidence, note "CI pending external billing fix" in the PR handoff, and close
out the goal rather than re-auditing. When billing is restored, re-run the
workflow once and attach the green run to PR #39.
</ci_blocker_disposition>
