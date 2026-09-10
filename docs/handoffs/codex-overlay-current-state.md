# Codex Overlay — Canonical State Handoff

**Created:** 2026-07-22 · **Author:** repository-integrator audit (read-only)
**Status:** advisory. No branches were pushed, reset, rebased, or deleted to
produce this document. PR #46 was not modified.

> **Every SHA and test count in this document is a 2026-07-22 snapshot and is
> NON-ACTIONABLE.** The canonical branch has moved since. Never branch from,
> diff against, or assert "latest good" from a SHA copied out of this file.
> Resolve the base dynamically with the block in
> `docs/prompts/codex-sync-to-current-overlay.md` ("Resolve the canonical base"),
> which fetches `origin/feat/overlay-tier-card`, checks upstream tracking, and
> fails closed when the working branch is based on stale history.

---

## TL;DR

The "recovery" line Codex built (`fix/level-11-15-lifecycle-current`) is **stale**.
It forked from the *merge-base* `4fa9482` (2026-07-20) and added only the
level-11/15 lifecycle fix — it is missing **47 commits** of newer overlay work
that already live on the canonical line.

**The lifecycle fix is already integrated on the canonical line** as `ec59fc4`,
on top of the latest product state, with a **byte-identical `liveGamePoll.ts`**.
There is therefore **nothing to port**. Codex should abandon the recovery line
as a base, use the canonical line, and only *validate* the lifecycle there.

---

## Canonical latest-good

The canonical line is the **branch**, not any particular commit on it.

| Field | Value |
|---|---|
| Branch | `feat/overlay-tier-card` |
| Tip SHA | resolve at run time — "Resolve the canonical base" in `docs/prompts/codex-sync-to-current-overlay.md` |
| Worktree | `/Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card` |
| PR | **This branch IS PR #46 head** → base `main`, state OPEN |
| Ahead of `origin/feat/overlay-tier-card` | local-only commits are expected; measure with `git rev-list --count origin/feat/overlay-tier-card..feat/overlay-tier-card` |
| Ahead of `origin/main` | measure with `git rev-list --count origin/main..feat/overlay-tier-card` |
| Health | re-run the inventory below; report observed numbers, never quoted ones |
| Backup refs | `backup/overlay-tier-card-*`, `backup/level-11-15-lifecycle-current-*` — historical only, never a build base |

> *Snapshot, non-actionable.* At the 2026-07-22 audit the tip was
> `22e0ed40e9de1c01ef5428fb0138e25d29445288` (code tip `ec59fc4`), 47 commits
> ahead of the pushed PR head and 84 ahead of `origin/main`, with overlay vitest
> 371 passed / 0 failed and a declared 863-test root inventory. Those values
> describe that day only and have since moved; do not branch from, diff against,
> or gate on them.
>
> One backup ref name contains the word "broken" — a **misattribution**. The
> obsolete overlay the user saw came from the *recovery* build, not this line.

### Evidence it is the latest intended overlay (all post-`4fa9482`, absent on recovery)

- `fd43c0f` champion-first augment dataset replaces reversed top_champions model
- `3e3f561` unified publication ownership + immutable slot identity (Phase A)
- `f787052` Phase B atomic per-slot reroll invalidation
- `7e9d9af` centralize offer surface state (`offerSurfaceState.ts`, NEW)
- `aa222bc` detect blue augment control structurally
- `59d9b74` champion-only augment stats — remove global fallback
- `6eb4ab9` DPI-aware click-through overlay window + shared locator
  (`overlay_window.rs` + `window_locator.rs`, NEW)
- `6641c52` harden overlay Windows CI · `831db5f` promote overlay to 0.5.0
- `df8fae2` bound OCR ownership and recovery
- `c26f2bf` stop a hung LCU/Live-Client poll from permanently sleeping capture
- `ec59fc4` **preserve live ownership across transient player-data gaps (the lifecycle fix)**

---

## Codex's stale recovery line

