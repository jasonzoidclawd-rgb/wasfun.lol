/**
 * The volume behind the provider's rates, from its own snapshot history
 * (The math, section 4: the noise scale is fitted, never assumed). Reported
 * as a LOWER BOUND, because the history cannot pin it down.
 *
 * The provider publishes no game counts. It does publish dated snapshots of
 * every champion's win rate. Snapshots within a patch are cumulative, so with
 * n(t) = R·π·t games after t days of the patch (R games per day, π the
 * champion's pick rate):
 *
 *   Var(W₂ − W₁) = μ(1 − μ)/(π·R) · (1/t₁ − 1/t₂)
 *
 * and each day-pair (all champions snapshotted together) gives one estimate of
 * R, from the robust median of ΔW²·π / (μ(1−μ)) over champions (divided by the
 * median of a χ²₁ variable, 0.4549). On 2026-09-24 the day-pairs disagreed by
 * an order of magnitude (164k to 1.8M games a day), so the model does not fit
 * well enough to report one value. The engine uses the SMALLEST day-pair rate
 * times the days since the current patch started (at least one day): fewer
 * games means wider uncertainty — the direction that never overstates, as far
 * as the cumulative model holds (the day-pairs' disagreement says it may not).
 *
 * Start dates: for the daily RATE a patch starts at the earlier of Riot's date
 * and the provider's first snapshot (an earlier start lowers the rate); for
 * DAYS INTO the current patch it starts at the later of the two (a later start
 * means fewer games). Data dated before its own patch's start is flagged.
 */
import { median } from "./normal";

export interface HistoryRow {
  snapshot: string; // "YYYYMMDD_HHMMSS"
  patch: string;
  /** percent */
  winRate: number;
  /** percent, share of games */
  pickRate: number;
}

export interface DayPairRate {
  patch: string;
  from: string;
  to: string;
  champions: number;
  /** games per day across all champions, share-of-games units */
  gamesPerDay: number;
}

export interface VolumeEstimate {
  status: "lower-bound";
  /** games behind the current snapshot used for noise */
  games: number;
  /** the smallest daily rate across day-pairs, and the days it is multiplied by */
  gamesPerDay: number;
  days: number;
  pairs: DayPairRate[];
  /** set when the elapsed days had to be floored, and why */
  note?: string;
}

const CHI2_1_MEDIAN = 0.45494;
const MIN_CHAMPIONS_PER_PAIR = 50;
const DAY_MS = 86_400_000;

function day(snapshot: string): number {
  return Date.UTC(+snapshot.slice(0, 4), +snapshot.slice(4, 6) - 1, +snapshot.slice(6, 8));
}

function isoDay(iso: string): number {
  return Date.parse(iso.slice(0, 10) + "T00:00:00Z");
}

/**
 * `patchStarts`: when each patch began (Riot's patch-notes date, ISO). A patch's
 * start is the earlier of that date and the provider's first snapshot for it.
 */
export function dayPairRates(histories: HistoryRow[][], patchStarts: Record<string, string>): DayPairRate[] {
  const firstSeen = new Map<string, number>();
  for (const rows of histories) {
    for (const r of rows) {
      const d = day(r.snapshot);
      if (!firstSeen.has(r.patch) || d < (firstSeen.get(r.patch) as number)) firstSeen.set(r.patch, d);
    }
  }
  const start = (patch: string) => {
    const riot = patchStarts[patch] ? isoDay(patchStarts[patch]) : Infinity;
    return Math.min(riot, firstSeen.get(patch) ?? Infinity);
  };
  const byPair = new Map<string, number[]>();
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
      if (d === 0 && a.pickRate === b.pickRate) continue; // a re-publish, not a new estimate
      const key = `${b.patch}|${a.snapshot.slice(0, 8)}|${b.snapshot.slice(0, 8)}`;
      byPair.set(key, [...(byPair.get(key) ?? []), (d * d * pi) / (mu * (1 - mu))]);
    }
  }
  const out: DayPairRate[] = [];
  for (const [key, ratios] of byPair) {
    if (ratios.length < MIN_CHAMPIONS_PER_PAIR) continue; // not a snapshot of the whole field
    const [patch, from, to] = key.split("|");
    const s = start(patch);
    const t1 = (day(from) - s) / DAY_MS;
    const t2 = (day(to) - s) / DAY_MS;
    if (!(t1 > 0) || !(t2 > t1)) continue;
    const K = median(ratios) / CHI2_1_MEDIAN; // = (1/t1 − 1/t2) / R
    out.push({ patch, from, to, champions: ratios.length, gamesPerDay: (1 / t1 - 1 / t2) / K });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

export function estimateVolume(
  histories: HistoryRow[][],
  patchStarts: Record<string, string>,
  current: { patch: string; dataDate: string },
): VolumeEstimate | null {
  const pairs = dayPairRates(histories, patchStarts);
  if (pairs.length < 2) return null;
  const gamesPerDay = Math.min(...pairs.map((p) => p.gamesPerDay));
  const snaps = histories.flat().filter((r) => r.patch === current.patch).map((r) => day(r.snapshot));
  const candidates = [
    ...(patchStarts[current.patch] ? [isoDay(patchStarts[current.patch])] : []),
    ...(snaps.length ? [Math.min(...snaps)] : []),
  ];
  const start = candidates.length ? Math.max(...candidates) : NaN;
  const elapsed = Number.isFinite(start) ? (isoDay(current.dataDate) - start) / DAY_MS : NaN;
  const days = Math.max(1, Number.isFinite(elapsed) ? elapsed : 1);
  const note = !Number.isFinite(elapsed)
    ? "no start date for the current patch: treated as one day"
    : elapsed < 1
      ? `data date ${current.dataDate} is ${elapsed < 0 ? "before" : "on"} the start of patch ${current.patch} (rows predate the patch or are mislabelled): treated as one day`
      : undefined;
  return { status: "lower-bound", games: gamesPerDay * days, gamesPerDay, days, pairs, ...(note ? { note } : {}) };
}

export { median };
