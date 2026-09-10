# Monetization Readiness Review — wasfun.lol

Date: 2026-07-14
Reviewer: release audit (evidence-based; production + repository at `origin/main` 3f8d16e, patch 26.13)
Method: rendered production probes (curl against https://wasfun.lol), public data analysis, source inspection on main, CI run history, open PR inventory. In-flight work (PR #39) noted separately from deployed truth. No code changes were made during this review.

---

## A. Executive Verdict

**Is the website ready for promotion? No — but it is one merged PR and three fixes away, not a rewrite away.**
The deployed product is far more complete than the "broad infrastructure without a product" framing suggests: 172 champions with 100% field population, working champion/augment/item detail routes, five locales, patch labels, source disclosure, Riot disclaimer, JSON-LD, and a clean sitemap whose counts match the data exactly. What blocks promotion is a short list of trust-breakers: the newest champion (Locke) is missing from the roster entirely, unknown champion URLs (including `/champions/locke`) return HTTP 200 junk pages, six live augments are falsely labeled "removed" in production, and the data pipeline that keeps everything fresh is currently dead because GitHub Actions billing rejects all runners.

**Is it ready for advertising? No — but the hard parts are already built.**
ConsentManager is mounted in the root layout, AdSlot is consent-gated with reserved height (CLS-safe by design), and privacy/terms/contact pages exist and resolve. What's missing is measurable: there is **zero analytics** of any kind in the product, no `/about` page, AdSlot is only wired on patch-notes (not the high-intent champion/augment pages), and soft-404s would hurt an ad-network quality review.

**Is the overlay ready for paid subscriptions? No.**
Foundations are real — LCU integration code exists (`overlay/src-tauri/src/lcu.rs`, collector, sanitizer, upload queue), a Windows CI workflow builds an NSIS installer with artifact audits, and device auth is implemented per the overlay handoff. But `tauri.conf.json` has no updater configuration, no signing evidence, version is 0.1.0, failure states are partially granular at best, there is no automated multi-game lifecycle proof, and the installer pipeline cannot even run today (CI billing). Correctly, **nobody is being charged**: the membership page offers "Invite & trial access" via a mailto link, and no billing/checkout code exists.

**Three most important blockers:**
1. **GitHub Actions billing (external, user-fixable in minutes).** All 8 workflows fail at runner start. This kills daily data updates (staleness clock started 2026-07-12), freshness gates, SEO verification, the Windows installer artifact, and CI on every PR. Every other fix funnels through this.
2. **Roster and route truth in production.** Locke absent from `public/data/champions.json` (172 rows; checklist dated 2026-07-11 already flagged it); `/champions/<anything>` returns 200 with an error-state body in all locales; six live augments (`terraind`, `porcupine`, `surge-field`, `squishy-slappy-grab`, `its-go-time`, `from-downtown`) render as removed. A player who searches for the new champion or their favorite augment concludes the site is dead.
3. **No measurement layer.** Zero analytics means advertising cannot be valued, funnel claims cannot be verified, and the overlay CTA→signup→waitlist path the monetization plan depends on is invisible.

**Stop immediately:** LCU snowball crawling, model-candidate builds (`build-model-candidate.yml` is a standing workflow), Riot API/BigQuery discovery, decision-engine foundation work, API v1 shipping, pro-player roadmap work, and any further visual redesign beyond landing PR #39. Section K lists the branches.

---

## B. Current Product State

| Area | State | Evidence |
| --- | --- | --- |
| Website core | **Working.** 4,665-URL sitemap; per-locale counts match data exactly (173 champ / 269 aug / 476 item routes per locale). Champion pages render tier, WR, patch 26.13, updated stamp, source, disclaimers. | sitemap.xml probe; `/champions/aatrox` marker scan |
| Data | **Working but single-source and now frozen.** champions.json 172/172 on every core field; augments 268 (198 active); items 468; combos cover 159/172 champions. Source: arammayhem scrape, last run 2026-07-12. Pipeline currently cannot run (CI dead). | `public/data/*.json` analysis; `gh run list` all FAIL |
| SEO | **Mostly working.** robots.txt correct, sitemap clean, JSON-LD present, canonical locale routing works. Marred by champion soft-404s and the missing Locke page. | production probes |
| Advertising | **Foundations built, not enabled.** ConsentManager in `src/app/[locale]/layout.tsx`; AdSlot (consent-gated, fixed min-height) used only on patch-notes. Privacy/terms/contact live; `/about` 404s. | `src/components/ads/*`; route probes |
| Analytics | **Absent.** No gtag/plausible/umami/vercel-analytics/posthog anywhere in src or package.json. | grep sweep |
| Accounts | **Present.** Auth routes + entitlements lib (`src/lib/entitlements/{core,server,admin}.ts`); robots excludes /account /admin /auth. | source |
| Membership | **Honest and minimal.** "Invite & trial access" via mailto; no prices, no checkout, no Stripe code anywhere. No waitlist implementation (grep: zero hits). | membership page + messages/en.json |
| Overlay | **Foundations, not a product.** LCU/collector/sanitize/upload-queue Rust modules; OCR availability handling; member coach with disabled-reason states; calibration fallback tested. No updater config, no signing evidence, no lifecycle E2E. | `overlay/` inspection |
| Installer | **CI-built NSIS with artifact audits — currently unbuildable** (billing). PR #35 "Ship Windows overlay alpha path" still open. | `.github/workflows/windows-overlay.yml` |
| Entitlement | Implemented server-side (`requireActiveEntitlement`), enforced on member routes; overlay member snapshot has explicit disabled reasons. | source |
| In-flight | PR #39 (entity presentation system + lifecycle fix + cross-entity detection + tier frames) — draft, locally verified per handoff, blocked from CI by billing. PR #40 (design docs). PRs #35/#37 (overlay). | `gh pr list` |

---

## C. Critical Findings

### P0-1 — GitHub Actions billing halts every automated system
- **User impact:** data staleness (site promises patch-fresh data; last scrape 2026-07-12), no freshness alarms, no installer artifacts, no CI on PRs.
- **Monetization impact:** blocks every phase; ad review requires fresh content; overlay alpha requires installer builds.
- **Evidence:** `gh run list` — 8/8 recent runs FAIL across CI, Update PBE Preview, Windows Overlay, Ingest telemetry; Codex audit reports runners rejected before step 1 for billing.
- **Fix:** GitHub → Settings → Billing (account `jasonzoidclawd-rgb`): restore spending limit/payment. Then re-run `update-data.yml` and `windows-overlay.yml` once and attach green runs to PR #39.
- **Acceptance:** one green run of each workflow; fresh `data:` commit on main.

### P0-2 — Champion routes soft-404 (HTTP 200 error pages)
- **User impact:** searchers land on junk; crawlers index error pages; the missing-champion problem (P0-3) is invisible to monitoring.
- **Evidence:** `curl -w %{http_code}` → `/champions/nonexistent-xyz` = 200 (root and /zh-TW). Augments and items correctly 404. Source has `dynamicParams = false` + `notFound()` on both page families (`src/app/[locale]/champions/[slug]/page.tsx:71,90,142`), so production behavior diverges from source intent — likely a deployment/rewrite artifact that must be root-caused on Vercel, not in page code.
- **Fix:** root-cause why champions differ from augments in production; add a rendered-route CI check asserting unknown slugs return 404 for all three families.
- **Acceptance:** `curl -o /dev/null -w '%{http_code}' https://wasfun.lol/champions/zzz` → 404; same for /zh-TW.

### P0-3 — Locke missing from roster; his URL serves a 200 junk page
- **User impact:** the single highest-intent query a new-champion patch generates has no real answer on wasfun.lol; ARAMGG has one.
- **Evidence:** `public/data/champions.json` = 172 rows, no `locke`; production `/champions/locke` = 200 error-state page; `docs/plans/wasfun-vs-aramgg-overtake-checklist.md` (P0, dated 2026-07-11) already ordered this fix through the pipeline with null-stat support.
- **Fix:** exactly as the checklist specifies — roster gate derived from Data Dragon (CommunityDragon corroboration), Locke added via the normal pipeline with explicit unknown statistical fields, publication blocked when an active champion is missing.
- **Acceptance:** `/champions/locke` renders identity + explicit "no statistical data yet" state in all 5 locales and appears in the sitemap; CI gate fails on missing roster IDs.

### P0-4 — Six live augments render as "removed" in production
- **User impact:** users looking up live augments are told they don't exist in the current game; this is the exact "incomplete data coverage" that pushes users back to ARAMGG.
- **Evidence:** production `/zh-TW/augments/terraind` renders the removed-archive treatment; generated snapshot rows carry `flags.lifecycle: "removed"` + `availability.status: "unverified_legacy"`; the reconciliation fix exists in PR #39 (commit 80e86a4) but is unmerged.
- **Fix:** land PR #39's lifecycle reconciliation (with its regression fixtures for all six slugs) after review.
- **Acceptance:** all six routes render active state, appear in the active collection, absent from the removed archive, in all locales.

### P0-5 — Zero analytics
- **Evidence:** no analytics of any kind in `src/` or `package.json`.
- **Fix:** one lightweight, consent-gated provider (Vercel Analytics or Plausible) + exactly the eight launch events: `page_view`, `entity_search`, `champion_open`, `augment_open`, `overlay_cta_click`, `signup_start`, `signup_complete`, `ad_slot_viewable`. Wire `ad_slot_viewable` into the existing AdSlot. No custom platform.
- **Acceptance:** events visible in dashboard from production traffic; fired only post-consent.

### P1-1 — No sample counts or confidence states anywhere on rendered pages
Champion pages show win rate with no n= and no reliability state (`curl` marker scan: sample/games count absent). With a single scraped source (arammayhem, disclosed), honest presentation requires at least a source-level "based on arammayhem aggregate, patch 26.13" plus an explicit `insufficient/unavailable` state where a stat is absent. Currently a missing stat and a real stat are visually indistinguishable. Affects trust and ad-content quality. Fix inside the shared presentation contract (PR #39's `DataProvenance`-style row), not per page.

### P1-2 — Presentation contracts are per-page on deployed main
`DataProvenance` is used by exactly one family (augments index); champion pages hand-roll their provenance; `GradeBadge` appears only in advisor/matrix; item/augment/champion pages implement their own entity headers, icons, and stat lines. PR #39 introduces the shared system (`EntityLink`/`EntityIcon`/entity catalog + 300+ lines of tests) and is the vehicle — the finding is that **main must not receive further per-page UI patches**; everything routes through PR #39's contract after its visual corrections (1px frames, tier-color contract) are review-confirmed.

### P1-3 — 13 champions have no combo coverage
`combos.json`: 453 combos across 159/172 champions. On affected champion pages the combos section either hides or renders empty (verify per page). Requires an explicit "no verified combos this patch" state rather than silence.

### P1-4 — Overlay has no updater and no signing evidence
`tauri.conf.json`: version 0.1.0, `targets: "all"`, no updater block, no signing config. The NSIS workflow builds and audits artifacts but nothing ships updates or handles Windows SmartScreen reputation. Blocks any paid promise (a paying user stranded on a broken version with no update path is a refund).

### P2 — assorted
- `/about` 404s (ad-network and trust checklists expect it).
- Sitemap includes the 70 removed-augment archive pages — intentional archive content, but ensure they self-describe as historical (they do render an archive treatment) and are excluded from "active" structured data.
- Items sitemap family has 476 entries/locale vs 468 items + index (7 extra) — reconcile slug+ID duality in the sitemap generator.
- `champions with combos` / tier-list / advisor surfaces should consume the same tier vocabulary as the (now authorized) global augment tier contract to avoid a second divergence.
- No waitlist implementation despite it being the stated pre-Pro conversion mechanism.

---

## D. Page Consistency Matrix (deployed main)

| Responsibility | Home | Champions index | Champion detail | Augments index | Augment detail | Items | Patch notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Entity name/icon | own markup | own markup | own markup | own markup | own markup | own markup | own markup |
| Tier label | TierMiniGrid | ChampionMatrixClient (GradeBadge) | inline | n/a (no aug tier yet) | n/a | n/a | n/a |
| WR formatting | own | own | own | not shown (policy) | not shown | n/a | n/a |
| Patch label | yes | yes | yes (26.13) | yes | yes | yes | yes |
| Updated stamp | ? | ? | inline "Updated" | DataProvenance | inline | ? | inline |
| Source disclosure | footer | footer | inline (arammayhem) | DataProvenance | inline | footer | inline |
| Sample counts | — | — | — | — | — | — | — |
| CTA placement | hero + companion cell | — | overlay CTA present | — | — | — | — |
| Ad slot | — | — | — | — | — | — | AdSlot |

Reading: only patch labels and the Riot disclaimer are consistently delivered by shared machinery (layout/footer). Everything else is family-local. PR #39 replaces the name/icon/link row and stats presentation with one contract; provenance, sample states, and CTA placement still need to be pulled into it.

---

## E. Roster and Route Integrity Report

| Measure | Count | Status |
| --- | --- | --- |
| Riot active roster (patch 26.13) | 173 (172 + Locke) | ⚠ upstream truth to be encoded in gate |
| champions.json | 172 | ❌ missing Locke |
| Champion routes/sitemap (per locale) | 173 = 172 + index | ✓ internally consistent, externally short by one |
| augments.json | 268 (198 active / 70 removed) | ✓ counts consistent; 6 rows mislabeled removed (P0-4) |
| Augment routes/sitemap | 269/locale | ✓ |
| items.json | 468 | sitemap 476/locale → 7 extra to reconcile (P2) |
| Unknown champion slug | HTTP 200 | ❌ soft 404 (P0-2) |
| Unknown augment/item slug | HTTP 404 | ✓ |
| Legal routes | privacy/terms/contact 200; about 404 | ⚠ |

**Recommended CI gates (extend existing `freshness-check.yml` / `verify-live-seo.yml` once runners work):**
1. `dd_roster_count == champions.json count == generated champion routes == sitemap champion count` — fail publication on divergence (the checklist's `roster_coverage_ratio = 1.0`).
2. Rendered-route probe: 3 known slugs → 200 with entity h1; 1 unknown slug per family → 404. Run post-deploy.
3. Lifecycle gate: every `lifecycle: active` augment absent from removed archive and vice versa (PR #39 fixtures cover this).

---

## F. Data Completeness Report

| Dataset | Source | Completeness | Gaps / risks | Blocker? |
| --- | --- | --- | --- | --- |
| champions.json (172) | arammayhem scrape + DDragon/CDragon enrich | 100% on tier/WR/pick/rank/baseStats/icon | Locke missing; no sample counts in schema; single-source WR | P0-3 / P1-1 |
| augments.json (268) | CDragon kiwi_ stringtable + wiki + arammayhem WR (internal) | names/desc/rarity localized; lifecycle 198/70 | 6 lifecycle mislabels (P0-4); no public quality tier yet (contract authorized 2026-07-14, implementation in PR #39 orbit) | P0-4 |
| items.json (468) | CDragon/DDragon | route-complete | sitemap +7; Void-Immolation-class cross-entity changes now detected (PR #39 commit 109e7df, unmerged) | P1 |
| combos.json (453) | curated + scoring | 159/172 champions | 13 champions uncovered, no explicit empty state | P1-3 |
| meta.json | pipeline | patch 26.13, scraped 2026-07-12 | staleness clock running while CI is dead | P0-1 |
| internal win_rate (120/268 augments) | arammayhem bridge | 45% coverage | label-only tier export authorized; WR must never cross the public boundary (policy) | gate exists |

Fallback audit: augment detail page comments show the right instinct (`No try/catch: with dynamicParams=false a data read failure must fail the build`). The champion soft-404 shows the rendered layer can still betray that intent — hence gate 2 above. Cross-surface: web and overlay share scoring twins with a cross-parity suite at budget 0 (`src/lib/__tests__/cross-parity.test.ts`) — this is the strongest consistency asset in the repo; keep it as a release gate.

---

## G. ARAMGG Minimum-Parity Matrix

| Requirement | Status |
| --- | --- |
| Champion roster completeness | **partial** — 172/173 (Locke) |
| Champion route accessibility | **present but unreliable** — soft 404s |
| Augment roster + routes | **present but unreliable** — 6 false-removed |
| Champion statistics (tier/WR/pick) | **parity achieved** (sample counts missing → partial on trust) |
| Champion augment recommendations | **parity achieved** (pool + scoring rendered) |
| Champion item recommendations | **partial** — augment→item build-order remains an open product gap |
| Sample counts | **missing** |
| Patch labels / update timestamps | **parity achieved** |
| Data-source disclosure | **parity achieved** (arammayhem named) |
| Mobile layout | **partial** — PWA + tab bar exist; no systematic verification this review |
| Search | **parity achieved** (client cmd-k; no /search route needed) |
| Navigation / empty states / loading | **partial** — empty states inconsistent (combos) |
| SEO metadata / canonical / sitemap | **parity achieved** minus soft-404s |
| Page speed / CWV | **unverified** — measure before ads |
| Recommendation clarity | **partial** — explanations exist on advisor; entity pages thinner |

**Release gate for promotion:** all "unreliable" rows fixed, Locke live, sample/confidence state rendered, CWV measured ≥ "Good" on champion detail template.

---

## H. Advertising Readiness Checklist

- **Technically ready:** ConsentManager mounted; AdSlot consent-gated with reserved height (CLS-protected); five-locale copy machinery.
- **Legally ready:** privacy ✓ terms ✓ contact ✓ Riot non-affiliation ✓ (footer). Missing: `/about`; confirm privacy policy names the ad/analytics vendors before enabling.
- **Content-quality ready:** blocked by P0-2/3/4 (ad networks review page quality; error-state 200s and false "removed" content are exactly what fails review).
- **Performance ready:** unverified — run Lighthouse/CWV on champion detail + listing before and after first slot.
- **Analytics ready:** blocked — no analytics (P0-5); `ad_slot_viewable` has an obvious home in AdSlot.
- **Still blocked overall:** enable ads only after P0-1…P0-5 close and one week of clean analytics baselines. First placements: champion listing (after first content section), champion detail (between recommendations and patch context), augment detail (after main content) — the three families named in the brief, using the existing AdSlot component.

## I. Overlay Readiness Checklist

- **Installation:** NSIS installer built + audited in CI ✓ (workflow), currently unbuildable (billing) ❌; no signing evidence ❌; SmartScreen posture unknown ❌.
- **League detection:** LCU module + lockfile handling present ✓; missing-League UX unverified ⚠.
- **Game lifecycle:** no automated multi-game lifecycle test found ❌; reconnection/dodge/restart handling unverified ❌.
- **Rendering:** calibration with monitor fallback tested ✓; DPI/scaling matrix (100/125/150%, ultrawide, multi-monitor) unverified ❌; click-through in PR #37 (open) ⚠.
- **Recognition:** OCR availability states handled ✓; champion/augment recognition accuracy unmeasured ❌.
- **Recommendation data:** scoring parity suite ✓; patch-mismatch behavior between overlay bundle and backend unverified ⚠.
- **Auth/entitlement:** device auth + member snapshot with per-reason disabled states ✓.
- **Updates:** no updater config ❌ — hard blocker for paid.
- **Failure handling:** partial granularity (OCR, member, disconnect) ⚠; the 13-state matrix in the brief is not implemented ❌.
- **Supportability:** log location/support flow undefined ❌.

**"Ready for paid Pro" definition (measurable):** signed installer + working auto-update; 10 consecutive real games across ≥2 sessions without restart; recognition ≥95% on current-patch champions/augments; every state in the failure matrix renders a distinct, localized message; entitlement expiry mid-game degrades gracefully; support doc tells a user where logs live. Until all six hold, sell nothing.

---

## J. Monetization-Critical Execution Plan

**Phase 0 — Unfreeze the machinery (gate: green CI)**
Scope: fix GitHub billing (user); re-run update-data, freshness-check, verify-live-seo, windows-overlay; merge nothing yet. Out of scope: everything else.

**Phase 1 — Truth on production (gate: roster/route/lifecycle invariants green)**
Scope: review + land PR #39 (entity contract, lifecycle fix, cross-entity detection, corrected 1px frames); land the authorized augment-tier export; First Changeset below (Locke + roster gate + hard 404); add the three CI gates from §E. Files: PR #39's surface, `scripts/update-data.sh`, sitemap generator, `.github/workflows/`. Acceptance: §E table all ✓, six augments live, `/champions/locke` real in 5 locales, unknown slugs 404.

**Phase 2 — Measure, then monetize (gate: 7 days clean analytics + CWV Good)**
Scope: consent-gated analytics with the 8 events; `/about`; CWV pass on champion detail/listing; then enable AdSlot on the three page families. Out of scope: any new analytics platform, interstitials, additional placements.

**Phase 3 — Overlay to alpha (gate: the six "ready for paid" criteria measured, even if not yet met)**
Scope: tauri updater + signing decision; failure-state matrix; lifecycle E2E script against a real client; DPI matrix manual test doc; land PRs #35/#37 or close them. Website side: implement the waitlist (it's promised by the plan and doesn't exist). Out of scope: Mac, new recognition models.

**Phase 4 — Pro launch (gate: paid promise = shipped behavior)**
Scope: Stripe (or chosen processor) checkout, entitlement lifecycle incl. expiry/refund states, pricing page limited to: no ads, real-time overlay, full explanations, preferences, faster updates. Out of scope: annual plans, teams, API access tiers.

## K. Stop-Doing List

Freeze (leave branches, stop investing): `origin/codex/lcu-collector`, `origin/codex/model-overlay`, `origin/codex/decision-engine-foundation`, `origin/codex/riot-api-bigquery-discovery`, `origin/codex/repo-context-overlay-riot-roadmap`, `origin/ship/api-v1`, `origin/claude/native-ocr` (until Phase 3 needs it), `build-model-candidate.yml` (disable the schedule), pro-player registry ideas, new data-source research (`docs/research/` continues as archive only), further landing-page redesign iterations beyond PR #39 completion. Delete-or-merge within 2 weeks: `claude/mobile-dashboard`, `claude/champions-duplicate-cleanup`, `improve/transparency-freshness-clutter` (fold its intent into Phase 1's provenance work).

## L. First Changeset Recommendation

- **Branch:** `fix/roster-truth-and-hard-404`
- **PR title:** `fix: champion roster gate, Locke ingestion, hard 404 for unknown champion slugs`
- **Changes:** (1) roster gate script comparing Data Dragon active roster to champions.json with CI hook in `update-data.yml` (fail publication on divergence, per checklist metrics); (2) run the normal pipeline to ingest Locke with explicit-null stats and an `unavailable` stat state rendered on his page; (3) root-cause and fix the production champion soft-404 (deployment/rewrite layer — source already declares `dynamicParams=false`); (4) post-deploy probe added to `verify-live-seo.yml` asserting 404 on unknown slugs across the three families.
- **Files:** `scripts/update-data.sh`, new `scripts/check_roster_coverage.py` + tests, `src/app/[locale]/champions/[slug]/page.tsx` (only if root cause lands there), `.github/workflows/update-data.yml`, `.github/workflows/verify-live-seo.yml`, regenerated `public/data/` via pipeline.
- **Acceptance:** `/champions/locke` 200 with real identity content + explicit no-stats state (5 locales, in sitemap); `/champions/zzz` 404; CI gate red when a roster ID is missing; `npm test`, `npx eslint src scripts`, `npm run build` green.
- **Verify:** `python3 scripts/check_roster_coverage.py`, `npm test`, curl probes above.
- **Risks:** pipeline run depends on Phase 0 billing fix (can run locally first); Locke's null-stat rendering exercises the new explicit-state path — write the red test first.
- **Exclusions:** no visual redesign, no PR #39 rebase inside this changeset, no new data sources, no sample-count schema work (Phase 1 follow-up).

---

**Bottom line:** the smallest sequence from here is: *restore CI billing → land PR #39 → ship `fix/roster-truth-and-hard-404` → add analytics + /about → enable three ad slots on champion/augment families → then, and only then, spend the 30% on making the overlay updatable, signed, and lifecycle-proven before asking anyone for money.* The repository does not need another engine. It needs the last 5% of truthfulness, one merge, and a payment of a GitHub bill.
