/**
 * Pick rate is published by the statistics source only when the source has it.
 * As of 2026-09-10 arammayhem.com stopped publishing champion pick rate
 * entirely, so every row carries null — and the UI kept a Pick% column, an
 * "and pick rates" meta description, and a "— pick" stat on the homepage, all
 * of which promise a number the site does not have.
 *
 * Coverage is measured, never assumed, so these surfaces disappear at zero and
 * come back on their own the moment the source publishes pick rate again.
 */

export interface PickRateRecord {
  pick_rate?: number | null;
}

/**
 * Three states, because the honest claim differs in each:
 *
 *   none    — advertise nothing; there is no pick rate to show.
 *   partial — show every value we DO have, and say so ("where available").
 *             Claiming full coverage would be false; claiming none would hide
 *             real data.
 *   full    — the plain claim is accurate.
 */
export type PickRateCoverageLevel = "none" | "partial" | "full";

export function pickRateCoverage(champions: PickRateRecord[]): number {
  if (champions.length === 0) return 0;
  const covered = champions.filter(
    (champion) => typeof champion.pick_rate === "number",
  ).length;
  return covered / champions.length;
}

export function pickRateCoverageLevel(
  champions: PickRateRecord[],
): PickRateCoverageLevel {
  const coverage = pickRateCoverage(champions);
  if (coverage === 0) return "none";
  return coverage === 1 ? "full" : "partial";
}

/**
 * True when at least one champion has a pick rate worth a column. A partially
 * covered roster still shows it: a champion missing one field is a fact about
 * that champion, not about the feed.
 */
export function hasPickRateCoverage(champions: PickRateRecord[]): boolean {
  return champions.some((champion) => typeof champion.pick_rate === "number");
}
