/**
 * "Moved since last patch" (Home): a champion's win rate now against its last
 * snapshot on the previous patch, shown only when the change clears a 3σ
 * binomial noise test. Game counts come from the volume LOWER bound times the
 * champion's pick rate, so σ is overstated, never understated: the test can
 * miss a real move but should not show noise as one.
 */
import type { ChampionRow } from "./engine";

export const MOVE_Z = 3;

export interface Mover {
  slug: string;
  fromPatch: string;
  from: number;
  to: number;
  /** percentage points, signed */
  delta: number;
  z: number;
}

function comparePatch(a: string, b: string): number {
  const [a1, a2] = a.split(".").map(Number);
  const [b1, b2] = b.split(".").map(Number);
  return a1 - b1 || a2 - b2;
}

export function championMovers(champions: Record<string, ChampionRow>, patch: string, volume: number): Mover[] {
  const out: Mover[] = [];
  for (const [slug, row] of Object.entries(champions)) {
    if (row.patch !== patch || row.pickRate == null || !row.history?.length) continue;
    // the latest snapshot of the most recent earlier patch (cumulative for that patch)
    const earlier = row.history.filter((h) => comparePatch(h.patch, patch) < 0);
    if (!earlier.length) continue;
    const fromPatch = earlier.reduce((p, h) => (comparePatch(h.patch, p) > 0 ? h.patch : p), earlier[0].patch);
    const prev = earlier.filter((h) => h.patch === fromPatch).sort((a, b) => b.snapshot.localeCompare(a.snapshot))[0];
    const nNow = (volume * row.pickRate) / 100;
    const nPrev = (volume * (prev.pickRate ?? row.pickRate)) / 100;
    if (!(nNow > 0 && nPrev > 0)) continue;
    const p = (row.winRate + prev.winRate) / 200;
    const sd = 100 * Math.sqrt(p * (1 - p) * (1 / nNow + 1 / nPrev));
    const delta = row.winRate - prev.winRate;
    const z = delta / sd;
    if (Math.abs(z) >= MOVE_Z) out.push({ slug, fromPatch, from: prev.winRate, to: row.winRate, delta, z });
  }
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
