# Phase 2 — Off-game bench for the geometry dispatch/resume collapse

Slice: `overlay-r34-shortest`
Worktree: `/Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card`
Branch: `feat/overlay-tier-card`

Phase 2 was run **regardless of the Phase 0 and Phase 1 verdicts**, as
instructed. Its purpose is not to confirm those verdicts; it is to convert the
evidence-acquisition problem from luck into repetition.

## Why this phase exists

The pinned manifest establishes that exactly **one** recorded run in existence
reaches Round 3 or Round 4, and that it predates the dispatch/resume
instrumentation. Every further reading of the collapse currently costs a live
ARAM Mayhem game that has to survive past ~13 minutes of game clock. This phase
asks whether the collapse can be provoked with no League process at all, purely
as a function of elapsed time.

Hypothesis under test, stated by the caller: **the collapse is time-correlated,
not round-correlated.** If true, a 20-minute unattended loop over the same
capture/geometry path at the same tick interval should show `rust_wait` growing
with wall clock, with no game and no rounds involved.

## Files added

Two new files, both new, both untracked, neither a product source file:

| Path | Purpose |
| --- | --- |
| `overlay/src-tauri/examples/geometry_dispatch_bench.rs` | the harness |
| `overlay/scripts/analyze-geometry-bench.mjs` | the analyzer and the verdict |

The cap was 3. Two were used. `cargo` auto-discovers `examples/`, so no
`Cargo.toml` edit was needed and none was made.

**Zero modifications to product source.** Proof, at the end of this phase:

```
/usr/bin/git -C <worktree> status --porcelain
?? .codex/evidence/
?? .codex/gates/
?? docs/proposals/
?? docs/reviews/2026-08-20-v08-recovery-and-harness-audit.md
?? overlay/scripts/analyze-geometry-bench.mjs
?? overlay/src-tauri/examples/geometry_dispatch_bench.rs
```

The first four entries are the baseline's. No tracked file is modified;
`/usr/bin/git diff --check` is clean.

## The seam limitation — read this before the verdict

The harness does **not** call the product's capture path. It cannot.

| Symbol | Location | Visibility |
| --- | --- | --- |
| `probe_augment_surface` | `overlay/src-tauri/src/lib.rs:1485` | private |
| `run_bounded_capture_with_gate` | `overlay/src-tauri/src/lib.rs:862` | private |
| `capture_surface_frame` | `overlay/src-tauri/src/lib.rs:1399` | private |
| `CapturePermit` | `overlay/src-tauri/src/lib.rs:828` | private |
| `GEOMETRY_CAPTURE_IN_FLIGHT` | `overlay/src-tauri/src/lib.rs:803` | private |

An `examples/` or `tests/` target reaches only the crate's public surface.
Making any of the five reachable requires adding `pub` to product source, which
this slice forbids without qualification. The public surface that *is* reachable
— `mayhem_oracle_lib::surface_probe::analyze_surface` and
`mayhem_oracle_lib::calibration::{physical_card_rects, Rect}` — is the analysis
half only, not the dispatch machinery under investigation.

The harness is therefore a **replica**: every constant, every ordering, and
every measurement point is copied from the cited product site, and the deliberate
differences are listed below. A replica can demonstrate a mechanism. It cannot
prove the product is free of one. That asymmetry is the single most important
thing to carry out of this phase, and it is why `NOT_REPRODUCED` below is
reported as `NOT_REPRODUCED` and not as evidence of health.

This is a **seam that blocks full fidelity**, not a seam that blocks the
harness. The harness built and ran, so the verdict is not `BENCH: BLOCKED`.

## What is replicated exactly

