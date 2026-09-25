//! Off-game bench for the geometry dispatch/resume collapse (slice
//! `overlay-r34-shortest`, Phase 2).
//!
//! # Why this exists
//!
//! Exactly one recorded run in existence reaches Round 3 or Round 4, and it
//! predates the dispatch/resume instrumentation. Acquiring another costs a
//! ~25-minute live Mayhem game that has to survive to the late rounds. This
//! harness replaces that with `cargo run --example geometry_dispatch_bench`,
//! needs no League process, and emits the SAME record schema as the product
//! path so the existing analysis applies unchanged.
//!
//! # What it does NOT do
//!
//! It does not import the product's capture path. `probe_augment_surface`,
//! `run_bounded_capture_with_gate`, `capture_surface_frame` and
//! `GEOMETRY_CAPTURE_IN_FLIGHT` are all private to `lib.rs`, and this slice
//! forbids modifying product source to widen them. What follows is therefore a
//! REPLICA: every constant, ordering and measurement point is copied from the
//! cited product site, and every deliberate difference is listed under
//! "Substitutions" below. A replica can demonstrate a mechanism; it cannot
//! prove the product is free of one. Read a NOT_REPRODUCED result with that in
//! mind.
//!
//! # Replicated exactly (site -> value)
//!
//! | Product site | Constant |
//! | --- | --- |
//! | `overlay/src/surfaceGeometry.ts:30` | tick interval 150 ms (NOT the 250 ms `PROBE_INTERVAL_MS` default, which `App.tsx:228-232` overrides) |
//! | `overlay/src/surfaceProbeScheduler.ts:34` | logical watchdog 2000 ms, abandon-without-replacement |
//! | `overlay/src/surfaceProbeScheduler.ts:59` | `MAX_OUTSTANDING_NATIVE_PROBES` 1 |
//! | `overlay/src/surfaceProbeScheduler.ts:69` | `WEDGED_NATIVE_PROBE_MS` 4000 |
//! | `overlay/src/surfaceProbeScheduler.ts:79` | wedged cap 2 |
//! | `overlay/src-tauri/src/lib.rs:790` | `NATIVE_CAPTURE_TIMEOUT` 1500 ms |
//! | `overlay/src-tauri/src/lib.rs:798` | `MAX_CONCURRENT_CAPTURES` 4 |
//! | `overlay/src-tauri/src/lib.rs:873-884` | permit CAS -> `spawn_blocking` -> `timeout(worker).await` |
//! | `overlay/src-tauri/src/lib.rs:1516`, `:1551` | `dispatch_wait_ms` / `resume_wait_ms` measurement points |
//! | `overlay/src-tauri/src/lib.rs:2179`, `:2211` | 5 s-TTL `sysinfo::System::new_all()` presence walk |
//! | `overlay/src-tauri/src/lib.rs:2398-2434` | 250 ms heartbeat, 1 s aggregation |
//! | `overlay/src/App.tsx:3942-3944` | 1500 ms game poll |
//! | `overlay/src-tauri/src/lib.rs:117-126`, `lcu.rs:145`, `lcu.rs:24` | that poll calling `System::new_all()` DIRECTLY in an async task body |
//! | `tauri-2.10.3/src/async_runtime.rs:213-220` | `tokio::runtime::Runtime::new()`, i.e. multi-thread, one worker per core |
//!
//! The two tickers run on ORDINARY OS THREADS, not on the runtime. That is not
//! a shortcut — it is the fidelity requirement. In the product the clock is a
//! webview `setInterval` that Phase 0 proved keeps firing to the millisecond
//! while the runtime is 73 s behind. A ticker implemented as a tokio task would
//! stall with the runtime it is supposed to be probing and would silently
//! measure nothing. The heartbeat is the one loop that MUST be a tokio task,
//! for the same reason and in the opposite direction.
//!
//! # Substitutions (all deliberate, none load-bearing for the verdict)
//!
//! 1. No Tauri IPC. `transportMs` here is pre-first-poll scheduling latency
//!    only (issue -> the spawned future's first statement); the product's also
//!    includes webview<->host serialization. This UNDER-reports, never over.
//! 2. No foreground gate. Without League, `capture_surface_frame` would return
//!    `actual-game-window-not-foreground` in microseconds and no closure work
//!    would happen at all. The window/monitor enumeration that dominates
//!    `pre_capture_ms` is kept; the game-window predicate is dropped.
//! 3. Closure work is padded to `CLOSURE_WORK_TARGET_MS` when the real work
//!    lands under it. Blocking-pool occupancy is the property that matters for
//!    dispatch/resume latency, and the product's measured median is 703 ms
//!    (`.codex/gates/overlay-collapse-fix/phase1-root-cause.md`). Every record
//!    reports `padMs` so a reader can subtract it.
//! 4. Records go to stdout via `println!`. The product routes them through
//!    `console.info` plus an `eprintln!` IPC bridge.
//!
//! # Compliance
//!
//! No game process is launched, read, or automated. No hidden information is
//! accessed. The only capture is of the operator's own screen, by the same
//! `xcap` call the shipped overlay already makes, and it is analyzed in memory
//! and discarded — nothing is written to disk or transmitted.
//!
//! # Usage
//!
//! ```text
//! cd overlay/src-tauri
//! cargo run --example geometry_dispatch_bench -- 20 > bench.jsonl
//! node ../scripts/analyze-geometry-bench.mjs bench.jsonl
//! ```
//!
//! The argument is the run length in minutes (default 20).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mayhem_oracle_lib::calibration::{physical_card_rects, Rect};
use mayhem_oracle_lib::surface_probe::analyze_surface;

