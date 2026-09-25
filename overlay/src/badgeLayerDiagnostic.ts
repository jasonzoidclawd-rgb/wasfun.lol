/**
 * The FINAL badge-layer decision, reported as a development-only diagnostic.
 *
 * `[offer-session].render` and `offer-state.renderDecision` are intermediate
 * offer-surface decisions: they are computed before authorization, preview
 * mode, the visible frame, and geometry-scheduler health are consulted, so a
 * `render:true` there does NOT mean a badge reached the screen. Only this
 * record — taken at the same gate that decides `showBadgeLayer` — can certify
 * that visible badges existed.
 *
 * Privacy: bounded booleans, small enums, and small counts only. No augment
 * names, OCR text, tokens, paths, account identifiers, or raw geometry.
 *
 * Production: every call site is behind a leading `import.meta.env.DEV`, which
 * the production build folds to `false`, so this module's tag, reason strings,
 * and helper names are tree-shaken out of the bundle entirely.
 */
import {
  localOverlayAuthorized,
  realAugmentOverlayRenderable,
  type RealAugmentOverlayGate,
} from "./augmentOverlayGate";
import { emitNativeDiagnostic } from "./dev/publicationDiagnostics";

/** Why the final gate opened or closed. Exactly one applies, in this order. */
export type BadgeLayerReason =
  | "authorization-denied"
  | "preview-mode"
  | "visible-frame-rejected"
  | "offer-surface-rejected"
  | "scheduler-unhealthy"
  | "no-visible-badges"
  | "badge-layer-visible";

/** Which authority opened the gate — never WHO the member is. */
export type BadgeLayerAuthorization = "none" | "member" | "fixture";

export interface BadgeLayerGate extends RealAugmentOverlayGate {
  /** Strict logical offer identity for this decision. */
  offerGeneration: number;
  /** Chips the real (non-preview) path is about to paint. */
  renderedBadgeCount: number;
  /** Chips the preview path is about to paint. */
  previewBadgeCount: number;
}

export interface BadgeLayerDecision {
  badgeLayerVisible: boolean;
  reason: BadgeLayerReason;
  authorized: boolean;
  authorizationSource: BadgeLayerAuthorization;
  previewMode: boolean;
  visibleFrame: boolean;
  offerSurface: boolean;
  schedulerHealthy: boolean;
  offerGeneration: number;
  renderedBadgeCount: number;
  previewBadgeCount: number;
}

export type RoundContentFailureCategory =
  | "FAIL_DATA"
  | "FAIL_IDENTITY"
  | "FAIL_TIMEOUT"
  | null;
export type RoundContentTerminalState = "resolved" | "no-data" | "error";
export type RoundContentResult =
  | "PASS"
  | "FAIL_DATA"
  | "FAIL_IDENTITY"
  | "FAIL_RENDER"
  | "FAIL_TIMEOUT"
  | "FAIL_STALE_STATE";

export interface RoundContentOwner {
  gameEpoch: number;
  round: number;
  offerGeneration: number;
}

export interface SemanticPublication extends RoundContentOwner {
  slot: number;
  publicationGeneration: number;
  terminalState: RoundContentTerminalState | "loading-data";
  noDataVerified: boolean;
  failureCategory: RoundContentFailureCategory;
}

export interface DomAcknowledgement extends RoundContentOwner {
  slot: number;
  publicationGeneration: number;
  terminalState: RoundContentTerminalState;
  noDataVerified: boolean;
  failureCategory: RoundContentFailureCategory;
}

export interface RoundContentCompletionInput {
  owner: RoundContentOwner;
  expectedPublications: readonly SemanticPublication[];
  domAcknowledgements: readonly DomAcknowledgement[];
  renderedContainerCount: number;
  schedulerHealthy: boolean;
}

export interface RoundContentCompletionDecision {
  contentComplete: boolean;
  result: RoundContentResult;
}

export interface RoundContentEmissionDecision {
  emit: boolean;
  emittedOwnerKey: string | null;
}

/** Emit completion once for each logical offer owner, regardless of result changes. */
export function reduceRoundContentEmission(
  emittedOwnerKey: string | null,
  owner: RoundContentOwner,
  decision: RoundContentCompletionDecision,
): RoundContentEmissionDecision {
  if (!decision.contentComplete) return { emit: false, emittedOwnerKey };
  const ownerKey = `${owner.gameEpoch}/${owner.round}/${owner.offerGeneration}`;
  return ownerKey === emittedOwnerKey
    ? { emit: false, emittedOwnerKey }
    : { emit: true, emittedOwnerKey: ownerKey };
}

function sameOwner(left: RoundContentOwner, right: RoundContentOwner): boolean {
  return left.gameEpoch === right.gameEpoch &&
    left.round === right.round &&
    left.offerGeneration === right.offerGeneration;
}

function sameAcknowledgement(
  publication: SemanticPublication,
  acknowledgement: DomAcknowledgement,
): boolean {
  return sameOwner(publication, acknowledgement) &&
    publication.slot === acknowledgement.slot &&
    publication.publicationGeneration === acknowledgement.publicationGeneration &&
    publication.terminalState === acknowledgement.terminalState &&
    publication.noDataVerified === acknowledgement.noDataVerified &&
    publication.failureCategory === acknowledgement.failureCategory;
}

