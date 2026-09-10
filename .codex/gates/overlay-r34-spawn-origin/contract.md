# Contract — R3/R4 collector render-loop

**Terminal state: COMPLETE. The fix is IMPLEMENTED and LIVE-VERIFIED across
two ARAM Mayhem games in one overlay process (2026-08-27).**

## What shipped

One product change, `overlay/src/collector/CollectorStatus.tsx`, +7/-1:
the inline `() => {}` default for `onStatus` is hoisted to a module-level
`IGNORE_STATUS` constant so callers that omit it get a stable identity.

Supporting, both new and untracked:
- `overlay/src/collector/collectorStatusSubscription.test.tsx` — true-seam
  regression test (frozen, `77cca500…c65c05`).
- `overlay/src/react-test-renderer.d.ts` — local ambient types; the
  devDependency ships none and no `@types` package is installed. Chosen over
  adding a dependency and churning the lockfile.

## What did NOT ship

- No Rust change. No commit, push, tag, or merge.
- The `void refresh(false)`-before-`if (!poll) return` ordering at line 75 was
  left alone. It was flagged separately and not approved; with a stable
  `applyStatus` it now fires once per mount and reads as an intentional
  initial fetch.
- The `validCardCount` 3→2 reroll defect remains untouched and out of scope.
- The `#[cfg(debug_assertions)]` spawn-origin / runtime-occupancy instruments
  from the prior slice are deliberately left in place — they are how the next
  run measures whether this worked.

## Root cause

A default parameter expression is re-evaluated on every call, so
`onStatus = () => {}` yielded a fresh identity per render for the two call
sites that omit it (`CollectorConsentWindow:263`, `CollectorControlsWindow:296`).
That destabilised `applyStatus` (`useCallback(..., [onStatus])`), which
re-ran both effects on every commit: one `plugin:event|unlisten` +
`plugin:event|listen` pair, plus one `get_collector_status`. Each reply is a
freshly deserialized object, so `Object.is` always failed and React committed
again — an unconditional loop with no fixed point, bounded only by IPC
round-trip latency.

`plugin:event|listen`/`|unlisten` are `async fn` commands
(`tauri-2.10.3/src/event/plugin.rs:14-31`), so each routes through
`tauri::async_runtime::spawn` (`src/async_runtime.rs:200`) and is injected
from the off-runtime IPC thread into the global queue — matching the measured
census of 755,031/759,450 spawns at that one site.

`Listeners::unlisten_js` (`tauri-2.10.3/src/event/listener.rs:239-252`) holds
a process-wide mutex, sweeps every webview label, and does an O(n) `retain`.
Async `listen()` means registrations outran teardowns, so the set grew, the
retain cost grew, and poll time escalated 261µs → 23ms. That is the positive
feedback that turned a fast render loop into total collapse.

Full derivation: `phase1-root-cause-run4.md`.

## Live verification — CONFIRMED

Two games, one process (PID 43770). Full report:
`phase4-live-verification.md`. Evidence pinned at
`.codex/evidence/overlay-r34-spawn-origin-live/`.

| | Run 4 (collapsed) | This run, both games |
| --- | --- | --- |
| `globalQueueDepth` | 341,048 | **0** in all 2,253 in-game windows |
| `injectionPendingMs` | 197,317 | **0** |
| peak spawn rate | 4,874/sec | 20-25/sec |
| `src/async_runtime.rs:200` | 99.4% of spawns | 33.6% (~3.4/sec) |
| `meanPollUs` | median 23,139 | median 643 / 659 |
| rounds | R3/R4 absent | **R1-R4 in both games** |

Game 2 was detected and fully processed in the same process after game 1, so
the absorbing failure mode — once collapsed, later games disappear — is gone.

Because every async Tauri command routes through `src/async_runtime.rs:200`,
its 3.4-3.5/sec rate is a hard **upper bound** on `plugin:event|listen` +
`|unlisten`. Its *share* rose to 33.6% only because the denominator collapsed.

The CRITICAL REFUTATION outcome (R3/R4 still failing with a bounded queue) did
not fire.

## Invariants preserved

The ARAM Mayhem augment cardinality invariant named in `CLAUDE.md` is
untouched: nothing here reads, derives, or bounds round progression or final
augment inventory.

## Compliance

Overlay work is compliance-sensitive. No game automation, no hidden-
information access, no client injection. No agent launched or operated League.
**No git write ran** — `git status` and `git rev-parse HEAD` confirm HEAD is
still `c014a390db5e1aab7ff4f7a8116f4e185ab390ee`.

## Verification findings and disposition

| Finding | Disposition |
| --- | --- |
| Interim run-4 analysis read `get_collector_status` at 54 weighted sample frames as proof the refresh effect was idle, exonerating `applyStatus` | **CORRECTED.** `collector.rs:685` is `pub fn`, not `pub async fn`; a sync command answers inline on the IPC thread and cannot appear in a tokio worker sample at any call rate. The inference was void and the conclusion it supported was wrong. |
| First red attempt timed out instead of asserting | **CORRECTED.** `IS_REACT_ACT_ENVIRONMENT` was unset, then `act()` could not reach quiescence against a genuinely infinite loop. Bounded the mock to 5 replies so the count became an assertion. |
| Fix only stabilises the two `undefined` call sites | **ACCEPTED, stated.** A ref-based `applyStatus` would make the hook immune to any unstable caller callback. Not approved, not shipped. `App.tsx:4110` currently passes a stable `setCollectorStatus`, so no live call site is exposed. |
| Row 3 of the decision matrix (refutation) | **CLOSED — did not fire.** The queue stayed bounded AND R3/R4 succeeded in both games. |
| Visual badge rendering unproven | **ACCEPTED, stated.** Fixture mode was forbidden, so `authorizationSource` was `none` throughout and `[badge-layer]` never certified `rendered`. Rounds are trace-proven, not pixel-proven. |
| Isolated poll spikes persist | **OPEN, low.** 12/1,324 and 6/929 windows over 10 ms, max 32 ms, against a 643 us median and a queue pinned at 0. Not the collapse signature; not zero either. |
| Game 1 produced 12 `[identity-start]` with `round: null` (generations 42-82, after R4's 41); game 2 produced none | **OPEN, low.** Reads as post-round re-identification without round attribution. Worth a look if it recurs. |
