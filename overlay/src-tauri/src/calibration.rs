use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayCalibration {
    pub monitor: MonitorInfo,
    pub game_window: Option<Rect>,
    pub viewport: Rect,
    /// The rect (same calibrated space as `viewport`/`game_window`) that the
    /// overlay webview's CSS box maps onto. Frontend conversion is a single
    /// ratio: css = (rect − anchor.origin) × cssWindowSize / anchorSize —
    /// `scale_factor` and devicePixelRatio never re-enter, so a monitor whose
    /// reported scale flaps 1.0↔2.0 yields identical CSS geometry. Defaults
    /// to the monitor (macOS: the overlay window is fullscreen); the Windows
    /// path overrides it with the viewport after repositioning the window.
    pub overlay_anchor: Rect,
    pub mode: String,
    pub warnings: Vec<String>,
}

pub const CARD_NAME_REGIONS: [CardRegion; 3] = [
    CardRegion {
        x: 0.219,
        y: 0.347,
        w: 0.172,
        h: 0.083,
    },
    CardRegion {
        x: 0.414,
        y: 0.347,
        w: 0.172,
        h: 0.083,
    },
    CardRegion {
        x: 0.609,
        y: 0.347,
        w: 0.172,
        h: 0.083,
    },
];

const FULLSCREEN_TOLERANCE_PX: i32 = 24;
const FULLSCREEN_TOLERANCE_RATIO: f64 = 0.02;

pub fn select_viewport(monitor: &MonitorInfo, game_window: Option<&Rect>) -> OverlayCalibration {
    match game_window {
        Some(window) if rect_approximately_matches_monitor(monitor, window) => OverlayCalibration {
            monitor: monitor.clone(),
            game_window: Some(window.clone()),
            viewport: monitor_rect(monitor),
            overlay_anchor: monitor_rect(monitor),
            mode: "borderless-monitor-fallback".to_string(),
            warnings: Vec::new(),
        },
        Some(window) => OverlayCalibration {
            monitor: monitor.clone(),
            game_window: Some(window.clone()),
            viewport: window.clone(),
            overlay_anchor: monitor_rect(monitor),
            mode: "league-window".to_string(),
            warnings: Vec::new(),
        },
        None => OverlayCalibration {
            monitor: monitor.clone(),
            game_window: None,
            viewport: monitor_rect(monitor),
            overlay_anchor: monitor_rect(monitor),
            mode: "monitor-fallback".to_string(),
            warnings: vec!["League window not detected; using monitor bounds.".to_string()],
        },
    }
}

pub fn rect_approximately_matches_monitor(monitor: &MonitorInfo, rect: &Rect) -> bool {
    let tolerance = fullscreen_tolerance(monitor);

    (monitor.x - rect.x).abs() <= tolerance
        && (monitor.y - rect.y).abs() <= tolerance
        && (right_monitor(monitor) - right_rect(rect)).abs() <= tolerance
        && (bottom_monitor(monitor) - bottom_rect(rect)).abs() <= tolerance
}

pub fn physical_card_rects(viewport: &Rect) -> Vec<Rect> {
    CARD_NAME_REGIONS
        .iter()
        .map(|region| physical_rect_for_region(region, viewport))
        .collect()
}

pub fn physical_rect_for_region(region: &CardRegion, viewport: &Rect) -> Rect {
    let x = viewport.x + (region.x * viewport.width as f64).round() as i32;
    let y = viewport.y + (region.y * viewport.height as f64).round() as i32;
    let width = (region.w * viewport.width as f64).round() as u32;
    let height = (region.h * viewport.height as f64).round() as u32;
    let max_width = (right_rect(viewport) - x).max(0) as u32;
    let max_height = (bottom_rect(viewport) - y).max(0) as u32;

    Rect {
        x,
        y,
        width: width.min(max_width),
        height: height.min(max_height),
    }
}

pub fn physical_to_logical_rect(rect: &Rect, scale_factor: f64) -> Rect {
    let divisor = safe_scale_factor(scale_factor);

    Rect {
        x: (rect.x as f64 / divisor).round() as i32,
        y: (rect.y as f64 / divisor).round() as i32,
        width: (rect.width as f64 / divisor).round() as u32,
        height: (rect.height as f64 / divisor).round() as u32,
    }
}

/// Convert a monitor-relative logical rectangle into pixels in a captured image.
/// CoreGraphics captures a logical display rect but returns a pixel-sized image.
pub fn capture_rect_for_monitor(
    rect: &Rect,
    monitor: &MonitorInfo,
    capture_width: u32,
    capture_height: u32,
) -> Rect {
    let scale_x = capture_width as f64 / monitor.width.max(1) as f64;
    let scale_y = capture_height as f64 / monitor.height.max(1) as f64;

    Rect {
        x: ((rect.x - monitor.x) as f64 * scale_x).round().max(0.0) as i32,
        y: ((rect.y - monitor.y) as f64 * scale_y).round().max(0.0) as i32,
        width: (rect.width as f64 * scale_x).round().max(0.0) as u32,
        height: (rect.height as f64 * scale_y).round().max(0.0) as u32,
    }
}

pub fn overlap_area(left: &Rect, right: &MonitorInfo) -> u64 {
    let x1 = left.x.max(right.x);
    let y1 = left.y.max(right.y);
    let x2 = right_rect(left).min(right_monitor(right));
    let y2 = bottom_rect(left).min(bottom_monitor(right));

    if x2 <= x1 || y2 <= y1 {
        return 0;
    }

    ((x2 - x1) as u64) * ((y2 - y1) as u64)
}

fn monitor_rect(monitor: &MonitorInfo) -> Rect {
    Rect {
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
    }
}

fn fullscreen_tolerance(monitor: &MonitorInfo) -> i32 {
    FULLSCREEN_TOLERANCE_PX
        .max((monitor.width.max(monitor.height) as f64 * FULLSCREEN_TOLERANCE_RATIO).round() as i32)
}

fn right_rect(rect: &Rect) -> i32 {
    rect.x + rect.width as i32
}

fn bottom_rect(rect: &Rect) -> i32 {
    rect.y + rect.height as i32
}

fn right_monitor(monitor: &MonitorInfo) -> i32 {
    monitor.x + monitor.width as i32
}

fn bottom_monitor(monitor: &MonitorInfo) -> i32 {
    monitor.y + monitor.height as i32
}

fn safe_scale_factor(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
}
