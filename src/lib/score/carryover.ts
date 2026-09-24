/**
 * Patch-day carry-over (The math, section 3).
 *
 * The new patch's prior is last patch's posterior, widened by drift:
 * (0.5 pp)² for unchanged augments, (3 pp)² + (1 pp)² for augments the patch
 * notes changed. Each day that prior is combined ONCE with the patch-to-date
 * snapshot. Snapshots are cumulative, so they are never chained: chaining counts
 * the early games again every day and understates uncertainty.
 */

export const DRIFT_UNCHANGED = 0.5 ** 2; // pp²
export const DRIFT_CHANGED = 3 ** 2 + 1 ** 2; // pp²

export interface Normal {
  m: number;
  v: number;
}

export function carriedPrior(lastPatchPosterior: Normal, changedThisPatch: boolean): Normal {
  return { m: lastPatchPosterior.m, v: lastPatchPosterior.v + (changedThisPatch ? DRIFT_CHANGED : DRIFT_UNCHANGED) };
}

/** Patch-to-date evidence: one cumulative snapshot, never a sequence. */
export interface PatchToDate {
  kind: "patch-to-date";
  snapshotDate: string;
  /** lift observed so far this patch, pp */
  l: number;
  /** its noise variance, pp² */
  se2: number;
}

export function combineOnce(prior: Normal, evidence: PatchToDate): Normal {
  if (evidence.kind !== "patch-to-date") throw new Error("carry-over combines one patch-to-date snapshot");
  if (!(evidence.se2 > 0)) return prior;
  const precision = 1 / prior.v + 1 / evidence.se2;
  return { m: (prior.m / prior.v + evidence.l / evidence.se2) / precision, v: 1 / precision };
}

/** The label the page shows while carry-over applies. */
export function carryOverLabel(patch: string, fromPatch: string): string {
  return `Patch ${patch} · carried over from ${fromPatch}, updating daily`;
}
