/**
 * Pick rate is published by the statistics source only when the source has it.
 * As of 2026-09-10 arammayhem.com stopped publishing champion pick rate
 * entirely, so every row carries null — and the UI kept a Pick% column, an
 * "and pick rates" meta description, and a "— pick" stat on the homepage, all
 * of which promise a number the site does not have.
 *
 * Coverage is measured, never assumed, so these surfaces disappear at zero and
 * come back on their own the moment the source publishes pick rate again. A
 * partially covered roster still shows the column: a champion missing one field
 * is a fact about that champion, not about the feed.
 */

export interface PickRateRecord {
  pick_rate?: number | null;
}

export function pickRateCoverage(champions: PickRateRecord[]): number {
  if (champions.length === 0) return 0;
  const covered = champions.filter(
    (champion) => typeof champion.pick_rate === "number",
  ).length;
  return covered / champions.length;
}

/** True when at least one champion has a pick rate worth a column. */
export function hasPickRateCoverage(champions: PickRateRecord[]): boolean {
  return champions.some((champion) => typeof champion.pick_rate === "number");
}
