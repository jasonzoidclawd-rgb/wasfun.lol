//! A wholesale screen-capture failure must be a flagged, crop-less outcome —
//! NEVER a clean "the game legitimately shows zero cards" observation. On
//! Windows (as on macOS) capture goes through xcap and can fail transiently
//! (device loss, session switch); this pins the shape that keeps the failure
//! distinguishable from a successful empty scan.

use mayhem_oracle_lib::{calibration::Rect, capture_failure_diagnostics};

fn viewport() -> Rect {
    Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    }
}

#[test]
fn capture_failure_flags_every_region_and_produces_no_crops() {
    let diagnostics = capture_failure_diagnostics(&viewport(), "Capture failed: device lost");

    // One diagnostic per card region, and NONE reports a successful capture.
    assert_eq!(diagnostics.len(), 3);
    assert!(diagnostics.iter().all(|d| !d.capture_succeeded));
    assert!(diagnostics
        .iter()
        .all(|d| d.error.as_deref() == Some("Capture failed: device lost")));
    // No raw text and no capture dimensions were produced — nothing that could
    // be mistaken for a real recognized-but-empty result.
    assert!(diagnostics.iter().all(|d| d.raw_text.is_none()));
    assert!(diagnostics.iter().all(|d| d.capture_width.is_none()));
}

#[test]
fn a_capture_failure_is_not_the_same_shape_as_a_successful_empty_scan() {
    // A capture failure yields crop_count 0 (no crops from these diagnostics).
    // A legitimate "no augment recognized" scan would instead have captured
    // every region (capture_succeeded=true, crop_count == region count). The
    // presence of any capture_succeeded=true is the signal that separates them.
    let failure = capture_failure_diagnostics(&viewport(), "Capture failed: xcap error");
    let any_capture_succeeded = failure.iter().any(|d| d.capture_succeeded);
    assert!(
        !any_capture_succeeded,
        "capture failure must not look like a captured scan"
    );
}
