# /goal — Unify all pages on the ability-card design language (Codex Luna Max)

Paste everything below this line into Codex (`/goal`) running in
`.worktrees/entity-presentation-followup` (branch `followup/entity-presentation`,
dev server already on `localhost:3000`).

---

<task>
Repo: wasfun.lol (Mayhem Oracle), Next.js 16 PWA, worktree `.worktrees/entity-presentation-followup`, branch `followup/entity-presentation`. Keep this branch's data layer exactly as is (entity catalog, routes, types, tests under `src/lib/entities/`, `src/lib/items/`); this goal changes presentation only.

Problem: the recent entity-presentation work styled several surfaces after Google Labs' DESIGN.md examples. The product owner rejects that aesthetic entirely. The rejected pattern ("stat tiles") looks like: a 1–2 column grid of rounded-xl tiles, each with a tiny muted micro-label on top and an oversized bold numeral below, uppercase tracking-widest section micro-headers, raw data-source keys rendered to users (`coefficient1`, `Effect2Amount`, `coefficients.coefficient1`), and six-entry slash-runs as body text ("100 sec / 90 sec / 80 sec / 80 sec / 80 sec / 80 sec"). Today this renders on champion, item, and augment detail pages via `src/components/entities/EntityStats.tsx`, and echoes of it exist on the landing dashboard and patch-notes surfaces.

Canonical design: the champion abilities section rendered inline by `src/app/[locale]/champions/[slug]/page.tsx` (the 技能 section — see `/zh-TW/champions/brand`). The owner approved this page as the reference for the whole product. Its language:

1. Section header: short bold title with a cyan left accent bar. Sentence case, no letter-spacing tricks.
2. Semantic tag pills: bordered rounded chips whose border/text color carries meaning (e.g. damage type blue, ranged teal), always with a text label.
3. Meter rows: segmented horizontal bars (cyan filled segments on dark track) with a muted text label beneath each meter.
4. Entity card rows: 14px-radius cards on `--color-bg-card`; icon left (rounded, with slot/kind label like PASSIVE/Q/W beneath); name as card heading; one inline stat line of label–value pairs where labels are muted and values are semantically colored (damage default-white, scaling ratio blue, cooldown muted gray, cost cyan, crowd-control yellow, range muted); small neutral chips for mechanic tags; description paragraph below in body text.
5. Human-first values: per-rank arrays collapsed to ranges ("8-6s", "70-190", "60-110"); every label localized; no raw field names anywhere.

End state: every user-facing page presents data in this ability-card language; the stat-tile pattern is gone from the codebase; the landing page is recomposed toward the owner's broadcast-dashboard prototype (composition described below).
</task>

<scope>
Convert these surfaces, in this order:

1. `champions/[slug]`: delete the `EntityStats` tile block. Fold its data into the canonical language: a compact base-stat strip in inline label–value form, and per-ability patch-change rows (label, buff/nerf word + sign glyph, before → after, patch chip) attached to the matching ability card. Current-stat values that duplicate what the ability stat line already shows should not render twice.
2. `items/[identifier]` and `augments/[slug]`: same conversion. Header card with icon, localized name, rarity/tier pill (text + color, never color alone), tag chips; stats as grouped inline label–value lines; patch history as compact change rows. Retire `EntityStats.tsx` once no page imports it.
3. Patch-notes surfaces (`PatchCard.tsx`, `PatchNotesView.tsx`, `PbePreview.tsx`): entity-led rows — changed entity + impact summary first, then details and source; buff/nerf shown with label plus sign/icon, never green/red alone; numbers tabular.
4. Landing page (`src/app/[locale]/page.tsx` + `HeroMover`, `MoversCarousel`, `TierMiniGrid`, `ComboHighlights`): recompose toward the owner's prototype — a 12-column broadcast-dashboard: a featured hero cell (~col-8) with one champion + recommendation, a side rail (~col-4), a movers row with delta-up/delta-down chips (sign + word + value), compact ring/segment gauges for pool health, prismatic augment and item shortlists as icon rows, a combos cell, a companion-launcher cell, a patch chip ("26.13 · date") in the header, and one primary CTA "Score my augments" in `accent-member` amber. Keep the Inter/CJK stack — do NOT add the prototype's display fonts (Anton, Permanent Marker, Sedgwick Ave); list font adoption as an open question instead.
5. Sweep the index pages (`champions`, `items`, `augments`, `tier-list`) and `advisor`, `companion`, `membership` for any tile-grid or uppercase-micro-label data presentation and align them.
</scope>

<forbidden>
- Do not consult, fetch, or pattern-match to Google Labs' DESIGN.md spec or its example pages in any form. If any existing code comment or doc points there for visual style, the champion abilities page overrides it.
- No stat-tile grids (micro-label over big numeral), no new `tracking-widest`/all-caps data labels, no raw source keys or `source_path` context strings in rendered UI, no six-entry slash-runs, no color-only semantics.
- The repo `DESIGN.md` constraint sections (tokens, accessibility, localization, provenance, entitlement boundaries, Riot rules) still bind; only its visual interpretation defers to the abilities page.
</forbidden>

<constraints>
- Presentation-only: no changes to scoring (`src/lib/scoring/` twins), the public-data boundary, `public/data/`, the update pipeline, or `overlay/`.
- Every new string in all five locale files (`en`, `zh-TW`, `zh-CN`, `ja`, `ko`); display names via `src/lib/i18n/localized-name.ts`; links via `@/i18n/navigation`.
- Colors only from `src/styles/globals.css` variables (mapping table in repo `DESIGN.md`); tabular numerals for all stats; WCAG 2.2 AA contrast; 44px touch targets on mobile.
</constraints>

<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going. Stop to ask only for decisions that change product boundaries: adding a font or dependency, moving data across the public/member boundary, or removing a feature a page currently exposes.
</default_follow_through_policy>

<completeness_contract>
Resolve the task fully before stopping: after converting the named surfaces, grep the rendered app for leftovers of the forbidden pattern and fix what you find. Do not stop at the champion page.
</completeness_contract>

<verification_loop>
Before finalizing:
- `npm test`, `npx eslint src scripts`, `npm run build` all pass (overlay untouched, skip its build).
- `curl` the rendered pages for `/zh-TW/champions/brand`, one item, one augment: assert no `coefficient`, `EffectAmount`, or other raw keys appear in the HTML.
- Screenshot landing, brand champion, one item, one augment at 375 / 768 / 1280 widths; check zh-TW and en both render without clipped labels.
- Confirm grayscale legibility of tier/rarity/buff/nerf cues (labels present without color).
If a check fails, fix and re-verify instead of reporting the first draft.
</verification_loop>

<structured_output_contract>
Report: (1) changed files grouped by surface; (2) before/after screenshots per surface; (3) test/lint/build results; (4) open product questions (display-font adoption, gauge data sources, anything cut); (5) any forbidden-pattern remnants you could not remove and why. Keep it compact, highest-impact first.
</structured_output_contract>