| Product site | Constant / behaviour |
| --- | --- |
| `overlay/src/surfaceGeometry.ts:30` | tick interval 150 ms — the live value. Not the 250 ms `PROBE_INTERVAL_MS` default, which `App.tsx:228-232` overrides. |
| `overlay/src/surfaceProbeScheduler.ts:34` | `PROBE_TIMEOUT_MS` 2000 ms, abandon-without-replacement, sequence not advanced |
| `overlay/src/surfaceProbeScheduler.ts:59` | `MAX_OUTSTANDING_NATIVE_PROBES` 1 |
| `overlay/src/surfaceProbeScheduler.ts:69` | `WEDGED_NATIVE_PROBE_MS` 4000 ms |
| `overlay/src/surfaceProbeScheduler.ts:79` | wedged cap 2 |
| `overlay/src-tauri/src/lib.rs:790` | `NATIVE_CAPTURE_TIMEOUT` 1500 ms |
| `overlay/src-tauri/src/lib.rs:798` | `MAX_CONCURRENT_CAPTURES` 4 |
| `overlay/src-tauri/src/lib.rs:828-860` | `CapturePermit` CAS acquire + `Drop` release, permit moved INTO the blocking worker |
| `overlay/src-tauri/src/lib.rs:873-884` | acquire -> `spawn_blocking` -> `tokio::time::timeout(worker).await` |
| `overlay/src-tauri/src/lib.rs:1516`, `:1551` | `dispatch_wait_ms` and `resume_wait_ms` measurement points, including the `saturating_sub` |
| `overlay/src-tauri/src/lib.rs:1382-1391` | `absent_surface_observation`: `pre_capture_ms` is a copy of total elapsed, sub-phases zero |
| `overlay/src-tauri/src/lib.rs:2179`, `:2193-2223` | 5 s-TTL presence cache, lock never held across the `System::new_all()` walk |
| `overlay/src-tauri/src/lib.rs:2398-2434` | 250 ms heartbeat tick, 1 s aggregation window, drift = observed minus expected |
| `overlay/src/App.tsx:3942-3944` | 1500 ms game poll |
| `lib.rs:117-126` + `lcu.rs:145` + `lcu.rs:24` | that poll calling `sysinfo::System::new_all()` DIRECTLY in an async task body — the one Q1 exception Phase 1 found |
| `tauri-2.10.3/src/async_runtime.rs:213-220` | `tokio::runtime::Runtime::new()`, i.e. multi-thread, one worker per core |

### The clock fidelity requirement

Both tickers run on **ordinary OS threads** with `std::thread::sleep`, not as
tokio tasks. This is not a shortcut, it is the point. In the product the clock
is a webview `setInterval`, and Phase 0 proved that clock kept firing to the
millisecond — zero of 2290 foreground-poll intervals across the whole run
exceeded 4995 ms — while the runtime ran 73 s behind. A ticker implemented as a
tokio task would stall together with the runtime it is supposed to be probing
and would silently measure nothing.

The heartbeat is the one loop that **must** be a tokio task, for the same
reason in the opposite direction: it is the instrument that detects the stall.

## Substitutions, and which way each one biases

