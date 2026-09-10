//! Captured-frame replay of the failed 2026-07-16 timed retest.
//!
//! `corpus/full_frames/r1_offer_zh_tw_1280x720.jpeg` is the REAL R1 augment
//! offer captured from the GameClient (borderless 1280x720, zh-TW). This test
//! runs the exact production crop pipeline — `select_viewport` →
//! `physical_rect_for_region` → `capture_rect_for_monitor` → crop →
//! `read_card_text` — against that frame and requires a per-slot resolution
//! for all three cards. A real three-card screen is sufficient to activate
//! scanning; nothing in the pipeline may depend on prior (stale) foreground
//! state.
#![cfg(target_os = "macos")]

use std::path::Path;

use mayhem_oracle_lib::calibration::{
    capture_rect_for_monitor, physical_rect_for_region, select_viewport, MonitorInfo, Rect,
    CARD_NAME_REGIONS,
};
use mayhem_oracle_lib::ocr::{read_card_text, GameLocale};

fn normalized(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace()).collect()
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut current = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let substitution = previous[j] + usize::from(ca != cb);
            current.push(substitution.min(previous[j + 1] + 1).min(current[j] + 1));
        }
        previous = current;
    }
    previous[b.len()]
}

/// Same tolerance as the corpus test / frontend matcher: exact, containment
/// either way, or levenshtein within 30% of the shorter string.
fn matches(ocr_text: &str, expected: &str) -> bool {
    if ocr_text.is_empty() {
        return false;
    }
    if ocr_text.contains(expected) || expected.contains(ocr_text) {
        return true;
    }
    let a: Vec<char> = ocr_text.chars().collect();
    let b: Vec<char> = expected.chars().collect();
    let threshold = (a.len().min(b.len()) as f64 * 0.3).ceil() as usize;
    levenshtein(&a, &b) <= threshold
}

#[test]
fn r1_frame_yields_three_card_resolutions_through_the_production_pipeline() {
    let overlay_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("overlay root");
    let frame = image::open(overlay_root.join("corpus/full_frames/r1_offer_zh_tw_1280x720.jpeg"))
        .expect("open captured R1 frame");

    // The observed live geometry: borderless GameClient covering the monitor
    // (calibration mode "borderless-monitor-fallback", League 0,0 1280x720,
    // scale 1.00).
    let monitor = MonitorInfo {
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        scale_factor: 1.0,
    };
    let game_window = Rect {
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
    };
    let calibration = select_viewport(&monitor, Some(&game_window));
    assert_eq!(calibration.mode, "borderless-monitor-fallback");

    let expected = ["術士果汁盒", "極度邪惡", "幻影武器"].map(normalized);
    let mut failures = Vec::new();

    for (region_index, region) in CARD_NAME_REGIONS.iter().enumerate() {
        let logical_rect = physical_rect_for_region(region, &calibration.viewport);
        let rect = capture_rect_for_monitor(&logical_rect, &monitor, frame.width(), frame.height());

        assert!(rect.x >= 0 && rect.y >= 0, "crop origin outside monitor");
        assert!(
            rect.width > 0
                && rect.height > 0
                && rect.x as u32 + rect.width <= frame.width()
                && rect.y as u32 + rect.height <= frame.height(),
            "crop outside captured frame: {:?}",
            rect
        );

        let crop = frame.crop_imm(rect.x as u32, rect.y as u32, rect.width, rect.height);
        let text = read_card_text(&crop, Some(GameLocale::ZhTw), &[])
            .expect("vision ocr")
            .unwrap_or_default();

        if !matches(&normalized(&text), &expected[region_index]) {
            failures.push(format!(
                "region {}: expected {:?}, got {:?}",
                region_index, expected[region_index], text
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "R1 replay failed to resolve all three cards:\n{}",
        failures.join("\n")
    );
}