// ─── Replicated constants ───────────────────────────────────────────────────

/// `overlay/src/surfaceGeometry.ts:30` — the interval `App.tsx:3376-3381`
/// actually ticks on.
const GEOMETRY_INTERVAL_MS: u64 = 150;
/// `overlay/src/surfaceProbeScheduler.ts:34`.
const PROBE_TIMEOUT_MS: u64 = 2_000;
/// `overlay/src/surfaceProbeScheduler.ts:69`.
const WEDGED_NATIVE_PROBE_MS: u64 = 4_000;
/// `overlay/src/surfaceProbeScheduler.ts:59`.
const MAX_OUTSTANDING_NATIVE_PROBES: usize = 1;
/// `overlay/src/surfaceProbeScheduler.ts:79`.
const MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT: usize = 2;
/// `overlay/src-tauri/src/lib.rs:790`.
const NATIVE_CAPTURE_TIMEOUT: Duration = Duration::from_millis(1_500);
/// `overlay/src-tauri/src/lib.rs:798`.
const MAX_CONCURRENT_CAPTURES: usize = 4;
/// `overlay/src-tauri/src/lib.rs:2179`.
const PROCESS_PRESENCE_TTL: Duration = Duration::from_millis(5_000);
/// `overlay/src-tauri/src/lib.rs:2410` (`HEARTBEAT_TICK_MS`).
const HEARTBEAT_TICK_MS: u64 = 250;
/// `overlay/src-tauri/src/lib.rs:2413` (`HEARTBEAT_REPORT_MS`).
const HEARTBEAT_REPORT_MS: u64 = 1_000;
/// `overlay/src/App.tsx:3942-3944`.
const GAME_POLL_INTERVAL_MS: u64 = 1_500;
/// Product median closure work, `phase1-root-cause.md` band `0-545 s`.
const CLOSURE_WORK_TARGET_MS: u64 = 703;

// ─── Capture permit — replica of `lib.rs:828-860` ───────────────────────────

static GEOMETRY_CAPTURE_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

struct CapturePermit {
    in_flight: &'static AtomicUsize,
}

impl CapturePermit {
    fn try_acquire(in_flight: &'static AtomicUsize, max: usize) -> Option<Self> {
        let mut current = in_flight.load(Ordering::Acquire);
        loop {
            if current >= max {
                return None;
            }
            match in_flight.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self { in_flight }),
                Err(actual) => current = actual,
            }
        }
    }
}

impl Drop for CapturePermit {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::Release);
    }
}

// ─── Closure work — replica of `capture_surface_frame` + `analyze_surface` ──

