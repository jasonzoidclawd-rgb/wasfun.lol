import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BadgeChipLayer, type SlotChip } from "./BadgeChipLayer";
import type { DomAcknowledgement, SemanticPublication } from "./badgeLayerDiagnostic";
import type { PositionedBadgeChip } from "./positionedBadgeChips";

interface ReplayFixture {
  schemaVersion: "overlay-replay/v1";
  sourceSessionId: string;
  initialState: { gameEpoch: number };
  actions: ReplayAction[];
}

type ReplayAction =
  | { atMs: number; type: "game-start"; championId: number }
  | { atMs: number; type: "offer-accepted"; offerGeneration: number }
  | { atMs: number; type: "publish"; publications: SemanticPublication[] }
  | { atMs: number; type: "clear"; offerGeneration: number }
  | { atMs: number; type: "confirmed-game-end" };

interface ReplayOutput {
  schemaVersion: "overlay-replay/v1";
  sourceSessionId: string;
  timeline: Array<{
    atMs: number;
    type: string;
    round?: number;
    offerGeneration?: number;
    acknowledgements?: DomAcknowledgement[];
    ownershipBeforeCleanup?: {
      activeOwner: null;
      pendingClosedOwner: { offerGeneration: number; round: number } | null;
      completedOwners: Array<{ offerGeneration: number; round: number }>;
    };
    ownershipAfterCleanup?: {
      activeOwner: null;
      pendingClosedOwner: null;
      completedOwners: [];
    };
  }>;
  publications: DomAcknowledgement[];
  roundResults: Array<{ round: number; result: string }>;
  gameResult: string;
  cleanupCount: number;
  finalState: {
    cards: unknown[];
    currentGame: null;
    currentChampion: null;
    currentOffer: null;
    ownership: {
      activeOwner: null;
      pendingClosedOwner: null;
      completedOwners: [];
    };
  };
}

type ReplayRenderer = (
  publications: readonly SemanticPublication[],
) => DomAcknowledgement[];

type ReplayRunner = (
  fixture: ReplayFixture,
  adapters: { render: ReplayRenderer },
) => ReplayOutput;

const OWNER = { gameEpoch: 27 };
const OFFERS = [101, 205, 309, 413] as const;

function roundPublications(round: number, offerGeneration: number): SemanticPublication[] {
  return [0, 1, 2].map((slot) => ({
    ...OWNER,
    round,
    offerGeneration,
    slot,
    publicationGeneration: round * 10 + slot,
    terminalState: "resolved",
    noDataVerified: false,
    failureCategory: null,
  }));
}

const actions: ReplayAction[] = [
  { atMs: 0, type: "game-start", championId: 56 },
  ...OFFERS.flatMap((offerGeneration, index): ReplayAction[] => {
    const round = index + 1;
    const base = round * 1_000;
    return [
      { atMs: base, type: "offer-accepted", offerGeneration },
      { atMs: base + 100, type: "publish", publications: roundPublications(round, offerGeneration) },
      { atMs: base + 200, type: "clear", offerGeneration },
    ];
  }),
  { atMs: 5_000, type: "confirmed-game-end" },
  { atMs: 5_100, type: "confirmed-game-end" },
];

const fixture: ReplayFixture = {
  schemaVersion: "overlay-replay/v1",
  sourceSessionId: "four-round-success",
  initialState: OWNER,
  actions,
};

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

/** The replay adapter only paints the real layer and reads its bounded ownership attributes. */
function renderSemanticLayer(publications: readonly SemanticPublication[]): DomAcknowledgement[] {
  const positionedChips: PositionedBadgeChip<SlotChip>[] = publications.map((publication) => {
    const chip: SlotChip = {
      regionIndex: publication.slot,
      key: `${publication.gameEpoch}/${publication.round}/${publication.offerGeneration}/${publication.slot}`,
      state: "tier",
      tier: "S",
      winRateText: "58.4%",
      isNew: false,
      statScope: "champion",
      semanticPublication: publication,
    };
    return {
      chip,
      regionIndex: publication.slot,
      key: chip.key,
      position: { left: `${publication.slot * 120}px`, top: "80px" },
    };
  });
  const markup = renderToStaticMarkup(
    <BadgeChipLayer positionedChips={positionedChips} isPreviewMode={false} />,
  );

  return [...markup.matchAll(/<div class="badge-chip[^>]*>/g)].map(([tag]) => {
    const failureCategory = attribute(tag, "data-failure-category");
    return {
      gameEpoch: Number(attribute(tag, "data-game-epoch")),
      round: Number(attribute(tag, "data-round")),
      offerGeneration: Number(attribute(tag, "data-offer-generation")),
      slot: Number(attribute(tag, "data-slot")),
      publicationGeneration: Number(attribute(tag, "data-publication-generation")),
      terminalState: attribute(tag, "data-terminal-state") as "resolved",
      noDataVerified: attribute(tag, "data-no-data-verified") === "true",
      failureCategory: failureCategory === "none"
        ? null
        : failureCategory as DomAcknowledgement["failureCategory"],
    };
  });
}

