import type { FollowedChampion } from "@/components/member/FollowingCard";
import type { Letter } from "@/lib/score/grade";
import type { ChampionHistory } from "@/lib/score/pack";

/**
 * Members' followed champions: letter, last patch's letter, and the patch
 * alert. The alert needs both a letter change and a win-rate move that passes
 * the movers' noise test (movers.ts), in the same direction: on real data, 38 of 173 champion letters
 * differed between the last 26.18 snapshot and the next day's rows, which
 * cover nearly the same games, so a letter change alone is mostly noise.
 * While this patch's rows predate the patch there is no last-patch letter and
 * no alert.
 */
export function followedChampions(
  champions: { slug: string; name: string; grade: Letter | null; outlined: boolean }[],
  history: Map<string, ChampionHistory> | null,
  movers: { slug: string; delta: number }[],
  predates: boolean,
): FollowedChampion[] {
  const delta = new Map(movers.map((m) => [m.slug, m.delta]));
  const rank = (l: Letter) => ["D", "C", "B", "A", "S"].indexOf(l);
  return champions.map((c) => {
    const previous = predates ? null : (history?.get(c.slug)?.previous?.letter ?? null);
    return {
      slug: c.slug,
      name: c.name,
      grade: c.grade,
      outlined: c.outlined,
      previous,
      // the letter and the win rate must move the same way
      alert:
        previous !== null &&
        c.grade !== null &&
        delta.has(c.slug) &&
        Math.sign(rank(c.grade) - rank(previous)) === Math.sign(delta.get(c.slug)!) &&
        rank(c.grade) !== rank(previous),
    };
  });
}
