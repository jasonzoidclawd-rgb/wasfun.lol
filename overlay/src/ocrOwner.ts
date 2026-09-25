/**
 * Phase C policy, measured against the existing 2 s native watchdog and 150 ms
 * geometry cadence. Two visible retries fit inside the old 1.5 s retry window;
 * later attempts continue in the background with a 6 s cap without leaving the
 * UI indefinitely in SCANNING.
 */
export const NATIVE_OCR_TIMEOUT_MS = 2_000;
export const INITIAL_OCR_RETRY_MS = 750;
export const MAX_OCR_RETRY_MS = 6_000;
export const VISIBLE_SCANNING_FAILURES = 2;
export const OCR_WATCHDOG_CADENCE_MS = 150;

export type OcrUnresolvedState = "scanning" | "unmatched" | "ocr-error";

export interface OcrOwnerContext {
  foregroundEpoch: number;
  gameEpoch: number;
  championGeneration: number;
  championId: string | null;
  offerGeneration: number;
  round: number | null;
  requestedSlots: number[];
  slotGenerations: number[];
  fingerprints: string[];
}

export interface OcrOwnerToken extends OcrOwnerContext {
  runId: number;
  startedAt: number;
  timeoutDeadline: number;
}

/**
 * May this completed run publish?
 *
 * Every axis here is SEMANTIC — an epoch, a champion, or a generation counter
 * that some other authority deliberately advanced. Raw fingerprint drift is
 * deliberately NOT one of them.
 *
 * It used to be. `current.fingerprints` is the accepted baseline, which the
 * settlement re-latch rewrites without touching anything else, so a run keyed to
 * the baseline at trigger time could be rejected purely because the baseline
 * moved underneath it while the card did not. The 2026-07-27 trace has 25 stale
 * rejects; 24 carried `cause: fingerprint-drift` with
 * `slotGenerationsAtStart === slotGenerationsNow` on all 25 rows and
 * `currentOwnerRunId === runId` on all 24 non-null rows — nothing had actually
 * been superseded, and every one of those discarded reads was correct. A real
 * replacement still rejects the run, one line up, via `slotGenerations`, because
 * the confirmed-reroll path bumps that counter when it clears the slot.
 */
export function ownerCurrent(
  result: OcrOwnerToken,
  currentOwner: OcrOwnerToken | null,
  current: OcrOwnerContext,
): boolean {
  if (currentOwner?.runId !== result.runId) return false;
  if (
    result.foregroundEpoch !== current.foregroundEpoch ||
    result.gameEpoch !== current.gameEpoch ||
    result.championGeneration !== current.championGeneration ||
    result.championId !== current.championId ||
    result.offerGeneration !== current.offerGeneration ||
    result.round !== current.round
  ) return false;
  return result.requestedSlots.every((slot) =>
    result.slotGenerations[slot] === current.slotGenerations[slot]);
}

/** The single authority that invalidated a completed-but-unpublishable OCR run. */
export type StaleRejectCause =
  | "foreground-epoch"
  | "game-epoch"
  | "champion-id"
  | "champion-generation"
  | "offer-generation"
  | "round"
  | "slot-generation"
  | "owner-replaced"
  | "capture-seq-only";

/**
 * Name the FIRST violated authority behind an `ownerCurrent` rejection.
 *
 * `ownerCurrent` answers only yes/no, so the 2026-07-26 four-phase trace logged
 * 11 rejections under one opaque `owner-superseded-before-publication` string.
 * That single reason covers a legitimate reroll, a closed offer, a foreground
 * flip and a bare bookkeeping bump alike — so the trace could not distinguish
 * "the card genuinely changed and a replacement read is already running" from
 * "OCR silently gave up", and the run was misread as zero recovery.
 *
 * Order is deliberate: SEMANTIC ownership first, then the registry swap, then
 * the capture sequence. A registry replacement is a CONSEQUENCE of a reroll, so
 * it must never mask the reroll that caused it. `capture-seq-only` is last and
 * distinct because geometry capture sequence alone is NOT an ownership
 * authority: when it is the only thing that moved, the diagnostic has to say so
 * rather than report a supersede that did not happen.
 *
 * `fingerprint-drift` is GONE from this chain because it is gone from
 * `ownerCurrent`. Leaving it would be worse than useless: sitting above
 * `owner-replaced`, it would relabel rejections it no longer causes and hide the
 * authority that did. The drift itself is still measured — as bounded per-slot
 * Hamming integers by `staleRejectSlotDrift`, which is evidence rather than a
 * verdict.
 *
 * Diagnostic only — this classifies a rejection the caller has already decided.
 */