/// Replica of the 5 s-TTL presence cache at `lib.rs:2193-2223`, including the
/// property that makes it safe there: the lock is never held across the walk.
static PRESENCE_CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

fn cached_process_presence() -> bool {
    let cached = { *PRESENCE_CACHE.lock().unwrap_or_else(|e| e.into_inner()) };
    if let Some((stamp, value)) = cached {
        if stamp.elapsed() < PROCESS_PRESENCE_TTL {
            return value;
        }
    }
    let system = sysinfo::System::new_all();
    let running = system.processes().len() > 0;
    let mut guard = PRESENCE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some((Instant::now(), running));
    running
}

struct ClosureTimings {
    pre_capture_ms: u64,
    capture_ms: u64,
    analysis_ms: u64,
    pad_ms: u64,
    capture_width: u32,
    capture_height: u32,
    captured_real_frame: bool,
}

fn closure_work(probe_seq: u64) -> ClosureTimings {
    let start = Instant::now();

    // pre-capture: the enumeration half of `capture_surface_frame`
    // (`lib.rs:1409-1419`) — presence walk, monitor list, window list.
    let _ = cached_process_presence();
    let _ = xcap::Window::all().map(|windows| windows.len()).unwrap_or(0);
    let monitors = xcap::Monitor::all().ok();
    let pre_capture_ms = start.elapsed().as_millis() as u64;

    // capture: `lib.rs:1421-1424`.
    let capture_started = Instant::now();
    let frame = monitors
        .and_then(|list| list.into_iter().next())
        .and_then(|monitor| monitor.capture_image().ok());
    let capture_ms = capture_started.elapsed().as_millis() as u64;

    let (image, viewport, captured_real_frame) = match frame {
        Some(rgba) => {
            let (width, height) = (rgba.width(), rgba.height());
            (
                image::DynamicImage::ImageRgba8(rgba),
                Rect {
                    x: 0,
                    y: 0,
                    width,
                    height,
                },
                true,
            )
        }
        // Screen Recording permission is granted per binary on macOS, and
        // `cargo run --example` produces a binary the OS has never seen. A
        // denied capture must degrade to a synthetic frame rather than abort
        // the run — the record reports `capturedRealFrame:false` so the
        // analysis can say so out loud.
        None => (
            image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                1920,
                1080,
                image::Rgb([18, 18, 22]),
            )),
            Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            false,
        ),
    };

    // analysis: `lib.rs:1478-1480`.
    let analysis_started = Instant::now();
    let rects = physical_card_rects(&viewport);
    let bands = [rects[0].clone(), rects[1].clone(), rects[2].clone()];
    let observation = analyze_surface(&image, &viewport, &bands, probe_seq, 0.0, 0);
    std::hint::black_box(&observation);
    let analysis_ms = analysis_started.elapsed().as_millis() as u64;

    // Pad to the product's measured occupancy. See Substitution 3.
    let pad_started = Instant::now();
    let done = start.elapsed().as_millis() as u64;
    if done < CLOSURE_WORK_TARGET_MS {
        let deadline = Duration::from_millis(CLOSURE_WORK_TARGET_MS - done);
        let mut acc: u64 = probe_seq;
        while pad_started.elapsed() < deadline {
            for _ in 0..4_096 {
                acc = acc.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            }
            std::hint::black_box(acc);
        }
    }
    let pad_ms = pad_started.elapsed().as_millis() as u64;

    ClosureTimings {
        pre_capture_ms,
        capture_ms,
        analysis_ms,
        pad_ms,
        capture_width: image.width(),
        capture_height: image.height(),
        captured_real_frame,
    }
}

// ─── Shared scheduler state ─────────────────────────────────────────────────

#[derive(Default)]
struct ProbeState {
    /// `App.tsx:527` `geometryNativeStartsRef` — seq -> start instant.
    starts: Mutex<HashMap<u64, Instant>>,
    /// `App.tsx:3211` `nativeOutstanding`.
    outstanding: AtomicUsize,
    /// `App.tsx` `geometryInFlightTokenRef` / `geometryInFlightSinceRef`.
    in_flight: Mutex<Option<(u64, Instant)>>,
}

