export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonitorInfo extends PhysicalRect {
  scaleFactor: number;
}

export interface NormalizedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CssSize {
  width: number;
  height: number;
}

export interface OverlayCalibration {
  monitor: MonitorInfo;
  gameWindow: PhysicalRect | null;
  viewport: PhysicalRect;
  /**
   * The rect (same calibrated space as `viewport`) the overlay webview's CSS
   * box maps onto — the monitor on macOS (fullscreen overlay window), the
   * viewport on Windows (the backend repositions the window onto it). All
   * CSS conversion goes through `cssRectFromCalibratedRect` with this anchor;
   * `monitor.scaleFactor` is display metadata only, never geometry.
   */
  overlayAnchor: PhysicalRect;
  mode: "league-window" | "borderless-monitor-fallback" | "monitor-fallback";
  warnings: string[];
}

export const CARD_NAME_REGIONS: NormalizedRegion[] = [
  { x: 0.219, y: 0.347, w: 0.172, h: 0.083 },
  { x: 0.414, y: 0.347, w: 0.172, h: 0.083 },
  { x: 0.609, y: 0.347, w: 0.172, h: 0.083 },
];

const FULLSCREEN_TOLERANCE_PX = 24;
const FULLSCREEN_TOLERANCE_RATIO = 0.02;

function edgeTolerance(monitor: PhysicalRect): number {
  return Math.max(
    FULLSCREEN_TOLERANCE_PX,
    Math.round(Math.max(monitor.width, monitor.height) * FULLSCREEN_TOLERANCE_RATIO),
  );
}

function right(rect: PhysicalRect): number {
  return rect.x + rect.width;
}

function bottom(rect: PhysicalRect): number {
  return rect.y + rect.height;
}

export function rectApproximatelyMatchesMonitor(
  monitor: PhysicalRect,
  rect: PhysicalRect,
): boolean {
  const tolerance = edgeTolerance(monitor);

  return (
    Math.abs(monitor.x - rect.x) <= tolerance &&
    Math.abs(monitor.y - rect.y) <= tolerance &&
    Math.abs(right(monitor) - right(rect)) <= tolerance &&
    Math.abs(bottom(monitor) - bottom(rect)) <= tolerance
  );
}

export function selectOverlayViewport(
  monitor: MonitorInfo,
  gameWindow: PhysicalRect | null,
): OverlayCalibration {
  if (!gameWindow) {
    return {
      monitor,
      gameWindow: null,
      viewport: rectOnly(monitor),
      overlayAnchor: rectOnly(monitor),
      mode: "monitor-fallback",
      warnings: ["League window not detected; using monitor bounds."],
    };
  }

  if (rectApproximatelyMatchesMonitor(monitor, gameWindow)) {
    return {
      monitor,
      gameWindow,
      viewport: rectOnly(monitor),
      overlayAnchor: rectOnly(monitor),
      mode: "borderless-monitor-fallback",
      warnings: [],
    };
  }

  return {
    monitor,
    gameWindow,
    viewport: rectOnly(gameWindow),
    overlayAnchor: rectOnly(monitor),
    mode: "league-window",
    warnings: [],
  };
}

export function physicalRectForNormalizedRegion(
  region: NormalizedRegion,
  viewport: PhysicalRect,
): PhysicalRect {
  const x = viewport.x + Math.round(region.x * viewport.width);
  const y = viewport.y + Math.round(region.y * viewport.height);
  const width = Math.round(region.w * viewport.width);
  const height = Math.round(region.h * viewport.height);

  return {
    x,
    y,
    width: Math.max(0, Math.min(width, right(viewport) - x)),
    height: Math.max(0, Math.min(height, bottom(viewport) - y)),
  };
}

/**
 * THE coordinate-space boundary (fix #3, scale-flap regression).
 *
 * Every calibrated rect (viewport, detected card rects, normalized regions
 * resolved against the viewport) converts to overlay-window CSS pixels here,
 * exactly once, as a pure ratio between the overlay anchor and the CSS window
 * size the webview itself reports (window.innerWidth/innerHeight):
 *
 *   cssX = (x − anchor.x) × cssWindow.width / anchor.width
 *
 * scaleFactor / devicePixelRatio NEVER enter: a monitor whose reported scale
 * flaps 1.0↔2.0 (observed on macOS) yields identical CSS geometry, and
 * detected-window vs monitor-fallback modes are equivalent by construction
 * because both express rects in the same anchored space.
 */
export function cssRectFromCalibratedRect(
  rect: PhysicalRect,
  anchor: PhysicalRect,
  cssWindow: CssSize,
): PhysicalRect {
  const ratioX = cssWindow.width / Math.max(1, anchor.width);
  const ratioY = cssWindow.height / Math.max(1, anchor.height);

  return {
    x: Math.round((rect.x - anchor.x) * ratioX),
    y: Math.round((rect.y - anchor.y) * ratioY),
    width: Math.round(rect.width * ratioX),
    height: Math.round(rect.height * ratioY),
  };
}

function rectOnly(rect: PhysicalRect): PhysicalRect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}
