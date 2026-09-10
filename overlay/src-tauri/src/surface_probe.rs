//! Pixel/geometry augment-surface probe — Stage-1 PRESENCE without OCR.
//!
//! Round 6 moved presence away from OCR, but the frontend still expired a valid
//! frame 500 ms after the previous capture started. A newer native capture could
//! legitimately still be in flight at that instant, so the three chips blinked
//! together even though all card pixels remained strongly valid. Geometry now
//! feeds confidence hysteresis, while scheduler health—not frame age—owns expiry.
//! OCR remains unable to decide whether the offer surface is visibly usable.
//!
//! This module answers three questions from pixels alone — is a three-card
//! augment surface on screen, is it occluded by a dialog/scoreboard, and what is
//! each card's visual fingerprint — and never runs OCR. OCR (identity) is a
//! separate, triggered track. The signals were tuned and validated against
//! sanitized labeled fixtures (`tests/fixtures/surface/`); see the tests below.
//!
//! Design constraints honored:
//!   - No dependence on exact gold/purple frame color. The card gate is a
//!     luminance signature (dark+flat interior vs a much brighter frame ring),
//!     so silver-frame offers pass exactly like gold ones.
//!   - Scale invariant. Every gate is a region mean/std (resolution independent),
//!     so a 2× retina capture classifies identically. Edge energy (which is not
//!     scale invariant) is a diagnostic only, never a gate.
//!   - No catalog/identity input. A brand-new patch's unknown augments are still
//!     a present, renderable surface.

use serde::{Deserialize, Serialize};

use crate::calibration::Rect;

// ─── Normalized geometry (viewport fractions) ──────────────────────────────
// Card centers/size measured from the 1280×720 fixtures. The three cards sit at
// these horizontal centers, same width/height, tops aligned.
const CARD_CENTERS_X: [f64; 3] = [0.310, 0.502, 0.693];
const CARD_HALF_W: f64 = 0.080;
const CARD_TOP: f64 = 0.174;
const CARD_BOTTOM: f64 = 0.667;

// Interior sample: the lower-centre dead zone of the card, below quest/reward
// copy. It is a near-black, flat fill on every offer and never so on combat.
const INTERIOR_HALF_W: f64 = 0.045;
const INTERIOR_TOP: f64 = 0.56;
const INTERIOR_BOTTOM: f64 = 0.62;

// Frame side strips: thin vertical slivers at the card's left/right borders,
// where the ornate frame ring is much brighter than the interior.
const FRAME_STRIP_W: f64 = 0.010;
const FRAME_STRIP_INSET_Y: f64 = 0.05;

// Card top/bottom border bands: edge-energy diagnostic (not a gate).
const BORDER_BAND_H: f64 = 0.015;

// Inter-card gaps at the card y-band. A centred modal panel fills these with a
// dark, *smooth* rectangle; the game world between cards stays dark but textured.
const GAP1_X0: f64 = 0.392;
const GAP1_X1: f64 = 0.420;
const GAP2_X0: f64 = 0.584;
const GAP2_X1: f64 = 0.612;
const GAP_TOP: f64 = 0.24;
const GAP_BOTTOM: f64 = 0.50;

// Fingerprint window: the static centre of the icon+name band, excluding the
// animated frame and portrait ornaments. Live animation drift is <=6 bits while
// distinct slots in the labeled offers remain >=16 bits apart.
const FP_HALF_W: f64 = 0.050;
const FP_TOP: f64 = 0.220;
const FP_BOTTOM: f64 = 0.430;
const FP_GRID: usize = 12; // 12×12 = 144-bit average hash

// ─── Thresholds (locked with margin from labeled fixtures) ─────────────────
// offer interiors ≤14.3 / std ≤5.8 ; combat interiors ≥48 / std ≥12.4
const T_INTERIOR_LUMA: f32 = 30.0;
const T_INTERIOR_STD: f32 = 9.0;
// offer frame−interior ≥81 (gold & silver) ; combat ≤19
const T_FRAME_CONTRAST: f32 = 40.0;
// a gap is "paneled" (modal) when dark AND smooth. offer gap std ≥32 ; modal ≤26
const T_GAP_PANEL_LUMA: f32 = 42.0;
const T_GAP_PANEL_STD: f32 = 30.0;
// a surface needs at least this many structurally-present cards
const MIN_PRESENT_CARDS: usize = 2;

const CONTROL_X0: f64 = 0.435;
const CONTROL_X1: f64 = 0.565;
const CONTROL_Y0: f64 = 0.758;
const CONTROL_Y1: f64 = 0.825;
const CONTROL_BODY_X0: f64 = 0.448;
const CONTROL_BODY_X1: f64 = 0.552;
const CONTROL_BODY_Y0: f64 = 0.770;
const CONTROL_BODY_Y1: f64 = 0.812;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlueControlFeatures {
    pub aspect_ratio: f32,
    pub blue_body_coverage: f32,
    pub body_saturation: f32,
    pub border_contrast: f32,
    pub central_icon_coverage: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlueControlObservation {
    pub present: bool,
    pub confidence: f32,
    pub normalized_rect: NormalizedRect,
    /// Feature diagnostics are serialized only in debug builds.
    #[cfg_attr(not(debug_assertions), serde(skip_serializing))]
    pub features: BlueControlFeatures,
}

pub fn empty_blue_control() -> BlueControlObservation {
    BlueControlObservation {
        present: false,
        confidence: 0.0,
        normalized_rect: NormalizedRect {
            x: CONTROL_X0 as f32,
            y: CONTROL_Y0 as f32,
            width: (CONTROL_X1 - CONTROL_X0) as f32,
            height: (CONTROL_Y1 - CONTROL_Y0) as f32,
        },
        features: BlueControlFeatures {
            aspect_ratio: 0.0,
            blue_body_coverage: 0.0,
            body_saturation: 0.0,
            border_contrast: 0.0,
            central_icon_coverage: 0.0,
        },
    }
}

/// Per-card structural observation. `present` is decided from `interior_luma` +
/// `interior_std` + `frame_contrast` only (scale invariant); `edge_energy` and
/// `structural_score` are diagnostics.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardObservation {
    pub region_index: usize,
    pub present: bool,
    /// Name-band rect (calibrated LOGICAL space) for chip rendering — Some only
    /// when the card is structurally present. Matches the OCR path's card_rect.
    pub card_rect: Option<Rect>,
    pub interior_luma: f32,
    pub interior_std: f32,
    pub frame_contrast: f32,
    pub edge_energy: f32,
    /// 0..1 soft confidence this rect holds a card (diagnostic).
    pub structural_score: f32,
    /// 144-bit average-hash of the icon+name window as a bitstring. Stable across
    /// identical pixels; changes strongly when the slot is rerolled.
    pub fingerprint: String,
}

