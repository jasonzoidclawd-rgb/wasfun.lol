//! The geometry probe must ship the measurements that name where its time went.
//!
//! Phase 1 (`.codex/gates/overlay-collapse-fix/phase1-root-cause.md`) quantified
//! the round34 collapse: the blocking closure's own work stayed flat (median
//! 703 ms healthy -> 714 ms at the end) while the time that requires a TOKIO
//! ASYNC-RUNTIME WORKER TO POLL A TASK grew to a median in-Rust wait of
//! 166 522 ms and an IPC transport wait of 137 477 ms. That in-Rust wait is
//! today a single opaque residual — `elapsed_ms - (pre + capture + analysis)` —
//! because nothing measures the two async segments that make it up:
//!
//!   * segment 6  — `spawn_blocking` queueing until the closure actually runs;
//!   * segment 10 — the `timeout(worker)` future being polled again after the
//!                  closure has already returned.
//!
//! `SurfaceObservation` must carry them as `dispatch_wait_ms` / `resume_wait_ms`,
//! serialized (serde `rename_all = "camelCase"`) as `dispatchWaitMs` and
//! `resumeWaitMs`, so one controlled game settles segment 6 vs segment 10.
//!
//! DIAGNOSTIC ONLY. These are measurements attached to a result that is already
//! produced. Nothing here changes scheduling, concurrency bounds, the bounded
//! capture gate, or any staleness guard.
//!
//! The assertions read the SERIALIZED JSON rather than struct fields on purpose:
//! naming a field that does not exist yet is a compile error, and this suite must
//! compile and fail at RUNTIME. `serde_json::to_value` compiles against today's
//! struct; the missing keys fail as assertions.
//!
//! Deliberately NOT guarded by `#![cfg(target_os = "macos")]` (unlike
//! `r1_replay.rs`, which drives the macOS capture stack): `analyze_surface` and
//! `calibration` are pure, platform-independent arithmetic over an in-memory
//! image, so this contract holds on every platform the overlay ships to.

use mayhem_oracle_lib::calibration::{physical_card_rects, Rect};
use mayhem_oracle_lib::surface_probe::{analyze_surface, SurfaceObservation};
use serde_json::Value;

fn viewport() -> Rect {
    Rect {
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
    }
}

fn name_bands(viewport: &Rect) -> [Rect; 3] {
    let rects = physical_card_rects(viewport);
    [rects[0].clone(), rects[1].clone(), rects[2].clone()]
}

/// A synthetic, uniformly dark frame built in memory — no corpus file, no
/// filesystem, fully deterministic. What the detector concludes about the pixels
/// is irrelevant here; this suite is about the timing fields the observation
/// carries.
fn synthetic_frame() -> image::DynamicImage {
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        1280,
        720,
        image::Rgb([18, 18, 22]),
    ))
}

fn observe(elapsed_ms: u64) -> SurfaceObservation {
    let viewport = viewport();
    let bands = name_bands(&viewport);
    analyze_surface(
        &synthetic_frame(),
        &viewport,
        &bands,
        483,
        1_234.5,
        elapsed_ms,
    )
}

fn serialized(observation: &SurfaceObservation) -> Value {
    serde_json::to_value(observation).expect("SurfaceObservation must serialize")
}