1. **No Tauri IPC.** `transportMs` here covers only pre-first-poll scheduling
   latency (issue to the spawned future's first statement); the product's also
   includes webview/host serialization. This **under**-reports latency, never
   over — it cannot manufacture a reproduction.
2. **No foreground gate.** Without League, `capture_surface_frame` would return
   `actual-game-window-not-foreground` in microseconds and no closure work would
   run at all. The window and monitor enumeration that dominates
   `pre_capture_ms` is kept; the game-window predicate is dropped.
3. **Closure work padded to 703 ms** when the real work lands under it. Blocking
   pool occupancy is the property that matters for dispatch/resume latency, and
   703 ms is the product's own measured median. Every record reports `padMs` so
   a reader can subtract it. This is the largest substitution in the harness.
4. **Debug build.** `cargo run --example` produces a debug binary. That matches
   the recorded run: run B was captured under `npm run tauri dev`, and the
   `async-runtime-heartbeat` the product ships is `#[cfg(debug_assertions)]`
   and does not exist in a release binary at all.
5. **Idle machine, no game.** See the load-fidelity finding in the results.

## Pre-registered reproduction criterion

Written into `overlay/scripts/analyze-geometry-bench.mjs` before the run, so
that a threshold cannot be accused afterwards of having been fitted to the data.

`REPRODUCED` requires **both**, in the same 60 s bucket:

- **(a)** median `rust_wait` (= `dispatchWaitMs + resumeWaitMs`) >= **2000 ms**.
  2000 ms is `PROBE_TIMEOUT_MS` — the point at which the product abandons the
  probe and the displayed geometry goes stale. It is far below the live R3
  stale-geometry `rust_wait` median of 8157.5 ms, so this is a **generous** bar:
  the bench could clear it while being an order of magnitude milder than the
  live collapse.
- **(b)** that bucket's median `closureWorkMs` within 2x of the whole run's
  median. The live collapse held closure work flat while `rust_wait` exploded. A
  bucket that is slow because the *work* got slower is a different phenomenon
  and must not be scored as a reproduction.

Anything else is `NOT_REPRODUCED`.

## Instrument sanity check

Run before the measurement run and discarded, per the rule that an instrument
which already misbehaves during the healthy phase invalidates the run.

- 60 s, 80 geometry records, 59 heartbeat records, 40 game-poll records.
- Geometry inter-arrival median **750 ms**. The live run-B geometry *service*
  rate was 1.42/s, i.e. ~704 ms. The harness reproduces the product's throughput,
  not merely its tick rate.
- `capturedRealFrame` true on 80/80 — screen capture is genuinely executing.
- `analysisMs` 52-59 ms — `analyze_surface` is doing real work, not early-outing.
- Heartbeat max drift 3 ms, zero dropped ticks. The instrument reads healthy
  when the system is healthy.

## The run

One run, as instructed. 20 continuous minutes, no League process, no game.

```
[bench-start] {"minutes":20,"tickIntervalMs":150,"closureTargetMs":703,"workerThreads":10,"nativeCaptureTimeoutMs":1500,"maxConcurrentCaptures":4}
[bench-end] {"benchElapsedMs":1200000,"probesIssued":1599,"outstandingAtEnd":1}
```

| | |
| --- | --- |
| Geometry records | 1598 (probe 1599 was in flight at the cut-off) |
| Stale / abandoned records | **0** |
| Watchdog abandons | **0** |
| Heartbeat records | 1190, **0** with dropped ticks |
| Game-poll records | 800 |
| Real frames captured | 1598 / 1598 |

Full time series: `phase2-bench.jsonl` — 3590 lines, every record: 1598
`[geometry-timing]`, 1190 `[async-runtime-heartbeat]`, 800
`[bench-game-poll]`, 1 `[bench-start]`, 1 `[bench-end]`, 0
`[geometry-watchdog]`.
Per-minute table: `phase2-bench-analysis.txt`.
Quoted extremes: `phase2-quotes.txt`. Process RSS: `phase2-bench-rss.txt`.

### Per-minute time series

`rustWait = dispatchWaitMs + resumeWaitMs`. All values in milliseconds.

```
min	n	stale	rustWait_med	rustWait_p95	rustWait_max	disp_med	disp_max	resume_med	resume_max	closure_med	transport_med	hb_drift_max	sysinfo_med	sysinfo_max
0	80	0	0	1	1	0	0	0	1	702	0	2	3	9
1	80	0	0	0.0	1	0	1	0	1	702	0	2	2	5
2	80	0	0	0	1	0	1	0	1	702	0	2	3	5
3	80	0	0	1	1	0	0	0	1	702	0	2	3	5
4	80	0	0	1	1	0	0	0	1	702	0	2	3	7
5	80	0	0	0.0	1	0	0	0	1	702	0	2	3	7
6	80	0	0	1	1	0	0	0	1	702	0	2	3	4
7	80	0	0	0.0	1	0	0	0	1	702	0	2	3	5
8	80	0	0	0	1	0	0	0	1	702	0	2	3	6
9	80	0	0	1	1	0	0	0	1	702	0	3	3	5
10	80	0	0	0	1	0	0	0	1	702	0	3	3	4
11	80	0	0	0.0	1	0	0	0	1	702	0	2	3	7
12	79	0	0	1	1	0	1	0	1	702	0	5	3	25
13	80	0	0	0	1	0	0	0	1	702	0	4	2	12
14	80	0	0	1	1	0	0	0	1	702	0	6	2	35
15	79	0	0	1	1	0	0	0	1	702	0	2	2	62
16	80	0	0	0.0	1	0	0	0	1	702	0	2	2	5
17	80	0	0	1	1	0	0	0	1	702	0	4	3	7
18	80	0	0	1	1	0	0	0	1	702	0	4	3	9
19	80	0	0	0	1	0	0	0	1	702	0	4	3	9
```

Whole-run aggregates:

| Metric | Value |
| --- | --- |
| `rust_wait` median / p95 / max | **0 / 1 / 1 ms** |
| Records with `rust_wait > 0` | 102 of 1598, every one of them exactly 1 ms |
| `rust_wait` first-quarter median vs last-quarter median | **0 ms vs 0 ms** |
| `nativeElapsedMs` min / median / p95 / max | 703 / 703 / 704 / 846 |
| `closureWorkMs` bucket median | **702 ms in all 20 buckets** |
| Heartbeat drift max | **6 ms**, dropped ticks 0 / 1190 |
| Geometry inter-arrival median / p95 / max | 750 / 754 / **943 ms** |
| `System::new_all()` median / p95 / max | 3 / 5 / 62 ms; 0 calls over 100 ms |
| Process RSS min / median / max | 45392 / 77936 / 92944 KiB, over 34 samples at 30 s spacing |

### Quoted raw lines

Opening and closing geometry records, 1199 seconds apart:

```
[geometry-timing] {"benchElapsedMs":703,"probeSeq":1,"stale":false,"preCaptureMs":37,"captureMs":71,"analysisMs":55,"padMs":539,"nativeElapsedMs":703,"roundTripMs":703,"timeoutClassification":"none","attemptGeneration":1,"dispatchWaitMs":0,"resumeWaitMs":0,"closureWorkMs":702,"unattributedNativeMs":1,"transportMs":0,"asyncRuntimeMs":0,"captureWidth":1280,"captureHeight":720,"capturedRealFrame":true}
[geometry-timing] {"benchElapsedMs":1199359,"probeSeq":1598,"stale":false,"preCaptureMs":1,"captureMs":55,"analysisMs":57,"padMs":589,"nativeElapsedMs":704,"roundTripMs":704,"timeoutClassification":"none","attemptGeneration":1598,"dispatchWaitMs":0,"resumeWaitMs":0,"closureWorkMs":702,"unattributedNativeMs":2,"transportMs":0,"asyncRuntimeMs":0,"captureWidth":1280,"captureHeight":720,"capturedRealFrame":true}
```

Opening and closing heartbeat windows:

```
[async-runtime-heartbeat] {"benchElapsedMs":1008,"intervalMs":250,"ticks":4,"expectedTicks":4,"maxDriftMs":2,"lastDriftMs":2,"elapsedMs":1007}
[async-runtime-heartbeat] {"benchElapsedMs":1199000,"intervalMs":250,"ticks":4,"expectedTicks":4,"maxDriftMs":2,"lastDriftMs":2,"elapsedMs":1007}
```

The worst heartbeat window and the worst `System::new_all()` call in the run:

```
[async-runtime-heartbeat] {"benchElapsedMs":890661,"intervalMs":250,"ticks":4,"expectedTicks":4,"maxDriftMs":6,"lastDriftMs":6,"elapsedMs":1011}
[bench-game-poll] {"benchElapsedMs":928637,"sysinfoMs":62,"processCount":414}
```

### An unplanned natural experiment inside the run

The captured monitor changed resolution mid-run without intervention: 1390
records at 1280x720, then **208 records at 2560x1440 between 767.3 s and
928.6 s**, then back. Real closure work rose accordingly — `captureMs` to 376 ms
and `analysisMs` to 465 ms — and in 8 records the synthetic pad fell to zero and
`nativeElapsedMs` reached its run maximum of 846 ms:

```
[geometry-timing] {"benchElapsedMs":859451,"probeSeq":1145,"stale":false,"preCaptureMs":2,"captureMs":376,"analysisMs":465,"padMs":0,"nativeElapsedMs":846,"roundTripMs":846,"timeoutClassification":"none","attemptGeneration":1145,"dispatchWaitMs":0,"resumeWaitMs":0,"closureWorkMs":843,"unattributedNativeMs":3,"transportMs":0,"asyncRuntimeMs":0,"captureWidth":2560,"captureHeight":1440,"capturedRealFrame":true}
```

Closure work rose ~20 % for 161 continuous seconds and `rust_wait` still never
exceeded 1 ms. That is a small but real stress test the harness did not ask for,
and the dispatch/resume path absorbed it without registering.

## Verdict

Two criteria were available. Both were evaluated; they agree.

**The caller's criterion**, from the goal document: `REPRODUCED` iff `rust_wait`
climbs monotonically to >= 10x its opening median; `NOT_REPRODUCED` iff flat
across the full 20 minutes.

This criterion is **degenerate as written**, and it must be said rather than
quietly worked around: the opening bucket median is **0 ms**, and 10 x 0 = 0, so
the reproduction threshold evaluates to zero and any record at all would clear
it. The healthy baseline is at the bottom of the measurement's resolution, so a
purely multiplicative threshold has nothing to multiply. The `NOT_REPRODUCED`
half of the same definition is not degenerate, is directly checkable, and is
satisfied literally: bucket median `rust_wait` is 0 ms in all 20 buckets, the
whole-run maximum is 1 ms, and the first- and last-quarter medians are both 0 ms.

**The pre-registered criterion**, written into the analyzer before the run to
supply the absolute bar the multiplicative one lacks: median `rust_wait`
>= 2000 ms in some 60 s bucket with closure work flat. Buckets meeting it: **0**.

```
BENCH: NOT_REPRODUCED
```

The verdict is `NOT_REPRODUCED` and not `BLOCKED`: the harness was built inside
the authorization, compiled with zero warnings of its own, and ran to completion.
The private-symbol seam limits the harness's fidelity, not its existence.

## What this result does and does not establish

**Establishes.** Over 20 continuous minutes, at the product's own 150 ms tick, at
the product's own throughput (750 ms inter-arrival against the live 704 ms
service interval), with the product's own bounds and the product's own
measurement points, elapsed time alone does not produce the collapse. Four
specific time-dependent mechanisms were live and none degraded:

