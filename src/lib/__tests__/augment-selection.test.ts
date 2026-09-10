import { describe, expect, test } from "vitest";
import {
  addAugmentAliases,
  isCompleteThreeCardOffer,
  matchAugment,
  matchAugmentFrame,
  shouldClearOcrStateForGameflow,
  shouldRunOcrForGameflow,
} from "../../../overlay/src/augmentSelection";
import {
  applyScanToOffer,
  emptyOfferState,
  offerActive,
} from "../../../overlay/src/offerLifecycle";
import {
  eligibleRoundCount,
  resolveRoundDelivery,
} from "../../../overlay/src/roundDelivery";
import type { PoolAugment } from "../../../overlay/src/scoring";

function augment(slug: string, name: string, name_zh_TW: string): PoolAugment {
  return {
    slug,
    name,
    name_zh_TW,
    win_rate: 50,
    score: 50,
    tier: "B",
    rarity: "gold",
    probability: 0,
    probabilityWithReroll: 0,
  };
}

const identity = (title: string) => title;

function scan(state = emptyOfferState<string>(), titles: Array<string | null>) {
  return applyScanToOffer(state, titles, identity, (title) => title, () => true);
}

describe("overlay augment selection matching", () => {
  test("level thresholds create ELIGIBILITY, not delivery", () => {
    // Mayhem delivers R1 at the level-3 timing but R2/R3/R4 only during a
    // death sequence after crossing 7/11/15. Crossing a threshold alive must
    // never open a fast scan window or consume a round.
    expect(eligibleRoundCount(3)).toBe(1);
    expect(eligibleRoundCount(7)).toBe(2);
    expect(eligibleRoundCount(11)).toBe(3);
    expect(eligibleRoundCount(15)).toBe(4);

    const aliveAtSeven = resolveRoundDelivery({
      playerLevel: 7,
      isDead: false,
      completedRounds: 1,
      offerLatched: false,
    });
    expect(aliveAtSeven.scanMode).toBe("ambient");
    expect(aliveAtSeven.pendingRounds).toBe(1);
  });

  test("a level gained during an open offer never ends the selection", () => {
    // Regression pin for the level 3→4 badge wipe: the delivery model has no
    // level-derived completion input at all — a latched offer keeps its fast
    // scan loop at any level.
    const midOffer = resolveRoundDelivery({
      playerLevel: 8,
      isDead: false,
      completedRounds: 1,
      offerLatched: true,
    });
    expect(midOffer.scanMode).toBe("fast");
  });

  test("ends the offer only after card text disappears for two consecutive OCR passes", () => {
    const seen = scan(undefined, ["卡一", "卡二", "卡三"]);
    expect(offerActive(seen.state)).toBe(true);

    const firstEmpty = scan(seen.state, [null, null, null]);
    expect(firstEmpty.cleared).toBe(false);
    expect(offerActive(firstEmpty.state)).toBe(true);

    const secondEmpty = scan(firstEmpty.state, [null, null, null]);
    expect(secondEmpty.cleared).toBe(true);
    expect(offerActive(secondEmpty.state)).toBe(false);
  });

  test("treats a full-screen refresh gap as transient, not selection exit", () => {
    const seen = scan(undefined, ["卡一", "卡二", "卡三"]);
    const refreshGap = scan(seen.state, [null, null, null]);
    const refreshed = scan(refreshGap.state, ["卡一", "卡二", "卡三"]);

    expect(refreshGap.cleared).toBe(false);
    expect(refreshed.cleared).toBe(false);
    expect(refreshed.state.screenEmptyPasses).toBe(0);
    expect(offerActive(refreshed.state)).toBe(true);
  });

  test("preserves three-card slot order from OCR fixture frames", () => {
    const left = augment("left-card", "Left Card", "左卡");
    const middle = augment("middle-card", "Middle Card", "中卡");
    const right = augment("right-card", "Right Card", "右卡");
    const lookup = new Map<string, PoolAugment>([
      [left.name, left],
      [middle.name, middle],
      [right.name, right],
    ]);

    const matched = matchAugmentFrame(
      [
        { text: "Right Card", region_index: 2 },
        { text: "Left Card", region_index: 0 },
        { text: "Middle Card", region_index: 1 },
      ],
      lookup,
    );

    expect(matched.map((card) => card.augment.slug)).toEqual([
      "left-card",
      "middle-card",
      "right-card",
    ]);
    expect(isCompleteThreeCardOffer(matched)).toBe(true);
  });

  test("keeps partial reads incomplete while preserving recognized slots", () => {
    const left = augment("left-card", "Left Card", "左卡");
    const right = augment("right-card", "Right Card", "右卡");
    const lookup = new Map<string, PoolAugment>([
      [left.name, left],
      [right.name, right],
    ]);

    const matched = matchAugmentFrame(
      [
        { text: "Left Card", region_index: 0 },
        { text: "unreadable", region_index: 1 },
        { text: "Right Card", region_index: 2 },
      ],
      lookup,
    );

    expect(matched.map((card) => card.regionIndex)).toEqual([0, 2]);
    expect(isCompleteThreeCardOffer(matched)).toBe(false);
  });

  test("clears stale OCR state when normalized gameflow leaves live capture", () => {
    expect(shouldRunOcrForGameflow({ liveCaptureAllowed: true })).toBe(true);
    expect(shouldClearOcrStateForGameflow({ liveCaptureAllowed: true })).toBe(false);

    expect(shouldRunOcrForGameflow({ liveCaptureAllowed: false })).toBe(false);
    expect(shouldClearOcrStateForGameflow({ liveCaptureAllowed: false })).toBe(true);
  });

  test("matches Steel Your Heart OCR aliases", () => {
    const steelHeart = augment(
      "quest-steel-your-heart",
      "Quest: Steel Your Heart",
      "任務：心鋼起來",
    );
    const lookup = new Map<string, PoolAugment>([
      [steelHeart.name, steelHeart],
      [steelHeart.name_zh_TW!, steelHeart],
    ]);

    addAugmentAliases(lookup, steelHeart);

    expect(matchAugment("任務:鋼鐵雄心", lookup)?.slug).toBe("quest-steel-your-heart");
    expect(matchAugment("任務：鋼鐵雄心", lookup)?.slug).toBe("quest-steel-your-heart");
  });

  test("matches one-character Traditional Chinese OCR drift", () => {
    const poroBlaster = augment("poro-blaster", "Poro Blaster", "普羅能量炮");
    const lookup = new Map<string, PoolAugment>([
      [poroBlaster.name, poroBlaster],
      [poroBlaster.name_zh_TW!, poroBlaster],
    ]);

    expect(matchAugment("普纖能量炮", lookup)?.slug).toBe("poro-blaster");
  });
});