/** Certify current semantic content only after the real DOM acknowledges it. */
export function evaluateRoundContentCompletion(
  input: RoundContentCompletionInput,
): RoundContentCompletionDecision {
  if (!input.schedulerHealthy) return { contentComplete: false, result: "FAIL_RENDER" };
  if (input.expectedPublications.some((publication) => !sameOwner(publication, input.owner))) {
    return { contentComplete: false, result: "FAIL_STALE_STATE" };
  }
  if (input.expectedPublications.length === 0) {
    return { contentComplete: false, result: "FAIL_RENDER" };
  }

  const slots = input.expectedPublications.map(({ slot }) => slot);
  if (slots.length !== 3 || slots.some((slot, index) => slot !== index)) {
    return { contentComplete: false, result: "FAIL_IDENTITY" };
  }
  if (input.expectedPublications.some(({ terminalState }) => terminalState === "loading-data")) {
    return { contentComplete: false, result: "FAIL_RENDER" };
  }
  if (input.expectedPublications.some(
    ({ terminalState, noDataVerified }) => terminalState === "no-data" && !noDataVerified,
  )) {
    return { contentComplete: false, result: "FAIL_DATA" };
  }
  if (
    input.renderedContainerCount !== 3 ||
    input.domAcknowledgements.length !== 3 ||
    input.expectedPublications.some((publication, index) =>
      !sameAcknowledgement(publication, input.domAcknowledgements[index]))
  ) {
    return { contentComplete: false, result: "FAIL_RENDER" };
  }

  const failureCategories = input.expectedPublications.map(({ failureCategory }) => failureCategory);
  const result: RoundContentResult = failureCategories.includes("FAIL_TIMEOUT")
    ? "FAIL_TIMEOUT"
    : failureCategories.includes("FAIL_IDENTITY")
      ? "FAIL_IDENTITY"
      : failureCategories.includes("FAIL_DATA")
        ? "FAIL_DATA"
        : "PASS";
  return { contentComplete: true, result };
}

/** Parse acknowledgements from the actual chip nodes after React commits. */
export function parseRoundContentAcknowledgements(
  root: ParentNode,
): DomAcknowledgement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".badge-chip[data-game-epoch]")).flatMap(
    (element) => {
      const gameEpoch = Number(element.dataset.gameEpoch);
      const round = Number(element.dataset.round);
      const offerGeneration = Number(element.dataset.offerGeneration);
      const slot = Number(element.dataset.slot);
      const publicationGeneration = Number(element.dataset.publicationGeneration);
      const terminalState = element.dataset.terminalState;
      const failure = element.dataset.failureCategory;
      const failureCategory: RoundContentFailureCategory | undefined = failure === "none"
        ? null
        : failure === "FAIL_DATA" || failure === "FAIL_IDENTITY" || failure === "FAIL_TIMEOUT"
          ? failure
          : undefined;
      if (
        ![gameEpoch, round, offerGeneration, slot, publicationGeneration].every(Number.isSafeInteger) ||
        !["resolved", "no-data", "error"].includes(terminalState ?? "") ||
        failureCategory === undefined
      ) return [];
      return [{
        gameEpoch,
        round,
        offerGeneration,
        slot,
        publicationGeneration,
        terminalState: terminalState as RoundContentTerminalState,
        noDataVerified: element.dataset.noDataVerified === "true",
        failureCategory,
      }];
    },
  );
}

/** A bounded, non-negative integer, or -1 when the input is not one. */
function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

/**
 * Describe the final badge-layer gate. `badgeLayerVisible` is true only when
 * the real render gate is fully open AND at least one chip is actually being
 * painted — an open gate over zero chips shows the operator nothing.
 */
export function describeBadgeLayerDecision(
  gate: BadgeLayerGate,
): BadgeLayerDecision {
  const authorized = localOverlayAuthorized(gate);
  const renderedBadgeCount = boundedCount(gate.renderedBadgeCount);
  const reason: BadgeLayerReason = !authorized
    ? "authorization-denied"
    : gate.previewMode
      ? "preview-mode"
      : !gate.visibleFrameRenderable
        ? "visible-frame-rejected"
        : !gate.offerSurfaceRenderable
          ? "offer-surface-rejected"
          : !gate.geometrySchedulerHealthy
            ? "scheduler-unhealthy"
            : renderedBadgeCount < 1
              ? "no-visible-badges"
              : "badge-layer-visible";
  return {
    // Cross-checked against the production gate itself, so the diagnostic can
    // never claim visibility the real render path did not grant.
    badgeLayerVisible:
      reason === "badge-layer-visible" && realAugmentOverlayRenderable(gate),
    reason,
    authorized,
    authorizationSource: gate.memberCoachEnabled
      ? "member"
      : authorized
        ? "fixture"
        : "none",
    previewMode: gate.previewMode,
    visibleFrame: gate.visibleFrameRenderable,
    offerSurface: gate.offerSurfaceRenderable,
    schedulerHealthy: gate.geometrySchedulerHealthy,
    offerGeneration: boundedCount(gate.offerGeneration),
    renderedBadgeCount,
    previewBadgeCount: boundedCount(gate.previewBadgeCount),
  };
}

/**
 * One logical decision per (epoch, gate outcome, offer identity, chip counts).
 * React re-renders far more often than the decision changes, so the caller
 * emits only when this signature moves.
 */
export function badgeLayerSignature(
  decision: BadgeLayerDecision,
  gameEpoch: number,
): string {
  return [
    gameEpoch,
    decision.reason,
    decision.authorizationSource,
    decision.offerGeneration,
    decision.renderedBadgeCount,
    decision.previewBadgeCount,
  ].join("/");
}

export function reportBadgeLayerDecision(
  decision: BadgeLayerDecision,
  gameEpoch: number,
): void {
  emitNativeDiagnostic("[badge-layer]", { gameEpoch, ...decision });
}
