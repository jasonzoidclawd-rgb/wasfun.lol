/**
 * PHASE A — one explicit publication-ownership model shared by geometry, OCR,
 * champion datasets, statistics and rendering.
 *
 * Every asynchronous result (a geometry probe, an OCR run, a champion-dataset
 * fetch, a derived statistic) captures an `OwnershipToken` at START. A result
 * may publish ONLY when `ownershipCurrent(result, current)` still holds — the
 * single guard that makes stale geometry, post-reroll OCR, post-champion-change
 * datasets, and late results after no-offer/occlusion all fail closed.
 *
 * Separately, within one ownership scope a card's canonical identity is
 * IMMUTABLE: `reconcileSlotIdentity` refuses to let a conflicting OCR read
 * replace it. Derived statistics remain refreshable for that same canonical id
 * so a current champion dataset can legitimately upgrade GLOBAL to CHAMP.
 *
 * All pure — no timers, IPC or React — so the ordering and immutability rules
 * are unit-tested deterministically. Fingerprint comparisons reuse the geometry
 * average-hash Hamming band so animated-background drift is not a stale result.
 */
import { fingerprintChanged } from "./surfaceGeometry";

export interface OwnershipToken {
  /** Foreground epoch (bumps whenever the game window gains/loses foreground). */
  foregroundEpoch: number;
  /** Active-game epoch (bumps on game start / exit / reconnect). */
  gameEpoch: number;
  /** Champion generation (bumps on every final-champion change). */
  championGeneration: number;
  /** Canonical numeric Riot champion ID (null before resolution). */
  championId: string | null;
  /** Champion-dataset request id (monotonic per champion load). */
  championRequestId: number;
  /** Offer generation (bumps per genuinely new offer surface or close). */
  offerGeneration: number;
  /** Geometry probe sequence. */
  geometrySeq: number;
  /** Slot generation (bumps only for the slot whose fingerprint changed). */
  slotGeneration: number;
  /** Geometry fingerprint (144-bit average hash) the result is keyed to. */
  fingerprint: string;
  /** OCR run id (monotonic per identity probe). */
  ocrRunId: number;
}

/**
 * A result may publish only when EVERY relevant ownership field still matches
 * current state. The fingerprint is compared with the geometry Hamming band so
 * sub-threshold animated drift is the same card; every other field is exact, so
 * a superseded sequence/generation/epoch/champion rejects the publish.
 */
export function ownershipCurrent(result: OwnershipToken, current: OwnershipToken): boolean {
  return (
    result.foregroundEpoch === current.foregroundEpoch &&
    result.gameEpoch === current.gameEpoch &&
    result.championGeneration === current.championGeneration &&
    result.championId === current.championId &&
    result.championRequestId === current.championRequestId &&
    result.offerGeneration === current.offerGeneration &&
    result.geometrySeq === current.geometrySeq &&
    result.slotGeneration === current.slotGeneration &&
    result.ocrRunId === current.ocrRunId &&
    !fingerprintChanged(result.fingerprint, current.fingerprint)
  );
}

// ─── Slot identity immutability & conflict reconciliation ───

export interface SlotIdentity<R> {
  foregroundEpoch: number;
  gameEpoch: number;
  /** Geometry fingerprint this identity is bound to. */
  fingerprint: string;
  /** Champion generation the statistic was computed for. */
  championGeneration: number;
  offerGeneration: number;
  /** Canonical numeric augment ID (a verified identity has a non-empty id). */
  augmentId: string;
  /** The published statistic payload for this slot. */
  resolution: R;
  slotGeneration: number;
  ocrRunId: number;
  /** Saturating diagnostic count; conflicts never replace the canonical id. */
  conflictCount: number;
}

export type IdentityReconciliation<R> =
  | { action: "adopt"; identity: SlotIdentity<R> }
  | { action: "replace"; identity: SlotIdentity<R> }
  | { action: "recompute-stat"; identity: SlotIdentity<R> }
  | { action: "keep"; identity: SlotIdentity<R>; reason: "identity-conflict" };

export const MAX_IDENTITY_CONFLICTS = 3;

/**
 * Decide whether an incoming OCR-derived identity may publish over the slot's
 * current verified identity. Canonical identity and derived statistic have
 * deliberately different mutability:
 *   - no prior verified identity → ADOPT the incoming one;
 *   - ownership generation/epoch changed → REPLACE;
 *   - fingerprint changed past the Hamming band (a real reroll) → REPLACE;
 *   - same ownership + same fingerprint + same augment id → keep the
 *     canonical identity but RECOMPUTE its derived statistic. This is required
 *     for GLOBAL fallback → CHAMP once the current champion dataset loads;
 *   - same champion + same fingerprint, different augment id → KEEP (a
 *     conflicting OCR read never silently replaces the verified identity).
 */
export function reconcileSlotIdentity<R>(
  prev: SlotIdentity<R> | null,
  incoming: SlotIdentity<R>,
): IdentityReconciliation<R> {
  if (prev === null || prev.augmentId.length === 0) {
    return { action: "adopt", identity: incoming };
  }
  if (
    prev.foregroundEpoch !== incoming.foregroundEpoch ||
    prev.gameEpoch !== incoming.gameEpoch ||
    prev.championGeneration !== incoming.championGeneration ||
    prev.offerGeneration !== incoming.offerGeneration ||
    prev.slotGeneration !== incoming.slotGeneration
  ) {
    return { action: "replace", identity: incoming };
  }
  if (fingerprintChanged(prev.fingerprint, incoming.fingerprint)) {
    return { action: "replace", identity: incoming };
  }
  if (prev.augmentId === incoming.augmentId) {
    return {
      action: "recompute-stat",
      identity: {
        ...prev,
        resolution: incoming.resolution,
        ocrRunId: incoming.ocrRunId,
      },
    };
  }
  return {
    action: "keep",
    identity: {
      ...prev,
      conflictCount: Math.min(MAX_IDENTITY_CONFLICTS, prev.conflictCount + 1),
    },
    reason: "identity-conflict",
  };
}
