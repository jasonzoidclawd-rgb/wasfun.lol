import type { PatchNote } from "@/lib/types";

export interface PatchDigest {
  added: number;
  removed: number;
  hotfixes: number;
}

/**
 * The three states a patch card can be in. They are NOT interchangeable:
 *
 *   changes     — a patch-adjacent structural diff ran and found changes.
 *   no-changes  — a patch-adjacent structural diff ran and found none. A
 *                 verified fact about the game.
 *   unavailable — no structural diff covers this patch, so nothing is known.
 *                 Rendering this as zeroes claims a check we never made.
 *
 * A payload without `structuredDiff` (or without a `summary` to back it) has
 * no evidence, so it resolves to "unavailable" rather than to zero.
 */
export type PatchChangeState = "changes" | "no-changes" | "unavailable";

/** Only the evidence fields are needed, so partial payloads can be classified. */
export type PatchChangeEvidence = Pick<PatchNote, "structuredDiff" | "summary">;

export function patchChangeState(patch: PatchChangeEvidence): PatchChangeState {
  if (patch.structuredDiff !== "available" || !patch.summary) return "unavailable";
  return patch.summary.totalChanges > 0 ? "changes" : "no-changes";
}

/**
 * Counts for one patch's summary cards. Each is a claim about THAT patch, so
 * added/removed come only from its dated events. The archive of augments that
 * are not currently live (removed, disabled, unverified, candidate) is not
 * "removed in this patch" and must never stand in when no removal is dated.
 *
 * Returns null when no structural diff covers the patch: there is nothing to
 * count, and a zeroed digest would read as a measurement.
 */
export function buildPatchDigest(
  patch: PatchNote,
  hotfixEventCount: number,
): PatchDigest | null {
  if (patchChangeState(patch) === "unavailable") return null;
  return {
    added: patch.summary?.byKind.added ?? 0,
    removed: patch.summary?.byKind.removed ?? 0,
    hotfixes: hotfixEventCount,
  };
}