/// One geometry probe's result. Presence/occlusion/visual-freshness authority.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceObservation {
    /// Monotonic probe sequence claimed at probe START (stale-result guard).
    pub probe_seq: u64,
    /// Caller's monotonic capture clock, echoed back for diagnostic provenance.
    pub captured_at: f64,
    pub capture_width: u32,
    pub capture_height: u32,
    /// A three-card augment surface exists (≥2 structurally-present cards).
    pub present: bool,
    /// A dialog/scoreboard is occluding the offer (cards exist behind a panel).
    pub occluded: bool,
    /// 0..1 offer-level confidence (mean present-card structural score).
    pub confidence: f32,
    pub blue_control: BlueControlObservation,
    pub cards: Vec<CardObservation>,
    pub rejection_reasons: Vec<String>,
    /// Native work before screen capture starts (foreground/window discovery).
    pub pre_capture_ms: u64,
    /// Native monitor capture duration.
    pub capture_ms: u64,
    /// Pixel analysis duration after capture.
    pub analysis_ms: u64,
    /// Complete native probe latency, retained as the existing API field.
    pub elapsed_ms: u64,
    /// Command entry (the first poll of this command's future) → the blocking
    /// capture closure's body actually beginning.
    ///
    /// This is `spawn_blocking` QUEUE LATENCY, **not** async-runtime starvation.
    /// No SUSPENSION POINT separates the command-entry clock from the
    /// `spawn_blocking` call. (There are two syntactic `.await`s on the way, but
    /// awaiting an `async fn` polls it inline within the same poll — the first
    /// construct that can actually yield is the `timeout(..).await` *after* the
    /// spawn.) Crossing this interval therefore needs no async worker. Against
    /// tokio's default 512 blocking threads it should read ~0 even while the
    /// async runtime is fully starved; a large value means the BLOCKING POOL is
    /// saturated. Async-runtime starvation surfaces in `resume_wait_ms`, and —
    /// for the segment before the first poll, which is outside `elapsed_ms`
    /// entirely — in the JS-side `transportMs`.
    /// Always a number; 0 when the segment was not measured.
    pub dispatch_wait_ms: u64,
    /// The blocking closure returning → the command being about to return.
    ///
    /// This one DOES measure async-runtime scheduling latency: the worker's
    /// completion wakes `tokio::time::timeout(..)`, and crossing this interval
    /// requires an async worker to poll that task again.
    /// Always a number; 0 when the segment was not measured.
    pub resume_wait_ms: u64,
}

fn normalized_region_px(
    width: usize,
    height: usize,
    viewport: &Rect,
    nx0: f64,
    ny0: f64,
    nx1: f64,
    ny1: f64,
) -> (usize, usize, usize, usize) {
    let x0 = ((viewport.x as f64 + nx0 * viewport.width as f64).round() as i64)
        .clamp(0, width as i64) as usize;
    let x1 = ((viewport.x as f64 + nx1 * viewport.width as f64).round() as i64)
        .clamp(0, width as i64) as usize;
    let y0 = ((viewport.y as f64 + ny0 * viewport.height as f64).round() as i64)
        .clamp(0, height as i64) as usize;
    let y1 = ((viewport.y as f64 + ny1 * viewport.height as f64).round() as i64)
        .clamp(0, height as i64) as usize;
    (x0, y0, x1.max(x0), y1.max(y0))
}

