# Overlay Current State

This file captures recent overlay findings so future agents do not rediscover
them from screenshots, terminal history, or old handoffs. It is context only.
Do not treat it as permission to change runtime behavior without a task.

## Champion-Conditional ARAMGG Stats + LCU Shape Probe (2026-07-20, PR #46 round 8)

- The dev/test ARAMGG path now parses each augment's sparse `top_champions`
  rows and selects by Riot's numeric champion key. `scripts/scrape_base_stats.py`
  joins that key by canonical champion identity (never localized display text),
  and the generated internal/public/overlay champion catalogs carry
  `champion_key`. A champion hit renders the champion row; a miss renders the
  augment-wide row. Both the chip (`CHAMP` / `GLOBAL`) and dev diagnostics name
  the provenance. Production still aliases every `src/dev/*` module to inert
  stubs, so the release decision-engine behavior is unchanged.
- Live ARAMGG raw data measured on 2026-07-20 (patch 16.14, dated 2026-07-18):
  206 augment rows, 1,015 valid top-champion rows, 0 malformed rows, 166 unique
  champions. This is 2.8481% of the 206×173 augment/champion matrix; every
  uncovered cell deliberately falls back to the labeled global record.
- The collector's unverified real LCU augment-field contract remains a hard
  gate before persistent round matching or schema-v2 work. Debug builds now
  emit one privacy-bounded `[collector-lcu-shape]` JSON line when the consented
  collector fetches an owned queue-2400 match detail. It contains only queue ID,
  augment-named field paths/value kinds/values, and the current parser output—
  never game ID, PUUID, Riot ID, summoner name, chat, or unrelated stats. The
  code and marker are compiled out of release builds.
- Phase B (blue hide/show control) is still blocked on new user-captured,
  full-frame labeled fixtures. Phase C2 onward remains blocked until one real
  shape line proves the match-detail field name and string-vs-numeric format.
  Do not invent either contract from the synthetic fixture.

Safe user-run capture command (does not upload and does not automate League):

```bash
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card/overlay && env -u MAYHEM_TELEMETRY_ENDPOINT -u MAYHEM_DEVICE_TOKEN MAYHEM_OVERLAY_TIER_FIXTURE=1 npm run tauri -- dev 2>&1 | /usr/bin/grep --line-buffered -F '[collector-lcu-shape]'
```

## Two-Stage Decoupling + Self-Healing 250 ms Scheduler (2026-07-18, PR #46 round 5)

Round-4 still failed a timed GUI retest: stale placeholders flashed over combat
(~1 poll cycle), a real level-15 offer (不可通行 / 拍拍鼓勵 / 斗內) was never
scanned for 37 s+, and detection latency ran ~6 s. Root cause was a circular
dependency — resolved augment *identities* were used to decide whether a card
*surface* existed, and scanning was gated by telemetry (`scanMode`) via the
poll, so a wedged/asleep scan loop stayed asleep. Round 5 separates the two
stages and replaces every scan trigger with one self-healing clock.

- **Stage 1 (surface presence) vs Stage 2 (identity)**:
  `overlay/src/surfacePresence.ts` decides presence from OCR *title quality*
  alone — `isPlausibleTitle` (normalized length 2–16, not a bare number) counted
  and fed to `evaluateSurfacePresence` (reuses `validateOfferSurface` thresholds:
  ≥2 plausible titles for a NEW surface, ≥1 for an already-present one, all three
  crops required). Catalog resolution (Riot/ARAMGG) NEVER gates presence, so a
  brand-new patch's unknown augments still render. `SurfacePresenceProvider` is
  the seam a future Rust geometry probe drops into without touching the
  scheduler / freshness / rendering contracts.
