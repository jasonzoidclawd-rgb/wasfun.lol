import { describe, expect, it } from "vitest";
import {
  geometryPreviewEnabledFrom,
  resolveOverlayFixtureMode,
} from "./fixtureMode";
import { tierFixtureEnabledFrom } from "./tierFixture";

const baseInput = {
  tierFixtureOn: true,
  previewOn: false,
  gameWindowForeground: false,
  phase: "idle" as const,
  offerActive: false,
  aramggReady: true,
};

describe("development overlay surface modes", () => {
  it("requires a development build before either fixture flag is enabled", () => {
    expect(tierFixtureEnabledFrom({ dev: false, flag: "1" })).toBe(false);
    expect(geometryPreviewEnabledFrom({ dev: false, flag: "1" })).toBe(false);
  });

  it("keeps the tier fixture hidden over Riot Client while a game is running", () => {
    expect(
      resolveOverlayFixtureMode({
        ...baseInput,
        phase: "in_game",
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("allows only explicit geometry preview to render without the game", () => {
    expect(
      resolveOverlayFixtureMode({
        ...baseInput,
        tierFixtureOn: false,
        previewOn: true,
      }),
    ).toEqual({ kind: "preview" });
  });

  it("renders a real fixture offer only for a focused LATCHED selection", () => {
    expect(
      resolveOverlayFixtureMode({
        ...baseInput,
        gameWindowForeground: true,
        phase: "augment_selection",
        offerActive: true,
      }),
    ).toEqual({ kind: "real-offer" });
  });

  it("keeps a focused screen with no latched offer diagnostic-only, never synthetic", () => {
    expect(
      resolveOverlayFixtureMode({
        ...baseInput,
        gameWindowForeground: true,
        phase: "augment_selection",
      }),
    ).toEqual({ kind: "ocr-unavailable" });
  });
});
