/**
 * The volume behind the provider's rates, from its own snapshot history
 * (The math, section 4: the noise scale is fitted, never assumed).
 *
 * The provider publishes no game counts. It does publish dated snapshots of
 * every champion's win rate. Within one patch, two successive snapshots
 * estimate the same quantity, so their difference is mostly sampling noise:
 *
 *   Var(W₂ − W₁) ≈ μ(1 − μ) / (π · N)
 *
 * where π is the champion's pick rate (share of games) and N the number of
 * games behind the later snapshot. (Cumulative windows that double between
 * snapshots give exactly this; independent windows give twice the variance, so
 * N reads low — the conservative direction.) Real within-patch drift and
 * hotfixes also inflate the differences, again toward fewer games and wider
 * uncertainty, never toward overconfidence.
 *
 * N is estimated robustly: the median of ΔW²·π / (μ(1−μ)) divided by the
 * median of a χ²₁ variable (0.4549), so a few mislabelled snapshots or a
 * hotfix cannot drive it.
 */
import { median, rng } from "./normal";

export interface HistoryRow {
  snapshot: string;
  patch: string;
  /** percent */
  winRate: number;
  /** percent, share of games */
  pickRate: number;
}

export interface VolumeEstimate {
  /** games behind a snapshot (share-of-games units) */
  games: number;
  /** pairs of same-patch successive snapshots used */
  pairs: number;
  /** 5th–95th percentile of a seeded bootstrap of the estimate */
  range: [number, number];
}

const CHI2_1_MEDIAN = 0.45494;

export function estimateVolume(histories: HistoryRow[][]): VolumeEstimate | null {
  const ratios: number[] = [];
  for (const rows of histories) {
    const sorted = [...rows].sort((a, b) => a.snapshot.localeCompare(b.snapshot));
    for (let k = 1; k < sorted.length; k++) {
      const a = sorted[k - 1];
      const b = sorted[k];
      if (a.patch !== b.patch) continue;
      const mu = b.winRate / 100;
      const pi = b.pickRate / 100;
      const d = (b.winRate - a.winRate) / 100;
      if (!(pi > 0) || mu <= 0 || mu >= 1) continue;
      // Identical values can be a re-publish, not a new estimate: skip exact repeats.
      if (d === 0 && a.pickRate === b.pickRate) continue;
      ratios.push((d * d * pi) / (mu * (1 - mu)));
    }
  }
  if (ratios.length < 20) return null;
  const games = CHI2_1_MEDIAN / median(ratios);
  const rand = rng(20260924);
  const boot: number[] = [];
  for (let b = 0; b < 400; b++) {
    const sample = ratios.map(() => ratios[Math.floor(rand() * ratios.length)]);
    boot.push(CHI2_1_MEDIAN / median(sample));
  }
  boot.sort((x, y) => x - y);
  return { games, pairs: ratios.length, range: [boot[Math.floor(0.05 * 399)], boot[Math.floor(0.95 * 399)]] };
}
