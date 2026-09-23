/**
 * Augment-statistics kill switch.
 *
 * One flag removes every augment statistic — win, pick and appearance rates,
 * lifts, and anything graded from them (letters, verdicts, oracle scores) —
 * from pages, static payloads and API responses. Set on the deployment:
 *
 *   WASFUN_AUGMENT_STATS=off   → removed everywhere after the next deploy
 *
 * Fail-safe parsing: only an unset variable or "on" / "1" / "true" leaves the
 * statistics on. Any other value — including typos — turns them off, so a
 * mistyped kill still kills.
 *
 * Every server surface that returns augment statistics must check this, and
 * `scripts/verify_kill_switch.py` crawls a build with the flag off to prove it.
 */

export const AUGMENT_STATS_ENV = "WASFUN_AUGMENT_STATS";

const ON_VALUES = new Set(["", "on", "1", "true"]);

export function augmentStatsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[AUGMENT_STATS_ENV];
  if (raw === undefined) return true;
  return ON_VALUES.has(raw.trim().toLowerCase());
}

/** The response every augment-statistics API returns while the switch is off. */
export function augmentStatsDisabledResponse(): Response {
  return Response.json(
    { error: "augment-stats-unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Remove augment-statistic fields from augment rows. Rows keep their identity
 * and text; only numbers (and grades derived from them) go.
 */
export const AUGMENT_STAT_KEYS = [
  "win_rate",
  "winRate",
  "pick_rate",
  "pickRate",
  "appearanceRate",
  "lift",
  "letter",
  "grade",
  "score",
  "oracleScore",
] as const;

export function stripAugmentStats<T extends object>(row: T): T {
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of AUGMENT_STAT_KEYS) {
    if (key in copy) copy[key] = null;
  }
  return copy as T;
}
