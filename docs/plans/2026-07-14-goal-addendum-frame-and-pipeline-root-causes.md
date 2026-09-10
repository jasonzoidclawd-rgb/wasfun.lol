# Addendum — confirmed root causes for the frame + pipeline correction

Paste this block at the top of the corrective `/goal` (icon frames + Void
Immolation) before sending it to Codex. It replaces the "diagnose before
editing" guesswork with verified facts, and it resolves the one contradiction
that would have made the augment half of the goal impossible.

---

<confirmed_root_causes>
Do not re-derive these; verify them quickly and proceed.

Defect A — augment surfaces show no tier color (three stacked causes):

1. No augment surface passes `tier`. Every augment call site passes only
   `rarity`, so `EntityIcon` renders `data-tier="neutral"`:
   - `src/components/augments/AugmentsClient.tsx:505`
   - `src/app/[locale]/augments/[slug]/page.tsx:269` and `:355`
   - `src/components/dashboard/AugmentSpotlight.tsx:55`
   - `src/components/patch-notes/PatchNotesView.tsx:280`
2. There is no augment quality-tier value anywhere in the data model.
   `public/data/augments.json` (268 rows) and
   `public/data/entity-presentation.json` (255 augment records) contain no
   tier/grade field. The only quality signals in the repo are the
   policy-gated `win_rate` in `data/internal/augments.json` and the
   per-champion `DecisionGrade` in the member advisor. The previous run
   plumbed the attribute and stopped, because there was nothing to feed it.
3. The CSS mechanism itself works — champions prove it (see Defect B).

Defect B — champion and landing borders too thick (two stacked causes):

1. `src/styles/globals.css:142-147` encodes tier as border WIDTH:
   `S+` = 3px, `S` = 2px, `A` = 2px dashed, `B` = dotted. On a 28px icon a
   3px border reads as heavy chrome. These unlayered attribute selectors
   beat the Tailwind utility layer, which is why the neutral
   `border-[var(--color-border-default)]` class loses.
2. Champion ranking tier leaks into the frame path. `EntityLink` forwards
   `tier` straight into the icon frame at these call sites:
   - `src/components/dashboard/HeroMover.tsx:51`
   - `src/components/dashboard/TierMiniGrid.tsx:47`
   - `src/components/champions/ChampionsIndex.tsx:391`, `:466`, `:543`
   - `src/app/[locale]/champions/[slug]/page.tsx:530` and `:555` — these two
     hardcode `tier="S"` / `tier="C"` merely to colorize matchup lists.
   The contract is the inverse: champion icons stay neutral; only augment
   quality tier may color a frame.

Defect C — Void Immolation (premise verified):

- Item `223069` ("Void Immolation") in `public/data/items.json` contains the
  new Desolate passive; the quest augment `ARAM_Quest_VoidImmolation` row
  does not carry the structural change.
- `scripts/scrape_mayhem_augments_cdragon.py:838` restricts detected diffs to
  the augment-row fields `("rarity", "tooltip", "name")`, so a passive added
  to the reward item is structurally invisible. "No augment changes since
  last snapshot" was a correct answer to the wrong question.
</confirmed_root_causes>

<tier_source_decision>
The corrective goal as previously written was unsatisfiable for augments: it
demanded visible tier borders while forbidding both derivation from rarity or
Oracle score and any new public field without owner approval — and no tier
field exists. The owner now resolves this:

- Derive a global augment quality tier label (S+, S, A, B, C) from the
  internal `win_rate` in `data/internal/augments.json` using explicit,
  documented thresholds kept in one reviewed constant (source-owned, not
  hand-edited output).
- Export it as a label-only public field through the existing
  `scripts/export_public_catalog.py` boundary process, extending
  `public-data-boundary.test.ts` to assert that `win_rate` itself and any
  raw telemetry never cross into public output. Labels are public by
  product direction; win rates remain member/internal.
- Augments with no win-rate evidence get no tier field and therefore the
  neutral frame. Never infer tier from rarity, lifecycle, or route.
- Surface the thresholds in the completion report so the owner can retune.
</tier_source_decision>

<frame_contract_amendments>
- Flatten `globals.css` tier rules: every tier renders exactly 1px solid,
  color-only differences; delete the 3px/2px/dashed/dotted width-and-style
  ladder. Grayscale accessibility comes from `aria-label`/tooltip text and
  the existing rarity tag, not border weight.
- Scope the selectors to the icon component (e.g.
  `[data-entity-icon][data-tier="..."]` or a class) so a bare `data-tier`
  attribute elsewhere in the app can never grow a border.
- Add `data-entity-type` to `EntityIcon` so computed-style tests can select
  augment icons precisely.
- Make the frame states explicit in the component API (neutral | augment
  quality tier | unknown), and stop `EntityLink` from forwarding champion
  tier into the frame path at all — remove the `tier` prop from the champion
  call sites listed above rather than styling around them.
</frame_contract_amendments>
