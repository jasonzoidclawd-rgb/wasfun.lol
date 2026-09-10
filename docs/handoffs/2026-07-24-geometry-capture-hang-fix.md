# Handoff → Codex — Geometry screen-capture hangs up to 126 s (the 11/15 stall)

**Date:** 2026-07-24 · **Author:** Claude (diagnosis confirmed via trace harness)
· **Status:** FIXED in native Rust (bounded-concurrency capture gate). Verified:
tests + release build. Awaiting live confirmation at levels 11/15. No
push/PR/merge. PR #46 untouched. Commit only when asked.

## UPDATE (round 4) — audit of rounds 1–3; round 3's root cause is NOT established

Grilled the last three builds. Two findings, one of which invalidated the
instrumentation round 3 shipped.

### 4a. The round-3 instrument was blind to the failure it diagnoses (FIXED)

`[geometry-timing]` was logged AFTER `runGeometryProbe`'s stale-rejection
returns. During a wedge the 2 s watchdog restarts the seq BEFORE the slow invoke
resolves, so `captureSeq !== geometrySeqRef.current` is true for **every** probe
→ the log never fires in the exact scenario it exists to explain. The round-3
build would have produced a trace with zero `[geometry-timing]` lines.

Fixed (red→green, source-guard test in `publicationDiagnostics.test.ts`, the
repo's existing idiom for pinning diagnostic wiring): the log now fires BEFORE
the stale return, carries `stale`, and adds **`nativeElapsedMs`**
(`observation.elapsedMs`, the Rust probe total) next to `roundTripMs` (the JS
invoke round-trip).

**That gap is the decisive measurement.** `roundTripMs − nativeElapsedMs` is
IPC + main-thread queueing delay:
- **Large gap** (native fast, round-trip 2–3 s) → the capture path is innocent;
  the delay is the main thread / IPC. See 4b.
- **Small gap, large `nativeElapsedMs`** → the capture path really is slow; the
  1500 ms `NATIVE_CAPTURE_TIMEOUT` is the thing to change.

### 4b. Leading unproven hypothesis: sync commands block the MAIN THREAD

Verified in `tauri-macros-2.5.5/src/command/wrapper.rs:137` —
`function.sig.asyncness.is_some()` selects `ExecutionContext::Async`; everything
else is `Blocking`, i.e. run inline in the IPC handler (the main thread on
macOS). `get_foreground_state` (lib.rs:1885) is **sync**, and `refreshForeground`
(App.tsx) invokes it on a **250 ms interval**. Its body walks CGWindowList,
NSWorkspace, and `sysinfo::System::new_all()`. A blocked main thread delays every
IPC response — including `probe_augment_surface`, which is `async` and therefore
finishes fine on the runtime but cannot get its reply back.

This would explain what round 3 could not: why the wedge is **2000–3000 ms** when
the Rust capture is bounded at **1500 ms**, and why it starts exactly when the
game goes live (window-server contention with active ScreenCaptureKit capture).

**Measured, and it refuted the obvious sub-hypothesis:** at idle,
`System::new_all()` = 1–3 ms (431 procs), `game_process_running()` = 2–3 ms,
`collect_foreground_state()` = 3–4 ms steady state (101 ms first call). So the
walk is cheap when nothing is happening. That does NOT clear it — the trace wedge
only occurs under live-game window-server load, which this measurement cannot
reproduce. Unproven either way; 4a's `nativeElapsedMs` split settles it.

**Deliberately NOT changed:** making `get_foreground_state` async would move
NSWorkspace off the main thread, which lib.rs:1554 explicitly warns "can freeze
indefinitely." That is a sensitive subsystem and shipping it on a hypothesis is
the exact failure mode of rounds 1 and 3. Get the trace first.

### 4c. Round 3's stated root cause is downgraded, not confirmed

Round 3 claimed on-runtime `collect_foreground_state()` starved the tokio
runtime. Note `probe_augment_surface` was ALREADY `async` (off the main thread)
before round 3, so that change moved the call from a runtime worker to a blocking
worker — it did not move it off the main thread, because it was never on it. The
change is still defensible (it bounds the walk inside the capture timeout) but it
is **not** demonstrated to be the fix for the no-badges symptom. One caveat it
introduced: the walk now runs inside the 1500 ms capture budget and consumes a
capture permit at 150 ms cadence.

Verification this round: vitest **391 passed** (+1 new guard) / 0 failed; tsc
clean; eslint clean; `cargo test -- --test-threads=1` → 123 passed / 0 failed /
1 ignored; `npx tauri build` → app + DMG, binary stamped Jul 25 02:13.

Next: ONE traced live game at 11/15 on this build, then read
`roundTripMs − nativeElapsedMs`. That single number picks the fix.

## UPDATE (round 3) — the wedge was the foreground gate OUTSIDE the bound

Live multi-game trace `overlay-trace-1906.log` (8346 lines) proved round 2's
bounded capture killed the 126 s freeze (`geometry inFlightMs` max **3001**, was
126484) — but later games still showed **no badges**. Evidence, all grounded in
that log:

- Pre-live **fixture** offers (geometry probes 1–598, log lines 274–1028)
  published **14** badges cleanly (`[identity-publish]` at 290–889). "First
  instance ran great."
- The instant the poll reported live `inProgress` (line 1034, probe 599 onward),
  **every** geometry probe wedged ≥2000 ms → **304** `[geometry-watchdog]`
  restarts across the whole `inProgress` window, **zero** OCR triggers, **zero**
  badges. Bounded, so it no longer froze 126 s — but wedged 2–3 s each,
  continuously.
- The long `endOfGame` stretch (lines 1344→8088) had **zero** geometry activity
  — idle post-game, not a cross-instance state leak. So the user's "segregate
  game instances" intuition doesn't match the data: the failure is entirely
  inside the single live window, not leaking between games.

Root cause (code): `probe_augment_surface` called `collect_foreground_state()`
**on the async runtime, OUTSIDE** `run_bounded_capture`'s 1500 ms guard. Its
CGWindowList / NSWorkspace walk slows badly under sustained live polling, adding
≥2000 ms per probe on top of the (already-bounded) capture → wedge past the
2000 ms JS watchdog → OCR never triggers → no badges. Round 2 bounded the
`capture_image()` call but left this walk unbounded.

Fix (this change, `overlay/src-tauri/src/lib.rs`): fold the foreground gate INTO
`capture_surface_frame` (lib.rs:1166), which already runs inside
`run_bounded_capture` (spawn_blocking + 1500 ms timeout). A slow walk now times
out to a clean absent observation (`reason "actual-game-window-not-foreground"`
preserved via `BoundedCaptureError::Capture`) instead of starving the runtime.
`pre_capture_ms` (lib.rs:1183) now folds the walk in.

Instrumentation added (TS, dev-only, bounded numerics — no names/text):
`[geometry-timing]` in `App.tsx` `runGeometryProbe`, throttled 1/s, splits each
probe's cost into `preCaptureMs` (enumeration + foreground) vs `captureMs`
(`capture_image`) vs `roundTripMs`. Marker added to the `DiagnosticMarker` union.

Verification: `npx vitest run` → 390/0; `npx tsc --noEmit` clean; eslint clean;
`cargo test -- --test-threads=1` → 123 passed / 1 ignored; `npx tauri build` →
app + DMG, binary stamped fresh (Jul 25 00:03).

REMAINING UNCERTAINTY (one live trace of THIS build decides it): if the walk
genuinely takes **>1500 ms even off-runtime** during live play, the bounded
capture will time out → still absent → still no badges. Then the real fix is to
make the foreground/enumeration check **cheaper or cached**, not merely bounded.
The `[geometry-timing]` split tells us which: high `preCaptureMs` = the walk
itself is the cost (cache it); high `captureMs` = `capture_image` is slow (raise
the bound / investigate xcap). Capture ONE traced live game at 11/15 and replay.

## UPDATE (round 2) — Codex's first fix REGRESSED it; corrected here

Codex's round-1 fix (spawn_blocking + 1500 ms timeout + a **single-flight**
permit per channel) removed the 126 s freeze but made levels 11/15 show **no
badges at all** (worse than the prior "badges appear then hang" at level 11).