/// Structural, locale-independent detector for the central cyan hide/show
/// control. It combines body hue/saturation, gold/light border contrast, the
/// central hand/icon highlight and the fixed relationship to the three columns.
pub fn detect_blue_augment_control(
    img: &image::DynamicImage,
    viewport: &Rect,
) -> BlueControlObservation {
    let rgb = img.to_rgb8();
    let (width, height) = (rgb.width() as usize, rgb.height() as usize);
    let body = normalized_region_px(
        width,
        height,
        viewport,
        CONTROL_BODY_X0,
        CONTROL_BODY_Y0,
        CONTROL_BODY_X1,
        CONTROL_BODY_Y1,
    );
    let icon = normalized_region_px(width, height, viewport, 0.485, 0.770, 0.515, 0.812);
    let border_top = normalized_region_px(width, height, viewport, 0.445, 0.760, 0.555, 0.765);
    let border_bottom = normalized_region_px(width, height, viewport, 0.445, 0.817, 0.555, 0.822);

    let mut body_count = 0usize;
    let mut blue_count = 0usize;
    let mut saturation_sum = 0.0f32;
    let mut body_luma_sum = 0.0f32;
    for y in body.1..body.3 {
        for x in body.0..body.2 {
            let [r, g, b] = rgb.get_pixel(x as u32, y as u32).0;
            let max = r.max(g).max(b) as f32;
            let min = r.min(g).min(b) as f32;
            let saturation = if max <= 0.0 { 0.0 } else { (max - min) / max };
            if b >= 70 && g >= 45 && (b as f32) > r as f32 * 1.25 && saturation >= 0.35 {
                blue_count += 1;
            }
            saturation_sum += saturation;
            body_luma_sum += 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
            body_count += 1;
        }
    }
    let body_count_f = body_count.max(1) as f32;
    let blue_body_coverage = blue_count as f32 / body_count_f;
    let body_saturation = saturation_sum / body_count_f;
    let body_luma = body_luma_sum / body_count_f;

    let mut border_luma_sum = 0.0f32;
    let mut border_count = 0usize;
    for region in [border_top, border_bottom] {
        for y in region.1..region.3 {
            for x in region.0..region.2 {
                let [r, g, b] = rgb.get_pixel(x as u32, y as u32).0;
                border_luma_sum += 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
                border_count += 1;
            }
        }
    }
    let border_contrast = border_luma_sum / border_count.max(1) as f32 - body_luma;

    let mut icon_count = 0usize;
    let mut icon_light = 0usize;
    for y in icon.1..icon.3 {
        for x in icon.0..icon.2 {
            let [r, g, b] = rgb.get_pixel(x as u32, y as u32).0;
            if b >= 140 && g >= 95 && b > r {
                icon_light += 1;
            }
            icon_count += 1;
        }
    }
    let central_icon_coverage = icon_light as f32 / icon_count.max(1) as f32;
    let aspect_ratio = ((CONTROL_X1 - CONTROL_X0) * viewport.width as f64
        / ((CONTROL_Y1 - CONTROL_Y0) * viewport.height as f64)) as f32;

    let confidence = ((blue_body_coverage / 0.72).min(1.0) * 0.40
        + (body_saturation / 0.52).min(1.0) * 0.20
        + (border_contrast.max(0.0) / 8.0).min(1.0) * 0.20
        + (central_icon_coverage / 0.08).min(1.0) * 0.20)
        .clamp(0.0, 1.0);
    let present = blue_body_coverage >= 0.55
        && body_saturation >= 0.42
        && border_contrast >= 3.5
        && central_icon_coverage >= 0.035
        && confidence >= 0.72;

    BlueControlObservation {
        present,
        confidence,
        normalized_rect: NormalizedRect {
            x: CONTROL_X0 as f32,
            y: CONTROL_Y0 as f32,
            width: (CONTROL_X1 - CONTROL_X0) as f32,
            height: (CONTROL_Y1 - CONTROL_Y0) as f32,
        },
        features: BlueControlFeatures {
            aspect_ratio,
            blue_body_coverage,
            body_saturation,
            border_contrast,
            central_icon_coverage,
        },
    }
}

/// A luminance buffer (Rec601, matching the fixture tuning) over the capture.
struct LumaImage {
    width: usize,
    height: usize,
    data: Vec<f32>,
}

impl LumaImage {
    fn from_rgb(img: &image::DynamicImage) -> Self {
        let rgb = img.to_rgb8();
        let (w, h) = (rgb.width() as usize, rgb.height() as usize);
        let mut data = Vec::with_capacity(w * h);
        for px in rgb.pixels() {
            let [r, g, b] = px.0;
            data.push(0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32);
        }
        LumaImage {
            width: w,
            height: h,
            data,
        }
    }

    #[inline]
    fn at(&self, x: usize, y: usize) -> f32 {
        self.data[y * self.width + x]
    }

    /// Convert a normalized region (relative to `viewport`, in capture pixels)
    /// into a clamped pixel rect [x0,x1) × [y0,y1).
    fn region_px(
        &self,
        viewport: &Rect,
        nx0: f64,
        ny0: f64,
        nx1: f64,
        ny1: f64,
    ) -> (usize, usize, usize, usize) {
        let vx = viewport.x as f64;
        let vy = viewport.y as f64;
        let vw = viewport.width as f64;
        let vh = viewport.height as f64;
        let x0 = ((vx + nx0 * vw).round() as i64).clamp(0, self.width as i64) as usize;
        let x1 = ((vx + nx1 * vw).round() as i64).clamp(0, self.width as i64) as usize;
        let y0 = ((vy + ny0 * vh).round() as i64).clamp(0, self.height as i64) as usize;
        let y1 = ((vy + ny1 * vh).round() as i64).clamp(0, self.height as i64) as usize;
        (x0, y0, x1.max(x0), y1.max(y0))
    }

    fn mean_std(&self, r: (usize, usize, usize, usize)) -> (f32, f32) {
        let (x0, y0, x1, y1) = r;
        let mut sum = 0.0f64;
        let mut sq = 0.0f64;
        let mut n = 0u64;
        for y in y0..y1 {
            for x in x0..x1 {
                let v = self.at(x, y) as f64;
                sum += v;
                sq += v * v;
                n += 1;
            }
        }
        if n == 0 {
            return (0.0, 0.0);
        }
        let mean = sum / n as f64;
        let var = (sq / n as f64 - mean * mean).max(0.0);
        (mean as f32, var.sqrt() as f32)
    }