- **Single self-healing scheduler**: `overlay/src/surfaceProbeScheduler.ts` —
  `nextProbeAction(state, config, now)` is a pure reducer returning
  start / skip(reason) / restart(reason) from live refs ONLY (foreground,
  active-game, in-flight timing). It reads no telemetry, so nothing can wedge it
  asleep. A `setInterval` fires it every `PROBE_INTERVAL_MS` (250 ms) for the
  component's life; the 1.5 s-poll ambient probe AND the 20 ms fast loop are
  both gone. `startOcr`/`scheduleNextOcr`/`runAmbientProbe`/`resolveScanActivation`
  and `scanActivation.ts` are deleted. The permanent-sleep path (phase stuck at
  `augment_selection` → `stopOcr` from a flicker → `selectionCompleted` false →
  `startOcr` no-ops) cannot recur: there is no `startOcr`, and phase now FOLLOWS
  presence rather than gating scanning.
- **Guard release + watchdog**: `runSurfaceProbe` acquires the in-flight guard
  and releases it in a `finally` on EVERY path (success, stale-reject return,
  throw, timeout) — this try/finally is the core anti-wedge fix. If a probe
  overruns `PROBE_TIMEOUT_MS` (2000 ms) the reducer returns `restart`; the tick
  bumps the seq (its late return stale-rejects), resets the guard, and starts a
  fresh probe — recovery needs no remount or focus toggle.
- **Immediate clear + freshness TTL**: every probe publishes a fresh frame or an
  explicit EMPTY frame, so insufficient title-presence clears chips within one
  250 ms tick (no waiting for a poll / two misses / latch expiry). A positive
  frame also renders only while `visibleFrameFresh(frame, renderClock,
  FRAME_FRESHNESS_TTL_MS=500ms)` holds; `renderClock` refreshes every ~250 ms so
  a stalled/dead scheduler fails closed (hides) instead of freezing the surface.
- **Stale-result rejection, two axes**: a probe result publishes only while its
  `captureSeq === scanSeqRef` AND its captured `foregroundEpoch ===
  foregroundEpochRef` (bumped on every focus flip). A delayed or superseded
  probe can never restore an already-cleared frame.