1. **No blocking-pool queue growth.** `dispatch_wait_ms` max 1 ms over 1598
   dispatches. This is the direct consequence Phase 1 predicted from
   `MAX_CONCURRENT_CAPTURES = 4` and the JS outstanding cap of 1.
2. **No async-runtime starvation.** `resume_wait_ms` max 1 ms; heartbeat drift
   max 6 ms with zero dropped ticks in 1190 windows.
3. **No capture-resource leak.** `captureMs` median 56 ms at minute 0 and at
   minute 19; RSS ends the run *below* its median with no trend.
4. **No degradation of `sysinfo::System::new_all()`** — the one blocking FFI
   Phase 1 found in an async task body — across 800 calls: median 3 ms, max
   62 ms, none over 100 ms.

Point 4 does double duty. It is also the strongest available evidence *against*
Phase 1's leading remaining candidate, and it was produced by the arm of the
harness built specifically to test it.

**Does not establish.** That the product is healthy. A replica that cannot call
`probe_augment_surface` cannot exonerate `probe_augment_surface`. Three fidelity
gaps are large enough to name individually, and every one of them makes this
bench *milder* than the live condition:

- **No foreground game.** The live collapse ran with League saturating the CPU.
  The bench ran on an idle machine and never exceeded ~93 % of one core. The
  same `System::new_all()` measured **3 ms median here** was measured **flat at
  ~300 ms throughout the live collapse** (Phase 0) — a hundredfold difference in
  the cost of the single call most likely to matter. The bench's competing-load
  arm is therefore roughly two orders of magnitude lighter than the live one.
