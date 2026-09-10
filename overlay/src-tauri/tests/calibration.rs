use mayhem_oracle_lib::calibration::{
    capture_rect_for_monitor, physical_card_rects, physical_to_logical_rect, select_viewport,
    MonitorInfo, Rect,
};

fn monitor(width: u32, height: u32, scale_factor: f64) -> MonitorInfo {
    MonitorInfo {
        x: 0,
        y: 0,
        width,
        height,
        scale_factor,
    }
}

fn window(width: u32, height: u32) -> Rect {
    Rect {
        x: 0,
        y: 0,
        width,
        height,
    }
}

#[test]
fn uses_monitor_bounds_for_borderless_1920x1080() {
    let calibration = select_viewport(&monitor(1920, 1080, 1.0), Some(&window(1920, 1080)));

    assert_eq!(calibration.mode, "borderless-monitor-fallback");
    assert_eq!(calibration.viewport.width, 1920);
    assert_eq!(calibration.viewport.height, 1080);
    assert!(calibration.warnings.is_empty());
}

#[test]
fn supports_ultrawide_2560x1080_card_regions_without_clipping() {
    let calibration = select_viewport(&monitor(2560, 1080, 1.0), Some(&window(2560, 1080)));
    let rects = physical_card_rects(&calibration.viewport);

    assert_eq!(rects.len(), 3);
    for rect in rects {
        assert!(rect.x >= 0);
        assert!(rect.y >= 0);
        assert!(rect.x as u32 + rect.width <= 2560);
        assert!(rect.y as u32 + rect.height <= 1080);
    }
}

#[test]
fn converts_physical_pixels_to_logical_css_pixels() {
    let logical = physical_to_logical_rect(&window(2560, 1440), 1.25);

    assert_eq!(logical.width, 2048);
    assert_eq!(logical.height, 1152);
}

#[test]
fn scales_logical_card_crop_into_retina_capture_pixels() {
    let monitor = monitor(1280, 720, 2.0);
    let logical = Rect {
        x: 280,
        y: 250,
        width: 220,
        height: 60,
    };

    assert_eq!(
        capture_rect_for_monitor(&logical, &monitor, 2560, 1440),
        Rect {
            x: 560,
            y: 500,
            width: 440,
            height: 120,
        }
    );
}

#[test]
fn overlay_anchor_is_the_monitor_rect_in_every_selection_mode() {
    // The anchor is what the webview's CSS box maps onto: on macOS the overlay
    // window is fullscreen over the monitor in EVERY mode, so detected-window
    // and monitor-fallback modes produce identical CSS geometry for the same
    // screen rect (fix #3: no chip jumps when window detection flaps).
    let monitor_info = monitor(1280, 720, 2.0);
    let expected = Rect {
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
    };

    for calibration in [
        select_viewport(&monitor_info, Some(&window(1280, 720))),
        select_viewport(&monitor_info, Some(&window(960, 540))),
        select_viewport(&monitor_info, None),
    ] {
        assert_eq!(calibration.overlay_anchor, expected, "{}", calibration.mode);
    }
}

#[test]
fn falls_back_to_monitor_when_league_window_is_missing() {
    let calibration = select_viewport(&monitor(2560, 1080, 1.0), None);

    assert_eq!(calibration.mode, "monitor-fallback");
    assert_eq!(calibration.viewport.width, 2560);
    assert!(calibration
        .warnings
        .contains(&"League window not detected; using monitor bounds.".to_string()));
}

#[test]
fn windows_borderless_scaling_keeps_capture_and_overlay_rects_in_sync() {
    let monitor = monitor(1920, 1080, 1.5);
    let calibration = select_viewport(&monitor, Some(&window(1920, 1080)));
    let logical = physical_card_rects(&calibration.viewport)[1].clone();

    assert_eq!(calibration.mode, "borderless-monitor-fallback");
    assert_eq!(
        capture_rect_for_monitor(&logical, &monitor, 2880, 1620).width,
        logical.width * 3 / 2
    );
    assert_eq!(
        capture_rect_for_monitor(&logical, &monitor, 2880, 1620).height,
        logical.height * 3 / 2
    );
}
