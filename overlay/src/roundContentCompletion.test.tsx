import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BadgeChipLayer, type SlotChip } from "./BadgeChipLayer";
import * as badgeLayerDiagnostic from "./badgeLayerDiagnostic";
import {
  describeBadgeLayerDecision,
  type BadgeLayerGate,
} from "./badgeLayerDiagnostic";
import type { PositionedBadgeChip } from "./positionedBadgeChips";

type TerminalState = "resolved" | "no-data" | "error";
type FailureCategory = "FAIL_DATA" | "FAIL_IDENTITY" | "FAIL_TIMEOUT" | null;
type RoundResult =
  | "PASS"
  | "FAIL_DATA"
  | "FAIL_IDENTITY"
  | "FAIL_RENDER"
  | "FAIL_TIMEOUT"
  | "FAIL_STALE_STATE";

interface RoundOwner {
  gameEpoch: number;
  round: number;
  offerGeneration: number;
}

interface SemanticPublication extends RoundOwner {
  slot: number;
  publicationGeneration: number;
  terminalState: TerminalState | "loading-data";
  noDataVerified: boolean;
  failureCategory: FailureCategory;
}

interface SemanticSlotChip extends SlotChip {
  semanticPublication?: SemanticPublication;
}

interface DomAcknowledgement extends RoundOwner {
  slot: number;
  publicationGeneration: number;
  terminalState: TerminalState;
  noDataVerified: boolean;
  failureCategory: FailureCategory;
}

interface RoundContentCompletionInput {
  owner: RoundOwner;
  expectedPublications: readonly SemanticPublication[];
  domAcknowledgements: readonly DomAcknowledgement[];
  renderedContainerCount: number;
  schedulerHealthy: boolean;
}

interface RoundContentCompletionDecision {
  contentComplete: boolean;
  result: RoundResult;
}

type RoundContentEvaluator = (
  input: RoundContentCompletionInput,
) => RoundContentCompletionDecision;

interface RoundContentEmissionDecision {
  emit: boolean;
  emittedOwnerKey: string | null;
}

type RoundContentEmissionReducer = (
  emittedOwnerKey: string | null,
  owner: RoundOwner,
  decision: RoundContentCompletionDecision,
) => RoundContentEmissionDecision;

const CURRENT_OWNER: RoundOwner = {
  gameEpoch: 12,
  round: 2,
  offerGeneration: 41,
};

const OPEN_GATE: BadgeLayerGate = {
  devBuild: true,
  tierFixtureEnabled: true,
  memberCoachEnabled: false,
  previewMode: false,
  visibleFrameRenderable: true,
  offerSurfaceRenderable: true,
  geometrySchedulerHealthy: true,
  offerGeneration: CURRENT_OWNER.offerGeneration,
  renderedBadgeCount: 3,
  previewBadgeCount: 0,
};

function publication(
  slot: number,
  terminalState: SemanticPublication["terminalState"] = "resolved",
  overrides: Partial<SemanticPublication> = {},
): SemanticPublication {
  return {
    ...CURRENT_OWNER,
    slot,
    publicationGeneration: 7,
    terminalState,
    noDataVerified: terminalState === "no-data",
    failureCategory: terminalState === "error" ? "FAIL_DATA" : null,
    ...overrides,
  };
}

function chip(
  slot: number,
  semanticPublication?: SemanticPublication,
): SemanticSlotChip {
  const terminalState = semanticPublication?.terminalState;
  return {
    regionIndex: slot,
    key: `epoch-12-round-2-offer-41-slot-${slot}`,
    state:
      terminalState === "no-data"
        ? "no-data"
        : terminalState === "loading-data"
          ? "loading-data"
          : terminalState === "error"
            ? "data-error"
            : "tier",
    tier: terminalState === "resolved" ? "S" : null,
    winRateText: terminalState === "resolved" ? "59.2%" : null,
    isNew: false,
    statScope: terminalState === "resolved" ? "champion" : null,
    semanticPublication,
  };
}

function positioned(
  chips: readonly SemanticSlotChip[],
): PositionedBadgeChip<SemanticSlotChip>[] {
  return chips.map((semanticChip) => ({
    chip: semanticChip,
    regionIndex: semanticChip.regionIndex,
    key: semanticChip.key,
    position: { left: `${semanticChip.regionIndex * 120}px`, top: "100px" },
  }));
}

