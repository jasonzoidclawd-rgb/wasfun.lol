# Phase 1 — root cause

Static analysis first, then quantified against the pinned trace. Every number
below is computed from `.codex/evidence/round34-live/trace.timestamped.jsonl`
(434 `[geometry-timing]` records, 2291 `[foreground-poll]` records).

## 1. Where is the unmeasured time?

### The full round trip and what each timer covers

| # | Segment | Timer | Covered? |
| --- | --- | --- | --- |
| 1 | `geometryProbeTick` → `nextProbeAction` (`surfaceProbeScheduler.ts:158`) | — | pure reducer, no I/O |
| 2 | `runGeometryProbe` (`App.tsx:1905`); `startedAt = performance.now()` (`:1910`) | starts `roundTripMs` | — |
| 3 | `await invoke("probe_augment_surface")` (`App.tsx:1938`) → Rust command body entry | **UNMEASURED** | ✗ |
| 4 | `probe_augment_surface` body entry; `start = Instant::now()` (`lib.rs:1494`) | starts `elapsed_ms` | — |
| 5 | `CapturePermit::try_acquire` (`lib.rs:872`) | **UNMEASURED** | atomic CAS, non-blocking |
| 6 | `tokio::task::spawn_blocking` (`lib.rs:874`) queueing until the closure runs | **UNMEASURED** | ✗ |
| 7 | `capture_surface_frame` foreground gate + monitors + locator + calibration | `pre_capture_ms` (`lib.rs:1423`) | ✓ |
| 8 | `monitor.capture_image()` | `capture_ms` (`lib.rs:1434`) | ✓ |
| 9 | `surface_probe::analyze_surface` | `analysis_ms` (`lib.rs:1484`) | ✓ |
| 10 | closure returns → `timeout(...).await` resumes on a tokio worker | **UNMEASURED** | ✗ |
| 11 | `observation.elapsed_ms = start.elapsed()` (`lib.rs:1524`), command returns | ends `elapsed_ms` | — |
| 12 | Rust return → JS promise resolution; `completedAt` (`App.tsx:1946`) | ends `roundTripMs` | — |

Two derived quantities isolate the unmeasured segments exactly:

```
rust_wait  = nativeElapsedMs − (preCaptureMs + captureMs + analysisMs)   # segments 5,6,10
transport  = roundTripMs     −  nativeElapsedMs                          # segments 3,12
```

### The measurement

| Band | n | closure work (7+8+9) | `rust_wait` | `transport` |
| --- | --- | --- | --- | --- |
| healthy `0–545 s` | 384 | med **703** max 1506 | med **1** max 126 | med **15** max 423 |
| onset `545–600 s` | 22 | med **751** max 962 | med **550** max 2756 | med **443** max 2281 |
| `600–700 s` | 12 | med **709** max 768 | med **5337** max 12593 | med **6268** max 10862 |
| `700–1000 s` | 11 | med **741** max 1046 | med **27385** max 46001 | med **23509** max 42113 |
| `1000 s–end` | 5 | med **714** max 1029 | med **73690** max **166522** | med **62637** max **137477** |

**The closure's own work is flat — median 703 ms at the start, 714 ms at the
end.** Capture and analysis never degrade. `rust_wait` grows by a factor of
~166,000 and `transport` by ~9,000. Peak `nativeElapsedMs` 167,551 ms; peak
`roundTripMs` 305,028 ms.

### Mechanism statement

`rust_wait` and `transport` are, between them, **exactly the segments that
require a tokio async-runtime worker to poll a task**:

- segment 3 = the Tauri IPC dispatching the command future onto the runtime;
- segment 6/10 = the `timeout(worker)` future being polled to completion after
  the blocking closure has finished;
- segment 12 = the response returning to the webview.

Segments 7–9 run on the **blocking pool** (`spawn_blocking`, `lib.rs:874`) and
stay healthy throughout. So the lost time is not queueing on capture, not
locking, not the window server, and not analysis. **It is scheduling latency on
the tokio async runtime, and only there.**

Enumerated shared resources, each checked and eliminated:

