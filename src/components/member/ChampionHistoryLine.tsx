import { getTranslations } from "next-intl/server";
import { LetterChip } from "@/components/grades/LetterChip";
import type { ChampionHistory } from "@/lib/score/pack";
import { MemberOnly } from "./MemberOnly";

/**
 * Members: last patch's letter and the rank range among champions, off the
 * clock. Last patch's letter is left out while this patch's rows predate the
 * patch (they would be last patch's totals again, and a letter "change"
 * between them would be noise).
 */
export async function ChampionHistoryLine({
  history,
  total,
  predates,
}: {
  history: ChampionHistory | null;
  total: number;
  predates: boolean;
}) {
  if (!history) return null;
  const t = await getTranslations("member");
  const previous = predates ? null : history.previous;
  if (!previous && !history.rank) return null;
  return (
    <MemberOnly>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-secondary)]">
        {previous && (
          <span className="inline-flex items-center gap-1">
            {t("lastPatch", { patch: previous.patch })}
            <LetterChip kind="champion" letter={previous.letter} thin={previous.outlined} label={t("lastPatchLabel", { patch: previous.patch, letter: previous.letter })} />
          </span>
        )}
        {history.rank && <span>{t("rankRange", { low: history.rank.low, high: history.rank.high, total })}</span>}
      </p>
    </MemberOnly>
  );
}
