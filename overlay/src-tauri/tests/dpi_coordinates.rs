//! Coordinate/DPI conversions must hold across every supported Windows display
//! scale (100–200%), on secondary monitors, and on monitors with negative
//! origins (a display placed left of / above the primary). These exercise the
//! SAME pure functions the live capture path uses, so a Windows box at 150% on a
//! second monitor and this test agree by construction.

use mayhem_oracle_lib::calibration::{
    capture_rect_for_monitor, physical_to_logical_rect, select_viewport, MonitorInfo, Rect,
};

fn monitor(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> MonitorInfo {
    MonitorInfo {
        x,
        y,
        width,
        height,
        scale_factor,
    }
}

#[test]
fn logical_conversion_holds_across_100_to_200_percent_scaling() {
    // Physical 1920×1080 divided by each Windows scale → CSS/logical size.
    let cases: [(f64, u32, u32); 5] = [
        (1.00, 1920, 1080),
        (1.25, 1536, 864),
        (1.50, 1280, 720),
        (1.75, 1097, 617), // 1920/1.75 = 1097.14 → 1097, 1080/1.75 = 617.14 → 617
        (2.00, 960, 540),
    ];
    for (scale, expected_w, expected_h) in cases {
        let logical = physical_to_logical_rect(
            &Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            scale,
        );
        assert_eq!(logical.width, expected_w, "width at {scale}x");
        assert_eq!(logical.height, expected_h, "height at {scale}x");
    }
}

#[test]
fn capture_rect_maps_onto_a_secondary_monitor_offset() {
    // Second monitor placed to the right of a 1920-wide primary, 150% scale, so
    // the captured image is 2880×1620. A viewport-relative rect must land inside
    // the captured pixels, not the desktop-absolute coordinates.
    let secondary = monitor(1920, 0, 1920, 1080, 1.5);
    let logical = Rect {
        x: 1920 + 400,
        y: 300,
        width: 200,
        height: 60,
    };
    let mapped = capture_rect_for_monitor(&logical, &secondary, 2880, 1620);

    assert_eq!(mapped.x, 600); // (2320 - 1920) * 1.5
    assert_eq!(mapped.y, 450); // 300 * 1.5
    assert_eq!(mapped.width, 300);
    assert_eq!(mapped.height, 90);
    assert!((mapped.x as u32) + mapped.width <= 2880);
    assert!((mapped.y as u32) + mapped.height <= 1620);
}

#[test]
fn capture_rect_handles_a_negative_origin_monitor() {
    // A monitor placed LEFT of and ABOVE the primary has a negative origin. The
    // subtraction (rect - monitor.origin) must yield non-negative capture pixels.
    let negative = monitor(-1920, -1080, 1920, 1080, 1.0);
    let logical = Rect {
        x: -1920 + 100,
        y: -1080 + 200,
        width: 300,
        height: 80,
    };
    let mapped = capture_rect_for_monitor(&logical, &negative, 1920, 1080);

    assert_eq!(mapped.x, 100);
    assert_eq!(mapped.y, 200);
    assert_eq!(mapped.width, 300);
    assert_eq!(mapped.height, 80);
}

#[test]
fn negative_origin_monitor_still_calibrates_to_its_own_bounds() {
    let negative = monitor(-2560, -100, 2560, 1440, 1.0);
    let calibration = select_viewport(
        &negative,
        Some(&Rect {
            x: -2560,
            y: -100,
            width: 2560,
            height: 1440,
        }),
    );
    assert_eq!(calibration.mode, "borderless-monitor-fallback");
    assert_eq!(calibration.viewport.x, -2560);
    assert_eq!(calibration.viewport.y, -100);
    assert_eq!(calibration.viewport.width, 2560);
}