    /// Mean central-difference gradient magnitude over a region (diagnostic).
    fn edge_energy(&self, r: (usize, usize, usize, usize)) -> f32 {
        let (x0, y0, x1, y1) = r;
        let mut sum = 0.0f64;
        let mut n = 0u64;
        for y in y0..y1 {
            for x in x0..x1 {
                if x == 0 || y == 0 || x + 1 >= self.width || y + 1 >= self.height {
                    continue;
                }
                let gx = (self.at(x + 1, y) - self.at(x - 1, y)) * 0.5;
                let gy = (self.at(x, y + 1) - self.at(x, y - 1)) * 0.5;
                sum += ((gx * gx + gy * gy).sqrt()) as f64;
                n += 1;
            }
        }
        if n == 0 {
            0.0
        } else {
            (sum / n as f64) as f32
        }
    }

    /// 144-bit average hash of the icon+name window: FP_GRID×FP_GRID cell means,
    /// each bit set when its cell exceeds the window median.
    fn fingerprint(&self, viewport: &Rect, cx: f64) -> String {
        let (x0, y0, x1, y1) =
            self.region_px(viewport, cx - FP_HALF_W, FP_TOP, cx + FP_HALF_W, FP_BOTTOM);
        let w = x1.saturating_sub(x0);
        let h = y1.saturating_sub(y0);
        if w == 0 || h == 0 {
            return "0".repeat(FP_GRID * FP_GRID);
        }
        let mut cells = [0.0f32; FP_GRID * FP_GRID];
        for gy in 0..FP_GRID {
            for gx in 0..FP_GRID {
                let cx0 = x0 + gx * w / FP_GRID;
                let cx1 = x0 + (gx + 1) * w / FP_GRID;
                let cy0 = y0 + gy * h / FP_GRID;
                let cy1 = y0 + (gy + 1) * h / FP_GRID;
                let (m, _) = self.mean_std((
                    cx0,
                    cy0,
                    cx1.max(cx0 + 1).min(self.width),
                    cy1.max(cy0 + 1).min(self.height),
                ));
                cells[gy * FP_GRID + gx] = m;
            }
        }
        let mut sorted = cells;
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        // median of an even-length array: average of the two middle samples
        let mid = sorted.len() / 2;
        let median = (sorted[mid - 1] + sorted[mid]) * 0.5;
        cells
            .iter()
            .map(|&c| if c > median { '1' } else { '0' })
            .collect()
    }
}