async function loadReplayRunner(): Promise<ReplayRunner | undefined> {
  const moduleUrl = new URL(`./${"overlayReplay"}.ts`, import.meta.url).href;
  const replayModule = await import(/* @vite-ignore */ moduleUrl).catch(() => null);
  return typeof replayModule?.runOverlayReplay === "function"
    ? replayModule.runOverlayReplay as ReplayRunner
    : undefined;
}

describe("overlay-replay/v1 four-round-success", () => {
  it("replays four independently owned rounds deterministically and cleans up once", async () => {
    const runOverlayReplay = await loadReplayRunner();
    expect(runOverlayReplay, "overlayReplay.ts must export runOverlayReplay").toBeTypeOf("function");
    if (!runOverlayReplay) return;

    const firstRenderer = vi.fn(renderSemanticLayer);
    const secondRenderer = vi.fn(renderSemanticLayer);
    const first = runOverlayReplay(fixture, { render: firstRenderer });
    const second = runOverlayReplay(fixture, { render: secondRenderer });

    const expectedPublications = OFFERS.flatMap((offer, index) =>
      renderSemanticLayer(roundPublications(index + 1, offer)),
    );
    expect({ schemaVersion: first.schemaVersion, sourceSessionId: first.sourceSessionId }).toEqual({
      schemaVersion: "overlay-replay/v1",
      sourceSessionId: "four-round-success",
    });
    expect(firstRenderer).toHaveBeenCalledTimes(4);
    expect(secondRenderer).toHaveBeenCalledTimes(4);
    expect(first.publications).toEqual(expectedPublications);
    expect(first.publications).toHaveLength(12);
    expect(new Set(first.publications.map(({ round, offerGeneration }) => `${round}/${offerGeneration}`)))
      .toEqual(new Set(["1/101", "2/205", "3/309", "4/413"]));

    expect(first.timeline.filter(({ type }) => type === "round-content-complete")).toEqual(
      OFFERS.map((offerGeneration, index) => ({
        atMs: (index + 1) * 1_000 + 100,
        type: "round-content-complete",
        round: index + 1,
        offerGeneration,
        acknowledgements: expectedPublications.slice(index * 3, index * 3 + 3),
      })),
    );
    expect(first.timeline.filter(({ type }) => type === "offer-cleared")).toHaveLength(4);
    for (let round = 2; round <= 4; round += 1) {
      const previousClear = first.timeline.findIndex(
        ({ type, offerGeneration }) => type === "offer-cleared" && offerGeneration === OFFERS[round - 2],
      );
      const nextPublication = first.timeline.findIndex(
        ({ type, round: publishedRound }) => type === "round-content-complete" && publishedRound === round,
      );
      expect(previousClear).toBeGreaterThanOrEqual(0);
      expect(previousClear).toBeLessThan(nextPublication);
    }

    expect(first.roundResults).toEqual([1, 2, 3, 4].map((round) => ({ round, result: "PASS" })));
    expect(first.gameResult).toBe("PASS");
    expect(first.cleanupCount).toBe(1);
    expect(first.timeline.filter(({ type }) => type === "game-ended")).toEqual([{
      atMs: 5_000,
      type: "game-ended",
      ownershipBeforeCleanup: {
        activeOwner: null,
        pendingClosedOwner: { offerGeneration: 413, round: 4 },
        completedOwners: [
          { offerGeneration: 101, round: 1 },
          { offerGeneration: 205, round: 2 },
          { offerGeneration: 309, round: 3 },
        ],
      },
      ownershipAfterCleanup: {
        activeOwner: null,
        pendingClosedOwner: null,
        completedOwners: [],
      },
    }]);
    expect(first.finalState).toEqual({
      cards: [],
      currentGame: null,
      currentChampion: null,
      currentOffer: null,
      ownership: {
        activeOwner: null,
        pendingClosedOwner: null,
        completedOwners: [],
      },
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
