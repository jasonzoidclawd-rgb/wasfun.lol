# Handoff — Death-triggered augment offers were blanking to "waiting for game"

**Date:** 2026-07-24 · **Author:** Claude (implemented + verified) · **Status:**
DONE on `feat/overlay-tier-card` (uncommitted working tree at time of writing).
No push/PR/merge. PR #46 untouched.

> ⚠️ **This supersedes one clause of `docs/prompts/codex-sync-to-current-overlay.md`.**
> That prompt describes the lifecycle contract as "fail closed after grace." That
> is now **conditional** — see the Contract below. Do **not** revert
> `resolveLiveDataPoll` to an unconditional fail-closed; doing so reintroduces
> the bug fixed here.

---

## Goal

Death-triggered augment offers (rounds R2/R3/R4 at levels 7/11/15, which fire
while the champion is dead) must keep rendering tier badges. They were showing
the live augment cards with **no badges** and the overlay panel
**"Client found — waiting for game…"**.

## Root cause (verified from code + live screenshots)

The augment badge pipeline is gated, transitively, on the **port-2999 Live
Client Data** poll, and a death/respawn drops port 2999 for **30–60 s** — longer
than the 30 s grace:

1. During the death, `get_live_player_data` (port 2999) returns nothing, but the
   LCU gameflow still reports the match **InProgress**
   (`gameflowCaptureAllowedRef.current === true`), so
   `shouldClearOcrStateForGameflow` is false and we reach `resolveLiveDataPoll`.
2. `resolveLiveDataPoll` preserves for 30 s, then returns **`clear`** (outage >
   grace).
3. `clearGameOnlyState("client_found")` runs → `setActiveGame(false)`,
   `setChampionSlug(null)`, `setPlayerData(null)`, `phase → "client_found"`.
4. `nextProbeAction` returns `skip / "not-active-game"` (surfaceProbeScheduler.ts
   line 60) → **the geometry probe stops running**.
5. With no geometry probe, nothing sets `phase → "augment_selection"` (App.tsx
   ~1832), so it stays `"client_found"`.
6. `resolveOverlayFixtureMode` requires `phase === "augment_selection"`
   (dev/fixtureMode.ts:61) → resolves to **`hidden`** → no badges, and the
   `"Client found — waiting for game…"` panel renders (App.tsx:3155).

Discriminator confirmed by the test screenshots: **R1 (level 3, delivered while
ALIVE)** had port 2999 up → `activeGame` true → badges (A/S/B rendered). **R2/R3/R4
(delivered during death)** coincided with the outage → cleared → blank.

## Fix (the minimum change)

While the LCU **freshly confirms** a live match, a port-2999 outage — however
long — is never proof the match ended (the LCU's own non-live transition is the
authoritative game boundary, already handled by
`shouldClearOcrStateForGameflow`). So preserve indefinitely instead of failing
closed.

- `overlay/src/liveGamePoll.ts` — `resolveLiveDataPoll` gains optional
  `gameflowConfirmedLive?: boolean`. When `captureAllowed && !liveDataAvailable
  && gameflowConfirmedLive` → **`preserve`** (reset failure window). The bounded
  grace/fail-closed now applies **only** when liveness is UNCONFIRMED (LCU also
  unavailable, `captureAllowed` carried forward). Backward-compatible: the param
  is optional and defaults to the old behavior.
- `overlay/src/App.tsx` — the `resolveLiveDataPoll(...)` call now passes
  `gameflowConfirmedLive: gameflow != null`. At that call site a non-null
  gameflow is necessarily a live confirmation, because a confirmed non-live phase
  already returned earlier via `shouldClearOcrStateForGameflow`.

No change to the geometry gate, OCR, scoring, offer-surface, or Rust. `activeGame`
simply stays true through the outage, so the geometry probe keeps running,
`phase` stays `augment_selection`, champion/playerData are retained, and badges
render for the death-triggered offers.

## Contract (do not regress)

`resolveLiveDataPoll` decision table — locked by tests:

| captureAllowed | liveDataAvailable | gameflowConfirmedLive | failureAge | action |
|---|---|---|---|---|
| false | — | — | — | `clear` |
| true | true | — | — | `accept` |
| true | false | **true** | any (even ≫ grace) | **`preserve`** ← the fix |
| true | false | false | ≤ grace | `preserve` |
| true | false | false | > grace | `clear` |

## Files In Scope

- `overlay/src/liveGamePoll.ts`
- `overlay/src/liveGamePoll.test.ts` (unit contract, +3 tests)
- `overlay/src/liveGamePollIntegration.test.ts` (wiring guard, +1 test —
  asserts `gameflowConfirmedLive: gameflow != null,` stays in the poll)
- `overlay/src/App.tsx` (one call-site arg)

## Verification (all green at handoff)

```bash
cd overlay
npx vitest run                          # 383 passed / 0 failed
npx tsc --noEmit -p tsconfig.json       # clean
npx eslint src/liveGamePoll.ts src/liveGamePoll.test.ts \
  src/liveGamePollIntegration.test.ts src/App.tsx   # clean
npm run build                           # ✓ built
```

## Assumptions / open risks

- **Assumption:** the clear the user hit came from the `resolveLiveDataPoll`
  grace-expiry path, not `shouldClearOcrStateForGameflow`. This is consistent
  with the LCU staying InProgress through a death, but is **not yet confirmed
  from the `[game-poll]` diagnostic**. To confirm on the next run, tee stderr and
  look for `action: "clear"` (grace-expiry, this fix) vs
  `action: "clear-confirmed-non-live"` (LCU actually reported non-live — a
  different root cause this fix does NOT address):
  ```bash
  MAYHEM_OVERLAY_TIER_FIXTURE=1 npm run tauri dev 2>&1 \
    | tee /private/tmp/mayhem-overlay-deathoffer-$(date +%H%M).log
  ```
- **Separate, still-open:** an earlier test (07-23) showed offers reaching
  `augment_selection` with badges stuck at `SCANNING 0/3` and a frozen `geoseq`
  (OCR starvation / publish stall) — a *different* failure mode from this one.
  This fix is a prerequisite for even reaching OCR on death-triggered offers;
  whether badges now RESOLVE (vs. render SCANNING) on R2/R3/R4 must be validated
  live. If 0/3 recurs, that is the OCR-starvation thread, not this one.
- The sustained-confirmation/hysteresis change (`23a0eba`, hover-frame reroll
  confirmation in `rerollInvalidation.ts`) is unrelated and untouched here.

## Done criteria

- On a live ARAM: a death-triggered augment offer (levels 7/11/15) renders tier
  badges instead of "Client found — waiting for game…".
- `[game-poll]` shows `action: "preserve"` (not `clear`) through the death
  outage while the LCU reports InProgress.