| Field | Value |
|---|---|
| Branch | `fix/level-11-15-lifecycle-current` |
| Tip SHA | `574388c` (real change: `487779b`) |
| Worktree | `/Users/jason/Desktop/mayhem-oracle/.claude/worktrees/level-11-15-lifecycle-current` |
| Base | `4fa9482` (2026-07-20 01:50) — the merge-base of the two lines |
| Beyond base | only 2 commits: `487779b` (lifecycle) + `574388c` (state) |
| Ahead of `origin/main` | 39 commits |
| Declared test inventory | **720 passing** (143 fewer than canonical) |
| Backup ref (created this audit) | `backup/level-11-15-lifecycle-current-574388c-20260722` → `574388c` |

`487779b` and canonical `ec59fc4` share a **byte-identical `liveGamePoll.ts`**
and the same lifecycle tests. They differ only in wiring: `487779b` also had to
add `resolveGameflowCaptureAllowed` to `augmentSelection.ts` (which canonical
already had from `c26f2bf`), and canonical routed its `[game-poll]` diagnostics
through `publicationDiagnostics.ts`. Semantically equivalent.

---

## Feature gap (canonical → recovery)

New modules that exist ONLY on canonical (added, not on recovery):
`overlay/src-tauri/src/window_locator.rs`, `overlay/src-tauri/src/overlay_window.rs`,
`overlay/src/offerSurfaceState.ts`, `overlay/src/dev/championDataset.ts`,
`overlay/src/dev/championStats.ts`.
Modified on canonical, older on recovery: `overlay/src/App.css`,
`overlay/src-tauri/src/surface_probe.rs`, `overlay/src/surfaceGeometry.ts`,
`overlay/src/dev/aramggSource.ts`.

---

## Intended lifecycle behavior (already implemented on canonical)

Implemented in `overlay/src/liveGamePoll.ts` (`resolveLiveDataPoll`) + wired in
`overlay/src/App.tsx` `poll()`:

- Preserve existing game / offer / OCR ownership during a **transient** Live
  Client Data (port 2999) outage — death/respawn can drop it briefly.
- Bounded **30 s** grace (`LIVE_DATA_FAILURE_GRACE_MS = 30_000`) — three
  worst-case ~9 s poll attempts (`get_live_player_data` = 3 sequential requests
  × 3 s native timeout).
- **Clear immediately** on a confirmed non-live gameflow (`!captureAllowed` →
  `action: "clear"`).
- **Fail closed** after grace expiry (`failureAgeMs > graceMs` → `clear`).
- **Reset** the failure window on data recovery (`liveDataAvailable` →
  `accept`, `failureStartedAt: null`).
- Emit privacy-bounded, DEV-only `[game-poll]` diagnostics (App.tsx:2706/2736/2822).
- **Never** activate a new game from missing data alone — `resolveLiveDataPoll`
  only ever `preserve`s or `clear`s on absent data; it never `accept`s.

## Lifecycle files that may change (and nothing else)

`overlay/src/liveGamePoll.ts`, `overlay/src/liveGamePoll.test.ts`,
`overlay/src/liveGamePollIntegration.test.ts`, the `poll()` wiring in
`overlay/src/App.tsx`, and the `[game-poll]` marker in
`overlay/src/dev/publicationDiagnostics.ts`.

## Subsystems that MUST remain untouched

Statistics / ranking (`championDataset.ts`, `championStats.ts`,
`aramggSource.ts`), OCR matching, geometry thresholds (`surface_probe.rs`,
`surfaceGeometry.ts`), offer generation (`offerSurfaceState.ts`,
`rerollInvalidation.ts`), card UI/CSS (`App.css`, badge components), calibration
and window detection (`window_locator.rs`, `overlay_window.rs`), member-coach
auth / device-token handling, Tauri window behavior, and the web↔overlay scoring
parity twins (`src/lib/scoring/`, `overlay/src/scoring/`).

---

## Root cause of the "obsolete overlay" the user saw