fn key_list(value: &Value) -> Vec<String> {
    value
        .as_object()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

/// Assert the key exists and is a JSON number, then return it.
fn number_field(value: &Value, key: &str) -> f64 {
    let field = value.get(key);
    assert!(
        field.is_some(),
        "SurfaceObservation must serialize `{}` (serde rename_all = \"camelCase\"); keys present: {:?}",
        key,
        key_list(value)
    );
    let parsed = field.and_then(Value::as_f64);
    assert!(
        parsed.is_some(),
        "`{}` must serialize as a JSON number, got {:?}",
        key,
        field
    );
    parsed.unwrap_or(f64::NAN)
}

#[test]
fn observation_carries_the_dispatch_wait() {
    let value = serialized(&observe(167_551));

    assert!(
        value.get("dispatchWaitMs").is_some(),
        "SurfaceObservation must carry the spawn_blocking dispatch wait as \
         `dispatchWaitMs`; without it the 166 522 ms in-Rust wait stays an opaque \
         residual. Keys present: {:?}",
        key_list(&value)
    );
    assert!(
        value
            .get("dispatchWaitMs")
            .and_then(Value::as_f64)
            .is_some(),
        "`dispatchWaitMs` must be a JSON number (never null, never a string), got {:?}",
        value.get("dispatchWaitMs")
    );
}

#[test]
fn observation_carries_the_resume_wait() {
    let value = serialized(&observe(167_551));

    assert!(
        value.get("resumeWaitMs").is_some(),
        "SurfaceObservation must carry the post-closure resume wait as \
         `resumeWaitMs`; it is the half of the in-Rust wait that proves the \
         awaiting task was not polled. Keys present: {:?}",
        key_list(&value)
    );
    assert!(
        value.get("resumeWaitMs").and_then(Value::as_f64).is_some(),
        "`resumeWaitMs` must be a JSON number (never null, never a string), got {:?}",
        value.get("resumeWaitMs")
    );
}

#[test]
fn timing_fields_keep_their_camel_case_javascript_contract() {
    let value = serialized(&observe(716));

    // Existing fields — the JS boundary (`GeometryObservation` in
    // overlay/src/surfaceGeometry.ts) reads these names verbatim.
    for key in ["preCaptureMs", "captureMs", "analysisMs", "elapsedMs"] {
        let ms = number_field(&value, key);
        assert!(
            ms >= 0.0,
            "`{}` must never serialize a negative duration, got {}",
            key,
            ms
        );
    }

    // The snake_case Rust names must never leak across the boundary.
    for key in [
        "pre_capture_ms",
        "capture_ms",
        "analysis_ms",
        "elapsed_ms",
        "dispatch_wait_ms",
        "resume_wait_ms",
    ] {
        assert!(
            value.get(key).is_none(),
            "`{}` leaked as snake_case; the JS side reads camelCase only. Keys present: {:?}",
            key,
            key_list(&value)
        );
    }

    assert_eq!(
        number_field(&value, "elapsedMs"),
        716.0,
        "elapsedMs must echo the native probe total it was constructed with"
    );
}

#[test]
fn native_timing_segments_fit_inside_the_total_and_are_never_negative() {
    // probeSeq 483, verbatim from
    // `.codex/evidence/round34-live/trace.timestamped.jsonl`: the last probe of
    // the collapse. Closure work 674 + 182 + 173 = 1029 ms inside a 167 551 ms
    // command body — the remaining 166 522 ms is what dispatchWaitMs and
    // resumeWaitMs must eventually name.
    let mut observation = observe(167_551);
    observation.pre_capture_ms = 674;
    observation.capture_ms = 182;
    observation.analysis_ms = 173;

    let value = serialized(&observation);
    let pre_capture = number_field(&value, "preCaptureMs");
    let capture = number_field(&value, "captureMs");
    let analysis = number_field(&value, "analysisMs");
    let dispatch = number_field(&value, "dispatchWaitMs");
    let resume = number_field(&value, "resumeWaitMs");
    let elapsed = number_field(&value, "elapsedMs");

    for (name, ms) in [
        ("preCaptureMs", pre_capture),
        ("captureMs", capture),
        ("analysisMs", analysis),
        ("dispatchWaitMs", dispatch),
        ("resumeWaitMs", resume),
        ("elapsedMs", elapsed),
    ] {
        assert!(ms >= 0.0, "`{}` must never be negative, got {}", name, ms);
    }

    // Both new waits are sub-intervals of the same command body the `elapsedMs`
    // clock spans, so together with the closure's own phases they can never
    // exceed it. A decomposition that violated this would be measuring two
    // different clocks and could not attribute anything.
    let segments = pre_capture + capture + analysis + dispatch + resume;
    assert!(
        segments <= elapsed,
        "native timing segments must fit inside elapsedMs: pre {} + capture {} + \
         analysis {} + dispatch {} + resume {} = {} > elapsed {}",
        pre_capture,
        capture,
        analysis,
        dispatch,
        resume,
        segments,
        elapsed
    );

    // And the unattributed remainder is exactly the quantity Phase 1 had to
    // derive by hand. It must remain computable from the shipped fields alone.
    let unattributed = elapsed - segments;
    assert!(
        unattributed >= 0.0,
        "the unattributed in-Rust wait must never be negative, got {}",
        unattributed
    );
    assert!(
        unattributed <= elapsed,
        "the unattributed in-Rust wait must never exceed the total, got {} of {}",
        unattributed,
        elapsed
    );
}
