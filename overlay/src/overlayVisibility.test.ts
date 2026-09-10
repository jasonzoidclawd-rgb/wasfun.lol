import { describe, expect, it } from "vitest";
import {
  gameOverlayVisible,
  unknownForegroundState,
  type ForegroundState,
} from "./overlayVisibility";

function foreground(overrides: Partial<ForegroundState>): ForegroundState {
  return {
    ...unknownForegroundState(),
    ...overrides,
  };
}

describe("game overlay visibility", () => {
  it("allows in-game surfaces for the actual League game foreground", () => {
    expect(
      gameOverlayVisible({
        gameWindowForeground: foreground({
          gameWindowForeground: true,
          foregroundBundleIdentifier: "com.riotgames.LeagueofLegends.GameClient",
        }).gameWindowForeground,
        previewMode: false,
      }),
    ).toBe(true);
  });

  it("rejects Riot Client even while the game process is still running", () => {
    expect(
      gameOverlayVisible({
        gameWindowForeground: foreground({
          gameRunning: true,
          riotClientForeground: true,
          foregroundBundleIdentifier: "com.riotgames.RiotGames.RiotClient",
        }).gameWindowForeground,
        previewMode: false,
      }),
    ).toBe(false);
  });

  it("rejects Finder and Safari-equivalent unfocused states", () => {
    expect(
      gameOverlayVisible({
        gameWindowForeground: foreground({
          gameRunning: true,
          foregroundAppName: "Finder",
          foregroundBundleIdentifier: "com.apple.finder",
        }).gameWindowForeground,
        previewMode: false,
      }),
    ).toBe(false);
  });

  it("allows only explicit geometry preview outside the game", () => {
    expect(gameOverlayVisible({ gameWindowForeground: false, previewMode: true })).toBe(true);
    // MAYHEM_OVERLAY_TIER_FIXTURE=1 is not part of this predicate and cannot
    // authorize pixels by itself.
    expect(gameOverlayVisible({ gameWindowForeground: false, previewMode: false })).toBe(false);
  });

  it("starts fail-closed before native foreground state is known", () => {
    expect(unknownForegroundState().gameWindowForeground).toBe(false);
  });
});
