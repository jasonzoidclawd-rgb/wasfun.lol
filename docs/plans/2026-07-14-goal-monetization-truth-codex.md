# /goal — Monetization truth pass (Codex 5.6 Luna xhigh, fresh session)

Paste everything below the divider into a NEW Codex session (`/goal`), model
Luna, reasoning xhigh, launched from `/Users/jason/Desktop/mayhem-oracle`.
This goal is fully self-contained: it assumes no prior session context. A
separate Codex session owns PR #39 (`followup/entity-presentation`,
`.worktrees/entity-presentation-followup`, port 3000) — this goal must not
disturb it in any way.

---

<task>
Repo: wasfun.lol (Mayhem Oracle) at `/Users/jason/Desktop/mayhem-oracle`.
Next.js 16 App Router, TypeScript, Tailwind v4, next-intl (locales en, zh-TW,
zh-CN, ja, ko — en is served unprefixed at the root), generated JSON under
`public/data/` (NEVER hand-edited; regenerate via scripts), Vercel
deploy-on-push, daily data pipeline via GitHub Actions.

A 2026-07-14 release audit (docs/reviews/2026-07-14-monetization-readiness-review.md
on branch `claude/design-md-patch`, PR #40 — read it if present, but this goal
restates everything you need) found the site is close to promotable except for
a short list of trust-breakers that are independent of the in-flight
presentation work. Your job is to fix exactly that independent slice:

1. Champion roster truth: champion "Locke" is missing. `public/data/champions.json`
   has 172 rows; the current-patch active roster has 173. Production
   `https://wasfun.lol/champions/locke` returns HTTP 200 with an error-state
   body. There is no CI gate that catches a missing active champion.
2. Champion soft-404s: `https://wasfun.lol/champions/<unknown>` returns HTTP
   200 (root and locale-prefixed), while `/augments/<unknown>` and
   `/items/<unknown>` correctly return 404. Both champion and augment slug
   pages declare `export const dynamicParams = false` and call `notFound()`
   (`src/app/[locale]/champions/[slug]/page.tsx:71,90,142`), so production
   behavior diverges from source intent — the cause is likely at the
   build/deployment/rewrite layer, not page logic.
3. Zero analytics: no analytics provider or events exist anywhere in `src/`
   or `package.json`. Advertising cannot be valued and the overlay funnel
   cannot be measured without them. Consent infrastructure ALREADY EXISTS:
   `src/components/ads/ConsentManager.tsx` is mounted in
   `src/app/[locale]/layout.tsx`, and `src/components/ads/AdSlot.tsx` is
   consent-gated with reserved height.
4. `/about` returns 404. Privacy, terms, and contact pages exist and resolve.