- **No Tauri IPC and no webview.** The live path crosses a webview boundary this
  harness does not have.
- **No real game window.** The foreground gate is dropped, so the branch that
  actually runs live — enumerate, match the League window, capture that window —
  is replaced by capture of the whole first monitor.

A negative result from a milder harness is a **bound on what has been ruled
out**, not a clean bill of health. What it rules out is precisely the
time-correlated hypothesis the caller posed: level 15 not being a real
precondition would have predicted a collapse here, and there was none.

## Consequence for the caller's hypothesis

The hypothesis was that the collapse is time-correlated rather than
round-correlated, on the grounds that the last current look landed at 624.3 s and
R3 opened 35.7 s later.

That framing is not settled by this run, because the run tests only one half of
it. Elapsed time **alone**, on this path, with no game, does not produce the
collapse — 20 minutes is longer than the 10.4 minutes at which the live onset
occurred, and nothing moved. What remains untested is elapsed time **in the
presence of the live load**, which is the only configuration in which the
collapse has ever been observed. The bench narrows the search away from the
geometry loop's own internal state and toward the interaction between that loop
and the game process, which is exactly where `CADENCE: SELECTIVE` already pointed.

## Phase 3 authorization evaluation

Product code may be modified only if **all four** conditions hold.

| # | Condition | Actual | Holds |
| --- | --- | --- | --- |
| 1 | `CADENCE: GLOBAL` | `CADENCE: SELECTIVE` (`phase0-cadence.md`) | **NO** |
| 2 | `Q1: YES` or `Q2: NO` | `Q1: NO` and `Q2: YES` (`phase1-static.md`) | **NO** |
| 3 | `BENCH: REPRODUCED` | `BENCH: NOT_REPRODUCED` | **NO** |
| 4 | An off-game red test that fails before and passes after | Not writable — see below | **NO** |