- `GEOMETRY_CAPTURE_IN_FLIGHT` (`lib.rs:803`) — atomic, `try_acquire` is
  non-blocking and returns `Busy` immediately. Not a wait.
- `PROCESS_PRESENCE_CACHE` mutex (`lib.rs:2153`) — explicitly never held across
  the enumeration (`lib.rs:2178-2182`). Not a wait.
- Blocking pool saturation — would delay segment 6, but then
  `tokio::time::timeout(1500 ms)` would fire and return `Err(Timeout)` →
  `absent_surface_observation` with `capture_ms`/`analysis_ms` **zero**. All 19
  probes ≥ 10 s carry non-zero sub-phases, so the closure ran. Eliminated.
- JS main-thread stall — would inflate `roundTripMs` only; `nativeElapsedMs` is
  taken inside Rust and also explodes. Eliminated.

### Correction to pinned fact 6 — a category error, not evidence

Pinned fact 6 reads the healthy foreground poll as proof that "small native
calls remained healthy; the degradation is specific to the capture path."
**That inference does not hold.** The two commands run on different executors:

- `probe_augment_surface` — `#[tauri::command] async fn` (`lib.rs:1490`) → tokio async runtime.
- `get_foreground_state` — `#[tauri::command] fn` (`lib.rs:2323`, sync) → main thread, never touches the async runtime.

Measured `[foreground-poll]` `nativeMs` (median / max): healthy `130–400 s`
**12 / 450**; R3 window **14 / 309**; R4 window **12 / 357**; deep tail
`1100 s+` **10 / 465**. The foreground poll is flat because it measures the
**main thread**, which was never the problem. It provides no information about
the async runtime and therefore does not exonerate it.

### Correction to pinned fact 3 — probe 484 is a measurement artifact

Pinned fact 3 reads probe 484 (`preCaptureMs 214752`, `captureMs`/`analysisMs`
0) as an inversion showing the foreground walk itself taking 214 s. It is not.
On the error path `probe_augment_surface` returns
`absent_surface_observation(..., start.elapsed())` (`lib.rs:1506-1511`), and
that constructor sets **`pre_capture_ms: elapsed_ms`** with `capture_ms: 0`,
`analysis_ms: 0` (`lib.rs:1391-1394`). So `preCaptureMs` there is simply a copy
of the total command elapsed. Probe 484 is the same starvation on the
game-ended error path — not a slow window-server walk.

## 2. Why does recovery never restore?

`.codex/evidence/native-recovery-gate/contract.md` states the intended AFTER
behavior: a presumed-wedged call no longer blocks all geometry work; exactly one
replacement is admitted (hard ceiling 2); "a subsequent healthy probe is
accepted … and re-opens render eligibility."

The replacement is issued by `nextProbeAction` returning `{kind:"start"}` once
`now − oldestNativeStartedAt >= WEDGED_NATIVE_PROBE_MS` raises the cap to
`MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT = 2`
(`surfaceProbeScheduler.ts:165-172`). The caller then runs
`runGeometryProbe` → `invoke("probe_augment_surface")` (`App.tsx:1938`).

**The replacement is another `async fn` command dispatched onto the same
starved tokio runtime as the call it replaces.** It does not contend for the
capture permit (the geometry channel allows 4, `lib.rs:798`, and JS caps at 2),
and it does not contend for any mutex. It contends for the one resource that is
actually scarce: async-executor scheduling. It therefore inherits the same
60–200 s dispatch wait.

This is exactly what all three games show: the cap holds (`nativeOutstanding`
never exceeds 2, pinned fact 5) and health never returns (watchdog abandons
21 / 19 / 37). The recovery slice is not mis-tuned — it is **structurally
incapable of working**, because it replaces the *logical request* while the
*starved resource* is the executor. No threshold value fixes that.

Corroborating: the last accepted geometry in run-B is `geometrySequence 459` at
`elapsedMs 624275` (last `[geometry-recovery]`, last `stale:false`
`[offer-session]`). For the remaining ~878 s, every returned probe is
`stale:true` and rejected at `geometry-currentness` — each new probe supersedes
the previous sequence long before the previous one returns, so goodput is
pinned at exactly zero.

