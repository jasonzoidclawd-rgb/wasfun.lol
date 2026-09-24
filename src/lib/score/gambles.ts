/**
 * Augments that put unchosen augments into a game (The math, section 11).
 */

export type CountingBasis = "pick" | "game-end" | "unknown";

export interface RandomSource {
  /** the source augment (Pandora's Box, Transmute: Chaos, ...) */
  id: string;
  /** how often it is taken, as a share of games (same units as the rates it corrects) */
  takeRate: number;
  /** augments it produces per take */
  produces: number;
  /** the augments it can produce */
  pool: string[];
}

/** E[random_X] = Σ_s r_s n_s / |pool_s| for every augment X a source can produce. */
export function expectedRandomAppearances(sources: RandomSource[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sources) {
    if (s.pool.length === 0) continue;
    const each = (s.takeRate * s.produces) / s.pool.length;
    for (const x of s.pool) out[x] = (out[x] ?? 0) + each;
  }
  return out;
}

/**
 * Subtract expected random appearances before any use of pick rates, when the
 * provider counts what players hold at game end. At pick time random grants are
 * not counted, and with an unknown basis the correction's sign is unknown, so the
 * rates are returned unchanged (and the caller records that).
 */
export function correctForRandomGrants(
  rates: Record<string, number>,
  sources: RandomSource[],
  basis: CountingBasis,
): { rates: Record<string, number>; applied: boolean } {
  if (basis !== "game-end") return { rates: { ...rates }, applied: false };
  const extra = expectedRandomAppearances(sources);
  const out: Record<string, number> = {};
  for (const [id, r] of Object.entries(rates)) out[id] = Math.max(r - (extra[id] ?? 0), 0);
  return { rates: out, applied: true };
}

/**
 * Pandora's Box graded for this game: every held augment is swapped for an
 * average random Prismatic, so v_PB(H) = v_PB + Σ_{h ∈ H} (θ̄_Prismatic − θ_h).
 * Holding strong augments turns it down; holding only weak ones turns it up.
 */
export function pandorasBoxForHoldings(vPB: number, meanPrismatic: number, held: number[]): number {
  return vPB + held.reduce((t, theta) => t + (meanPrismatic - theta), 0);
}
