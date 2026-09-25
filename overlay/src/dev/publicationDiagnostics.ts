import { invoke } from "@tauri-apps/api/core";
import type { OfferSurfaceKind } from "../offerSurfaceState";
import type { GeometryClassification } from "../surfaceGeometry";

export type DiagnosticMarker =
  | "[slot-publication]"
  | "[slot-publication-violation]"
  | "[identity-trigger]"
  | "[identity-start]"
  | "[identity-native-finish]"
  | "[identity-publish]"
  | "[identity-stale-reject]"
  | "[identity-timeout]"
  | "[identity-watchdog-abandon]"
  | "[identity-retry]"
  | "[offer-state]"
  | "[offer-session]"
  | "[badge-layer]"
  | "[round-content-complete]"
  | "[game-poll]"
  | "[geometry-watchdog]"
  | "[identity-native-return]"
  | "[geometry-timing]"
  | "[geometry-stale-hide]"
  | "[geometry-recovery]"
  | "[foreground-poll]"
  | "[focus-transition]";

/** Bounded, irreversible FNV-1a hash; complete OCR text is never logged. */
export function boundedDiagnosticHash(value: string | null | undefined): string | null {
  if (!value) return null;
  let hash = 0x811c9dc5;
  for (const char of value.normalize("NFKC").slice(0, 64)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

type OfferAcquisitionDiagnosticInput = {
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

export function describeOfferAcquisitionDiagnostic(
  input: OfferAcquisitionDiagnosticInput,
) {
  let failureCategory: "stale-result-rejected" | "offer-not-detected" | null = null;
  let rejectionStage: string | null = null;
  let rejectionReason: string | null = null;

  if (!input.newOfferDetected) {
    failureCategory = input.stale ? "stale-result-rejected" : "offer-not-detected";
    if (input.stale) {
      rejectionStage = "geometry-currentness";
      rejectionReason = "superseded-geometry-sequence";
    } else if (input.offerState === "OCCLUDED") {
      rejectionStage = "surface-classification";
      rejectionReason = "current-surface-occluded";
    } else if (input.surfaceClassification === "absent") {
      rejectionStage = "surface-classification";
      rejectionReason = "current-surface-absent";
    } else if (input.surfaceClassification === "uncertain") {
      rejectionStage = "surface-classification";
      rejectionReason = input.geometryAction === "preserve"
        ? "current-surface-preserved"
        : input.geometryAction === "clear"
          ? "current-surface-cleared"
          : "current-surface-uncertain";
    } else if (input.offerState === "NO_OFFER") {
      rejectionStage = "surface-classification";
      rejectionReason = input.geometryAction === "preserve"
        ? "current-surface-preserved"
        : input.geometryAction === "clear"
          ? "current-surface-cleared"
          : "current-surface-no-offer";
    } else if (input.geometryAction === "preserve") {
      rejectionStage = "surface-classification";
      rejectionReason = "current-surface-preserved";
    } else if (input.geometryAction === "clear") {
      rejectionStage = "surface-classification";
      rejectionReason = "current-surface-cleared";
    } else if (input.fingerprintChangeCount === 0) {
      rejectionStage = "fingerprint-comparison";
      rejectionReason = "duplicate-observation";
    } else if (input.fingerprintChangeCount === 1) {
      rejectionStage = "fingerprint-comparison";
      rejectionReason = "one-slot-reroll";
    } else if (input.confirmedRerollCount < 2) {
      rejectionStage = "fingerprint-confirmation";
      rejectionReason = "multi-slot-confirmation-pending";
    } else {
      rejectionStage = "fingerprint-confirmation";
      rejectionReason = input.baselineSettling
        ? "baseline-settling"
        : "new-offer-not-confirmed";
    }
  }

  const { fingerprints, ...bounded } = input;
  return {
    ...bounded,
    fingerprintHashes: [
      boundedDiagnosticHash(fingerprints[0]),
      boundedDiagnosticHash(fingerprints[1]),
      boundedDiagnosticHash(fingerprints[2]),
    ] as const,
    failureCategory,
    rejectionStage,
    rejectionReason,
  };
}

type LiveClientStatus = "ready" | "unavailable" | "error";

type LiveClientStatusTransitionInput = {
  previousStatus: LiveClientStatus | null;
  nextStatus: LiveClientStatus;
  gameEpoch: number;
  foregroundEpoch: number;
  monotonicMilliseconds: number;
};

export function describeLiveClientStatusTransition(
  input: LiveClientStatusTransitionInput,
) {
  if (input.previousStatus == null || input.previousStatus === input.nextStatus) return null;
  const transition = input.previousStatus === "ready" && input.nextStatus === "unavailable"
    ? "ready->unavailable"
    : input.previousStatus === "unavailable" && input.nextStatus === "ready"
      ? "unavailable->ready"
      : input.previousStatus === "ready" && input.nextStatus === "error"
        ? "ready->error"
        : `${input.previousStatus}->${input.nextStatus}`;
  return {
    ...input,
    transition,
  };
}

/**
 * Pure enable predicate for terminal trace forwarding — split from `import.meta`
 * so it is unit-testable (mirrors `tierFixtureEnabledFrom`). Only a dev build
 * with `MAYHEM_OVERLAY_TRACE=1` forwards the console-only diagnostic stream to
 * the terminal stderr sink.
 */
export function traceForwardingEnabledFrom(input: {
  dev: boolean;
  flag: string | undefined;
}): boolean {
  return input.dev === true && input.flag === "1";
}

function isTraceForwardingEnabled(): boolean {
  const env = (import.meta as unknown as {
    env: { DEV: boolean; MAYHEM_OVERLAY_TRACE?: string };
  }).env;
  return traceForwardingEnabledFrom({ dev: env.DEV, flag: env.MAYHEM_OVERLAY_TRACE });
}

/** Bridge a pre-serialized bounded payload to the terminal stderr sink (best-effort). */
function forwardToNativeSink(marker: DiagnosticMarker, serialized: string): void {
  void invoke("emit_overlay_diagnostic", { marker, payload: serialized }).catch(() => {
    // Best-effort; the WebView console line always runs regardless.
  });
}

/**
 * Development-only structured logging. Production folding removes the call.
 * Console-only by default; with `MAYHEM_OVERLAY_TRACE=1` the same bounded line
 * ALSO reaches terminal stderr, so a tee'd live-game log captures the identity/
 * publication lifecycle (which the coarse `emitNativeDiagnostic` markers omit).
 */
export function logOverlayDiagnostic(
  marker: DiagnosticMarker,
  payload: Record<string, unknown>,
): void {
  if (!import.meta.env.DEV) return;
  const serialized = JSON.stringify(payload);
  console.info(marker, serialized);
  if (isTraceForwardingEnabled()) forwardToNativeSink(marker, serialized);
}

/**
 * Development-only diagnostic that ALSO reaches TERMINAL stderr via the Rust
 * bridge (not just the WebView console), for controlled retests where the
 * terminal is the only visible sink. Payload must be bounded counts/booleans/
 * enums — never OCR text, names, or account identifiers. Fire-and-forget.
 */
export function emitNativeDiagnostic(
  marker: DiagnosticMarker,
  payload: Record<string, unknown>,
): void {
  if (!import.meta.env.DEV) return;
  const serialized = JSON.stringify(payload);
  console.info(marker, serialized);
  forwardToNativeSink(marker, serialized);
}