/// Analyze one decoded capture for the augment surface. Pure CV: no OCR, no
/// catalog, no wall-clock. `viewport_px` is the game viewport mapped into
/// capture-pixel coordinates; `name_band_rects` are the calibrated LOGICAL
/// name-band rects to attach to present cards for chip rendering.
pub fn analyze_surface(
    img: &image::DynamicImage,
    viewport_px: &Rect,
    name_band_rects: &[Rect; 3],
    probe_seq: u64,
    captured_at: f64,
    elapsed_ms: u64,
) -> SurfaceObservation {
    let blue_control = detect_blue_augment_control(img, viewport_px);
    let luma = LumaImage::from_rgb(img);
    let mut cards = Vec::with_capacity(3);
    let mut rejection_reasons = Vec::new();
    let mut n_present = 0usize;
    let mut score_sum = 0.0f32;

    for (i, &cx) in CARD_CENTERS_X.iter().enumerate() {
        let x0n = cx - CARD_HALF_W;
        let x1n = cx + CARD_HALF_W;
        let (interior_luma, interior_std) = luma.mean_std(luma.region_px(
            viewport_px,
            cx - INTERIOR_HALF_W,
            INTERIOR_TOP,
            cx + INTERIOR_HALF_W,
            INTERIOR_BOTTOM,
        ));
        let (frame_l, _) = luma.mean_std(luma.region_px(
            viewport_px,
            x0n,
            CARD_TOP + FRAME_STRIP_INSET_Y,
            x0n + FRAME_STRIP_W,
            CARD_BOTTOM - FRAME_STRIP_INSET_Y,
        ));
        let (frame_r, _) = luma.mean_std(luma.region_px(
            viewport_px,
            x1n - FRAME_STRIP_W,
            CARD_TOP + FRAME_STRIP_INSET_Y,
            x1n,
            CARD_BOTTOM - FRAME_STRIP_INSET_Y,
        ));
        let frame_contrast = (frame_l + frame_r) * 0.5 - interior_luma;
        let edge_top = luma.edge_energy(luma.region_px(
            viewport_px,
            x0n,
            CARD_TOP,
            x1n,
            CARD_TOP + BORDER_BAND_H,
        ));
        let edge_bot = luma.edge_energy(luma.region_px(
            viewport_px,
            x0n,
            CARD_BOTTOM - BORDER_BAND_H,
            x1n,
            CARD_BOTTOM,
        ));
        let edge_energy = (edge_top + edge_bot) * 0.5;

        let interior_ok = interior_luma < T_INTERIOR_LUMA && interior_std < T_INTERIOR_STD;
        let frame_ok = frame_contrast > T_FRAME_CONTRAST;
        let present = interior_ok && frame_ok;
        let structural_score = if present {
            (frame_contrast / 120.0).min(1.0)
        } else {
            0.0
        };
        let fingerprint = luma.fingerprint(viewport_px, cx);

        if present {
            n_present += 1;
            score_sum += structural_score;
        } else if !interior_ok {
            rejection_reasons.push(format!("card{}-interior-not-dark-flat", i));
        } else {
            rejection_reasons.push(format!("card{}-frame-contrast-low", i));
        }

        cards.push(CardObservation {
            region_index: i,
            present,
            card_rect: if present {
                Some(name_band_rects[i].clone())
            } else {
                None
            },
            interior_luma,
            interior_std,
            frame_contrast,
            edge_energy,
            structural_score,
            fingerprint,
        });
    }

    let present = n_present >= MIN_PRESENT_CARDS;

    // Occlusion: a large opaque panel (modal/scoreboard) crossing the card
    // interiors fills BOTH inter-card gaps with a dark, smooth rectangle. Only
    // meaningful when cards exist behind it.
    let (gap1_l, gap1_std) =
        luma.mean_std(luma.region_px(viewport_px, GAP1_X0, GAP_TOP, GAP1_X1, GAP_BOTTOM));
    let (gap2_l, gap2_std) =
        luma.mean_std(luma.region_px(viewport_px, GAP2_X0, GAP_TOP, GAP2_X1, GAP_BOTTOM));
    let gap1_paneled = gap1_l < T_GAP_PANEL_LUMA && gap1_std < T_GAP_PANEL_STD;
    let gap2_paneled = gap2_l < T_GAP_PANEL_LUMA && gap2_std < T_GAP_PANEL_STD;
    let opaque_surface = gap1_l < T_GAP_PANEL_LUMA
        && gap2_l < T_GAP_PANEL_LUMA
        && gap1_std < 34.0
        && gap2_std < 34.0;
    let occluded = (present && gap1_paneled && gap2_paneled) || (!present && opaque_surface);

    if !present {
        rejection_reasons.push(format!("insufficient-cards-{}/3", n_present));
    }
    if occluded {
        rejection_reasons.push(
            if present {
                "occluded-modal-panel"
            } else {
                "occluded-opaque-surface"
            }
            .to_string(),
        );
    }

    let confidence = if present && n_present > 0 {
        score_sum / n_present as f32
    } else {
        0.0
    };

    SurfaceObservation {
        probe_seq,
        captured_at,
        capture_width: luma.width as u32,
        capture_height: luma.height as u32,
        present,
        occluded,
        confidence,
        blue_control,
        cards,
        rejection_reasons,
        pre_capture_ms: 0,
        capture_ms: 0,
        analysis_ms: 0,
        elapsed_ms,
        // The async-runtime waits are measured by the command that dispatched
        // this analysis, never by the pure analyzer. 0 until it fills them in.
        dispatch_wait_ms: 0,
        resume_wait_ms: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calibration::{physical_card_rects, Rect};

    fn full_viewport() -> Rect {
        Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        }
    }

    fn name_bands(viewport: &Rect) -> [Rect; 3] {
        let v = physical_card_rects(viewport);
        [v[0].clone(), v[1].clone(), v[2].clone()]
    }

    fn load(name: &str) -> image::DynamicImage {
        let path = format!(
            "{}/tests/fixtures/surface/{}",
            env!("CARGO_MANIFEST_DIR"),
            name
        );
        image::open(&path).unwrap_or_else(|e| panic!("load {}: {}", path, e))
    }

    fn analyze(name: &str) -> SurfaceObservation {
        let vp = full_viewport();
        let bands = name_bands(&vp);
        analyze_surface(&load(name), &vp, &bands, 1, 0.0, 0)
    }

    fn analyze_live_crop(name: &str) -> SurfaceObservation {
        // Live fixtures are the sanitized original-screen rect
        // x=280..1005, y=125..535. A translated 1280x720 viewport preserves
        // the production normalized geometry while keeping unrelated HUD/PII
        // completely outside the committed image.
        let viewport = Rect {
            x: -280,
            y: -125,
            width: 1280,
            height: 720,
        };
        let bands = name_bands(&full_viewport());
        analyze_surface(&load(name), &viewport, &bands, 1, 0.0, 0)
    }

    fn analyze_july20(name: &str) -> SurfaceObservation {
        analyze_live_crop(&format!("july20/{}", name))
    }

    fn detect_july20_control(name: &str) -> BlueControlObservation {
        let image = load(&format!("july20/{}-control.png", name));
        let viewport = Rect {
            x: -540,
            y: -530,
            width: 1280,
            height: 720,
        };
        detect_blue_augment_control(&image, &viewport)
    }

    fn hamming(a: &str, b: &str) -> usize {
        a.chars().zip(b.chars()).filter(|(x, y)| x != y).count()
    }

    // ── presence / absence / occlusion against labeled fixtures ──

    #[test]
    fn gold_offer_is_present_not_occluded() {
        let o = analyze("offer-gold-a.png");
        assert!(
            o.present,
            "gold offer should be present: {:?}",
            o.rejection_reasons
        );
        assert!(!o.occluded, "gold offer is not occluded");
        assert_eq!(o.cards.iter().filter(|c| c.present).count(), 3);
    }

    #[test]
    fn second_gold_offer_is_present() {
        let o = analyze("offer-gold-b.png");
        assert!(o.present && !o.occluded, "{:?}", o.rejection_reasons);
    }

    #[test]
    fn silver_frame_offer_is_present_color_independent() {
        // Silver-frame cards must pass exactly like gold — the gate is luminance
        // contrast, never frame color.
        let o = analyze("offer-silver.png");
        assert!(
            o.present && !o.occluded,
            "silver offer present: {:?}",
            o.rejection_reasons
        );
        assert_eq!(o.cards.iter().filter(|c| c.present).count(), 3);
    }

    #[test]
    fn live_blink_frames_are_independently_present_and_unoccluded() {
        for name in [
            "live-blink/offer-a-105715-0.png",
            "live-blink/offer-a-105715-1.png",
            "live-blink/offer-a-105716.png",
            "live-blink/offer-b-105740.png",
            "live-blink/offer-b-105741.png",
        ] {
            let observation = analyze_live_crop(name);
            eprintln!(
                "[live-blink-fixture] {} present={} occluded={} confidence={:.4} cards={:?} reasons={:?}",
                name,
                observation.present,
                observation.occluded,
                observation.confidence,
                observation.cards.iter().map(|card| (
                    card.interior_luma,
                    card.interior_std,
                    card.frame_contrast,
                    card.present,
                )).collect::<Vec<_>>(),
                observation.rejection_reasons,
            );
            assert!(
                observation.present,
                "{}: {:?}",
                name, observation.rejection_reasons
            );
            assert!(!observation.occluded, "{}", name);
            assert_eq!(
                observation.cards.iter().filter(|card| card.present).count(),
                3
            );
        }
    }

    #[test]
    fn live_blink_105715_and_105716_metrics_are_locked() {
        let cases = [
            (
                "live-blink/offer-a-105715-0.png",
                0.9221,
                [
                    (12.9687, 1.1279, 109.8679),
                    (12.9676, 1.1281, 109.6689),
                    (12.9599, 1.1292, 112.4096),
                ],
            ),
            (
                "live-blink/offer-a-105716.png",
                0.9176,
                [
                    (12.9687, 1.1279, 109.4353),
                    (12.9676, 1.1281, 109.0771),
                    (12.9599, 1.1292, 111.8062),
                ],
            ),
        ];
        for (name, expected_confidence, expected_cards) in cases {
            let observation = analyze_live_crop(name);
            assert!((observation.confidence - expected_confidence).abs() < 0.001);
            for (card, (mean, std, contrast)) in observation.cards.iter().zip(expected_cards) {
                assert!(card.present, "{} card{}", name, card.region_index);
                assert!((card.interior_luma - mean).abs() < 0.001);
                assert!((card.interior_std - std).abs() < 0.001);
                assert!((card.frame_contrast - contrast).abs() < 0.001);
            }
        }
    }

    #[test]
    fn alternating_live_positive_frames_never_hide_for_500_probes() {
        let fixtures = [
            "live-blink/offer-a-105715-0.png",
            "live-blink/offer-a-105715-1.png",
            "live-blink/offer-a-105716.png",
            "live-blink/offer-b-105740.png",
            "live-blink/offer-b-105741.png",
        ];
        for seq in 0..500 {
            let observation = analyze_live_crop(fixtures[seq % fixtures.len()]);
            assert!(
                observation.present && !observation.occluded,
                "probe {} fixture {}: {:?}",
                seq,
                fixtures[seq % fixtures.len()],
                observation.rejection_reasons,
            );
        }
    }

    #[test]
    fn animated_sparkles_keep_each_static_offer_fingerprint_stable() {
        for names in [
            [
                "live-blink/offer-a-105715-0.png",
                "live-blink/offer-a-105715-1.png",
                "live-blink/offer-a-105716.png",
            ]
            .as_slice(),
            [
                "live-blink/offer-b-105740.png",
                "live-blink/offer-b-105741.png",
            ]
            .as_slice(),
        ] {
            let first = analyze_live_crop(names[0]);
            for name in &names[1..] {
                let current = analyze_live_crop(name);
                assert!(current.present && !current.occluded);
                for slot in 0..3 {
                    assert!(
                        hamming(
                            &first.cards[slot].fingerprint,
                            &current.cards[slot].fingerprint,
                        ) <= 8,
                        "{} slot{} fingerprint changed across sparkle animation",
                        name,
                        slot,
                    );
                }
            }
        }
    }

    #[test]
    fn july20_unchanged_offer_fingerprints_are_stable() {
        let first = analyze_july20("july20-110425.png");
        let later = analyze_july20("july20-110439.png");
        assert!(first.present && later.present);
        for slot in 0..3 {
            assert!(
                hamming(
                    &first.cards[slot].fingerprint,
                    &later.cards[slot].fingerprint
                ) <= 8,
                "unchanged slot {} exceeded the stable-card Hamming band",
                slot,
            );
        }
    }

    #[test]
    fn july20_left_reroll_changes_only_left_fingerprint() {
        let before = analyze_july20("july20-110708.png");
        let after = analyze_july20("july20-110712.png");
        assert!(before.present && after.present);
        assert!(hamming(&before.cards[0].fingerprint, &after.cards[0].fingerprint) > 8);
        for slot in 1..3 {
            assert!(
                hamming(
                    &before.cards[slot].fingerprint,
                    &after.cards[slot].fingerprint
                ) <= 8,
                "neighbor slot {} changed across a left-only reroll",
                slot,
            );
        }
    }

    #[test]
    fn july20_recovery_sequence_keeps_later_offers_detectable() {
        for name in [
            "july20-110714.png",
            "july20-110954.png",
            "july20-110956.png",
            "july20-111042.png",
        ] {
            let observation = analyze_july20(name);
            assert!(
                observation.present,
                "{}: {:?}",
                name, observation.rejection_reasons
            );
            assert!(!observation.occluded, "{}", name);
        }
    }

    #[test]
    fn july20_shop_and_combat_render_no_surface() {
        let shop = analyze_july20("july20-111048.png");
        assert!(!shop.present, "{:?}", shop.cards);
        assert!(shop.occluded, "shop must be explicit occlusion evidence");
        let combat = analyze_july20("july20-111050.png");
        assert!(!combat.present, "{:?}", combat.cards);
        assert!(
            !combat.occluded,
            "ordinary combat is NO_OFFER, not occlusion"
        );
    }

    #[test]
    fn july20_blue_control_is_present_on_every_visible_offer() {
        for name in [
            "july20-110425",
            "july20-110439",
            "july20-110708",
            "july20-110712",
            "july20-110714",
            "july20-110954",
            "july20-110956",
            "july20-111042",
        ] {
            let control = detect_july20_control(name);
            assert!(control.present, "{}: {:?}", name, control);
            assert!(control.confidence >= 0.72, "{}: {:?}", name, control);
        }
    }

    #[test]
    fn july20_blue_control_is_absent_in_shop_and_combat() {
        for name in ["july20-111048", "july20-111050"] {
            let control = detect_july20_control(name);
            eprintln!("[blue-control-negative] {} {:?}", name, control);
            assert!(!control.present, "{}: {:?}", name, control);
        }
    }

    #[test]
    fn july20_blue_control_survives_two_x_scaling() {
        let image = load("july20/july20-110425-control.png");
        let scaled = image.resize_exact(400, 160, image::imageops::FilterType::Nearest);
        let viewport = Rect {
            x: -1080,
            y: -1060,
            width: 2560,
            height: 1440,
        };
        let control = detect_blue_augment_control(&scaled, &viewport);
        assert!(control.present, "{:?}", control);
        assert!((control.features.aspect_ratio - 3.4494).abs() < 0.01);
    }

    #[test]
    fn round7_live_frames_keep_all_three_slots_structurally_stable() {
        let frames = [
            "live-round7/offer-purple-30310.png",
            "live-round7/offer-purple-30312.png",
            "live-round7/offer-purple-30314.png",
            "live-round7/offer-gold-30741.png",
            "live-round7/offer-gold-30748.png",
            "live-round7/offer-silver-31259.png",
            "live-round7/offer-gold-31557.png",
        ];
        let observations = frames.map(|name| {
            let observation = analyze_live_crop(name);
            eprintln!(
                "[round7] {} present={} occluded={} confidence={:.4} metrics={:?}",
                name,
                observation.present,
                observation.occluded,
                observation.confidence,
                observation
                    .cards
                    .iter()
                    .map(|card| (
                        card.interior_luma,
                        card.interior_std,
                        card.frame_contrast,
                        card.structural_score,
                        card.present,
                    ))
                    .collect::<Vec<_>>(),
            );
            observation
        });
        for (frame, observation) in frames.iter().zip(&observations) {
            assert!(
                observation.present,
                "{}: {:?}",
                frame, observation.rejection_reasons
            );
            assert!(!observation.occluded, "{}", frame);
            assert_eq!(
                observation.cards.iter().filter(|card| card.present).count(),
                3,
                "{} must keep all three current slots",
                frame,
            );
        }

        for probe_seq in 0..500 {
            let frame = frames[probe_seq % frames.len()];
            let observation = analyze_live_crop(frame);
            assert!(
                observation.present && !observation.occluded,
                "probe {} {}: {:?}",
                probe_seq,
                frame,
                observation.rejection_reasons,
            );
            assert_eq!(
                observation.cards.iter().filter(|card| card.present).count(),
                3,
                "probe {} {} must keep all three slots",
                probe_seq,
                frame,
            );
        }

        for sequence in [[0, 1, 2].as_slice(), [3, 4].as_slice()] {
            for pair in sequence.windows(2) {
                for slot in 0..3 {
                    assert!(
                        hamming(
                            &observations[pair[0]].cards[slot].fingerprint,
                            &observations[pair[1]].cards[slot].fingerprint,
                        ) <= 8,
                        "{} -> {} slot{} fingerprint drift",
                        frames[pair[0]],
                        frames[pair[1]],
                        slot,
                    );
                }
            }
        }

        // Quest/reward copy animated inside the old sample on the first card.
        // The corrected dead zone remains flat in both consecutive frames.
        assert!(observations[3].cards[0].interior_std < 2.0);
        assert!(observations[4].cards[0].interior_std < 2.0);

        // Narrowing the window for animation must not collapse real identities.
        for (frame, observation) in frames.iter().zip(&observations) {
            for (left, right) in [(0, 1), (0, 2), (1, 2)] {
                assert!(
                    hamming(
                        &observation.cards[left].fingerprint,
                        &observation.cards[right].fingerprint,
                    ) > 8,
                    "{} slots {} and {} must remain distinct",
                    frame,
                    left,
                    right,
                );
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn silver_fixture_resolves_all_three_titles_and_records_ocr_latency() {
        use crate::ocr::{read_card_text, GameLocale};

        let frame = load("offer-silver.png");
        let expected = ["無敵大絕", "毫髮無傷", "重型打手"];
        let known_names = expected
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        let rects = name_bands(&full_viewport());
        let started = std::time::Instant::now();
        let mut per_slot_ms = Vec::new();

        for (region_index, rect) in rects.iter().enumerate() {
            let slot_started = std::time::Instant::now();
            let crop = frame.crop_imm(rect.x as u32, rect.y as u32, rect.width, rect.height);
            let title = read_card_text(&crop, Some(GameLocale::ZhTw), &known_names)
                .expect("Vision OCR")
                .unwrap_or_default();
            per_slot_ms.push(slot_started.elapsed().as_secs_f64() * 1000.0);
            let normalized: String = title
                .chars()
                .filter(|value| !value.is_whitespace())
                .collect();
            assert!(
                !normalized.is_empty()
                    && (normalized.contains(expected[region_index])
                        || expected[region_index].contains(&normalized)),
                "slot {} expected {:?}, got {:?}",
                region_index,
                expected[region_index],
                title,
            );
        }

        eprintln!(
            "[silver-ocr-replay] per-slot-ms={:?} sequential-total-ms={:.1}",
            per_slot_ms,
            started.elapsed().as_secs_f64() * 1000.0,
        );
    }

    #[test]
    fn afk_modal_is_present_but_occluded() {
        // Cards exist behind the AFK dialog → present=true, occluded=true. The
        // frontend renders zero chips while occluded.
        let o = analyze("offer-occluded-modal.png");
        assert!(o.present, "cards still exist behind the modal");
        assert!(o.occluded, "AFK modal must classify as occluded");
        assert!(o
            .rejection_reasons
            .iter()
            .any(|r| r == "occluded-modal-panel"));
    }

    #[test]
    fn combat_is_absent() {
        let o = analyze("combat.png");
        assert!(!o.present, "combat has no card surface: {:?}", o);
        assert!(!o.occluded);
        assert_eq!(o.cards.iter().filter(|c| c.present).count(), 0);
    }

    // ── the exact live regression: identical static pixels, repeated probes ──

    #[test]
    fn silver_pixels_stay_present_and_stable_for_100_probes() {
        // The 22:29:31 failure: a static offer blinked present→absent→present.
        // A geometry probe over unchanged SILVER pixels must be present and
        // fingerprint-stable for at least 100 consecutive probes.
        let expected = analyze("offer-silver.png");
        let expected_fingerprints: Vec<_> = expected
            .cards
            .iter()
            .map(|card| card.fingerprint.clone())
            .collect();
        for seq in 0..100 {
            let vp = full_viewport();
            let bands = name_bands(&vp);
            let o = analyze_surface(&load("offer-silver.png"), &vp, &bands, seq, seq as f64, 0);
            assert!(
                o.present && !o.occluded,
                "probe {} regressed: {:?}",
                seq,
                o.rejection_reasons
            );
            assert_eq!(
                o.cards
                    .iter()
                    .map(|card| card.fingerprint.clone())
                    .collect::<Vec<_>>(),
                expected_fingerprints,
                "probe {} fingerprint drifted",
                seq,
            );
        }
    }

    // ── fingerprints: stable on identical pixels, distinct on different offers ──

    #[test]
    fn fingerprints_are_stable_across_identical_captures() {
        let a = analyze("offer-gold-a.png");
        let b = analyze("offer-gold-a-repeat.png"); // same offer, next second
        for i in 0..3 {
            assert_eq!(
                a.cards[i].fingerprint, b.cards[i].fingerprint,
                "card{} fingerprint drifted on identical pixels",
                i
            );
        }
    }

    #[test]
    fn fingerprints_differ_across_different_offers() {
        let a = analyze("offer-gold-a.png");
        let b = analyze("offer-gold-b.png");
        for i in 0..3 {
            let d = hamming(&a.cards[i].fingerprint, &b.cards[i].fingerprint);
            assert!(d > 8, "card{} fingerprints too similar (hamming {})", i, d);
        }
    }

    #[test]
    fn fingerprints_distinguish_slots_within_one_offer() {
        let a = analyze("offer-gold-a.png");
        assert!(hamming(&a.cards[0].fingerprint, &a.cards[1].fingerprint) > 8);
        assert!(hamming(&a.cards[1].fingerprint, &a.cards[2].fingerprint) > 8);
    }

    // ── retina / scaling invariance ──

    #[test]
    fn detection_survives_2x_retina_scaling() {
        let base = load("offer-gold-a.png");
        let scaled = base.resize(
            base.width() * 2,
            base.height() * 2,
            image::imageops::FilterType::Triangle,
        );
        let vp = Rect {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        };
        // name-band rects are logical (unchanged by capture resolution)
        let bands = name_bands(&full_viewport());
        let o = analyze_surface(&scaled, &vp, &bands, 1, 0.0, 0);
        assert!(
            o.present && !o.occluded,
            "2x retina lost the offer: {:?}",
            o.rejection_reasons
        );
        assert_eq!(o.capture_width, 2560);
    }

    #[test]
    fn occlusion_survives_2x_retina_scaling() {
        let base = load("offer-occluded-modal.png");
        let scaled = base.resize(
            base.width() * 2,
            base.height() * 2,
            image::imageops::FilterType::Triangle,
        );
        let vp = Rect {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        };
        let bands = name_bands(&full_viewport());
        let o = analyze_surface(&scaled, &vp, &bands, 1, 0.0, 0);
        assert!(
            o.present && o.occluded,
            "2x retina lost occlusion: {:?}",
            o.rejection_reasons
        );
    }

    // ── present cards carry a render rect; absent/occluded surfaces do not ──

    #[test]
    fn present_cards_carry_name_band_rects() {
        let o = analyze("offer-gold-a.png");
        assert_eq!(o.cards.iter().filter(|c| c.card_rect.is_some()).count(), 3);
    }

    #[test]
    fn combat_cards_carry_no_rects() {
        let o = analyze("combat.png");
        assert!(o.cards.iter().all(|c| c.card_rect.is_none()));
    }

    // Analyze-only micro-benchmark (no screen capture): the CV cost the render
    // path pays per probe. Run explicitly:
    //   cargo test surface_probe -- --ignored --nocapture bench_analyze_latency
    #[test]
    #[ignore]
    fn bench_analyze_latency() {
        let vp = full_viewport();
        let bands = name_bands(&vp);
        let img = load("offer-gold-a.png");
        // Warm caches, then time 200 analyses.
        for _ in 0..20 {
            let _ = analyze_surface(&img, &vp, &bands, 1, 0.0, 0);
        }
        let mut samples: Vec<f64> = Vec::with_capacity(200);
        for seq in 0..200u64 {
            let start = std::time::Instant::now();
            let _ = analyze_surface(&img, &vp, &bands, seq, 0.0, 0);
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let at = |q: f64| samples[((q * samples.len() as f64) as usize).min(samples.len() - 1)];
        println!(
            "[analyze-bench] n={} p50={:.3} p95={:.3} p99={:.3} max={:.3} ms",
            samples.len(),
            at(0.5),
            at(0.95),
            at(0.99),
            samples[samples.len() - 1],
        );
    }
}
