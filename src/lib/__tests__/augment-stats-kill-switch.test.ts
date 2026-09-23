import { afterEach, describe, expect, test, vi } from "vitest";
import { handleChampionMatrix, handleEvaluate, type DecisionApiDeps } from "../api/decision";
import { handleOverlayBootstrap, type OverlayApiDeps } from "../api/overlay";
import { loadChampionDetailData } from "../champions/detail-data";
import {
  AUGMENT_STATS_ENV,
  augmentStatsEnabled,
  stripAugmentStats,
} from "../stats/kill-switch";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("augmentStatsEnabled", () => {
  test("statistics are on when the flag is unset or explicitly on", () => {
    expect(augmentStatsEnabled({})).toBe(true);
    for (const value of ["on", "ON", " true ", "1"]) {
      expect(augmentStatsEnabled({ [AUGMENT_STATS_ENV]: value })).toBe(true);
    }
  });

  test("any other value turns them off, so a mistyped kill still kills", () => {
    for (const value of ["off", "OFF", "0", "false", "no", "of", "disabled", "", "  "]) {
      expect(augmentStatsEnabled({ [AUGMENT_STATS_ENV]: value })).toBe(false);
    }
  });
});

describe("stripAugmentStats", () => {
  test("nulls every statistic and keeps identity and text", () => {
    const row = { slug: "tank-engine", name: "Tank Engine", win_rate: 60.1, pickRate: 43.6, letter: "S", score: 9 };
    expect(stripAugmentStats(row)).toEqual({
      slug: "tank-engine",
      name: "Tank Engine",
      win_rate: null,
      pickRate: null,
      letter: null,
      score: null,
    });
  });
});

const neverCalled = () => {
  throw new Error("the kill switch must answer before any gate or data load");
};

describe("with WASFUN_AUGMENT_STATS=off", () => {
  test("the decision APIs answer 503 before touching entitlement or data", async () => {
    vi.stubEnv(AUGMENT_STATS_ENV, "off");
    const deps: DecisionApiDeps = { requireEntitlement: neverCalled, loadData: neverCalled };
    const request = () => new Request("http://test.local/api", { method: "POST", body: "{}" });
    for (const handler of [handleEvaluate, handleChampionMatrix]) {
      const response = await handler(request(), deps);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "augment-stats-unavailable" });
    }
  });

  test("the overlay model manifest is withheld", async () => {
    vi.stubEnv(AUGMENT_STATS_ENV, "off");
    const deps = { requireEntitlement: neverCalled, getActiveRelease: neverCalled } as unknown as OverlayApiDeps;
    const response = await handleOverlayBootstrap(new Request("http://test.local/api"), deps);
    expect(response.status).toBe(503);
  });

  test("member champion data carries no augment win rates", async () => {
    const on = await loadChampionDetailData("member");
    expect(on.augments.some((augment) => typeof augment.win_rate === "number")).toBe(true);

    vi.stubEnv(AUGMENT_STATS_ENV, "off");
    const off = await loadChampionDetailData("member");
    expect(off.augments.length).toBe(on.augments.length);
    expect(off.augments.every((augment) => augment.win_rate === null)).toBe(true);
  });
});