The recovery build was launched from `level-11-15-lifecycle-current`, which is
`4fa9482` + 2 commits and lacks the 47-commit overlay evolution (window
detection, calibration geometry, `App.css`, champion-first stats, offer-surface
ownership). Per-symptom classification:

| Symptom | Classification | Evidence |
|---|---|---|
| Oversized cards covering the game | **stale source, compounded by runtime** | recovery lacks `window_locator.rs`/`overlay_window.rs` + newer `App.css`; overlay geometry then falls back to the full monitor at scale 2.00 → cards drawn against a 2× display instead of the game window |
| CALIBRATION: monitor-fallback | **runtime** (expected) | fallback mode when no game window is detected; the known-good build also used borderless-monitor-fallback but at 1280×720 / scale 1.00 because League was detected |
| League: not detected | **runtime** (League not running), secondarily stale detector | primary cause is the client not being up at launch; recovery also lacks the newer shared locator |
| Scale 2.00 | **runtime** (expected) | 2× Retina default when no game window is measured; not a code regression |
| Member coach: unauthenticated | **environment** (expected, NOT a bug) | `MAYHEM_DEVICE_TOKEN` unset; do not treat as broken |
| Missing newer overlay features | **stale source** | champion-first stats, offer-surface ownership, blue-control, `[game-poll]`/publication diagnostics all post-`4fa9482` |

---

## Correct live-development launch (from the canonical worktree)

```bash
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card/overlay
MAYHEM_OVERLAY_TIER_FIXTURE=1 npm run tauri dev
```

Local overlay content is authorized by a real member entitlement **or** by the
explicit fixture flag — never by `import.meta.env.DEV` alone. A bare
`npm run tauri dev` with no member token therefore renders no tiers, win rates,
or scope labels; it is not a broken build. Either export real member auth
(`MAYHEM_DEVICE_TOKEN` + `MAYHEM_API_BASE`, which also enables the coach panel)
or keep `MAYHEM_OVERLAY_TIER_FIXTURE=1` for a member-free visual check.

Start League into a live ARAM match so calibration measures the real 1280×720
game window (scale 1.00) instead of falling back to the monitor.

## Visual acceptance criteria

- Correctly sized, compact augment cards anchored to the game window (not the
  full monitor).
- CALIBRATION reads the real game window (e.g. `League: 0,0 1280x720`,
  `Scale: 1.00`) once League is live.
- Tier badges (`S+/S/A/B/C`) render above each card with compact win-rate —
  only under member auth or `MAYHEM_OVERLAY_TIER_FIXTURE=1`.
- With `MAYHEM_DEVICE_TOKEN` set, no "Member coach unavailable: unauthenticated".

## Test inventory to reproduce on canonical

Run these and report the counts you observe. The CLAUDE.md STATE block is the
only live record of the expected totals; a number quoted in this file is not.

- Overlay: `cd overlay && npx vitest run`.
- Root: `npx vitest run`.
- `npx tsc --noEmit -p overlay/tsconfig.json` → clean.
- Rust (if Rust changes): `cargo build --release` + binary timestamp check.

## PR #46 status

`feat/overlay-tier-card` → `main`, **OPEN**, title "feat(overlay): S+/S/A/B/C
tier scoring card with win rate [test build]". **Do not push this branch,
update, merge, or otherwise modify PR #46.** The local tip is ahead of the
pushed PR head; pushing would alter the PR.

## Historical SHAs (non-actionable)

Recorded by the 2026-07-22 audit for archaeology only. None of these is a
"latest good" base; resolve the canonical tip dynamically instead.

- Canonical tip at audit time `22e0ed4`; lifecycle `ec59fc4`; poll-hang
  `c26f2bf`; 0.5.0 `831db5f`; Windows window/locator `6eb4ab9`; champion-first
  `fd43c0f`.
- Recovery tip `574388c`; recovery lifecycle `487779b`.
- Shared base / merge-base `4fa9482`; older anchor `368f64d`.
- Backups: `backup/overlay-tier-card-broken-22e0ed4-20260722`,
  `backup/level-11-15-lifecycle-current-574388c-20260722`.