## 3. Why is `timeoutClassification` "none" at 165 s?

Two independent blind spots, both proven:

**(a) Rust cannot report the timeout.** `run_bounded_capture_with_gate` wraps
the worker in `tokio::time::timeout(NATIVE_CAPTURE_TIMEOUT = 1500 ms, worker)`
(`lib.rs:884`). `Timeout::poll` polls the **inner future first** and only checks
the deadline when the inner is `Pending`. A task that is not polled for 165 s is
eventually woken by the worker's completion; at that poll the inner future is
already `Ready`, so `timeout` returns `Ok` and the elapsed deadline is never
examined. Under executor starvation the timeout is structurally unreachable —
the same failure the code already documents at `lib.rs:1408-1413`: *"on the
runtime it starved the executor so the capture timeout could not fire."*

**(b) The JS field is not a timeout classifier.** `App.tsx:2052-2055`:

```ts
timeoutClassification:
  captureValid
    ? "none"
    : observation.rejectionReasons[0] ?? "capture-invalid",
```

`captureValid` is `captureWidth > 0 && captureHeight > 0` (`App.tsx:1958`). The
expression **has no elapsed-time input at all**. Any probe that returns pixels
is labelled `"none"` regardless of whether it took 700 ms or 167 s. Verified
across all 434 records: the field only ever takes `"none"` or
`"capture-timeout"`, and **all 19 probes with `nativeElapsedMs ≥ 10 s` are
labelled `"none"`.**

Scope: (b) is labelling-only — it feeds no scheduler or watchdog decision (the
scheduler reads `inFlightSince`/`nativeOutstanding`/`oldestNativeStartedAt`,
never this field). It is a genuine ≤10-line fix but, per the Phase-1 rule, it
is **not on the causal path**, so it is documented as follow-up rather than
taken in a slice that changes nothing else.

## 4. When does degradation start, and what correlates?

Onset is sharp and datable from `rust_wait`, which is ≤ 3 ms for essentially the
whole healthy period:

```
seq 431 t=545141  rust_wait     1      <- last healthy
seq 432 t=546236  rust_wait    22
seq 433 t=547245  rust_wait    39
seq 434 t=548341  rust_wait    66
seq 435 t=549698  rust_wait   114
seq 436 t=551893  rust_wait   248
seq 437 t=555098  rust_wait  1294
```

**Onset ≈ `t = 546 s`** (`geometrySequence 432`).

Correlation against the candidate triggers — all three are negative:

| Event | Time | Relation to onset (546 s) |
| --- | --- | --- |
| **R2 advance** (`geometrySequence 266`) | 384 442 | onset is **162 s later**. Not coincident. Fresh `absent` classifications continue normally for 162 s after R2. |
| **Last identity OCR** (`detect_augment_names`, runId 8) | 392 997 | onset is **153 s later**; all 8 OCR runs completed fast (833–1605 ms). Not coincident. |
| **First LCU `liveDataStatus` flap** (ready→unavailable) | 600 839 | onset **precedes it by 55 s**. The LCU flapping is a consequence or a coincidence, **not** the trigger. |

This is an important negative result: the collapse is **not** triggered by round
2, by the OCR path, or by LCU telemetry loss. Nothing in the pinned artifacts
identifies what begins occupying the async runtime at `t ≈ 546 s`.

## 5. Scope assessment — and why this slice stops here

### What is proven

1. The lost time is async-runtime scheduling latency, quantified per probe and
   bounded away from capture, analysis, locking, and the window server.
2. The bounded-replacement recovery is structurally incapable of restoring
   health, because it re-queues on the starved resource.
3. Rust's `tokio::time::timeout` cannot fire under this starvation.
4. `App.tsx`'s `timeoutClassification` is a capture-validity label with no
   elapsed input.
5. Two pinned facts (3 and 6) rest on measurement artifacts and are corrected
   above.

### What is NOT proven

