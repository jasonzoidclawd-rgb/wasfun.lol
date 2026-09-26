/**
 * "Moved since last patch" (Home): a champion's win rate now against its last
 * snapshot on the previous patch, shown only when the change clears a noise
 * test corrected for testing every champion at once.
 *
 * Each side's game count is its own patch's volume lower bound times the
 * champion's pick rate (share of games), so σ is overstated rather than
 * understated as far as those bounds hold. The bounds come from the source's
 * own snapshot history and disagree widely, so this is a screen for large
 * moves, not an exact test.
 */
import { Phi } from "./normal";
import type { ChampionRow } from "./engine";

/** Family-wise error for the whole list: the two-sided rate of a single 3σ test. */
export const MOVE_FAMILY_ALPHA = 2 * (1 - Phi(3));

export interface Mover {
  slug: string;
  fromPatch: string;
  from: number;
  to: number;
  /** percentage points, signed */
  delta: number;
  z: number;
}

export function comparePatch(a: string, b: string): number {
  const [a1, a2] = a.split(".").map(Number);
  const [b1, b2] = b.split(".").map(Number);
  return a1 - b1 || a2 - b2;
}

/** The two-sided z a test must clear when `tests` are run together (Bonferroni). */
export function criticalZ(tests: number, familyAlpha = MOVE_FAMILY_ALPHA): number {
  const target = 1 - familyAlpha / (2 * Math.max(1, tests));
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (Phi(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Where the current patch's data stands. The source's data date carries no
 * time or time zone and lags the scrape, so a date on or before the patch's
 * start day can hold none of the new patch: those rows are the previous
 * patch's running totals under a new label, and there is nothing of the new
 * patch to show yet (undetermined, not "no change"). Days are whole days
 * after the start day, never rounded up.
 */
export function patchDataState(dataDate: string, patchStart: string | undefined): { predates: boolean; days: number | null } {
  // no start date: whether these rows hold any of the new patch is unknown
  if (!patchStart) return { predates: true, days: null };
  const data = Date.parse(`${dataDate}T00:00:00Z`);
  const startDay = Date.parse(`${patchStart.slice(0, 10)}T00:00:00Z`);
  // an unreadable date can't show that the new patch has data: undetermined
  if (!Number.isFinite(data) || !Number.isFinite(startDay)) return { predates: true, days: null };
  const days = Math.floor((data - startDay) / 86_400_000);
  if (days < 1) return { predates: true, days: null };
  return { predates: false, days };
}

export function championMovers(
  champions: Record<string, ChampionRow>,
  patch: string,
  volume: { current: number; previous: (fromPatch: string) => number | null },
): Mover[] {
  const candidates: Mover[] = [];
  let tested = 0;
  for (const [slug, row] of Object.entries(champions)) {
    if (row.patch !== patch || row.pickRate == null || !row.history?.length) continue;
    // the latest snapshot of the most recent earlier patch (cumulative for that patch)
    const earlier = row.history.filter((h) => comparePatch(h.patch, patch) < 0);
    if (!earlier.length) continue;
    const fromPatch = earlier.reduce((p, h) => (comparePatch(h.patch, p) > 0 ? h.patch : p), earlier[0].patch);
    const prev = earlier.filter((h) => h.patch === fromPatch).sort((a, b) => b.snapshot.localeCompare(a.snapshot))[0];
    const prevVolume = volume.previous(fromPatch);
    if (prevVolume === null) continue; // no game count for that patch: undetermined, not tested
    const nNow = (volume.current * row.pickRate) / 100;
    const nPrev = (prevVolume * (prev.pickRate ?? row.pickRate)) / 100;
    if (!(nNow > 0 && nPrev > 0)) continue;
    tested++;
    const p = (row.winRate + prev.winRate) / 200;
    const sd = 100 * Math.sqrt(p * (1 - p) * (1 / nNow + 1 / nPrev));
    const delta = row.winRate - prev.winRate;
    candidates.push({ slug, fromPatch, from: prev.winRate, to: row.winRate, delta, z: delta / sd });
  }
  const zc = criticalZ(tested);
  return candidates.filter((m) => Math.abs(m.z) >= zc).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