Root cause of the regression (confirmed with a red test, `lib.rs`
`bounded_capture_tests`): the **single-flight** permit (max 1) means that once a
death-round capture hangs and holds the permit, its async side returns absent at
1500 ms, the JS scheduler (`GEOMETRY_INTERVAL_MS = 150`, watchdog
`PROBE_TIMEOUT_MS = 2000`) fires the next probe, but every retry hits
`try_acquire` → permit still held → `capture-busy` → absent, *instantly, for the
whole hang*. Pre-Codex those retries each started their own `capture_image()`, so
an intermittent success got a frame through and badges rendered. Single-flight
converts a slow/intermittent capture into a total channel blackout.

Fix (this change, `overlay/src-tauri/src/lib.rs`): keep spawn_blocking + timeout
(the real freeze fix — moves the hang off the async runtime), but replace the
max-1 permit with a **bounded-concurrency** permit
(`MAX_CONCURRENT_CAPTURES = 4`, `AtomicUsize` CAS). Retries beneath the cap run
concurrently (restoring the intermittent-success frames → badges), while the cap
still bounds how many hung blocking workers can accumulate. A hung worker keeps
its permit until the OS call truly returns (unchanged), so accumulation is capped
at 4 per channel, not unbounded.

Tests (red→green): `stuck_capture_must_not_block_a_same_channel_retry` (retry
beneath the cap runs; cap then refuses; recovers on release);
`capture_at_cap_is_refused_until_a_blocking_worker_returns` (cap=1 boundary);
`timed_out_geometry_capture_does_not_starve_ocr_capture` (cross-channel).

