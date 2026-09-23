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
 * `drift` is the carried prior's added variance (pp²). The first snapshot's
 * noise assumes it holds a third of the patch's final games (a patch needs at
 * least three snapshots to be used, so the first is an early one).
 */
export function carryOverBacktest(histories: SnapshotRow[][], volume: number, drift: number): CarryOverResult {
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
      const prev = (byPatch.get(patches[i - 1]) as SnapshotRow[]).at(-1) as SnapshotRow;
      const first = now[0];
      const end = now[now.length - 1];
      const mu = first.winRate / 100;
      const pi = first.pickRate / 100;
      const noise = (n: number) => ((mu * (1 - mu)) / Math.max(n, 1)) * 1e4;
      const carried = combineOnce(
        { m: prev.winRate, v: noise(pi * volume) + drift },
        { kind: "patch-to-date", snapshotDate: first.snapshot, l: first.winRate, se2: noise((pi * volume) / 3) },
      );
      e.push({ raw: first.winRate - end.winRate, carry: carried.m - end.winRate, last: prev.winRate - end.winRate });
    }
  }
  const rmse = (k: "raw" | "carry" | "last") => Math.sqrt(e.reduce((t, x) => t + x[k] ** 2, 0) / Math.max(e.length, 1));
  return { cases: e.length, rmseRaw: rmse("raw"), rmseCarry: rmse("carry"), rmseLastPatch: rmse("last") };
}