**Which async task occupies the tokio runtime from `t ≈ 546 s`.** The build
contains no instrument that observes the async runtime, and the pinned
artifacts contain no signal that identifies it. Static analysis narrowed the
candidates and eliminated every one that the evidence can reach:

- `detect_augment_names` (`lib.rs:1218`, `async fn`) calls
  `collect_foreground_state()` **directly on the async task** at `lib.rs:1220` —
  the exact pattern `capture_surface_frame` was fixed to avoid, with the
  comment naming executor starvation as the consequence. This is a **real
  latent defect and should be fixed**, but it is **not run-B's trigger**: the
  last OCR run completed at 392 997, 153 s before onset, and all 8 runs
  returned in under 1.7 s.
- OCR recognition routes through `spawn_blocking`
  (`run_bounded_ocr_recognition` → `run_bounded_capture_with_gate`,
  `lib.rs:919`) — off the runtime. Eliminated.
- The macOS level re-assert loop (`lib.rs:2472`) is a dedicated OS thread, not
  a tokio task. The Windows loop (`lib.rs:2527`) is `#[cfg(target_os = "windows")]`
  and inactive on this run. Eliminated.
- The game poll is single-flight (`pollInFlightRef`, `App.tsx:3535-3539`), so
  LCU/live-data invokes cannot pile up. Eliminated.

### Why no code change is proposed

For Round 3/4 to be captured, a probe must return **current** geometry inside
the offer window. Under 60–200 s round trips that is impossible, so any real
repair must restore sub-second async dispatch. Every available route to that
is out of bounds for this slice:

- **Fix the blocking agent** — requires identifying it; not possible from the
  pinned artifacts.
- **Raise `NATIVE_CAPTURE_TIMEOUT` / `PROBE_TIMEOUT_MS` / `WEDGED_NATIVE_PROBE_MS`** —
  explicitly forbidden as a primary fix, and provably useless here: the timeout
  cannot fire under starvation at *any* value.
- **Take geometry off the shared async runtime** (dedicated capture thread with
  its own channel, or a sync command handing back a handle) — this is precisely
  the *capture-stack redesign* the Phase-1 rule names as the PAUSED trigger, and
  `overlay-v1-product-contract.md:269` lists "a rewrite of the native capture,
  geometry, or OCR stack" as an explicit V1 non-goal.
- **Fix only the classifier blind spot** — honest labelling, but it repairs
  nothing; R3/R4 would still not be captured. It would produce a green slice
  that does not meet the primary goal.

A fix chosen without knowing the blocking agent would be speculative, and a
speculative change to the geometry scheduler is exactly the class of change
that has already shipped once (the native-recovery slice) and failed in three
consecutive live games.

**Terminal state: PAUSED.** No production file, test file, or repository file
was modified. Recommended next slice is below.

## 6. Recommended next slice (for operator approval)

**A diagnostic-only slice that instruments the async runtime**, mirroring the
round34 acquisition-diagnostic slice's shape (observe first, fix second):

1. In `probe_augment_surface`, record a timestamp immediately before
   `spawn_blocking` and immediately after the `timeout(...).await` resumes, and
   ship both as fields on `SurfaceObservation`. That splits today's opaque
   `rust_wait` into *dispatch-to-closure* vs *closure-to-resume* and settles
   segment 6 vs segment 10 in one game.
2. Emit a periodic heartbeat from a plain `tokio::spawn`ed task (e.g. 250 ms
   tick, log observed interval). Its drift **is** a direct measurement of
   async-runtime starvation, independent of any capture.
3. Replace the `timeoutClassification` expression at `App.tsx:2052-2055` with
   one that takes `roundTripMs` into account, so a 165 s probe can never again
   be labelled `"none"` (≤10 lines).
4. Independently of the above — and worth doing on its own merits — move the
   `collect_foreground_state()` call at `lib.rs:1220` inside the bounded
   capture, exactly as `capture_surface_frame` does at `lib.rs:1414`. It is a
   latent executor-starvation defect even though it did not trigger run-B.

Items 1–2 are what turn the next controlled game into a decisive experiment.
Only after the blocking agent is named can a minimal, testable repair be
written.