Verification: `cargo test -- --test-threads=1` → 123 passed / 1 ignored / 0
failed; `npx tauri build` → release binary + `Mayhem Oracle.app` + DMG built,
binary stamped fresh (`Jul 24 18:36`). TS untouched this round.

Remaining uncertainty (needs one live trace of THIS build at 11/15): if
death-round captures that succeed take **> 1500 ms**, the timeout still discards
them → still no badges, and `NATIVE_CAPTURE_TIMEOUT` must be raised. The trace
(`geometry inFlightMs`, capture-busy vs capture-timeout counts, any presence
confirmations) tells us which. Separately, the level-11 "badges hang, won't
clear" teardown/persistence issue is NOT addressed here.

---
## Original diagnosis + Codex round-1 prompt (kept for the record)

## The bug (confirmed from live traces, hypothesis corrected)

Death-triggered augment offers (levels 11/15, fired while the champion is dead)
render cleanly but freeze at `SCANNING · resolved 0/3` — geoseq frozen, tabbing
won't fix. **The initial "OCR starves geometry" hypothesis was WRONG** and was
corrected by a confirming capture:

Trace `overlay-trace-1452.log` (replay via `overlay/scripts/replay-trace.mjs`):
```
geometry-watchdogs  467
geometry inFlightMs count=467 min=2000 median=2999 max=126484   <- 126 SECONDS
native OCR ms       count=9   min=726 median=875 max=1612       <- OCR is FINE
timeouts 0 · publishes 6
```
- The **geometry probe capture hangs** — up to **126 s** in-flight, 467 watchdog
  restarts (~3 s cadence). The JS watchdog resets the flag and re-probes, but the
  native call keeps hanging (can't cancel a blocking OS call), so it never
  unsticks until the underlying condition clears.
- **OCR is exonerated**: 9 runs, 0 timeouts, ≤1612 ms. Not the cause.
- Geometry eventually recovers when the death/occlusion transition clears
  (geoseq advances again at the tail).

## Root cause (code)

`probe_augment_surface` (overlay/src-tauri/src/lib.rs:864):
- `monitor_snapshots()` (lib.rs:408) calls `xcap::Monitor::all()` **fresh each
  probe** — so it is NOT a stale cached handle.
- `monitor.monitor.capture_image()` (lib.rs:898) is a **synchronous blocking**
  call run **directly on the tokio async runtime** — no `spawn_blocking`, no
  timeout. xcap's macOS capture (ScreenCaptureKit) blocks indefinitely under the
  death/spectator/display-transition condition. A hung capture (a) blocks the
  geometry probe for the full hang and (b) occupies a runtime worker; concurrent
  probes pile up. `detect_augment_names`'s capture (lib.rs:715
  `capture_card_name_crops`) has the same blocking-on-runtime shape (its OCR
  recognition IS `spawn_blocking`'d at lib.rs:761, but the capture is not).

## Fix direction (for review before landing — sensitive subsystem)

Goal: a single hung native capture can NEVER block the geometry probe beyond a
short bound; on timeout the probe returns an ABSENT/uncertain observation (the
frontend already clears output for that, and the JS geometry watchdog already
handles it). Candidate change, native only:

1. Run `Monitor::all()` + `capture_image()` (and `capture_card_name_crops`) via
   `tokio::task::spawn_blocking` wrapped in `tokio::time::timeout` (~1200–1500 ms;
   baseline captureMs is 338–439 ms, so this is generous). On timeout → return
   `absent_surface_observation(..., "capture-timeout", ...)`.
2. Because a blocking OS call can't be cancelled, run captures on a **dedicated
   single capture thread / bounded queue** so hung calls can't exhaust runtime
   workers or pile up (drop/skip a probe rather than enqueue behind a hung one).
3. Investigate the xcap hang itself (is it a known ScreenCaptureKit block on
   display/spectator transition on death? pin/patch xcap, or add a pre-capture
   liveness check?). The timeout guard (1) is the pragmatic fix regardless.

Do NOT just raise timeouts elsewhere; the defect is an unbounded native capture.

## Reproduce / verify with the trace harness (already built, do not revert)

```bash
cd overlay
MAYHEM_OVERLAY_TIER_FIXTURE=1 MAYHEM_OVERLAY_TRACE=1 \
  npm run tauri dev 2>&1 | tee /tmp/overlay-trace-$(date +%H%M).log
# reproduce a level-11/15 death-triggered stall, dwell ~30 s, Ctrl-C
node ./scripts/replay-trace.mjs /tmp/overlay-trace-<HHMM>.log
```
Fix is validated when, under the same death sequence, `geometry inFlightMs.max`
stays bounded (≲ the timeout), geoseq keeps advancing, and the death-triggered
offer resolves to tier badges instead of frozen SCANNING.

Harness internals (keep intact — pinned by `publicationDiagnostics.test.ts` and
`traceReplay.test.ts`): `MAYHEM_OVERLAY_TRACE` forwards the bounded diagnostic
stream to terminal stderr; `[geometry-watchdog]` + `[identity-native-return]` are
the confirming signals; see `2026-07-24-overlay-trace-harness.md`.

## Constraints (non-negotiable)

- Compliance-sensitive overlay: no game automation, no hidden-info access
  (screen capture of the local screen is already the mechanism — do not add
  new capture surfaces), no client injection. Bounding an existing capture is in
  scope; new capabilities are not.
- Do NOT touch scoring parity twins, OCR matching/thresholds, offer generation,
  member-coach auth, or the trace harness. Do NOT revert the death-outage fix
  (`resolveLiveDataPoll` gameflowConfirmedLive — see
  `2026-07-24-death-outage-badges-fix.md`).
- TDD. Rust verification per CLAUDE.md is a RELEASE build + binary timestamp,
  not `cargo check`:
  ```
  cd overlay && npx tauri build 2>&1 | tail -5
  stat -f "%Sm %N" src-tauri/target/release/mayhem-oracle-overlay
  npx vitest run   # keep 390 green
  ```

## Also still open (separate thread, not this fix)

- Hanging badges over combat after an offer is gone (offer teardown/persistence).
- After the geometry-capture fix, re-confirm death-triggered offers RESOLVE
  (they should, once geometry stops freezing and re-triggers OCR).

## 2026-07-26 offline implementation

The native pipeline now runs foreground/window discovery, monitor selection,
capture, viewport mapping, image conversion, `analyze_surface`, and fingerprint
construction in one `spawn_blocking` worker with a 1500 ms async timeout.
Geometry and OCR have independent bounded permit counters (maximum four
outstanding native workers per channel). A timed-out worker retains its permit
until the OS call actually returns, so abandoned native work cannot create an
unbounded queue; the separate channel gates prevent either channel from
starving the other.

Timeout and busy results return a capture-invalid observation (zero capture
dimensions), which the renderer treats as uncertainty rather than confirmed
absence. A fresh completed zero-card capture remains authoritative no-offer
evidence and clears immediately.

The frontend now tracks five independent geometry clocks:

- current attempt generation/start;
- continuous unhealthy start;
- last native completion;
- last accepted authoritative geometry;
- last render-authoritative geometry.

Watchdog replacement resets only the current attempt. It cannot reset the
continuous unhealthy period or refresh rendering. An independent 150 ms health
clock hides both resolved badges and SCANNING placeholders when the last
accepted geometry exceeds the 1250 ms freshness bound, even if no native
promise completes. Only a fresh owner-current accepted geometry result restores
render authority. Late generations are diagnostic completions only and cannot
publish or reset accepted health.

This closes the previously separate hanging-badges issue offline. A manual
four-phase test is still required; no new League run was performed during this
implementation.

## Round 5 — OCR stale-rejection audit and the diagnostic contract (2026-07-26)

Trace: `/tmp/mayhem-four-phase-postfix-20260726-014355.log`.

### Two of the three reported symptoms were diagnostic artifacts

**"preCaptureMs max 34142"** — `absent_surface_observation` sets
`pre_capture_ms: elapsed_ms` and `capture_ms: 0`. Every sample where
`preCaptureMs == nativeElapsedMs && captureMs == 0` is an error/absent
observation, not a window-enumeration measurement. The native path was healthy
throughout: `nativeElapsedMs` median 612 ms across 616 samples. There is no
34-second pre-capture stall to fix, so no capture-target cache and no killable
helper process were built.

**"11 stale rejects, 0 retries"** — the reject payload carried only
`{runId, reason}`, and `[identity-retry]` is emitted only for the `retry:`
trigger reason. Recovery after a stale reject actually runs through the `new:`
reason (`applyRerollInvalidation` sets `store[i] = null`, which
`decideOcrTrigger` re-triggers every geometry frame until a run publishes), so
the recovery path was invisible to the summary. "Zero retries" was a
classification gap, not silence.

### All 11 rejections were correct; every slot resolved

| run | slots | slotGen | trigger | native ms | outcome | first violated authority | slot end state |
|----|----|----|----|----|----|----|----|
| 2  | [1]   | 4  | reroll:1 | 776  | reject | fingerprint drift (seq 634) | → run 3 |
| 3  | [1]   | 4  | reroll:1 | 702  | reject | fingerprint drift | → run 4 |
| 4  | [1]   | 4  | reroll:1 | 972  | reject | slot generation 4→5 (seq 636) | → run 5 |
| 5  | [1]   | 5  | new:1    | 974  | **publish** | — | resolved 1345 |
| 6  | [0]   | 4  | reroll:0 | 817  | reject | fingerprint drift (seq 639) | → run 7 |
| 7  | [0,2] | 4  | reroll:0,2 | 902 | reject | slot generation 4→5 (seq 641) | → run 8 |
| 8  | [0]   | 5  | new:0    | 936  | **publish** | — | resolved 1211 |
| 9  | [2]   | 4  | reroll:2 | 782  | reject | fingerprint drift (seq 655) | → run 10 |
| 10 | [2]   | 4  | reroll:2 | 859  | reject | slot generation 4→5 (seq 656) | → run 11 |
| 11 | [2]   | 5  | new:2    | 976  | **publish** | — | resolved 2100 |
| 13 | [2]   | 23 | reroll:2 | 857  | reject | fingerprint drift (seq 978) | → run 14 |
| 14 | [2]   | 23 | reroll:2 | 1009 | reject | slot generation 23→24 (seq 979) | → run 15 |
| 15 | [2]   | 24 | new:2    | 1079 | **publish** | — | resolved 2043 |
| 16 | [0]   | 23 | reroll:0 | 915  | reject | fingerprint drift (seq 985) | slot 0 already resolved 1061 |
| 17 | [0]   | 23 | reroll:0 | 1387 | reject | offer closed (gen 639→640, seq 1006) | offer over |

Offer 621 ended with slots 0/1/2 = 1211 / 1345 / 2100. Offer 639 ended with
slots 0/1/2 = 1061 / 2091 / 2043. **No slot was left unresolved at the close of
either offer**, and no rejection discarded a read the UI still needed. Runs 16
and 17 re-read an already-resolved slot 0 after hover/animation fingerprint
excursions; rejecting them preserved the correct published identity.

No bounded retry budget was added. The recovery loop demonstrably converges
(maximum three rejects before a publish), so an attempt cap could only truncate
a working path — it would regress the levels that currently pass. The gap that
was real is that the trace could not prove any of the above, so the diagnostics
were fixed instead.

### What changed

`classifyStaleReject` (`overlay/src/ocrOwner.ts`) names the FIRST violated
authority behind a rejection: foreground epoch → game epoch → champion id →
champion generation → offer generation → slot generation → fingerprint drift →
owner replaced → capture-seq-only. Semantic ownership outranks the registry
swap, because a registry replacement is a *consequence* of a reroll and must
never mask it. `capture-seq-only` is last and distinct: geometry capture
sequence alone is not an ownership authority, so when it is the only thing that
moved the trace must say so rather than report a supersede that did not happen.
Rejection behaviour is unchanged — this classifies a decision already made.

`[identity-stale-reject]` now carries stage, cause, requested slots,
slot generations at start vs now, per-slot fingerprint Hamming drift, per-slot
resolved state, offer/foreground/game/champion generations at start vs now, the
current owner run id, `captureSeqStale`, and elapsed ms. Bounded integers,
booleans and enums only — no fingerprints, titles or identifiers.

`[geometry-hidden]` → `[geometry-stale-hide]`, counted by marker OCCURRENCE.
The old summary counted a nested `staleHide === true` field while the runtime
emitted `staleHide: false` for TTL-expired hides, so the supplied trace's 2 real
hide events summarized as `stale hides 0` — read as "geometry never hid the
card", the opposite of the truth. `parseOverlayTrace` still accepts the legacy
marker so archived logs replay. Replaying the supplied trace now reports
`stale-hide events 2`.

Still unverified in a live game: the geometry backlog cap
(`MAX_OUTSTANDING_NATIVE_PROBES`) and the new diagnostics. A manual four-phase
test is required.

## Round 5 measurements — the freshness deadline is below the real frame budget

Baseline from `/tmp/mayhem-four-phase-round5-20260726-025137.log` (cap at 2):

| metric | p50 | p90 | p99 | max | n |
|---|---|---|---|---|---|
| nativeElapsedMs (all) | 620 | 706 | 1065 | 1920 | 447 |
| roundTripMs (all) | 648 | 936 | 108126 | 370533 | 447 |
| nativeElapsedMs (fresh) | 618 | 697 | 940 | 1322 | 421 |
| roundTripMs (fresh) | 641 | 788 | **1731** | 1911 | 421 |

Accepted-geometry cadence = the fresh round-trip figures. Max
`nativeOutstanding` 2 (cap held). Watchdog: 15 abandon / 12 restart. The
`roundTripMs` p99/max in the "all" row come entirely from the shutdown tail —
the last 36 lines of a 23,460-line log.

`GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS` is 1250 ms
(`max(3 * 150, GEOMETRY_FULL_PROBE_P99_BUDGET_MS 1000 + margin 250)`). The
measured fresh round-trip p99 is **1731 ms — 38 % above that deadline**, so
roughly 1 % of healthy frames are already "expired" when they arrive. Nine of
the trace's stale-hide events sit in the 1250–1500 ms band: one ordinary frame
gap plus jitter, not a stall.

The mismatch is a units error, not a tuning error. The deadline is derived from
the NATIVE probe-duration budget, but it is measured against ACCEPTED FRAME AGE,
which also carries scheduling and queueing. The native p99 budget of 1000 ms is
accurate (measured 940 ms fresh); the end-to-end frame budget is ~800 ms larger.

Not changed here. Raising the deadline directly weakens the hide that fixed
"badges remained after the round is over", so the right correction is to derive
freshness from an observed rolling frame budget with a floor and a ceiling
rather than from a native-duration constant — a geometry-threshold change that
needs review before it lands.