function renderLayer(
  chips: readonly SemanticSlotChip[],
  gate: BadgeLayerGate = OPEN_GATE,
): string {
  const decision = describeBadgeLayerDecision({
    ...gate,
    renderedBadgeCount: chips.length,
  });
  if (!decision.badgeLayerVisible) return "";
  return renderToStaticMarkup(
    <BadgeChipLayer positionedChips={positioned(chips)} isPreviewMode={false} />,
  );
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

/** Extract only acknowledgements actually published by real BadgeChipLayer nodes. */
function domAcknowledgements(markup: string): DomAcknowledgement[] {
  return [...markup.matchAll(/<div class="badge-chip[^>]*>/g)].flatMap(([tag]) => {
    const gameEpoch = Number(attribute(tag, "data-game-epoch"));
    const round = Number(attribute(tag, "data-round"));
    const offerGeneration = Number(attribute(tag, "data-offer-generation"));
    const slot = Number(attribute(tag, "data-slot"));
    const publicationGeneration = Number(
      attribute(tag, "data-publication-generation"),
    );
    const terminalState = attribute(tag, "data-terminal-state");
    const noDataVerified = attribute(tag, "data-no-data-verified") === "true";
    const rawFailureCategory = attribute(tag, "data-failure-category");
    const failureCategory: FailureCategory | undefined =
      rawFailureCategory === "none"
        ? null
        : rawFailureCategory === "FAIL_DATA" ||
            rawFailureCategory === "FAIL_IDENTITY" ||
            rawFailureCategory === "FAIL_TIMEOUT"
          ? rawFailureCategory
          : undefined;
    if (
      !Number.isSafeInteger(gameEpoch) ||
      !Number.isSafeInteger(round) ||
      !Number.isSafeInteger(offerGeneration) ||
      !Number.isSafeInteger(slot) ||
      !Number.isSafeInteger(publicationGeneration) ||
      !["resolved", "no-data", "error"].includes(terminalState ?? "") ||
      failureCategory === undefined
    ) {
      return [];
    }
    return [{
      gameEpoch,
      round,
      offerGeneration,
      slot,
      publicationGeneration,
      terminalState: terminalState as TerminalState,
      noDataVerified,
      failureCategory: failureCategory as FailureCategory,
    }];
  });
}

function evaluateRoundContentCompletion(
  input: RoundContentCompletionInput,
): RoundContentCompletionDecision | undefined {
  const futureExports = badgeLayerDiagnostic as unknown as Record<string, unknown>;
  const evaluator = futureExports.evaluateRoundContentCompletion;
  return typeof evaluator === "function"
    ? (evaluator as RoundContentEvaluator)(input)
    : undefined;
}

function reduceRoundContentEmission(
  emittedOwnerKey: string | null,
  owner: RoundOwner,
  decision: RoundContentCompletionDecision,
): RoundContentEmissionDecision | undefined {
  const futureExports = badgeLayerDiagnostic as unknown as Record<string, unknown>;
  const reducer = futureExports.reduceRoundContentEmission;
  return typeof reducer === "function"
    ? (reducer as RoundContentEmissionReducer)(emittedOwnerKey, owner, decision)
    : undefined;
}

function decisionInput(
  expectedPublications: readonly SemanticPublication[],
  markup: string,
  overrides: Partial<RoundContentCompletionInput> = {},
): RoundContentCompletionInput {
  return {
    owner: CURRENT_OWNER,
    expectedPublications,
    domAcknowledgements: domAcknowledgements(markup),
    renderedContainerCount: (markup.match(/<div class="badge-chip/g) ?? []).length,
    schedulerHealthy: true,
    ...overrides,
  };
}

describe("round-content-complete production contract", () => {
  it("fails render when three painted containers have no semantic publications or acknowledgements", () => {
    const markup = renderLayer([chip(0), chip(1), chip(2)]);

    expect((markup.match(/<div class="badge-chip/g) ?? [])).toHaveLength(3);
    expect(domAcknowledgements(markup)).toEqual([]);
    expect(evaluateRoundContentCompletion(decisionInput([], markup))).toEqual({
      contentComplete: false,
      result: "FAIL_RENDER",
    });
  });

  it("passes exactly three matching current terminal publications acknowledged by the real renderer", () => {
    const expected = [
      publication(0, "resolved"),
      publication(1, "no-data"),
      publication(2, "resolved"),
    ];
    const markup = renderLayer(expected.map((slot) => chip(slot.slot, slot)));

    expect(domAcknowledgements(markup)).toEqual(expected);
    expect(evaluateRoundContentCompletion(decisionInput(expected, markup))).toEqual({
      contentComplete: true,
      result: "PASS",
    });
  });

  it("does not pass while a semantic slot is temporary", () => {
    const expected = [
      publication(0),
      publication(1, "loading-data"),
      publication(2),
    ];
    const markup = renderLayer(expected.map((slot) => chip(slot.slot, slot)));

    expect(evaluateRoundContentCompletion(decisionInput(expected, markup))).toEqual({
      contentComplete: false,
      result: "FAIL_RENDER",
    });
  });

  it("rejects a publication owned by a different offer generation", () => {
    const expected = [
      publication(0),
      publication(1, "resolved", { offerGeneration: 40 }),
      publication(2),
    ];
    const markup = renderLayer(expected.map((slot) => chip(slot.slot, slot)));

    expect(evaluateRoundContentCompletion(decisionInput(expected, markup))).toEqual({
      contentComplete: false,
      result: "FAIL_STALE_STATE",
    });
  });

  it("fails render when DOM acknowledgements are fewer or do not match publications", () => {
    const expected = [publication(0), publication(1), publication(2)];
    const fewerMarkup = renderLayer(expected.slice(0, 2).map((slot) => chip(slot.slot, slot)));
    const mismatchedMarkup = renderLayer([
      chip(0, expected[0]),
      chip(1, { ...expected[1], publicationGeneration: 6 }),
      chip(2, expected[2]),
    ]);

    expect(evaluateRoundContentCompletion(decisionInput(expected, fewerMarkup))).toEqual({
      contentComplete: false,
      result: "FAIL_RENDER",
    });
    expect(evaluateRoundContentCompletion(decisionInput(expected, mismatchedMarkup))).toEqual({
      contentComplete: false,
      result: "FAIL_RENDER",
    });
  });

  it("keeps scheduler-unhealthy invisible and semantically incomplete", () => {
    const unhealthyGate = { ...OPEN_GATE, geometrySchedulerHealthy: false };
    const expected = [publication(0), publication(1), publication(2)];
    const gateDecision = describeBadgeLayerDecision(unhealthyGate);
    const markup = renderLayer(
      expected.map((slot) => chip(slot.slot, slot)),
      unhealthyGate,
    );

    expect(gateDecision.reason).toBe("scheduler-unhealthy");
    expect(gateDecision.badgeLayerVisible).toBe(false);
    expect(markup).toBe("");
    expect(evaluateRoundContentCompletion(
      decisionInput(expected, markup, { schedulerHealthy: false }),
    )).toEqual({ contentComplete: false, result: "FAIL_RENDER" });
  });

  it("can complete an explicit rendered error while preserving FAIL_DATA", () => {
    const expected = [publication(0), publication(1, "error"), publication(2)];
    const markup = renderLayer(expected.map((slot) => chip(slot.slot, slot)));

    expect(domAcknowledgements(markup)).toEqual(expected);
    expect(evaluateRoundContentCompletion(decisionInput(expected, markup))).toEqual({
      contentComplete: true,
      result: "FAIL_DATA",
    });
  });

  it("rejects three publications and acknowledgements with duplicate slot ownership", () => {
    const expected = [publication(0), publication(1), publication(1)];
    const markup = renderLayer([
      chip(0, expected[0]),
      chip(1, expected[1]),
      chip(2, expected[2]),
    ]);

    expect((markup.match(/<div class="badge-chip/g) ?? [])).toHaveLength(3);
    expect(domAcknowledgements(markup).map(({ slot }) => slot)).toEqual([0, 1, 1]);
    expect(evaluateRoundContentCompletion(decisionInput(expected, markup))).toEqual({
      contentComplete: false,
      result: "FAIL_IDENTITY",
    });
  });

  it("rejects an unverified no-data publication as FAIL_DATA", () => {
    const expected = [
      publication(0),
      publication(1, "no-data", { noDataVerified: false }),
      publication(2),
    ];
    const markup = renderLayer(expected.map((slot) => chip(slot.slot, slot)));

    expect(domAcknowledgements(markup)).toEqual(expected);
    expect(evaluateRoundContentCompletion(decisionInput(expected, markup))).toEqual({
      contentComplete: false,
      result: "FAIL_DATA",
    });
  });

  it("emits round-content-complete once per offer owner even when its result changes", () => {
    const offer42 = { ...CURRENT_OWNER, offerGeneration: 42 };
    const incomplete = reduceRoundContentEmission(null, CURRENT_OWNER, {
      contentComplete: false,
      result: "FAIL_RENDER",
    });
    const firstComplete = reduceRoundContentEmission(null, CURRENT_OWNER, {
      contentComplete: true,
      result: "FAIL_DATA",
    });
    const recoveredSameOffer = reduceRoundContentEmission(
      firstComplete?.emittedOwnerKey ?? null,
      CURRENT_OWNER,
      { contentComplete: true, result: "PASS" },
    );
    const nextOffer = reduceRoundContentEmission(
      recoveredSameOffer?.emittedOwnerKey ?? null,
      offer42,
      { contentComplete: true, result: "PASS" },
    );

    expect([incomplete, firstComplete, recoveredSameOffer, nextOffer]).toEqual([
      { emit: false, emittedOwnerKey: null },
      { emit: true, emittedOwnerKey: "12/2/41" },
      { emit: false, emittedOwnerKey: "12/2/41" },
      { emit: true, emittedOwnerKey: "12/2/42" },
    ]);
  });
});
