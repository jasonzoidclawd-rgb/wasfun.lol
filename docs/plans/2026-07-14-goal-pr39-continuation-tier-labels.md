# PR #39 continuation — real tier labels + rebase onto merged main

Paste everything below the divider into the Codex session that owns PR #39
(`followup/entity-presentation`, worktree `.worktrees/entity-presentation-followup`),
or a fresh session continuing that branch. It supplies the owner-approved tier
contract the previous audits were missing, corrects one over-strict gate in the
already-built derivation, and specifies the rebase now required because PR #42
merged to main.

---

<context_delta>
Since your last audit, two things changed:

1. PR #42 merged to main (merge commit `aa86f54`). Main now contains: champion
   Locke (real identity/base stats, explicitly null `tier`/`rank`/`win_rate`/
   `pick_rate`), a roster coverage gate (`scripts/check_roster_coverage.py`,
   wired as step 20 of `scripts/update-data.sh` with steps 7/8 reordered so
   Data Dragon runs before CommunityDragon), null-stat guards in
   `src/app/[locale]/champions/[slug]/page.tsx` and `src/app/[locale]/page.tsx`,
   a live entity-route probe in `verify-live-seo.yml`, a consent-gated
   analytics wrapper (`src/lib/analytics.ts`), and localized About pages.
2. Your branch is now CONFLICTING with main: the five generated PBE data files
   (`data/internal/cdragon-{augment,champion,item}-pbe.json`,
   `data/internal/pbe-preview.json`, `public/data/pbe-preview.json`) diverged
   on main after your base, plus the PR #42 files above.

Your blocker "no approved global augment tier source" is resolved below. Do
not re-audit it; the owner authorization follows.
</context_delta>

<authorized_tier_contract>
The product owner authorizes the following global augment quality-tier
contract. It intentionally reuses two existing approved structures — the
champion `Tier` display vocabulary and the advisor `GRADE_BANDS` percentile
boundaries — so no new product semantics are invented.

Source and scope:
- Input: `win_rate` for the current patch from the internal augment win-rate
  data (internal-only, never published). Augments without a numeric current-
  patch `win_rate` receive NO tier and render the neutral frame. Do not
  backfill from rarity, Oracle score, lifecycle, or advisor grades.
- Keeping your existing active/current-patch eligibility filter is approved:
  removed or non-current augments stay neutral even if they have historical
  win rates.

Ranking and banding:
- Rank all eligible augments by `win_rate` descending; break ties by slug
  ascending so output is deterministic.
- Percentile = rank position / ranked count, in [0, 1).
- Map percentile through the existing `GRADE_BANDS` boundaries
  (`src/lib/decision/grade.ts`) onto S+/S/A/B/C:
  - percentile < 0.10  → S+
  - 0.10 – 0.30        → S
  - 0.30 – 0.60        → A
  - 0.60 – 0.85        → B
  - 0.85 – 1.00        → C
- Keep the thresholds in ONE reviewed, exported constant, documented with a
  comment pointing at this contract. Do not scatter them.

Publication boundary (already matches what you built):
- `quality_tier` is exported label-only through `export_public_catalog.py`;
  `public-data-boundary.test.ts` keeps asserting `win_rate` and raw telemetry
  never cross into public output. Frames render the labels at the corrected
  1px solid color-only widths.
</authorized_tier_contract>

<gate_correction>
Your `scripts/augment_quality_tier.py` requires a minimum sample count
(`minimumGames: 1000`). The owner verified against your branch head: the
arammayhem feed carries NO per-augment sample counts, so ALL 120 augments
with a numeric win_rate are rejected as `missing-or-invalid-sample-count`
and the derivation summary is
`eligibleAugments: 0, tiers: {S+:0, S:0, A:0, B:0, C:0}` — the feature
silently no-ops and every augment still renders a neutral border, which was
the original complaint.

Correction, owner-approved: REMOVE the sample-count eligibility requirement
entirely. Eligibility = numeric current-patch win_rate + your existing
active/current filter, nothing else. Do not invent sample counts and do not
keep the gate at a lower value; if the feed ever grows a real games field, a
future contract can reintroduce it. Update fixtures/tests that encoded the
sample-count requirement. Expected outcome ≈120 ranked augments (report the
exact count).

Guard against this failure mode recurring: add an assertion (test or export-
time check) that fails loudly when the ranked count is 0 while the internal
feed contains ≥1 numeric win_rate — a silent all-neutral export must never
pass gates again.
</gate_correction>

<rebase_instructions>
Rebase `followup/entity-presentation` onto current main (`aa86f54`) BEFORE
re-deriving tiers, so the export runs against merged reality.

- Generated data conflicts (the five PBE files, `entity-presentation.json`,
  `patch-notes.json`, and any other `public/data/` or `data/internal/`
  collisions): never hand-merge. Take main's version, then re-run the owning
  projection/export scripts from your branch to regenerate them.
- `src/app/[locale]/champions/[slug]/page.tsx`: keep BOTH sides — main's
  `championStatisticsAvailable` null-stat guards and unavailable-state render
  AND your entity-presentation changes.
- `src/app/[locale]/page.tsx`: keep main's null-stat filter plus your changes.
- `scripts/update-data.sh`: keep main's step reordering (Data Dragon before
  CommunityDragon) and its step-20 roster gate, then re-apply your stage
  changes around them.
- `messages/*.json`: union of both sides' keys (parity tests enforce this).
- Push with `--force-with-lease` to your own branch only. Never push main.
</rebase_instructions>

<verification_loop>
After rebase + gate correction + re-export, all locally (CI remains billing-
blocked; local gates are the acceptance evidence — note that in the PR):
- `npm test`, `npx eslint src scripts`, `npm run build`, `git diff --check`,
  `PYTHONPATH=scripts python3 -m unittest discover -s scripts -p 'test_*.py'`.
- Cross-parity suite still at budget 0.
- Derivation summary shows ranked count ≈120 and a non-degenerate tier
  distribution; public `entity-presentation.json` and augment payloads carry
  the labels; `public-data-boundary.test.ts` still proves win_rate never
  leaks.
- Rendered check: augment index/detail/dashboard icons show colored 1px
  frames for labeled augments and neutral for unlabeled; champion and item
  frames stay neutral.
</verification_loop>

<structured_output_contract>
Update the PR #39 body and report, most important first:
1. Tier distribution actually produced (count per band out of the ranked
   set) and the win-rate cut values at each band edge, so the owner can
   retune the single constant later.
2. Confirmation the zero-ranked loud-failure guard exists and what it checks.
3. Rebase resolution summary: which files were regenerated vs merged.
4. Local gate results.
Do not re-declare the tier-source blocker; it is resolved by this contract.
</structured_output_contract>