End state: a single draft PR (separate from #39) that makes the champion
roster provably complete with a publication gate, makes unknown champion
slugs return real HTTP 404s, adds a minimal consent-gated analytics layer
with exactly eight events, and adds the About page in all five locales.
</task>

<no_touch_contract>
Another live Codex session owns PR #39. Hard rules:

- Do NOT enter, build in, or modify `.worktrees/entity-presentation-followup`.
- Do NOT check out, rebase, merge, or push `followup/entity-presentation`.
- Do NOT kill or restart anything on port 3000. Use port 3001 for any local
  server you need (`npm run start -- --port 3001`).
- Create your own worktree from origin/main:
  `git worktree add .worktrees/monetization-truth -b fix/roster-truth-and-hard-404 origin/main`
  and do all work there.
- Before editing ANY file, compute the PR #39 overlap set once:
  `git fetch origin && git diff --name-only origin/main...origin/followup/entity-presentation > /tmp/pr39-files.txt`
  Files in that list are collision-prone. Policy per file you need to change:
  - not in the list → edit freely;
  - in the list and your change is small and additive (e.g. rendering an
    explicit "no stats yet" state in `src/app/[locale]/champions/[slug]/page.tsx`)
    → make the minimal edit and flag it in the completion report as a rebase
    point for PR #39;
  - in the list and your change would be structural → stop that sub-task and
    report the collision instead of restructuring.
- Do not modify `src/components/entities/*`, `src/components/augments/*`,
  `src/components/patch-notes/*`, dashboard components, or the tier-frame CSS
  in `src/styles/globals.css` — that is PR #39's surface. The six
  wrongly-"removed" augments and augment tier frames are PR #39's job, not
  yours, even though the audit mentions them.
</no_touch_contract>

<environment_facts>
- GitHub Actions is currently DOWN for this account (billing rejects all
  runners before step 1). Do not wait for CI. Run every gate locally, note
  "CI pending external billing fix" in the PR body, and do not treat red
  cloud checks as your failure.
- `public/data/` is generated. The pipeline is `npm run update-data`
  (snapshot curated fields → scrape arammayhem + CDragon + DDragon + wiki →
  restore → classify → validation gate → pool rules). It runs locally and
  needs network access. Never hand-edit generated output; fix the generator.
- Data-boundary policy: raw augment win rates must never appear in public
  output. Champion tier/win_rate/pick_rate are already public. Do not add
  any new public field beyond what this goal specifies (Locke's roster row
  uses the existing champion schema; statistical fields may be explicitly
  null with a rendered "unavailable" state — silent zeros are forbidden).
- Every user-facing string ships in all five `messages/*.json` files (key
  parity is test-enforced). Locale-internal links use `@/i18n/navigation`,
  not `next/link`.
- Verification gates: `npm test`, `npx eslint src scripts`, `npm run build`,
  `git diff --check`, plus `PYTHONPATH=scripts python3 -m unittest discover
  -s scripts -p 'test_*.py'` when you touch scripts.
- An existing plan file `docs/plans/wasfun-vs-aramgg-overtake-checklist.md`
  (untracked, may exist in the main checkout) specifies the roster-gate
  metrics: `roster_coverage_ratio = 1.0`, `missing_active_champion_count = 0`,
  and a separate `statistical_coverage_ratio` that must NOT block a valid
  roster record when a third-party stat source lacks it.
</environment_facts>

<workstreams>
Execute in order. Each workstream gets its own commit(s), a red test before
the fix, and its own verification. Do not start the next workstream until the
current one is green locally.

## WS1 — Roster gate + Locke ingestion

1. Red test first: a fixture-driven test (under `scripts/`, following the
   existing `test_*.py` conventions) that fails when an active champion in
   the Riot Data Dragon roster for the current patch is missing from the
   normalized champion output. Use Data Dragon as the authority and
   CommunityDragon as corroboration. It must fail TODAY because Locke is
   missing.
2. Implement `scripts/check_roster_coverage.py` (or extend the existing
   freshness/validation stage if that is cleaner): compares upstream active
   roster IDs against `public/data/champions.json`, reports
   `roster_coverage_ratio`, `missing_active_champion_count`, duplicate IDs,
   and alias collisions. Non-zero missing count = non-zero exit. Wire it into
   `scripts/update-data.sh` so publication fails on divergence, and into
   `.github/workflows/update-data.yml` (check `/tmp/pr39-files.txt` first;
   if PR #39 touches that workflow, add a separate step file/script call
   rather than restructuring it).
3. Ingest Locke through the NORMAL pipeline (`npm run update-data` locally).
   If the statistical source (arammayhem) does not yet cover Locke, his row
   ships with explicitly null statistical fields — never fabricated zeros,
   never another champion's data. The champion detail page must render an
   explicit localized "statistics not yet available for this patch" state
   for null stats (this is the one permitted minimal edit inside a PR #39
   file if it collides — flag it).
4. Regenerate outputs via the pipeline; verify `/champions/locke` renders
   identity (name in all five locales, icon, base info) locally on port 3001
   and appears in the generated sitemap exactly once per locale.

## WS2 — Hard 404 for unknown champion slugs

1. Reproduce locally: `npm run build`, start on port 3001, then
   `curl -o /dev/null -w '%{http_code}' http://localhost:3001/champions/zzz-not-real`
   and the `/zh-TW/...` variant, plus the same for augments and items.
2. If local already returns 404 (source intent says it should): the
   production divergence is at the deployment layer. Inspect `next.config.*`,
   `vercel.json`, middleware/i18n routing config, and any rewrite/fallback
   settings for a rule that swallows champion 404s but not augment 404s.
   Fix the config cause if it is in-repo. If the cause is a stale Vercel
   deployment or dashboard-side setting, document the exact finding and the
   redeploy/settings step in the PR body instead of guessing at code.
3. If local returns 200: fix the route so unknown slugs hard-404 (keep
   `dynamicParams = false`; find what bypasses it), with a failing test
   first.
4. Add an automated post-deploy probe to `.github/workflows/verify-live-seo.yml`
   (same PR #39 overlap rule): for each of the three entity families, assert
   one known slug returns 200 with the entity name in the body, and one
   unknown slug returns HTTP 404. Also assert `/champions/locke` returns 200
   after WS1 deploys.

## WS3 — Minimal consent-gated analytics (exactly eight events)

1. Pick ONE lightweight provider. Preference order: `@vercel/analytics`
   custom events if the account plan supports them; otherwise Plausible
   with a self-descriptive script include. Hard constraints: loads and fires
   ONLY after the existing ConsentManager grants consent (never on first
   paint), no PII, no session recording, no new analytics platform of our
   own, bundle impact minimal. Record the choice and why in the PR body.
2. Implement exactly these events and no others:
   `page_view`, `entity_search`, `champion_open`, `augment_open`,
   `overlay_cta_click`, `signup_start`, `signup_complete`, `ad_slot_viewable`.
   - `page_view`: route-level, on navigation.
   - `champion_open` / `augment_open`: detail-page views with the slug as the
     only property.
   - `entity_search`: fired on search interaction (the cmd-k style client
     search) with result-count, NOT the raw query text if it could contain
     PII — truncate/omit accordingly.
   - `overlay_cta_click`: any overlay/companion CTA click.
   - `signup_start` / `signup_complete`: hook the existing auth flow
     boundaries; if the flow lacks a clean completion hook, instrument what
     exists and note the gap rather than refactoring auth.
   - `ad_slot_viewable`: inside the existing `src/components/ads/AdSlot.tsx`
     via IntersectionObserver at ≥50% visibility for ≥1s. Check
     `/tmp/pr39-files.txt` before editing; AdSlot is expected to be outside
     PR #39's diff.
3. Events are a thin wrapper module (e.g. `src/lib/analytics.ts`) so the
   provider can be swapped; components import the wrapper, never the
   provider directly. Unit-test the wrapper's consent gating (no consent →
   no calls).
4. Do NOT add ad placements, interstitials, or new slots in this goal.
   `ad_slot_viewable` instruments the slot component; enabling slots on
   champion/augment pages is a later, separate decision.

## WS4 — About page

1. Add `/about` under `src/app/[locale]/about/page.tsx` following the
   structure and styling of the existing privacy/terms/contact pages (read
   one of them first and match its conventions exactly).
2. Content: what Mayhem Oracle is, the data sources and update cadence
   (arammayhem, CommunityDragon, Data Dragon, wiki), the Riot Games
   non-affiliation disclaimer (reuse the existing disclaimer copy/component),
   and a contact pointer. All copy in all five `messages/*.json`.
3. Add it to the sitemap and footer navigation where privacy/terms/contact
   already appear.
</workstreams>

<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going. Stop
and report (rather than guess) only for: a PR #39 structural collision, a
data-boundary question (new public field beyond spec), evidence that Locke
should NOT be in the active roster, or a Vercel dashboard-side fix you
cannot make from the repository.
</default_follow_through_policy>

<verification_loop>
Before finalizing, all of the following locally in your worktree:
- `npm test` (including your new tests), `npx eslint src scripts`,
  `npm run build`, `git diff --check`,
  `PYTHONPATH=scripts python3 -m unittest discover -s scripts -p 'test_*.py'`.
- `python3 scripts/check_roster_coverage.py` exits 0 with
  `missing_active_champion_count = 0`.
- Port 3001 rendered checks: `/champions/locke` (en + zh-TW) shows identity
  plus the explicit no-stats state; `/champions/zzz-not-real` → 404;
  `/augments/zzz` → 404; `/items/9999999` → 404; `/about` → 200 in en and
  zh-TW; consent-then-events verified in the browser console/network tab
  (no analytics requests before consent).
- Confirm `git -C .worktrees/entity-presentation-followup status` was never
  touched by you and port 3000 still belongs to the other session.
If a check fails, fix and re-verify; do not report a first draft.
</verification_loop>

<shipping>
- Branch `fix/roster-truth-and-hard-404` from origin/main in your own
  worktree (created above).
- One commit per workstream, conventional messages:
  1. `fix: enforce active-roster coverage gate and ingest Locke`
  2. `fix: hard 404 for unknown champion slugs + live route probes`
  3. `feat: consent-gated analytics with eight launch events`
  4. `feat: add localized About page`
- Push and open ONE draft PR titled
  `fix: roster truth, hard 404s, analytics baseline, About page`.
  Body: root causes found, PR #39 overlap files touched (if any) flagged as
  rebase points, provider choice rationale, local gate results, and
  "CI pending external billing fix".
- Do not merge. Do not touch PR #39, #40, #37, or #35.
</shipping>

<structured_output_contract>
Final report, most important first:
1. Roster gate: upstream count vs local count before/after; Locke row
   summary (which fields are real vs explicitly null).
2. Soft-404 root cause: exact mechanism (repo config vs deployment layer),
   with file/line or dashboard setting.
3. Analytics: provider chosen and why; the eight events with trigger
   locations; proof of consent gating.
4. PR #39 overlap files touched (should be zero or one) and why.
5. Local verification results for every gate above.
6. Anything stopped per the follow-through policy, with evidence.
Keep it compact; no scene-setting.
</structured_output_contract>
