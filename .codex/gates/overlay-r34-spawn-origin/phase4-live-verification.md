# Phase 4 — Live verification: CONFIRMED

Two ARAM Mayhem games, one overlay process (PID 43770), 2026-08-27.
Evidence: `.codex/evidence/overlay-r34-spawn-origin-live/` (§1 pinned).
Human-controlled gameplay only; no agent launched or operated League.

## Setup

- DEV build (`target/debug/mayhem-oracle-overlay`); the instruments are
  `#[cfg(debug_assertions)]` and a release build emits nothing.
- `[spawn-origin-install] {"installed":true,"workers":10}` — the instrumented
  runtime was in force. Absent, the run would have measured Tauri's DEFAULT
  runtime and been discardable.
- `pollsInWindow` never -1, so `tokio_unstable` reached the build.
- No fixture, telemetry, auth, or API override. Preflight recorded
  `credentialEnvironmentVerified: true`,
  `forbiddenCredentialNamesPresent: false`.
- Capture device verified as `0:Capture screen 0` (index confirmed, not
  assumed).
- The previously collapsed PID 39097 was confirmed dead before launch; exactly
  one overlay process existed for the whole session.

## Per-game results

Game windows are bounded by `[game-poll]` `action:"live-active"` (open) and
the next `action:"clear-confirmed-non-live"` (close). Both `live-active`
records carry the complete authority tuple (`gameflowConfirmed: true`,
`captureAllowed: true`, `liveDataStatus: "ready"`,
`gameflowPhase: "inProgress"`).

| | Game 1 (`gameEpoch 0`, champion 876) | Game 2 (`gameEpoch 1`, champion 104) |
| --- | --- | --- |
| duration | ~1,324 s (1,324 occupancy windows) | ~929 s (929 windows) |
| **rounds** | **R1x2 R2x1 R3x5 R4x3** | **R1x1 R2x2 R3x2 R4x6** |
| peak `globalQueueDepth` | **0** | **0** |
| peak `injectionPendingMs` | **0** | **0** |
| peak `injectionLatencyMs` | 4 ms | 55 ms |
| peak `aliveTasks` | 8 (median 3) | 8 (median 3) |
| peak spawn rate | 20/sec | 25/sec |
| `src/async_runtime.rs:200` | 4,543 (33.6%) ~= 3.4/sec | 3,247 (33.7%) ~= 3.5/sec |
| `rt/tokio.rs:115` | 7,571 (56.1%) | 5,413 (56.3%) |
| `meanPollUs` | median 643, max 18,628 | median 659, max 32,410 |
| heartbeat | 1,409 windows, 0 missing ticks, maxDrift 11 ms | 990 windows, 0 missing ticks, maxDrift 41 ms |

`globalQueueDepth` was **0 in every one of the 2,253 in-game windows** — 0 was
the only value the counter ever took.

Round counts are `[identity-start]` runs per round, including retries, so a
count above one is re-identification within the same round, not extra rounds.

## Answers to the verification questions

**A. Did the IPC storm disappear?** Yes.

| | Run 4 (collapsed) | This run |
| --- | --- | --- |
| `globalQueueDepth` | 341,048 | 0 |
| `injectionPendingMs` | 197,317 | 0 |
| peak spawn rate | 4,874/sec | 20-25/sec |
| `async_runtime.rs:200` share | 99.4% | 33.6% |
| `meanPollUs` | median 23,139 | median 643 / 659 |

**B. Did listener churn disappear?** Yes, by an upper bound rather than a
direct count. There is no marker for `plugin:event|listen`/`|unlisten`, but
**every** async Tauri command routes through `src/async_runtime.rs:200`, so
that site's rate bounds them from above. At 3.4-3.5/sec, listen+unlisten cannot
exceed 3.5/sec — lifecycle scale. Share rose to 33.6% only because the
denominator collapsed; the rate fell ~1,400x from 4,874/sec.

**C. Did R1 -> R4 succeed?** Yes, in both games. R3 and R4 are present in each.
Run 4 produced neither.

**D. Did the runtime stay healthy across both games?** Yes. Game 2 was detected
and fully processed in the same process after game 1, with identical queue and
task figures. The prior failure was absorbing — once collapsed, later games
disappeared. That mode is gone.

## Decision matrix outcome

**CONFIRMED FIX.** The unstable default callback caused the collector render
loop, which caused the Tauri listener IPC storm, which saturated the
process-wide Tokio runtime and starved R3/R4. The stable callback resolves the
live failure.

The CRITICAL REFUTATION row (R3/R4 still failing with a bounded queue) did not
fire: the queue was bounded *and* the rounds succeeded.

## Limits of this run — stated, not buried

1. **No visual badge confirmation.** The caller forbade fixture mode; the
   recorder skill's canonical launch requires `MAYHEM_OVERLAY_TIER_FIXTURE=1`
   and says never to drop it silently, so this records that it was dropped.
   All 137 `[badge-layer]` records carry `authorizationSource: "none"` and
   `reason: "authorization-denied"`, so the analyzer's `rendered` coverage is
   structurally unattainable. R1-R4 are proven at the trace level
   (`[identity-start]` round attribution inside confirmed live epochs), NOT as
   pixels on screen. `analyze_trace.py` was not run: its
   `--require rendered,focus_loss,focus_recovery` set cannot pass without
   fixture and without the focus-out checkpoint being performed.
2. **Isolated poll spikes remain.** 12 of 1,324 windows (0.9%) in game 1 and 6
   of 929 (0.6%) in game 2 exceeded 10 ms, peaking at 32 ms. Against a 643 us
   median and a queue pinned at 0 these are noise, not the collapse signature
   (a 23,139 us *median*) — but they are not zero.
3. **Asymmetry between the games.** Game 1 produced 12 `[identity-start]`
   records with `round: null` at offer generations 42-82, all *after* R4's
   generation 41. Game 2 produced none. These read as post-round
   re-identification attempts without round attribution, not a round failure.
   Worth a look if it recurs.
4. Two games is the minimum for a timing-coupled failure, not a large sample.
