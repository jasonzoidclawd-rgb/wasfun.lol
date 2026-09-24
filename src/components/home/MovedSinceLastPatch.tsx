import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LetterChip } from "@/components/grades/LetterChip";
import type { Mover } from "@/lib/score/movers";
import type { HomeChampion } from "./HomeSearch";

const MAX = 8;

/**
 * Champions whose win rate moved beyond noise since the previous patch. When
 * none pass the test the card says so: that is "no move we can tell from
 * noise yet", not "nothing changed".
 */
export async function MovedSinceLastPatch({
  movers,
  champions,
  patch,
  fromPatch,
}: {
  movers: Mover[];
  champions: Map<string, HomeChampion>;
  patch: string;
  fromPatch: string | null;
}) {
  const t = await getTranslations("home");
  const tl = await getTranslations("championsIndex");
  const shown = movers.filter((m) => champions.has(m.slug)).slice(0, MAX);
  return (
    <section aria-labelledby="home-moved" className="glass-card col-span-full p-4">
      <h2 id="home-moved" className="text-lg font-bold">{t("movedTitle")}</h2>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        {fromPatch ? t("movedLead", { from: fromPatch, patch }) : t("movedNoPrevious", { patch })}
      </p>
      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-text-secondary)]">{t("movedNone")}</p>
      ) : (
        <ol className="mt-3 divide-y divide-[var(--color-border-default)]">
          {shown.map((m) => {
            const c = champions.get(m.slug)!;
            return (
              <li key={m.slug}>
                <Link href={`/champions/${m.slug}`} className="flex min-h-12 items-center gap-3 py-2">
                  {c.grade && <LetterChip kind="champion" letter={c.grade} thin={c.outlined} label={tl("letterLabel", { letter: c.grade })} />}
                  <span className="min-w-0 flex-1 font-semibold">{c.name}</span>
                  <span className="text-sm tabular-nums text-[var(--color-text-secondary)]">
                    {t("movedLine", { from: m.from.toFixed(1), to: m.to.toFixed(1), delta: `${m.delta > 0 ? "+" : "−"}${Math.abs(m.delta).toFixed(1)}` })}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
