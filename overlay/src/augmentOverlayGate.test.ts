import { describe, expect, it } from "vitest";
import {
  disabledMember,
  memberRecommendationsVisible,
} from "./auth/member";
import {
  localOverlayAuthorized,
  realAugmentOverlayRenderable,
} from "./augmentOverlayGate";
import { tierFixtureEnabledFrom } from "./dev/tierFixture";

const otherwiseRenderable = {
  previewMode: false,
  visibleFrameRenderable: true,
  offerSurfaceRenderable: true,
  geometrySchedulerHealthy: true,
};

describe("localOverlayAuthorized", () => {
  it("authorizes a real member entitlement without any fixture flag", () => {
    expect(localOverlayAuthorized({
      devBuild: false,
      tierFixtureEnabled: false,
      memberCoachEnabled: true,
    })).toBe(true);
    expect(localOverlayAuthorized({
      devBuild: true,
      tierFixtureEnabled: false,
      memberCoachEnabled: true,
    })).toBe(true);
  });

  it("authorizes the explicit fixture workflow without a member entitlement", () => {
    expect(localOverlayAuthorized({
      devBuild: true,
      tierFixtureEnabled: true,
      memberCoachEnabled: false,
    })).toBe(true);
  });

  it("refuses an ordinary development launch with no fixture flag", () => {
    // `npm run tauri dev` with MAYHEM_OVERLAY_TIER_FIXTURE unset: no member
    // authorization and no explicit fixture authorization → no local content.
    expect(tierFixtureEnabledFrom({ dev: true, flag: undefined })).toBe(false);
    expect(localOverlayAuthorized({
      devBuild: true,
      tierFixtureEnabled: false,
      memberCoachEnabled: false,
    })).toBe(false);
  });

  it("fails closed in production with neither member nor fixture", () => {
    expect(localOverlayAuthorized({
      devBuild: false,
      tierFixtureEnabled: false,
      memberCoachEnabled: false,
    })).toBe(false);
  });

  it("cannot be opened by toggling only the development build flag", () => {
    for (const devBuild of [false, true]) {
      expect(localOverlayAuthorized({
        devBuild,
        tierFixtureEnabled: false,
        memberCoachEnabled: false,
      })).toBe(false);
    }
  });

  it("never lets a fixture flag authorize a production build", () => {
    // Production aliases isTierFixtureEnabled() to a constant false, and the
    // predicate independently requires a dev build, so both layers must fail.
    expect(tierFixtureEnabledFrom({ dev: false, flag: "1" })).toBe(false);
    expect(localOverlayAuthorized({
      devBuild: false,
      tierFixtureEnabled: true,
      memberCoachEnabled: false,
    })).toBe(false);
  });
});

describe("realAugmentOverlayRenderable", () => {
  it("renders the local augment overlay for an explicit fixture launch when member coach is unauthenticated", () => {
    const memberCoachEnabled = memberRecommendationsVisible(
      true,
      disabledMember("unauthenticated"),
    );

    expect(memberCoachEnabled).toBe(false);
    expect(realAugmentOverlayRenderable({
      ...otherwiseRenderable,
      devBuild: true,
      tierFixtureEnabled: true,
      memberCoachEnabled,
    })).toBe(true);
  });

  it("does not render for an unauthenticated member on a plain development launch", () => {
    expect(realAugmentOverlayRenderable({
      ...otherwiseRenderable,
      devBuild: true,
      tierFixtureEnabled: false,
      memberCoachEnabled: false,
    })).toBe(false);
  });

  it("renders for an authorized member with no fixture flag", () => {
    expect(realAugmentOverlayRenderable({
      ...otherwiseRenderable,
      devBuild: false,
      tierFixtureEnabled: false,
      memberCoachEnabled: true,
    })).toBe(true);
  });

  it("does not bypass unauthenticated member authorization in production", () => {
    expect(realAugmentOverlayRenderable({
      ...otherwiseRenderable,
      devBuild: false,
      tierFixtureEnabled: false,
      memberCoachEnabled: false,
    })).toBe(false);
  });

  it("preserves every non-auth render safety gate on both authorized paths", () => {
    const authorized = [
      { devBuild: true, tierFixtureEnabled: true, memberCoachEnabled: false },
      { devBuild: false, tierFixtureEnabled: false, memberCoachEnabled: true },
    ];

    for (const authorization of authorized) {
      for (const blockedGate of [
        "visibleFrameRenderable",
        "offerSurfaceRenderable",
        "geometrySchedulerHealthy",
      ] as const) {
        expect(realAugmentOverlayRenderable({
          ...otherwiseRenderable,
          ...authorization,
          [blockedGate]: false,
        })).toBe(false);
      }

      expect(realAugmentOverlayRenderable({
        ...otherwiseRenderable,
        ...authorization,
        previewMode: true,
      })).toBe(false);
    }
  });
});