Condition 4 fails on the slice contract's own true-seam rule, independently of
the other three. There is no reproduction, so there is no failing behaviour for a
red test to assert against. Any test that could be made to fail today would have
to assert on something other than the proven defect — the *synthetic-green*
failure mode §5 exists to prevent. And per §5, when no fixture can reach the true
seam, the test is not written and the slice routes to the diagnostic branch.

Zero of four hold. **No product code was modified.** The caller's standing
instruction applies without qualification: with `CADENCE: SELECTIVE`, adding an
await timeout or a capture-stream rebuild is a guess, forbidden here regardless of
how plausible it looks, because a plausible guess that silently masks the symptom
destroys the only reproduction path that exists.

Live in-game verification remains a **HUMAN gate**. Nothing here is verified
against a live game, and nothing in this report should be read as claiming it is.

## Ledger

| Point | `/usr/bin/git rev-parse HEAD` | `/usr/bin/git status --porcelain \| wc -l` |
| --- | --- | --- |
| Start of Phase 2 | `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71` | 4 |
| End of Phase 2 | `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71` | 6 |

The count moved 4 to 6. Both additions are this phase's own authorized new
files — `overlay/src-tauri/examples/geometry_dispatch_bench.rs` and
`overlay/scripts/analyze-geometry-bench.mjs` — and neither is a tracked file.
This is drift caused by the slice, not drift found in the worktree, so it is not
the `R34 SLICE BLOCKED` condition. No git write ran; every git invocation used
`/usr/bin/git`.
