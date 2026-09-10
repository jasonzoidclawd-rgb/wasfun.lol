/** Development diagnostics are never a production render authorization. */
export function developmentSurfaceVisible(devBuild: boolean): boolean {
  return devBuild === true;
}

/**
 * THE single gate for every development panel (calibration, ARAMGG
 * fixture/debug, OCR diagnostics). A dev build — or any fixture flag — never
 * authorizes rendering on its own: the canonical foreground predicate
 * (`gameOverlayVisible`) must also hold, so panels can never paint over
 * Terminal or any other app the user is actually looking at.
 */
export function devPanelsVisible(input: {
  devBuild: boolean;
  gameOverlayIsVisible: boolean;
}): boolean {
  return developmentSurfaceVisible(input.devBuild) && input.gameOverlayIsVisible;
}