impl ProbeState {
    fn oldest_native_start(&self) -> Option<Instant> {
        self.starts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .min()
            .copied()
    }

    /// Clear the in-flight token only when it is still OURS — the product's
    /// token check, which is what stops a late settle from releasing a guard
    /// the watchdog already handed to a replacement.
    fn release_if_current(&self, probe_seq: u64) {
        let mut guard = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*guard, Some((seq, _)) if seq == probe_seq) {
            *guard = None;
        }
    }

    fn settle(&self, probe_seq: u64) {
        self.starts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&probe_seq);
        self.outstanding.fetch_sub(1, Ordering::Release);
        self.release_if_current(probe_seq);
    }
}

fn ms_since(base: Instant) -> u64 {
    base.elapsed().as_millis() as u64
}

// ─── The probe task — replica of `probe_augment_surface` (`lib.rs:1485-1553`) ─

async fn run_probe(state: Arc<ProbeState>, probe_seq: u64, issued_at: Instant, bench_start: Instant) {
    // First statement of the spawned future: everything before this is the
    // runtime's own pre-first-poll scheduling latency, which in the product
    // lands inside `transportMs` (`lib.rs:1510-1512`).
    let transport_ms = ms_since(issued_at);
    let start = Instant::now();

    let Some(permit) = CapturePermit::try_acquire(&GEOMETRY_CAPTURE_IN_FLIGHT, MAX_CONCURRENT_CAPTURES)
    else {
        emit_absent(bench_start, probe_seq, ms_since(start), transport_ms, "geometry-capture-busy");
        state.settle(probe_seq);
        return;
    };

    let worker = tokio::task::spawn_blocking(move || {
        // `lib.rs:1516` — command entry to closure body start.
        let dispatch_wait_ms = ms_since(start);
        let _permit = permit;
        let timings = closure_work(probe_seq);
        // `lib.rs:1518-1519` — closure body end, still on the same clock.
        let closure_end_ms = ms_since(start);
        (timings, dispatch_wait_ms, closure_end_ms)
    });

    match tokio::time::timeout(NATIVE_CAPTURE_TIMEOUT, worker).await {
        Ok(Ok((timings, dispatch_wait_ms, closure_end_ms))) => {
            let native_elapsed_ms = ms_since(start);
            // `lib.rs:1551` — saturating, for the same truncation reason.
            let resume_wait_ms = native_elapsed_ms.saturating_sub(closure_end_ms);
            let closure_work_ms =
                timings.pre_capture_ms + timings.capture_ms + timings.analysis_ms + timings.pad_ms;
            let unattributed_native_ms = native_elapsed_ms
                .saturating_sub(closure_work_ms + dispatch_wait_ms + resume_wait_ms);
            println!(
                "[geometry-timing] {{\"benchElapsedMs\":{},\"probeSeq\":{},\"stale\":false,\
                 \"preCaptureMs\":{},\"captureMs\":{},\"analysisMs\":{},\"padMs\":{},\
                 \"nativeElapsedMs\":{},\"roundTripMs\":{},\"timeoutClassification\":\"none\",\
                 \"attemptGeneration\":{},\"dispatchWaitMs\":{},\"resumeWaitMs\":{},\
                 \"closureWorkMs\":{},\"unattributedNativeMs\":{},\"transportMs\":{},\
                 \"asyncRuntimeMs\":{},\"captureWidth\":{},\"captureHeight\":{},\
                 \"capturedRealFrame\":{}}}",
                ms_since(bench_start),
                probe_seq,
                timings.pre_capture_ms,
                timings.capture_ms,
                timings.analysis_ms,
                timings.pad_ms,
                native_elapsed_ms,
                native_elapsed_ms + transport_ms,
                probe_seq,
                dispatch_wait_ms,
                resume_wait_ms,
                closure_work_ms,
                unattributed_native_ms,
                transport_ms,
                resume_wait_ms + transport_ms,
                timings.capture_width,
                timings.capture_height,
                timings.captured_real_frame,
            );
        }
        Ok(Err(_)) => emit_absent(
            bench_start,
            probe_seq,
            ms_since(start),
            transport_ms,
            "geometry-capture-worker-failed",
        ),
        Err(_) => emit_absent(
            bench_start,
            probe_seq,
            ms_since(start),
            transport_ms,
            "capture-timeout",
        ),
    }

    state.settle(probe_seq);
}

