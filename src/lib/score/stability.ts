/**
 * Stability rules: set-level debounce (The math, section 6.4), patch deltas
 * (section 8) and the synergy flag (section 2).
 */
import type { Graded, Letter } from "./grade";

/** A published grouping: the order and letter of every option in one set. */
export interface Grouping {
  order: string[];
  letters: Record<string, Letter>;
}

export function groupingOf(graded: Graded[]): Grouping {
  const order = [...graded].sort((a, b) => a.order - b.order).map((g) => g.id);
  return { order, letters: Object.fromEntries(graded.map((g) => [g.id, g.letter])) };
}

function sameGrouping(a: Grouping | null, b: Grouping | null): boolean {
  if (!a || !b || a.order.length !== b.order.length) return false;
  // Only the letters and the letter-group membership matter, not order inside a group.
  return a.order.every((id) => a.letters[id] === b.letters[id]) && b.order.every((id) => id in a.letters);
}

export interface DebounceState {
  published: Grouping | null;
  pending: Grouping | null;
}

/**
 * A set's letters change only when its new grouping repeats on two consecutive
 * daily runs. The published grouping carries its own order, so letters are
 * never shown out of order while a change waits. A set whose membership
 * changed (an augment added or removed) publishes at once: yesterday's grouping
 * no longer describes it.
 */
export function debounce(state: DebounceState, today: Grouping): DebounceState {
  const membershipChanged =
    !state.published ||
    state.published.order.length !== today.order.length ||
    !today.order.every((id) => id in state.published!.letters);
  if (membershipChanged) return { published: today, pending: null };
  if (sameGrouping(state.published, today)) return { published: { ...state.published!, order: state.published!.order }, pending: null };
  if (sameGrouping(state.pending, today)) return { published: today, pending: null };
  return { published: state.published, pending: today };
}

/**
 * A patch delta ("vs 26.17: +2") may appear only when the patch is named, the
 * new grouping has repeated, and |ℓ_new − ℓ_old| ≥ 3·√(se²_new + se²_old).
 */
export function patchDelta(opts: {
  lNew: number;
  se2New: number;
  lOld: number;
  se2Old: number;
  patchNamed: boolean;
  groupingRepeated: boolean;
}): number | null {
  if (!opts.patchNamed || !opts.groupingRepeated) return null;
  const d = opts.lNew - opts.lOld;
  return Math.abs(d) >= 3 * Math.sqrt(opts.se2New + opts.se2Old) ? Math.round(d) : null;
}

/**
 * "Better on <champion>": a shrunk champion-specific effect ι of +2 pp or more
 * with at least half of the estimate from the row's own data (shrink weight ≥ 0.5).
 * A pair with no champion-specific data never qualifies.
 */
export function synergy(iotaShrunk: number, ownDataWeight: number, hasOwnData: boolean): boolean {
  return hasOwnData && ownDataWeight >= 0.5 && iotaShrunk >= 2.0;
}
