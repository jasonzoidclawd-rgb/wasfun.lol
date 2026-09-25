import { describe, expect, it } from "vitest";
import type { OfferSurfaceKind } from "./offerSurfaceState";
import type { GeometryClassification } from "./surfaceGeometry";
import * as diagnosticModule from "./dev/publicationDiagnostics";

type OfferDiagnosticInput = {
  roundOwner: number | null;
  offerGeneration: number;
  geometrySequence: number;
  stale: boolean;
  surfaceClassification: GeometryClassification;
  offerState: OfferSurfaceKind;
  geometryAction: "publish" | "preserve" | "clear" | null;
  validCardCount: number;
  blueControlConfidence: number;
  fingerprints: readonly [string | null, string | null, string | null];
  fingerprintChangeCount: number;
  confirmedRerollCount: number;
  baselineSettling: boolean;
  newOfferDetected: boolean;
  gameEpoch: number;
  foregroundEpoch: number;
  timeSinceLastAcceptedOfferMs: number | null;
};

type OfferDiagnostic = Omit<OfferDiagnosticInput, "fingerprints"> & {
  fingerprintHashes: readonly [string | null, string | null, string | null];
  failureCategory: "stale-result-rejected" | "offer-not-detected" | null;
  rejectionStage: string | null;
  rejectionReason: string | null;
};

type LiveClientStatus = "ready" | "unavailable" | "error";

type LiveClientTransitionInput = {
  previousStatus: LiveClientStatus | null;
  nextStatus: LiveClientStatus;
  gameEpoch: number;
  foregroundEpoch: number;
  monotonicMilliseconds: number;
};

type LiveClientTransition = LiveClientTransitionInput & { transition: string };

type OfferDiagnosticHelper = (input: OfferDiagnosticInput) => OfferDiagnostic;
type LiveClientTransitionHelper = (
  input: LiveClientTransitionInput,
) => LiveClientTransition | null;

function offerAdapter(input: OfferDiagnosticInput): OfferDiagnostic | undefined {
  const seam = (diagnosticModule as Record<string, unknown>)[
    "describeOfferAcquisitionDiagnostic"
  ];
  if (typeof seam !== "function") return undefined;
  return (seam as OfferDiagnosticHelper)(input);
}

function transitionAdapter(
  input: LiveClientTransitionInput,
): LiveClientTransition | null | undefined {
  const seam = (diagnosticModule as Record<string, unknown>)[
    "describeLiveClientStatusTransition"
  ];
  if (typeof seam !== "function") return undefined;
  return (seam as LiveClientTransitionHelper)(input);
}

const presentObservation: OfferDiagnosticInput = {
  roundOwner: 2,
  offerGeneration: 26,
  geometrySequence: 401,
  stale: false,
  surfaceClassification: "present",
  offerState: "OFFER_VISIBLE",
  geometryAction: "publish",
  validCardCount: 3,
  blueControlConfidence: 0.91,
  fingerprints: ["left-card", "middle-card", "right-card"],
  fingerprintChangeCount: 0,
  confirmedRerollCount: 0,
  baselineSettling: false,
  newOfferDetected: false,
  gameEpoch: 12,
  foregroundEpoch: 8,
  timeSinceLastAcceptedOfferMs: 4_321,
};

function expectCorrelatedRecord(
  actual: OfferDiagnostic | undefined,
  input: OfferDiagnosticInput,
): asserts actual is OfferDiagnostic {
  expect(actual).toMatchObject({
    roundOwner: input.roundOwner,
    offerGeneration: input.offerGeneration,
    geometrySequence: input.geometrySequence,
    stale: input.stale,
    surfaceClassification: input.surfaceClassification,
    offerState: input.offerState,
    geometryAction: input.geometryAction,
    validCardCount: input.validCardCount,
    blueControlConfidence: input.blueControlConfidence,
    fingerprintChangeCount: input.fingerprintChangeCount,
    confirmedRerollCount: input.confirmedRerollCount,
    baselineSettling: input.baselineSettling,
    newOfferDetected: input.newOfferDetected,
    gameEpoch: input.gameEpoch,
    foregroundEpoch: input.foregroundEpoch,
    timeSinceLastAcceptedOfferMs: input.timeSinceLastAcceptedOfferMs,
  });
  expect(actual?.fingerprintHashes).toHaveLength(3);
  for (const fingerprint of actual?.fingerprintHashes ?? []) {
    if (fingerprint === null) continue;
    expect(fingerprint).toMatch(/^h[0-9a-f]{8}$/);
    expect(input.fingerprints).not.toContain(fingerprint);
  }
}

