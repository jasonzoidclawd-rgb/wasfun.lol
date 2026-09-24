# Monetization Readiness & Product Completeness Review — 2026-07-14

Reviewed from a clean worktree at `origin/main` = `aa86f54` (merge of PR #42).
Every claim below is tagged **[verified]** (reproduced in this review by
command, probe, or file read), **[source-read]** (established by reading code/
docs but not executed), or **[unverifiable-here]** (evidence not obtainable in
this environment — reason given). Production probes hit `https://wasfun.lol`
on 2026-07-14 (UTC+8 evening). Local verification used a production-equivalent
build (`NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` set to dummy values, which
reproduces production route classification exactly — confirmed by matching
live response headers).

---

## A. Executive verdict

**Is the website ready for promotion?** No — but it is close. Three concrete
defects stand between the current site and a promotable one: (1) six live
augments are publicly displayed as "Removed in patch 26.13" (verified on
`/augments/terraind`), (2) unknown champion URLs return HTTP 200 with a
generic fallback page (soft-404; the fix exists as draft PR #43 and is
merge-ready), and (3) the daily data pipeline is dead because GitHub Actions
billing rejects every runner, so the "daily updated" promise degrades by one
patch-day at a time (data last scraped 2026-07-12 [verified via
`public/data/meta.json`]). None of these requires new features.

**Is it ready for advertising?** No. The technical and legal foundations are
genuinely in place (consent manager, reserved ad slots, all five legal/info
pages live, 8 analytics events wired), but: analytics events currently go
nowhere (no Plausible account is registered for the domain), the most
valuable ad inventory — 865 champion detail pages — is served as uncached
per-request dynamic renders (`no-store`, Vercel MISS on every hit), and ads
on pages showing false data ("Removed" on live augments) would burn trust.
Ad launch is a Phase 2 event after the three P0s above are fixed.

**Is the overlay ready for paid subscriptions?** No, and it is not close. No
installer has ever been released (zero GitHub releases [verified]), the
bundle is unsigned with no updater configured [verified in
`overlay/src-tauri/tauri.conf.json`], member auth from the overlay is blocked
on an unimplemented device-token flow [source-read], and the Windows build
workflow cannot run because CI is down. The overlay has a strong working
foundation (LCU credential discovery, gameflow normalization, OCR, collector,
sanitization — all present in source), but a foundation is not a purchasable
product. Do not charge anyone yet; collect interest instead.

**Three largest blockers:**
1. **GitHub Actions billing** — kills the daily data pipeline, all CI gates,
   and the Windows installer build. Only the account owner can fix it
   (GitHub → Settings → Billing). Everything else in this plan degrades or
   stays unverifiable while this is down.
2. **Publicly false augment lifecycle data** — six live augments labeled
   removed on their own detail pages and in patch surfaces. The fix is
   stranded inside the large, conflicted PR #39; it must be extracted and
   shipped alone.
3. **Champion detail pages are dynamically rendered and uncacheable** — all
   865 champion URLs (the core SEO/ad surface) render per-request because the
   member entitlement gate reads `cookies()` during server render. This
   blocks CDN caching, degrades TTFB/Core Web Vitals, and makes champion
   pages the slowest and most expensive pages on the site.

**Stop immediately:** all PR #39 tier-label/entity-presentation continuation
work, collector/model/calibration expansion, riot-api/bigquery discovery,
pro-player tracking, new page families, and Mac overlay work. See §M.

---

## B. Verified current state

**Website / routes.** 173 champions, 268 augments, 468 items in public data
[verified]. Sitemap totals 4,675 URLs: 865 champion + 1,340 augment + 2,375
item + 95 static, internally consistent at 5 locales [verified]. All legal/
info pages live: `/privacy`, `/terms`, `/contact`, `/about` all HTTP 200
[verified]. `robots.txt` sane (disallows `/account`, `/admin`, `/api/`,
`/auth/`) [verified]. 22-champion route sample (common, odd-slug, Locke) all
200 in root and zh-TW forms [verified] — but note a 200 currently proves
nothing for champions (soft-404, §C-P0-2). zh-TW pages are fully localized
including titles (`阿璃 ARAM 大亂鬥指南 — B 階`) [verified].

**Data.** Champions: 172/173 rows have tier/win_rate/pick_rate/rank; Locke is
explicitly null with an honest rendered "Statistics not yet available" state
[verified]. baseStats/icon/kit_tags 173/173 [verified]. Augments: rarity and
icon 268/268; localized descriptions 233/268 (87%); English wiki description
225/268 (84%); `quality_tier` 0/268 (the label pipeline lives in unmerged
PR #39 and produces zero labels even there — see §K) [verified]. Combos cover
159/173 champions; the 14 without: akshan, caitlyn, graves, gwen, jax, jinx,
kalista, locke, lucian, samira, sivir, xayah, zed, zeri [verified]. 70
augments flagged `lifecycle=removed`, of which six are wrong (§C-P0-3)
[verified]. Data freshness: `meta.json` scraped_at 2026-07-12T22:39Z — two
days stale against a daily cadence [verified].

**Rendering / performance.** Production-equivalent build classifies champion
detail as the ONLY dynamic entity family: 0 champion pages prerendered vs
1,340 augment and 2,375 item pages [verified via
`.next/prerender-manifest.json`]. Live headers confirm: champion pages
`cache-control: private, no-cache, no-store` + `x-vercel-cache: MISS`;
augment pages `x-vercel-cache: PRERENDER` [verified]. Root cause: the page
awaits `requireActiveEntitlement()` → Supabase server client → `cookies()`
before rendering (`src/app/[locale]/champions/[slug]/page.tsx:127-134`,
`src/lib/supabase/server.ts:5`) [verified].

**SEO.** Sitemap counts match data exactly; canonical + hreflang alternates
emitted (spot-checked earlier this session); one soft-404 family (champions).
Locke's title renders "…— Tier Stats unavailable |…" — honest but awkward
[verified].

**Analytics.** All eight events wired on main at correct sites: `page_view`,
`entity_search`, `champion_open`/`augment_open`, `overlay_cta_click`,
`signup_start`/`signup_complete` (GoogleSignInButton), `ad_slot_viewable`
(AdSlot IntersectionObserver 50%/1s) [verified by call-site grep; unit tests
cover consent gating]. Consent-gated Plausible loader targets domain
`wasfun.lol`; **no Plausible account/site registration exists** as far as the
repo shows — events have nowhere to land [source-read; registration state
unverifiable-here].

**Accounts / membership.** Google sign-in exists; membership page offers
"Invite & trial access" via mailto — no self-serve checkout, no Stripe/
payment code anywhere [verified earlier this session; re-confirmed no
checkout routes in route manifest]. Server gating via
`requireActiveEntitlement` fails closed (401/403) [source-read].

**Overlay.** Source contains real implementations: LCU credential discovery
(lockfile, process args, logs), gameflow phase normalization
(`overlay/src-tauri/src/lcu.rs`), OCR (`ocr.rs`, native backends per merged
PR #36), collector + sanitize + upload queue + calibration [source-read].
Site-side device-auth endpoints exist (`/api/device/code`, `/api/device/link`
in route manifest) [verified], but `member.rs` contains no device/bearer/
token handling — the overlay cannot authenticate members yet [source-read;
matches `docs/handoffs/overlay-current-state.md`]. `tauri.conf.json`:
version 0.1.0, no updater block, no signing config [verified]. GitHub
releases: none, ever [verified]. Windows installer workflow
(`windows-overlay.yml`, NSIS) exists but cannot run (CI billing)
[verified].

**CI.** Latest runs: every workflow `completed/failure`, jobs rejected before
step 1 ("no steps") — the billing annotation, unchanged [verified]. Local
gates on main: 453/453 vitest, eslint clean [verified this review].

---

## C. Findings by severity

### P0-1 — GitHub Actions billing outage kills pipeline, gates, and installer
- **Severity:** P0. **User impact:** data staleness compounds daily; "daily
  updated" claim becomes false; patch-day updates (the site's core promise)
  fail. **Monetization impact:** advertisers land on stale pages; overlay
  installer cannot be produced at all.
- **Evidence:** `gh run list` — all runs `completed/failure` with zero steps
  executed; `meta.json` scraped_at 2026-07-12 vs today 2026-07-14 [verified].
- **Affected:** all `.github/workflows/*`; `public/data/*` freshness.
- **Correction:** account owner resolves billing (GitHub → Settings →
  Billing → payment/spending limit for `jasonzoidclawd-rgb`). No repository
  change can fix this. Then re-run `update-data.yml` once and confirm a green
  run.
- **Acceptance test:** one green scheduled `Update Data` run; `meta.json`
  scraped_at within 24h; `verify-live-seo.yml` green (its new entity-route
  probe will also validate P0-2's fix in production).

### P0-2 — Champion soft-404: unknown slugs return HTTP 200 (fix exists: PR #43)
- **Severity:** P0. **User impact:** typo/stale links show a generic shell
  page instead of a 404. **Monetization impact:** search engines index junk;
  crawl budget wasted; "soft 404" quality signal against the exact page
  family that should win search traffic.
- **Evidence:** `curl /champions/not-a-champ` → 200, generic site title, in
  root and zh-TW [verified today]. Root cause: entitlement gate reads
  `cookies()` before slug validation, so the route renders dynamically and a
  late `notFound()` can't set 404 [verified by production-equivalent build:
  champion route ƒ, unknown slug 200 pre-fix / 404 post-fix].
- **Affected:** `src/app/[locale]/champions/[slug]/page.tsx`; all champion
  URLs.
- **Correction:** merge PR #43 (36-line diff, single file, `MERGEABLE`,
  reviewed in §K). It is merge-ready; per this review's rules it is NOT
  merged by the reviewer.
- **Acceptance test:** `/champions/zzz-not-real` → HTTP 404 in root + zh-TW
  on production; live probe step in `verify-live-seo.yml` passes.

### P0-3 — Six live augments publicly labeled "Removed in patch 26.13"
- **Severity:** P0. **User impact:** players see augments in game that the
  site claims were removed — immediate credibility loss on exactly the pages
  a Mayhem player checks mid-session. **Monetization impact:** false data on
  core content pages is disqualifying for promotion and embarrassing under
  ads.
- **Evidence:** `public/data/augments.json` on main flags terraind,
  porcupine, surge-field, squishy-slappy-grab, its-go-time, from-downtown as
  `lifecycle=removed`; `/augments/terraind` renders "Removed in patch 26.13"
  banner [both verified today].
- **Affected:** scraper lifecycle reconciliation; `public/data/augments.json`;
  augment detail pages; patch-notes surfaces.
- **Correction:** extract the lifecycle-reconciliation fix from PR #39
  (commit `80e86a4` "reconcile current augment lifecycle in entity
  projection" is the relevant work) into a standalone small PR against main;
  regenerate data through the pipeline; add a regression test asserting an
  augment present in the current CDragon snapshot can never carry
  `lifecycle=removed`. Do NOT merge all of PR #39 to get this.
- **Acceptance test:** data-integrity test fails on main today, passes after;
  `/augments/terraind` shows no removed banner; count of `lifecycle=removed`
  drops 70 → 64.

### P0-4 — All 865 champion detail pages dynamically rendered, uncacheable
- **Severity:** P0 for advertising/SEO economics (site functions, so not a
  correctness outage). **User impact:** slowest pages on the site; every view
  is a cold server render. **Monetization impact:** champion pages are the
  primary ad inventory and search-landing surface; `no-store` blocks CDN
  caching, inflates TTFB (hurts Core Web Vitals, which gate both ranking and
  ad viewability), and each pageview costs a function invocation.
- **Evidence:** prerender manifest: 0 champion pages vs 1,340/2,375 for
  augments/items [verified]; live: `no-store` + MISS on every champion hit,
  PRERENDER on augments [verified]. Call chain:
  page → `requireActiveEntitlement()` (`page.tsx:131`) → `createClient()` →
  `cookies()` (`src/lib/supabase/server.ts:5`) → route dynamic.
- **Affected:** `champions/[slug]/page.tsx` only — no other page family
  imports the gate [verified: augment/item routes prerender].
- **Correction (smallest safe change, do not implement yet):** remove the
  entitlement gate from the server render of the champion page entirely.
  Render the public page statically (it already contains the full anonymous
  experience); load member-only content (member pool detail, Oracle-ranked
  scores) from a client component that calls an authenticated endpoint
  (`/api/decision/*` routes already exist and are already dynamic). This
  restores SSG for all 865 pages, keeps the member experience, and is
  strictly less server code. Alternatives considered: `<Suspense>` around a
  dynamic child (still dynamic route in current Next semantics without PPR),
  separately cached entitlement endpoint (still per-user, uncacheable),
  edge-cached HTML with cookie splitting (complex, error-prone). The
  client-fetch split is the smallest change that achieves static public HTML.
- **Acceptance test:** prerender manifest lists 865 champion routes; live
  champion page serves `x-vercel-cache: HIT/PRERENDER`; signed-in member
  still sees Oracle Ranked via client fetch; anonymous page byte-identical
  content to today's anonymous render.

### P0-5 — Analytics events have no destination
- **Severity:** P0 for ad readiness (measurement precondition). **User
  impact:** none. **Monetization impact:** cannot value inventory, measure
  funnel, or prove traffic to ad networks; overlay CTA performance invisible.
- **Evidence:** wrapper targets `plausible.io` with domain `wasfun.lol`
  [verified in `src/lib/analytics.ts:35-36`]; no account registration exists
  in any repo config; events verified consent-gated and correctly wired
  [verified].
- **Correction:** register the domain with Plausible (paid after trial) or
  self-host; set `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` if different. Zero code
  change expected.
- **Acceptance test:** after consent on production, `page_view` and
  `champion_open` appear in the Plausible dashboard.

### P1-1 — 14 champions silently show no combo section
- Combos absent for 14/173 champions including high-traffic picks (jinx, jax,
  caitlyn) [verified]. The page hides the section rather than rendering an
  explicit "no verified combos for this patch" state — a silent-hide instance
  of the missing data-state contract (§F). **Correction:** explicit empty
  state string (all five locales) + a completeness metric in the pipeline
  report. **Acceptance:** rendered explicit state on `/champions/jinx`;
  pipeline logs combo coverage 159/173.

### P1-2 — 35–43 augments lack any description text
- 233/268 have localized descriptions; 225/268 have English wiki descriptions
  [verified]. Detail pages for the gap set are thin (name + rarity + icon) —
  weak SEO targets and weak ad context. **Correction:** backfill via existing
  wiki/CDragon enrichment path; where genuinely unavailable, render an
  explicit "description pending" state instead of blank. **Acceptance:**
  description coverage ≥95% or explicit state rendered; list of remaining
  gaps in pipeline report.

### P1-3 — Membership funnel dead-ends in mailto
- The membership page offers invite/trial via a mailto link; no waitlist
  capture, no interest queue [verified earlier this session]. For the overlay
  acquisition path this loses every interested visitor who won't write an
  email. **Correction (Phase 3 gate, minimal):** replace mailto with a
  one-field waitlist form feeding an existing store (Supabase table), event
  `signup_start`/`signup_complete` already wired. Not a new feature family —
  it is the CTA the site already has, made functional.
- **Acceptance:** waitlist row created + `signup_complete` fires; no payment
  language anywhere until Phase 4.

### P1-4 — Locke SEO title reads "— Tier Stats unavailable"
- `<title>Locke ARAM Mayhem Guide — Tier Stats unavailable | …` [verified].
  Honest but malformed for search. **Correction:** metadata template should
  omit the tier clause when tier is null rather than substituting the
  fallback string. One-line conditional in `generateMetadata`. **Acceptance:**
  Locke title = "Locke ARAM Mayhem Guide | Mayhem Oracle …".

### P1-5 — Items route/data divergence (475 routes vs 468 rows per locale)
- Sitemap and prerender both emit 2,375 item URLs = 475/locale; `items.json`
  has 468 rows [verified]. `generateStaticParams` builds from
  `mayhemExclusive` plus additional identifier sources
  (`items/[identifier]/page.tsx:163-171`). Probably intentional aliases, but
  nothing asserts it. **Correction:** a route-census invariant (§E) that
  explains every route from a data row or a declared alias list; CI-fail on
  unexplained divergence. **Acceptance:** invariant test green with each
  route accounted for.

### P2-1 — No data-state contract (silent conversions catalogued in §F).
### P2-2 — `/search` 404s while search is dialog-only [verified]; ensure no
  nav/sitemap link points at it (none found in sitemap [verified]).
### P2-3 — PR #39 carries the tier-label pipeline that silently produces zero
  labels (minimumGames gate vs a feed with no sample counts) — the loud-
  failure guard recommended in the continuation prompt must ship with any
  revival of that work.
### P3 — deferred: overlay auto-update, code signing certificate purchase,
  member-data localization polish, DESIGN.md token migration (PR #40).

---

## D. Page consistency matrix

| Page family | Route | Shared presentation | State |
|---|---|---|---|
| Home | `/[locale]` | SSG ● | Consistent; hero + movers + spotlight [verified 200] |
| Champion index | `/champions` | SSG ● | Consistent [verified 200] |
| Champion detail | `/champions/[slug]` | **Dynamic ƒ** | Content consistent across 22-sample; the ONLY dynamic family; soft-404 (P0-2); honest null-stat state for Locke [verified] |
| Augment index | `/augments` | SSG ● | Consistent [verified 200] |
| Augment detail | `/augments/[slug]` | SSG ● | Consistent; hard 404 for unknown [verified]; six false "Removed" banners (P0-3) |
| Item index/detail | `/items`, `/items/[identifier]` | SSG ● | Hard 404 verified; 7-route divergence (P1-5) |
| Tier list | `/tier-list` | SSG ● | 200 [verified] |
| Patch notes | `/patch-notes`, `/[patch]` | SSG ● | 200; hosts the only AdSlot [verified] |
| Membership | `/membership` | Dynamic ƒ | mailto dead-end (P1-3) |
| About/Privacy/Terms/Contact | static | SSG ● | all 200 [verified] |
| Search | dialog (no route) | n/a | `/search` 404 by design (P2-2) |
| Error/404 | `/404` | static | correct for augments/items; champions bypass it (P0-2) |
| Mobile layouts | — | — | [unverifiable-here: no browser tooling connected; responsive classes present in source] |

Entity names/slugs/icons/patch labels are consistent across the sample;
tier labels consistent for champions (S+…C + explicit unavailable);
augment tier labels absent everywhere (neutral frames) pending parked PR #39;
win-rate formatting consistent (`.toFixed(1)%`); sample counts are not
displayed anywhere on the site (no source data for them — disclose rather
than fake; see §G).

## E. Roster and route integrity report

| Family | Data rows | Routes/locale | Sitemap total | Prerendered | Unknown-slug behavior |
|---|---|---|---|---|---|
| Champions | 173 | 173 | 865 | **0** (dynamic) | **soft-404 (200)** — P0-2 |
| Augments | 268 | 268 | 1,340 | 1,340 | hard 404 ✓ |
| Items | 468 | **475** | 2,375 | 2,375 | hard 404 ✓ |

Duplicates/collisions: none found (roster gate from PR #42 checks duplicate
IDs and alias collisions for champions [source-read]). Missing entities:
none (Locke present since #42). Stale aliases: unknown for items (P1-5).

**Recommended CI invariants (add to the existing gates):**
1. `sitemap_count(family) == data_rows(family) × locales` (items: plus an
   explicit, reviewed alias list).
2. Unknown-slug probe per family returns 404 (exists in
   `verify-live-seo.yml` since #42 — blocked only by P0-1).
3. Champion prerender count == 173 × locales (activates with P0-4's fix; this
   is the regression guard that would have caught the gate-induced dynamic
   flip).
4. `lifecycle=removed` ∩ current-CDragon-snapshot == ∅ (P0-3 regression).
5. meta.json scraped_at < 48h at publish time (freshness gate).

## F. Data completeness report

Champions (n=173): identity 100%; icon 100%; baseStats 100%; kit_tags 100%;
tier/win_rate/pick_rate/rank 99.4% (Locke null — explicit rendered state ✓);
combos 91.9% (14 missing — silent hide, P1-1); abilities coverage not
recounted this pass [source-read: enrichment step exists].

Augments (n=268): identity/rarity/icon 100%; localized descriptions 87.3%;
EN descriptions 84.0% (P1-2); quality tier 0% (parked); lifecycle flags 100%
present but 6/70 removed-flags false (P0-3).

Items (n=468): identity 100% [verified count]; per-field audit not repeated
this pass.

**Silent conversions found (violations of an honest data contract):**
- Pre-#42, missing champion WR became `?? 50` — removed for the null path,
  but the pattern existed; audit remaining `??`/`|| 0` fallbacks when
  implementing the contract.
- Combos: missing → section hidden (P1-1).
- Augment tier: absent field → neutral frame (acceptable interim, but
  indistinguishable from "ranked neutral" once labels exist).
- Six false `removed` flags → false banner (P0-3): stale lifecycle event
  never reconciled against the live snapshot.
- Pipeline freshness: site renders patch 26.13 with 2-day-old data and no
  on-page staleness indicator (meta timestamp is not surfaced to users).

**Recommended data-state contract** (per entity, per surface):
`complete | partial | insufficient_sample | unavailable | stale | invalid` —
carried as a field computed at export time, rendered as explicit localized
states, and asserted by tests (a page may not render a numeric claim unless
state == complete|partial). Smallest viable start: champions' stats state
(exists de-facto since #42) + combos state (P1-1) + lifecycle validity
(P0-3), then extend.

## G. ARAMGG minimum-parity matrix

Benchmark: can an ARAMGG user switch without bouncing? (ARAMGG's rendered
product was not re-crawled for this review; classifications below combine
today's wasfun probes with the benchmark's known public surface
[unverifiable-here beyond that].)

| Dimension | Status |
|---|---|
| Champion roster | **parity achieved** (173/173, gate enforced) |
| Augment roster | **present but unreliable** (268 listed; 6 falsely removed — P0-3) |
| Item coverage | parity achieved (468, hard 404s) |
| Route accessibility | partial (champion soft-404 — P0-2) |
| Champion statistics | parity achieved (tier/WR/PR/rank + honest null state) |
| Augment recommendations | partial (per-champion tailored pool public; global augment ranking absent pending parked tier labels) |
| Item recommendations | partial (item pages + combos; no per-champion build order — known product gap, deferred) |
| Sample-count disclosure | **missing** (no sample data exists; disclose source+method instead — do not fake) |
| Patch disclosure | parity achieved (patch label on every page) |
| Freshness disclosure | missing (meta timestamp not user-visible) |
| Missing-data handling | partial (Locke honest; combos silent — P1-1) |
| Search | parity achieved (dialog search with result counts) |
| Navigation | parity achieved (verified nav families all 200) |
| Mobile behavior | [unverifiable-here] — responsive classes present; browser check not available |
| Content density | partial (thin augment tail — P1-2) |
| Recommendation clarity | partial (anonymous sees pool preview + combos; scored ranking member-gated — a deliberate split, disclose it clearly at the gate) |
| Metadata/canonicals | parity achieved (titles/hreflang verified; Locke title nit P1-4) |
| Sitemap | parity achieved (counts exact) |
| Page performance | **missing for champions** (P0-4); parity for static families |
| Error behavior | partial (P0-2) |

## H. Static-rendering and caching report

Covered in P0-4. Chain: `ChampionPage` awaits `requireActiveEntitlement()`
(`page.tsx:131`) before anything else that matters → `createClient()` →
`await cookies()` (`supabase/server.ts:5`) → Next marks the render dynamic →
route excluded from SSG (0/865 prerendered) → Vercel serves `no-store` MISS
per request. Only this family is affected; membership page and API routes
are legitimately dynamic. PR #43 fixes the 404-status consequence but
deliberately does NOT restore staticness (valid slugs still hit the gate).
Recommended minimum repair: strip the gate from server render; client-fetch
member content from existing authenticated APIs (full reasoning + rejected
alternatives in P0-4). Implications while unfixed: no CDN cache (cost +
TTFB), CWV risk on the pages ads and SEO need most, and every crawler hit is
a paid function invocation.

## I. Advertising-readiness checklist

- **Technical:** ConsentManager mounted globally ✓; AdSlot consent-gated with
  reserved min-height (CLS-safe) ✓ but deployed only on patch-notes;
  champion/augment pages have zero placements; champion pages uncacheable
  (P0-4) ✗.
- **Legal:** privacy/terms/contact/about live ✓; Riot non-affiliation
  disclaimer present (reused on About) ✓; consent declines by default until
  granted ✓.
- **Content quality:** false removed-banners (P0-3) ✗; thin augment tail
  (P1-2) △; core champion/augment/item content real and localized ✓.
- **Performance:** static families fine; champion family fails until P0-4 ✗;
  CWV measurement unavailable until analytics live (P0-5).
- **Analytics:** 8 events wired ✓; no destination (P0-5) ✗.
- **Placements (when gates pass, max 3/page):** (1) below the hero/stats
  block after the first content section; (2) between Champion-Specific Pool
  and Base Stats/Abilities (champion) or between overview and patch-history
  (augment); (3) end of main content above footer. No interstitials, no
  sticky stacking, no ads on pages whose data-state != complete/partial.
- **Go/no-go gate for enabling ads (ALL must hold):** P0-1 green pipeline ·
  P0-2 merged+live-probed · P0-3 fixed+regression-tested · P0-4 champion
  pages static with cache HIT · P0-5 events visible in dashboard · CWV
  sampled (LCP < 2.5s p75 on champion detail) · zero soft-404s in family
  probes · false-data count == 0.

## J. Overlay-readiness checklist

| Area | State | Evidence |
|---|---|---|
| Installer | **absent as product** — workflow exists (NSIS), zero releases ever | [verified] |
| Signing | absent (no cert, config empty) | [verified tauri.conf] |
| Update path | absent (no updater block) | [verified] |
| First launch / logs / uninstall | [unverifiable-here — no Windows host; no installer artifact] |
| League detection | working foundation — lockfile/process/log credential discovery | [source-read lcu.rs] |
| LCU lifecycle (reconnect, restarts, dodges, repeated games) | partially integrated — gameflow normalization present; reconnection/dodge paths not testable here | [source-read] |
| Rendering matrix (1080p/1440p/ultrawide, 100–150% scaling, multi-monitor) | [unverifiable-here]; calibration module exists (`calibration.rs/.ts`) | [source-read] |
| Recognition (champion/augment, OCR fallback) | working foundation — native OCR merged (PR #36), resolve modules with tests | [source-read] |
| Recommendation consistency web↔overlay | enforced by cross-parity suite at budget 0 | [verified: suite passes on main] |
| Confidence/stale states | partially integrated (contracts exist in `overlay/src/contracts`) | [source-read] |
| Authentication | **blocked** — site device endpoints exist; overlay bearer flow unimplemented | [verified routes; source-read member.rs] |
| Entitlement (expiry, service-failure, offline) | mocked/planned — fails to `unauthenticated` banner | [source-read handoff] |
| Checkout/subscription lifecycle/refunds | absent (no payment code anywhere) | [verified] |
| Supportability (logs, diagnostics) | partially integrated | [source-read] |

**Verdict: working foundation, not sellable.** Until the full install →
detect → recommend → survive-restart → authenticate lifecycle is verified on
real Windows hardware, offer only: free account, overlay waitlist (P1-3),
alpha application, founding-user interest list. No charging.

## K. Branch and PR triage

| Ref | Decision | Rationale |
|---|---|---|
| **PR #43** `fix/champion-notfound-before-gate` | **merge now** (merge-ready; not merged by this review per its rules) | 36-line single-file diff re-inspected this review; `MERGEABLE`; fixes P0-2; verified production-equivalently; CI red is the global billing outage, not the change |
| **PR #39** `followup/entity-presentation` | **pause** + extract | Not required for page consistency, data-state integrity, static repair, or ad launch — its tier labels currently produce 0/268 anyway. CONFLICTING with main. Extract ONLY the lifecycle-truth fix (P0-3) as a fresh small PR; revive the rest (frames already merged-quality, labels need the gate fix) after Phase 2 |
| **PR #40** `claude/design-md-patch` | merge when convenient | Docs only (DESIGN.md + plans/contracts/reviews); MERGEABLE; no product risk |
| **PR #37** overlay click-through | finish after current blockers (Phase 3) | Overlay UX work; irrelevant to Phases 0–2 |
| **PR #35** windows-client-alpha | pause; harvest into Phase 3 | Superseded in part by later overlay work |
| `codex/augment-truth` (06-24) | preserve as documentation | Source of augment identity methodology; already partially superseded |
| `auth/session-hardening` (07-06) | finish after current blockers (Phase 3/4 gate) | Needed before charging, not before ads |
| `codex/riot-api-bigquery-discovery`, `codex/collector-local-calibration-export-surface`, model/collector branches | pause (scope freeze) | §M |
| Local worktrees (`mobile-dashboard`, `patch-hotfix-pbe-*`, `windows-client-alpha-fast`, `backend-analytics-reports`) | housekeeping later; no execution work | stale ≥3 weeks or spec-merged |

**Is PR #39's tier-label work required before consistency/data-state/static/
ads? No.** Neutral augment frames are cosmetically fine; false "removed"
banners are not — which is why P0-3 is extracted and the rest is parked.

## L. Monetization-critical execution plan

### Phase 0 — Freeze and establish release gates
- **Scope:** owner fixes GitHub billing (P0-1); merge PR #43 (P0-2); merge
  PR #40 (docs); adopt the scope freeze (§M); re-run `update-data.yml` and
  `verify-live-seo.yml` once green.
- **Dependencies:** billing is user-only; everything else is ready today.
- **Affected systems:** GitHub account, one champion route file, docs.
- **Acceptance:** green scheduled pipeline run; production unknown-champion
  probe 404s; `meta.json` < 24h old.
- **Verification:** `gh run list`, `curl -o /dev/null -w '%{http_code}'
  https://wasfun.lol/champions/zzz-not-real` → 404, sitemap probe.
- **Exclusions:** everything else.

### Phase 1 — Website consistency, roster and data completeness
- **Scope:** P0-3 lifecycle-truth extraction (first changeset, §N); P1-1
  combo empty-states; P1-2 description backfill/explicit states; P1-4 title
  fix; P1-5 items route census invariant; §E CI invariants 1/4/5; minimal
  data-state contract (§F) for stats/combos/lifecycle; surface freshness
  timestamp in the footer.
- **Dependencies:** Phase 0 (pipeline must run to regenerate data).
- **Affected:** scrapers, export, `public/data`, five `messages/*.json`,
  champion/augment detail templates, tests.
- **Acceptance:** false-data count 0; every champion renders data or an
  explicit state for stats/combos; invariants green in CI; 453+ tests green.
- **Verification:** `npm test`, python unittest discover, invariant scripts,
  production probes of the six augments + jinx combos state.
- **Exclusions:** tier labels, new sections, redesigns.

### Phase 2 — Static delivery, performance and advertising launch
- **Scope:** P0-4 champion static split (client-fetch member content); P0-5
  Plausible registration; CWV sampling; then ad placements per §I (three
  slots on champion detail + augment detail + champion index), gated by the
  §I go/no-go checklist.
- **Dependencies:** Phase 1 complete (no ads on false/thin data).
- **Affected:** champion page + a new client member panel; AdSlot call
  sites; env config.
- **Acceptance:** §I go/no-go all-green; prerender count 865; cache HIT on
  champion pages; `ad_slot_viewable` events flowing.
- **Verification:** prerender-manifest diff, live header probes, Plausible
  dashboard, cross-parity + full local gates.
- **Exclusions:** more than 3 placements/page; interstitials; membership
  changes.

### Phase 3 — Overlay completion
- **Scope:** device-token auth (site endpoints exist; implement overlay
  bearer flow per handoff); LCU lifecycle hardening (reconnect/dodge/repeat);
  rendering matrix verification on real hardware; NSIS installer from green
  CI; unsigned-alpha distribution to waitlist (P1-3 waitlist ships here);
  logs/diagnostics; PR #37 click-through lands here.
- **Dependencies:** Phase 0 (CI); web phases not blocking except waitlist.
- **Acceptance:** a stranger installs from a release artifact, gets
  recommendations across 3 consecutive real games incl. one restart, auth
  works end-to-end, uninstall clean.
- **Verification:** Windows-host test checklist (manual), `cargo build
  --release` + binary timestamp per repo rules, installer smoke script.
- **Exclusions:** payment, signing cert (evaluate cost at exit), Mac.

### Phase 4 — Pro subscription launch
- **Scope:** checkout (Stripe or equivalent), entitlement lifecycle
  (expiry/renewal/refund), `auth/session-hardening` review, pricing page;
  charging enabled ONLY after Phase 3 acceptance holds for the alpha cohort.
- **Dependencies:** Phase 3 acceptance evidence.
- **Acceptance:** trial→paid→cancel→refund lifecycle verified in test mode;
  entitlement-service failure degrades to read-only gracefully.
- **Exclusions:** everything in §M, permanently until re-scoped.

## M. Stop-doing list

Pause immediately (no execution work; branches preserved): PR #39
continuation (tier labels, entity presentation) beyond the P0-3 extraction ·
LCU snowball crawling · distributed match collection · pro-player tracking ·
new public APIs / API marketplace · new recommendation models / AI systems ·
additional game modes · social systems · personal match-history pages · Mac
overlay · speculative data-source research (riot-api/bigquery branches) ·
architecture modernization not required by P0-4 · new page families ·
`build-model-candidate.yml` scheduled runs (disable the schedule when billing
returns, keep manual dispatch).

## N. First changeset recommendation

- **Branch:** `fix/augment-lifecycle-truth`
- **PR title:** `fix: reconcile augment lifecycle against live snapshot (six false removals)`
- **Exact scope:** lifecycle reconciliation so any augment present in the
  current CDragon snapshot cannot carry `lifecycle=removed`; regenerate
  `public/data/augments.json` (+ dependent patch-notes/pool artifacts) via
  the pipeline; red regression test first (data-integrity test asserting the
  six are live TODAY fails on main); no UI changes.
- **Likely affected files:** `scripts/scrape_mayhem_augments_cdragon.py` or
  the lifecycle step in `scripts/update-data.sh`'s owning script (PR #39's
  commit `80e86a4` shows the intended reconciliation — use it as reference,
  re-implement against main, do not merge the branch);
  `scripts/test_*lifecycle*.py` (new); regenerated `public/data/*`;
  possibly `public/data/pool-rules.json`.
- **Acceptance criteria:** `/augments/terraind` (and the other five) render
  no removed banner on production after deploy; `lifecycle=removed` count
  70→64; new test red-on-main / green-on-branch; 453+ vitest and python
  suites green; cross-parity budget 0.
- **Tests:** the new data-integrity regression + existing suites.
- **Risks:** regeneration may pull unrelated upstream drift (2-day-stale
  data) — snapshot-diff the regenerated files and keep the diff scoped;
  pipeline needs network. If billing is still broken, run the pipeline
  locally (it is local-first) — CI greenness is not a dependency.
- **Exclusions:** tier labels, entity-presentation projection, frame CSS,
  any PR #39 merge.
- **Why this over alternatives:** PR #43 is already authored (merge, don't
  rewrite); this is the largest remaining user-visible falsehood, it is
  small, it is independent of PR #39's conflicts, and it unblocks the "no
  false data" precondition for every later monetization step.

---

## Verification performed (this review)

- Clean worktree from `origin/main` @ `aa86f54`; `npm test` 453/453; eslint
  clean; CI status inspected (`gh run list` — billing rejection confirmed).
- Production-equivalent build with dummy Supabase env; prerender manifest
  analyzed (0/865 champion pages prerendered).
- Production probes: sitemap census (4,675 = exact per-family counts),
  22-champion sample + zh-TW + invalid slugs, headers (no-store MISS vs
  PRERENDER), legal pages, robots.txt, `/augments/terraind` false banner,
  anonymous champion page section inventory.
- Data audits over `public/data/`: roster 173, completeness percentages,
  six false removals, combo coverage 159/173, description coverage,
  items 468-vs-475 divergence, meta freshness.
- PR inspection: #43 (diff re-read, MERGEABLE), #39 (CONFLICTING per GitHub;
  earlier this session: 478/478 tests in its worktree, quality_tier 0/255,
  minimumGames gate analysis), #40 (MERGEABLE), branch dates for triage.
- Overlay: source/structure/config/release/workflow inspection + handoff doc.

## Unavailable evidence / uncertainty

- **Mobile viewport & Core Web Vitals:** no browser tooling connected in
  this environment; responsive behavior and CLS/LCP unmeasured.
- **Windows overlay runtime:** macOS host, CI down, no release artifact —
  installer/LCU/rendering claims are source-read only.
- **ARAMGG side of the parity matrix:** classified against its known public
  surface, not re-crawled today.
- **Plausible account state:** external service; assumed unregistered
  (nothing in repo or session indicates otherwise).
- **PR #39 GitHub mergeability** reported `UNKNOWN` at fetch time (GitHub
  was recomputing); local merge-tree earlier this session showed real
  conflicts in five generated PBE files plus the champion page.
