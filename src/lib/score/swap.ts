import { verdict } from "./verdict";

export interface SwapOption {
  slug: string;
  m: number;
  v: number;
}

/**
 * Keep or swap: your champion against the best of the bench (not the top two
 * of everything entered). "swap" only when the best bench champion beats yours
 * by the grades' 0.5 pp margin with at least 80% certainty.
 */
export function swapAnswer(mine: SwapOption, bench: SwapOption[]): { kind: "keep" | "swap" | "close"; other: SwapOption } | null {
  if (!bench.length) return null;
  const best = bench.reduce((a, b) => (b.m > a.m ? b : a));
  const v = verdict([mine, best].map((c) => ({ id: c.slug, m: c.m, v: c.v })));
  return { kind: v.closeCall ? "close" : v.pick === mine.slug ? "keep" : "swap", other: best };
}
