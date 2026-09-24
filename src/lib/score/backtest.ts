/**
 * Real-data backtests (Build order, phase 1).
 *
 * Carry-over: do last patch's estimates, carried forward and combined once with
 * the first snapshot of the new patch, predict the end-of-patch value better
 * than that first snapshot alone? Run on the provider's own dated history.
 */
import { combineOnce } from "./carryover";

export interface SnapshotRow {
  snapshot: string;
  patch: string;
  winRate: number;
  pickRate: number;
}

export interface CarryOverResult {
  cases: number;
  /** RMSE of each estimator against the patch's last snapshot, pp */
  rmseRaw: number;
  rmseCarry: number;
  rmseLastPatch: number;
}

function patchKey(p: string): number[] {
  return p.split(".").map(Number);
}

/**
 * `drift` is the carried prior's added variance (pp²). Snapshots are
 * cumulative, so a snapshot t days into a patch holds R·π·t games (R the daily
 * rate, π the champion's pick rate); the same model the volume estimate uses.
 * Caveat: the end-of-patch target contains the early snapshot's own games,
 * which favours the raw early value; a patch needs three or more snapshots.
 */
export function carryOverBacktest(
  histories: SnapshotRow[][],
  patchStarts: Record<string, string>,
  gamesPerDay: number,
  drift: number,
): CarryOverResult {
  const DAY = 86_400_000;
  const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const e: { raw: number; carry: number; last: number }[] = [];
  for (const rows of histories) {
    const byPatch = new Map<string, SnapshotRow[]>();
    for (const r of [...rows].sort((a, b) => a.snapshot.localeCompare(b.snapshot))) {
      byPatch.set(r.patch, [...(byPatch.get(r.patch) ?? []), r]);
    }
    const patches = [...byPatch.keys()].sort((a, b) => {
      const x = patchKey(a);
      const y = patchKey(b);
      return x[0] - y[0] || x[1] - y[1];
    });
    for (let i = 1; i < patches.length; i++) {
      const now = byPatch.get(patches[i]) as SnapshotRow[];
      if (now.length < 3) continue;
      const prevRows = byPatch.get(patches[i - 1]) as SnapshotRow[];
      const prev = prevRows.at(-1) as SnapshotRow;
      const first = now[0];
      const end = now[now.length - 1];
      const startOf = (patch: string, list: SnapshotRow[]) =>
        Math.min(patchStarts[patch] ? Date.parse(patchStarts[patch].slice(0, 10) + "T00:00:00Z") : Infinity, day(list[0].snapshot));
      const tFirst = Math.max(1, (day(first.snapshot) - startOf(patches[i], now)) / DAY);
      const tPrev = Math.max(1, (day(prev.snapshot) - startOf(patches[i - 1], prevRows)) / DAY);
      const mu = first.winRate / 100;
      const noise = (pickRate: number, t: number) => ((mu * (1 - mu)) / Math.max((pickRate / 100) * gamesPerDay * t, 1)) * 1e4;
      const carried = combineOnce(
        { m: prev.winRate, v: noise(prev.pickRate, tPrev) + drift },
        { kind: "patch-to-date", snapshotDate: first.snapshot, l: first.winRate, se2: noise(first.pickRate, tFirst) },
      );
      e.push({ raw: first.winRate - end.winRate, carry: carried.m - end.winRate, last: prev.winRate - end.winRate });
    }
  }
  const rmse = (k: "raw" | "carry" | "last") => Math.sqrt(e.reduce((t, x) => t + x[k] ** 2, 0) / Math.max(e.length, 1));
  return { cases: e.length, rmseRaw: rmse("raw"), rmseCarry: rmse("carry"), rmseLastPatch: rmse("last") };
}