/// Replica of `absent_surface_observation` (`lib.rs:1382-1391`): on the error
/// path `pre_capture_ms` is a COPY of total elapsed and the sub-phases are
/// zero. Reproduced exactly, because a reader who knows the product will
/// otherwise misread these records as a slow enumeration.
fn emit_absent(bench_start: Instant, probe_seq: u64, elapsed_ms: u64, transport_ms: u64, reason: &str) {
    println!(
        "[geometry-timing] {{\"benchElapsedMs\":{},\"probeSeq\":{},\"stale\":true,\
         \"preCaptureMs\":{},\"captureMs\":0,\"analysisMs\":0,\"padMs\":0,\
         \"nativeElapsedMs\":{},\"roundTripMs\":{},\"timeoutClassification\":\"{}\",\
         \"attemptGeneration\":{},\"dispatchWaitMs\":0,\"resumeWaitMs\":0,\
         \"closureWorkMs\":{},\"unattributedNativeMs\":0,\"transportMs\":{},\
         \"asyncRuntimeMs\":{},\"captureWidth\":0,\"captureHeight\":0,\
         \"capturedRealFrame\":false}}",
        ms_since(bench_start),
        probe_seq,
        elapsed_ms,
        elapsed_ms,
        elapsed_ms + transport_ms,
        reason,
        probe_seq,
        elapsed_ms,
        transport_ms,
        transport_ms,
    );
}

// ─── Competing async load — replica of `lib.rs:117-126` + `lcu.rs:145` ──────

/// The one blocking FFI the product runs DIRECTLY in an async task body:
/// `get_lcu_gameflow_state` -> `discover_lcu_credentials` ->
/// `SysinfoLeagueProcessProvider::league_processes` -> `System::new_all()`.
/// Uncached, on the runtime, once per 1.5 s game poll.
async fn run_game_poll(bench_start: Instant) {
    let started = Instant::now();
    let system = sysinfo::System::new_all();
    let count = system.processes().len();
    println!(
        "[bench-game-poll] {{\"benchElapsedMs\":{},\"sysinfoMs\":{},\"processCount\":{}}}",
        ms_since(bench_start),
        ms_since(started),
        count
    );
}

/// Replica of `spawn_async_runtime_heartbeat` (`lib.rs:2398-2434`). Must be a
/// tokio task on the runtime under test; a thread with `std::thread::sleep`
/// would stay on time while the runtime burned and would measure nothing.
async fn run_heartbeat(bench_start: Instant) {
    let mut window_started = Instant::now();
    let mut last_tick = window_started;
    let mut ticks: u64 = 0;
    let mut max_drift_ms: u64 = 0;
    loop {
        tokio::time::sleep(Duration::from_millis(HEARTBEAT_TICK_MS)).await;
        let now = Instant::now();
        let observed_ms = now.duration_since(last_tick).as_millis() as u64;
        last_tick = now;
        let last_drift_ms = observed_ms.saturating_sub(HEARTBEAT_TICK_MS);
        max_drift_ms = max_drift_ms.max(last_drift_ms);
        ticks = ticks.saturating_add(1);
        let elapsed_ms = now.duration_since(window_started).as_millis() as u64;
        if elapsed_ms >= HEARTBEAT_REPORT_MS {
            println!(
                "[async-runtime-heartbeat] {{\"benchElapsedMs\":{},\"intervalMs\":{},\
                 \"ticks\":{},\"expectedTicks\":{},\"maxDriftMs\":{},\"lastDriftMs\":{},\
                 \"elapsedMs\":{}}}",
                ms_since(bench_start),
                HEARTBEAT_TICK_MS,
                ticks,
                elapsed_ms / HEARTBEAT_TICK_MS,
                max_drift_ms,
                last_drift_ms,
                elapsed_ms
            );
            window_started = now;
            ticks = 0;
            max_drift_ms = 0;
        }
    }
}