export function classifyStaleReject(
  result: OcrOwnerToken,
  currentOwner: OcrOwnerToken | null,
  current: OcrOwnerContext,
  captureSeqStale: boolean,
): StaleRejectCause | null {
  if (result.foregroundEpoch !== current.foregroundEpoch) return "foreground-epoch";
  if (result.gameEpoch !== current.gameEpoch) return "game-epoch";
  if (result.championId !== current.championId) return "champion-id";
  if (result.championGeneration !== current.championGeneration) return "champion-generation";
  if (result.offerGeneration !== current.offerGeneration) return "offer-generation";
  if (result.round !== current.round) return "round";
  for (const slot of result.requestedSlots) {
    if (result.slotGenerations[slot] !== current.slotGenerations[slot]) return "slot-generation";
  }
  if (currentOwner?.runId !== result.runId) return "owner-replaced";
  if (captureSeqStale) return "capture-seq-only";
  return null;
}

/**
 * Per-requested-slot Hamming distance between the fingerprint a run was keyed to
 * and the accepted fingerprint at completion. Bounded integers only — the
 * fingerprints themselves never reach the log.
 */
export function staleRejectSlotDrift(
  result: OcrOwnerToken,
  current: OcrOwnerContext,
  distance: (a: string, b: string) => number,
): number[] {
  return result.requestedSlots.map((slot) =>
    distance(result.fingerprints[slot] ?? "", current.fingerprints[slot] ?? ""));
}

export class OcrOwnerRegistry {
  private nextRunId = 0;
  current: OcrOwnerToken | null = null;

  start(context: OcrOwnerContext, startedAt: number): OcrOwnerToken {
    const owner: OcrOwnerToken = {
      ...context,
      requestedSlots: [...context.requestedSlots],
      slotGenerations: [...context.slotGenerations],
      fingerprints: [...context.fingerprints],
      runId: (this.nextRunId += 1),
      startedAt,
      timeoutDeadline: startedAt + NATIVE_OCR_TIMEOUT_MS,
    };
    this.current = owner;
    return owner;
  }

  release(runId: number): boolean {
    if (this.current?.runId !== runId) return false;
    this.current = null;
    return true;
  }

  expire(runId: number, now: number): boolean {
    if (this.current?.runId !== runId || now < this.current.timeoutDeadline) return false;
    this.current = null;
    return true;
  }

  invalidate(): OcrOwnerToken | null {
    const previous = this.current;
    this.current = null;
    return previous;
  }
}

export function nextRetryDelay(failureCount: number): number {
  const exponent = Math.max(0, failureCount - 1);
  return Math.min(MAX_OCR_RETRY_MS, INITIAL_OCR_RETRY_MS * (2 ** exponent));
}

export interface OcrFailurePublication {
  state: OcrUnresolvedState;
  failureCount: number;
  retryAt: number;
}

export function failurePublication(failureCount: number, failedAt: number): OcrFailurePublication {
  return {
    state: failureCount <= VISIBLE_SCANNING_FAILURES ? "scanning" : "ocr-error",
    failureCount,
    retryAt: failedAt + nextRetryDelay(failureCount),
  };
}

export function requestedPendingStates(
  requestedSlots: number[],
): Array<"scanning" | "unchanged"> {
  const requested = new Set(requestedSlots);
  return [0, 1, 2].map((slot) => requested.has(slot) ? "scanning" : "unchanged");
}

export type OcrExecutionResult<T> =
  | { kind: "success"; value: T }
  | { kind: "failure"; reason: string };

export async function executeOcrRun<Native, Matched>(
  invokeNative: () => Promise<Native> | Native,
  match: (native: Native) => Matched,
  timeoutMs = NATIVE_OCR_TIMEOUT_MS,
): Promise<OcrExecutionResult<Matched>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const nativePromise = Promise.resolve().then(invokeNative);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    const native = await Promise.race([nativePromise, timeout]);
    return { kind: "success", value: match(native) };
  } catch (error) {
    return {
      kind: "failure",
      reason: error instanceof Error ? error.message : "ocr-run-failed",
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
