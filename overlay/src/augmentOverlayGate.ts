/**
 * Who may see local augment overlay content, and under what render conditions.
 * Authorization (this gate's first concern) is kept separate from presentation
 * safety (foreground, offer surface, geometry health) so neither can silently
 * stand in for the other.
 */

export interface AugmentOverlayAuthorization {
  devBuild: boolean;
  /**
   * The explicit `MAYHEM_OVERLAY_TIER_FIXTURE=1` development workflow
   * (`isTierFixtureEnabled()`), NOT merely "this is a dev build".
   */
  tierFixtureEnabled: boolean;
  memberCoachEnabled: boolean;
}

export interface RealAugmentOverlayGate extends AugmentOverlayAuthorization {
  previewMode: boolean;
  visibleFrameRenderable: boolean;
  offerSurfaceRenderable: boolean;
  geometrySchedulerHealthy: boolean;
}

/**
 * Local overlay content is authorized by exactly two things:
 *
 *   1. a real member entitlement (`memberCoachEnabled`), which works in every
 *      build and is the only production path; or
 *   2. the explicit tier-fixture workflow, which additionally requires a dev
 *      build — an ordinary `npm run tauri dev` launch without
 *      `MAYHEM_OVERLAY_TIER_FIXTURE=1` is NOT authorized and must show no
 *      tiers, win rates, scope labels, or engine-fallback data.
 *
 * `devBuild` alone never authorizes anything, so flipping only
 * `import.meta.env.DEV` cannot open the gate.
 */
export function localOverlayAuthorized(
  input: AugmentOverlayAuthorization,
): boolean {
  return (
    input.memberCoachEnabled || (input.devBuild && input.tierFixtureEnabled)
  );
}

/**
 * Member authentication controls the optional coach. The explicit fixture
 * workflow — and only that workflow — additionally unlocks the local
 * geometry/OCR badge pipeline in development for testing. Every non-auth render
 * safety gate still applies on both paths.
 */
export function realAugmentOverlayRenderable(
  gate: RealAugmentOverlayGate,
): boolean {
  return (
    !gate.previewMode &&
    localOverlayAuthorized(gate) &&
    gate.visibleFrameRenderable &&
    gate.offerSurfaceRenderable &&
    gate.geometrySchedulerHealthy
  );
}