- **Dataset capture (dev-only, opt-in, OFF by default)**:
  `overlay/src/dev/datasetCapture.ts` — enable with `MAYHEM_OVERLAY_DATASET_CAPTURE=1`
  under a dev build; the wire is `import.meta.env.DEV`-gated and dead-code-
  eliminated from production (verified: 0 capture strings in `dist`). To collect
  fixtures for the future geometry provider, in the dev devtools call
  `window.__captureOfferFixture('offer'|'combat'|'scoreboard'|'respawn'|'unknown')`
  at the moment of interest, then `window.__exportOfferFixtures()` for a JSONL
  manifest to save by hand. Records are redacted to card regions (three rects +
  their OCR'd titles + the presence verdict) — no champion / player / game-hash /
  full-screen data — and never auto-persisted, uploaded, or committed. Pixel-
  level crop capture for training a geometry detector is a deliberate follow-up
  (this patch ships OCR-based decoupling only; no unvalidated Rust detector).

## Visual-Surface Authority + Never-Veto Scanning (2026-07-18, PR #46 round 4)

Round-4 fix after a timed GUI retest on HEAD `f8cee7e` still leaked resolved
chips and SCANNING/UNMATCHED placeholders over combat/respawn/other maps, and a
real death-triggered R2 offer (旋風鉤 / 不祥契約 / 靈光一閃) never activated
scanning. Root causes and current contracts:

- **Internal latch vs visible frame separation**: rendering was driven by the
  internal `OfferState` latch, whose invalidation depended on the scan loop
  continuing to run. `overlay/src/visibleOfferFrame.ts` introduces
  `VisibleOfferFrame` — the ONLY state rendered chips/placeholders read. The
  latch is nonvisual grace bookkeeping. Every scan publishes either a
  fresh-validated frame or an explicit EMPTY frame (`buildVisibleFrame` /
  `publishEmptyVisibleFrame`), so a stale surface can never linger. The render
  gate is `visibleFrameRenderable(frame, foreground)`; chip geometry comes
  ONLY from the frame's fresh per-slot `cardRect` — the calibrated/historical
  fallback in `badgePositions` is deleted, so normal gameplay can never anchor
  a chip to old card coordinates.
- **Stale-chip / stale-placeholder cause**: `validatedSlots` for surface
  validation was counted from `applied.state.slots`, which on a grace pass (a
  latched offer's first absent scan) still *retains* the prior validated
  identities (`surfaceVisible:false`). That validated a hidden surface. Fix:
  the count is now gated on `applied.state.surfaceVisible` (the authoritative
  "this capture saw a validated surface" flag) — a grace pass counts zero, so
  the first combat scan publishes an empty frame.
- **Never-veto scanning (death-triggered offer cause)**: `resolveScanActivation`
  returned `none` whenever `scanMode` was `off`, and `scanMode` went `off`
  whenever round bookkeeping said nothing pending (level 12 + `completedRounds`
  overcounted → `pendingRounds 0`). A real on-screen offer was never scanned.
  Now foreground + in-game ALWAYS at least runs an ambient probe; `scanMode`
  only ESCALATES cadence to the 20ms fast loop. Visual surface is ground truth
  that an offer exists; telemetry only estimates which round it is.
- **Stale-result rejection**: a monotonic `scanSeqRef` is claimed at scan START
  and bumped on every synchronous clear; `frameResultIsCurrent(seq, latest)`
  lets a scan publish only while its seq is still newest — a delayed OCR result
  can never restore a superseded (hidden) frame.
- **Multi-signal surface validation**: `validateOfferSurface` requires all
  three name-band crops AND ≥2 known identities to latch a NEW surface (≥1 to
  keep a latched offer through a single-slot reroll) — arbitrary combat UI with
  one stray name-match is rejected.
- Dev diagnostics (`import.meta.env.DEV` only, compiled out of release):
  activation source (telemetry-fast / visual-ambient / selection-open), visible
  frame revision, `surfaceValidated` + reason, fresh rect count, and a
  `LATCH≠VISIBLE (grace, not rendered)` amber flag on lifecycle disagreement.
- Tests: `visibleOfferFrame.test.ts`, `scanActivation.test.ts` (never-veto),
  `postDeathActivation.test.ts` (post-death activation under injected stale
  bookkeeping + normal-gameplay-renders-zero-slots). No new pixel fixtures were
  supplied for the combat/death states, so these are state-machine replays; the
  R1 pixel replay (`r1_replay.rs`) still covers OCR-from-image.

## Foreground Resolver Ground Truth (2026-07-17, PR #46 round 3)

The round-2 build inverted foreground classification live (panels over
Terminal at 18:53:36; dead overlay during a real R1 offer 18:53:40–18:55:25).
Live window metadata captured with `cargo run --example foreground_probe`
established ground truth that now anchors `overlay/src-tauri/src/foreground.rs`:

- The REAL macOS game window has an EMPTY `kCGWindowName`. Any title-based
  game detection is dead code on macOS. LeagueClientUx's window owner name is
  "League of Legends" — indistinguishable from the game by name. Game identity
  comes ONLY from owner PID → bundle id
  (`com.riotgames.LeagueofLegends.GameClient`) or executable path
  (`foreground::is_game_owner`).
- The game runs borderless and may hold an elevated window layer; the game
  process is the only owner allowed to be z-order authority from a non-zero
  layer (`select_frontmost_window`). Everything else non-zero is chrome:
  status items at layer 25 (a "Riot Client" status item exists), menubar 24,
  cursor ~2^31. The game also keeps a degenerate 1x2 helper window —
  zero-area and alpha<0.01 windows are excluded.
- NSWorkspace.frontmostApplication off the main thread can be stale or frozen
  in EITHER direction. It is only a fallback when the CGWindowList walk yields
  no candidate; a cached workspace value never overrides fresher z-order
  evidence (`effective_frontmost_pid`).
- Frontend: `foregroundWatchdog.ts` gives the foreground poll a timeout
  (degrades to unknown = hidden) and a stuck deadline (a hung IPC can never
  latch the last classification). `scanActivation.ts` decides
  fast-loop/ambient-probe/none purely from fresh inputs. `devPanelsVisible`
  is the single gate for every dev panel — the pin bypass is gone; the
  tier-fixture flag alone never renders over another app.
- `get_foreground_diagnostic` (full candidate walk + verdicts) is
  macOS+debug_assertions only; release returns Err. The R1 captured-frame
  replay test is `overlay/src-tauri/tests/r1_replay.rs` over
  `corpus/full_frames/r1_offer_zh_tw_1280x720.jpeg`.

## Death-Delivery Round Model + CSS-Space Chips (2026-07-17, PR #46 round 2)

Second fix round on PR #46 after the timed manual GUI test surfaced six
defects. Root causes and current contracts:

- **Round delivery**: Mayhem rounds R2–R4 are delivered during the DEATH
  sequence, not at level thresholds. Levels 3/7/11/15 only create
  eligibility. `overlay/src/roundDelivery.ts` owns the model:
  `pendingRounds = eligibleRoundCount(level) − completedRounds`, completion
  counted on strong evidence only (keydown pick confirm, or a queued offer
  replacing a latched validated one — `replacedOffer`), chained R2→R3→R4.
  `augment_selection` phase enters ONLY when a validated offer surface
  latches (fast OCR loop or ambient probe), never from a level poll —
  `transitionAugmentRound`/`shouldStartAugmentSelection` are deleted.
  Scan modes: `fast` (offer latched, or death sequence with pending
  rounds), `ambient` (pending rounds, one probe per 1.5s poll tick),
  `off`.
- **Foreground authority**: `NSWorkspace.frontmostApplication` off the
  main thread returns values up to ~18s stale (game reported while
  Terminal focused → chip/window leak onto desktop). The topmost layer-0
  CGWindowList window is now the authority
  (`foreground::effective_frontmost_pid`); workspace value is only a
  fallback for fullscreen game surfaces with no layer-0 window.
- **Coordinate space**: `OverlayCalibration.overlay_anchor` (macOS:
  monitor rect; Windows: repositioned viewport) is the single conversion
  boundary — `cssRectFromCalibratedRect(rect, anchor, cssWindow)` runs
  exactly once per rect. `scaleFactor`/`devicePixelRatio` are display
  metadata only; using either for geometry reintroduces the 1.0↔2.0
  chip-position flap.
- **Chips**: 118×32 CSS px, `[S+ · 61.6%]`, placed above the full card
  frame (icon band 0.17 + name band + body band 0.24 of game height),
  side-anchor fallback, withheld (null) rather than ever rendered inside
  a card or over the reroll/upgrade control zones.
- **Placeholder hygiene**: zero-validated scans are absence evidence —
  `surfaceVisible` drops on the first such pass (chips hide, fixes the
  33s stale placeholders and scoreboard occlusion), the latch survives
  one pass for restore, clears after two.
- **Win rate**: `overlay/src/winRateFormat.ts` — exact string decimal
  shift + half-up one-decimal rounding ("0.5915" → "59.2%"); never
  `Number()*100`/`toFixed`. Tier glyphs render in a bundled OFL Anton
  latin woff2 (no runtime font fetch; `productionFont.test.ts` audits
  source + dist).
- Windows remains compile-gated, not machine-validated: no physical
  Windows build has run.

## Latched Offer Lifecycle + Riot zh-TW Identity Bridge (2026-07-17, PR #46)

- `overlay/src/offerLifecycle.ts` owns augment-offer state: per-slot OCR-title
  fingerprints, latch-until-evidence clearing (2-pass surface absence, pick
  confirm, round boundary, focus loss, gameflow), per-slot reroll invalidation,
  and atomic generation publishes. Champion level is a round-boundary trigger
  ONLY — `transitionAugmentRound` no longer has `selectionComplete` (the level
  3→4 badge wipe root cause).
- OCR card identity (dev tier-fixture) resolves zh-TW OCR title → ARAMGG's
  Riot zh-TW catalog (`aram-mayhem-augments.zh_tw.json`) → canonical numeric
  augment ID → ARAMGG stats (`resolveOcrTitle` in `dev/aramggSource.ts`).
  Icons are never consulted (quest cards obscure them; generic icons are
  shared). Ambiguity rejects; zh-CN exact is a logged last resort.
  疾速追擊 (id 2100) was the proving case: local catalog has regressed English
  localized names + `lifecycle: "removed"`, so `buildOverlayAugmentLookup` now
  includes non-live augments (on-screen evidence trumps catalog lifecycle;
  pool prediction still excludes them).
- Badges are compact chips (`BADGE_CHIP_SIZE` 168×32) placed ABOVE the card
  frame derived from the detected name band (`cardFrameFromNameRect`), with
  side-anchor fallback and per-slot states: tier/WR, SCANNING, UNMATCHED,
  NO ARAMGG DATA. Dev calibration panel moved to bottom-left — top-right
  collided with the rightmost chip at 1280×720.
- Native `detect_augment_names` returns `captureMs`/`ocrMs`/`totalMs`
  (`OcrScanResult` also gained the missing serde camelCase rename); the
  frontend adds `matchMs`/`endToEndMs` to the diagnostics lifecycle panel.
- Known non-blockers: rustfmt drift pre-exists in `collector.rs`/`lcu.rs`/
  `member.rs`/`tests/member_contract.rs` (untouched); Windows MSVC
  cross-`cargo check` from macOS dies in `ring`'s C build (needs a Windows C
  toolchain) — Windows readiness is compile-gated but not machine-validated.

## Focus-Safety Finding

The old macOS focus trap came from rendering consent and collector controls
inside the same fullscreen transparent overlay window. That window also used
high-level macOS window behavior and click-through toggles, so controls inside
it could leave the transparent surface able to capture desktop input.

PR #21 (`codex/overlay-consent-focus` @ `8515ea7`) split the surfaces:

- `consent`: normal bounded consent/help-improve window.
- `collector-controls`: small bounded collector control window.
- `overlay`: fullscreen transparent visual surface.

Expected overlay contract after that branch:

- The main transparent overlay stays click-through by default.
- Consent and collector controls own mouse interaction in bounded windows.
- Collector polling remains single-owner; extra windows must not run duplicate
  collection/upload polling loops.
- User manually confirmed the focus-related behavior works.
- Do not assume PR #21 is merged until `gh pr view 21` says so.

## Member Coach And Auth

The member coach is still blocked by auth/entitlement rather than UI plumbing.

Verified finding:

- `MAYHEM_API_BASE=http://localhost:3000` changed the overlay banner from
  `api-base-not-configured` to `unauthenticated`.
- That proves the API base reaches Rust/Tauri.
- Tauri/Rust `reqwest` does not share browser cookies.

Recommended future auth path:

1. Overlay asks for a device code.
2. User links the device on the website account.
3. Overlay stores a device token.
4. Overlay sends `Authorization: Bearer <deviceToken>` to member APIs.

Do not try to fix member coach by relying on browser cookies inside Tauri.

## Collector Purpose

The collector is a safe anonymous data pipeline, not the gameplay coach. It
gathers privacy-bounded ARAM Mayhem match and round facts from consenting users.

Collector data supports:

- Private calibration.
- Patch drift checks.
- Model validation.
- Data quality review.

Collector data must not include:

- PUUIDs.
- Player names or Riot IDs.
- Chat.
- Screenshots.

Product direction:

- Collector UI should eventually become secondary or diagnostic.
- Member coach is the advisor UI.
- Do not turn collector status into gameplay recommendation UX.

## Compliance Boundary

Avoid hidden-information guidance. Do not expose game-session information the
player could not normally know.

This does not prohibit Oracle's core advisor logic over:

- Public patch data.
- The player's champion kit.
- Visible augment offers.
- Items.
- Explainable multiple-choice recommendations.

Do not build public augment win-rate pages.

## Roadmap Order

1. `overlay-consent-focus`
2. `overlay-device-auth`
3. `overlay-dev-fixture-mode`
4. `overlay-layout-manager`
5. `overlay-gameplay-ux`
6. Windows packaging/test matrix