// ─── Tickers (OS threads — see the fidelity note in the module docs) ────────

/// Replica of `nextProbeAction` (`surfaceProbeScheduler.ts:158-190`), including
/// the abandon branch that issues NO replacement and does NOT advance the
/// sequence.
fn geometry_tick(
    state: &Arc<ProbeState>,
    handle: &tokio::runtime::Handle,
    next_seq: &mut u64,
    bench_start: Instant,
) {
    let now = Instant::now();

    {
        let mut guard = state.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((seq, since)) = *guard {
            if now.duration_since(since).as_millis() as u64 >= PROBE_TIMEOUT_MS {
                println!(
                    "[geometry-watchdog] {{\"benchElapsedMs\":{},\"probeSeq\":{},\
                     \"inFlightMs\":{},\"nativeOutstanding\":{},\"action\":\"abandon\"}}",
                    ms_since(bench_start),
                    seq,
                    now.duration_since(since).as_millis() as u64,
                    state.outstanding.load(Ordering::Acquire)
                );
                *guard = None;
            }
            return;
        }
    }

    let wedged = state
        .oldest_native_start()
        .is_some_and(|oldest| now.duration_since(oldest).as_millis() as u64 >= WEDGED_NATIVE_PROBE_MS);
    let cap = if wedged {
        MAX_OUTSTANDING_WITH_WEDGED_REPLACEMENT
    } else {
        MAX_OUTSTANDING_NATIVE_PROBES
    };
    if state.outstanding.load(Ordering::Acquire) >= cap {
        return;
    }
    *next_seq += 1;
    let probe_seq = *next_seq;
    state
        .starts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(probe_seq, now);
    state.outstanding.fetch_add(1, Ordering::AcqRel);
    *state.in_flight.lock().unwrap_or_else(|e| e.into_inner()) = Some((probe_seq, now));

    let task_state = Arc::clone(state);
    let issued_at = Instant::now();
    handle.spawn(run_probe(task_state, probe_seq, issued_at, bench_start));
}

fn main() {
    let minutes: u64 = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(20);
    let total = Duration::from_secs(minutes * 60);

    let runtime = tokio::runtime::Runtime::new().expect("tokio multi-thread runtime");
    let handle = runtime.handle().clone();
    let bench_start = Instant::now();

    println!(
        "[bench-start] {{\"minutes\":{},\"tickIntervalMs\":{},\"closureTargetMs\":{},\
         \"workerThreads\":{},\"nativeCaptureTimeoutMs\":{},\"maxConcurrentCaptures\":{}}}",
        minutes,
        GEOMETRY_INTERVAL_MS,
        CLOSURE_WORK_TARGET_MS,
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(0),
        NATIVE_CAPTURE_TIMEOUT.as_millis(),
        MAX_CONCURRENT_CAPTURES
    );

    handle.spawn(run_heartbeat(bench_start));

    // Game poll: OS thread ticker, async body — exactly the product's shape.
    let poll_handle = handle.clone();
    std::thread::spawn(move || {
        let mut next = Instant::now();
        loop {
            next += Duration::from_millis(GAME_POLL_INTERVAL_MS);
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            }
            poll_handle.spawn(run_game_poll(bench_start));
        }
    });

    let state = Arc::new(ProbeState::default());
    let mut next_seq: u64 = 0;
    let mut next_tick = Instant::now();
    while bench_start.elapsed() < total {
        geometry_tick(&state, &handle, &mut next_seq, bench_start);
        next_tick += Duration::from_millis(GEOMETRY_INTERVAL_MS);
        let now = Instant::now();
        if next_tick > now {
            std::thread::sleep(next_tick - now);
        } else {
            next_tick = now;
        }
    }

    println!(
        "[bench-end] {{\"benchElapsedMs\":{},\"probesIssued\":{},\"outstandingAtEnd\":{}}}",
        ms_since(bench_start),
        next_seq,
        state.outstanding.load(Ordering::Acquire)
    );
}