describe("offer acquisition diagnostic at the live classification seam", () => {
  it.each([
    {
      name: "rejects a stale result at geometry currentness",
      input: {
        ...presentObservation,
        roundOwner: null,
        geometrySequence: 419,
        stale: true,
        surfaceClassification: "uncertain" as const,
        offerState: "NO_OFFER" as const,
        geometryAction: null,
        validCardCount: 0,
        blueControlConfidence: 0,
        fingerprints: [null, null, null] as const,
      },
      expected: [
        "stale-result-rejected",
        "geometry-currentness",
        "superseded-geometry-sequence",
      ],
    },
    {
      name: "classifies a current absent surface",
      input: {
        ...presentObservation,
        roundOwner: null,
        geometrySequence: 402,
        surfaceClassification: "absent" as const,
        offerState: "NO_OFFER" as const,
        geometryAction: "clear" as const,
        validCardCount: 0,
        blueControlConfidence: 0.32,
        fingerprints: [null, null, null] as const,
      },
      expected: [
        "offer-not-detected",
        "surface-classification",
        "current-surface-absent",
      ],
    },
    {
      name: "classifies current occlusion independently of geometry vocabulary",
      input: {
        ...presentObservation,
        roundOwner: null,
        geometrySequence: 400,
        surfaceClassification: "absent" as const,
        offerState: "OCCLUDED" as const,
        geometryAction: "clear" as const,
        validCardCount: 0,
        fingerprints: [null, null, null] as const,
      },
      expected: [
        "offer-not-detected",
        "surface-classification",
        "current-surface-occluded",
      ],
    },
    {
      name: "classifies a duplicate from zero changed fingerprints",
      input: presentObservation,
      expected: [
        "offer-not-detected",
        "fingerprint-comparison",
        "duplicate-observation",
      ],
    },
    {
      name: "keeps a one-slot reroll in its round",
      input: {
        ...presentObservation,
        fingerprints: ["left-card-rerolled", "middle-card", "right-card"] as const,
        fingerprintChangeCount: 1,
        confirmedRerollCount: 1,
      },
      expected: [
        "offer-not-detected",
        "fingerprint-comparison",
        "one-slot-reroll",
      ],
    },
    {
      name: "waits for confirmation of a multi-slot fingerprint change",
      input: {
        ...presentObservation,
        fingerprints: ["left-new", "middle-new", "right-card"] as const,
        fingerprintChangeCount: 2,
        confirmedRerollCount: 1,
        baselineSettling: true,
      },
      expected: [
        "offer-not-detected",
        "fingerprint-confirmation",
        "multi-slot-confirmation-pending",
      ],
    },
  ])("$name", ({ input, expected }) => {
    const actual = offerAdapter(input);
    expectCorrelatedRecord(actual, input);
    expect([
      actual.failureCategory,
      actual.rejectionStage,
      actual.rejectionReason,
    ]).toEqual(expected);
  });

  it("does not fabricate rejection diagnostics for an accepted new offer", () => {
    const input: OfferDiagnosticInput = {
      ...presentObservation,
      roundOwner: 3,
      offerGeneration: 27,
      fingerprints: ["left-new", "middle-new", "right-new"],
      fingerprintChangeCount: 3,
      confirmedRerollCount: 3,
      newOfferDetected: true,
    };
    const actual = offerAdapter(input);
    expectCorrelatedRecord(actual, input);
    expect(actual).toMatchObject({
      failureCategory: null,
      rejectionStage: null,
      rejectionReason: null,
    });
  });

  it("keeps the three-slot fingerprint set bounded, irreversible, and raw-free", () => {
    const input: OfferDiagnosticInput = {
      ...presentObservation,
      fingerprints: ["x".repeat(400), "account-like@example.test", "秘密の増強"],
    };
    const actual = offerAdapter(input);
    expectCorrelatedRecord(actual, input);
    const serialized = JSON.stringify(actual);
    for (const raw of input.fingerprints) expect(serialized).not.toContain(raw);
  });
});

describe("Live Client Data status transition diagnostic", () => {
  it("derives ready to unavailable to ready transitions with epoch provenance", () => {
    const unavailable = transitionAdapter({
      previousStatus: "ready",
      nextStatus: "unavailable",
      gameEpoch: 12,
      foregroundEpoch: 8,
      monotonicMilliseconds: 44_100,
    });
    expect(unavailable).toEqual({
      previousStatus: "ready",
      nextStatus: "unavailable",
      transition: "ready->unavailable",
      gameEpoch: 12,
      foregroundEpoch: 8,
      monotonicMilliseconds: 44_100,
    });
    expect(
      transitionAdapter({
        previousStatus: "unavailable",
        nextStatus: "ready",
        gameEpoch: 12,
        foregroundEpoch: 8,
        monotonicMilliseconds: 45_900,
      })?.transition,
    ).toBe("unavailable->ready");
  });

  it("derives ready to error and suppresses unchanged status", () => {
    expect(
      transitionAdapter({
        previousStatus: "ready",
        nextStatus: "error",
        gameEpoch: 12,
        foregroundEpoch: 8,
        monotonicMilliseconds: 46_000,
      })?.transition,
    ).toBe("ready->error");
    expect(
      transitionAdapter({
        previousStatus: "ready",
        nextStatus: "ready",
        gameEpoch: 12,
        foregroundEpoch: 8,
        monotonicMilliseconds: 46_100,
      }),
    ).toBeNull();
  });
});
