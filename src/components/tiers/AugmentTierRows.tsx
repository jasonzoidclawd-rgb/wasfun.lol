import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LetterChip } from "@/components/grades/LetterChip";
import type { GradedOption } from "@/lib/score/engine";
import type { RankRange } from "@/lib/score/rank-range";
import { MemberOnly } from "@/components/member/MemberOnly";

export interface TierRow extends Pick<GradedOption, "id" | "letter" | "outlined" | "m" | "winRate" | "pickRate" | "order"> {
  name: string;
  slug: string | null;
  icon: string | null;
  /** members: rank range within the rarity (only present when member extras are on) */
  rank?: RankRange | null;
}

function signedWhole(x: number): string {
  const r = Math.round(x);
  return r === 0 ? "0" : `${r > 0 ? "+" : "−"}${Math.abs(r)}`;
}

/** Graded augment rows (across all champions): icon, name, rates, whole-point lift, letter. */
export async function AugmentTierRows({ rows }: { rows: TierRow[] }) {
  const t = await getTranslations("tiers");
  const tp = await getTranslations("pick");
  const tm = await getTranslations("member");
  return (
    <>
    <div className="flex justify-end gap-3 pb-1 text-[11px] text-[var(--color-text-muted)]" aria-hidden="true">
      <span>{t("colVsAverage")}</span>
      <span className="w-7" />
    </div>
    <ol className="divide-y divide-[var(--color-border-default)]">
      {rows.map((r) => {
        const name = r.slug ? (
          <Link href={`/augments/${r.slug}`} className="inline-flex min-h-11 items-center font-semibold hover:underline">
            {r.name}
          </Link>
        ) : (
          <span className="font-semibold">{r.name}</span>
        );
        return (
          <li key={r.id} className="flex min-h-12 items-center gap-3 py-2">
            {r.icon ? (
              // eslint-disable-next-line @next/next/no-img-element -- build-time local asset, fixed size
              <img src={r.icon} alt="" width={32} height={32} className="shrink-0 rounded-md" loading="lazy" />
            ) : (
              <span className="h-8 w-8 shrink-0 rounded-md bg-[var(--color-bg-elevated)]" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              {name}
              <div className="text-xs text-[var(--color-text-secondary)]">
                {t("rowLine", { win: r.winRate.toFixed(1), pick: r.pickRate.toFixed(1) })}
                {r.rank && (
                  <MemberOnly>
                    {" · "}
                    {tm("rankRange", { low: r.rank.low, high: r.rank.high, total: rows.length })}
                  </MemberOnly>
                )}
              </div>
            </div>
            <span
              className="w-8 shrink-0 text-right text-sm tabular-nums text-[var(--color-text-secondary)]"
              aria-label={`${t("colVsAverage")}: ${signedWhole(r.m)}`}
            >
              {signedWhole(r.m)}
            </span>
            <LetterChip
              letter={r.letter}
              thin={r.outlined}
              label={r.outlined ? tp("gradeLabelThin", { letter: r.letter }) : tp("gradeLabel", { letter: r.letter })}
            />
          </li>
        );
      })}
    </ol>
    </>
  );
}
