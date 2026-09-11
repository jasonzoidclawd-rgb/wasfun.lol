import type { PatchNote } from "@/lib/types";

export interface PatchDigest {
  added: number;
  removed: number;
  hotfixes: number;
}

/**
 * Counts for one patch's summary cards. Each is a claim about THAT patch, so
 * added/removed come only from its dated events. The archive of augments that
 * are not currently live (removed, disabled, unverified, candidate) is not
 * "removed in this patch" and must never stand in when no removal is dated.
 */
export function buildPatchDigest(
  patch: PatchNote,
  hotfixEventCount: number,
): PatchDigest {
  return {
    added: patch.summary?.byKind.added ?? 0,
    removed: patch.summary?.byKind.removed ?? 0,
    hotfixes: hotfixEventCount,
  };
}
