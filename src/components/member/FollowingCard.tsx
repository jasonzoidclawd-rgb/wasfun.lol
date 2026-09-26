"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { LetterChip } from "@/components/grades/LetterChip";
import type { Letter } from "@/lib/score/grade";
import { useFollowing } from "@/lib/member/local-store";
import { MemberOnly } from "./MemberOnly";

export interface FollowedChampion {
  slug: string;
  name: string;
  letter: Letter | null;
  outlined: boolean;
  /** last patch's letter, when it can be shown (see ChampionHistoryLine) */
  previous: Letter | null;
  /**
   * the patch alert: the letter differs from last patch's AND the win rate
   * moved beyond Home's noise test. A letter change alone is not enough.
   */
  alert: boolean;
}

/** Members: the champions they follow, with their letters and patch alerts. */
export function FollowingCard({ champions, fromPatch }: { champions: FollowedChampion[]; fromPatch: string | null }) {
  return (
    <MemberOnly>
      <Inner champions={champions} fromPatch={fromPatch} />
    </MemberOnly>
  );
}

function Inner({ champions, fromPatch }: { champions: FollowedChampion[]; fromPatch: string | null }) {
  const t = useTranslations("member");
  const following = useFollowing();
  const bySlug = new Map(champions.map((c) => [c.slug, c]));
  const shown = following.map((s) => bySlug.get(s)).filter((c): c is FollowedChampion => !!c);
  return (
    <section aria-labelledby="home-following" className="col-span-full rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4">
      <h2 id="home-following" className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
        {t("followingTitle")}
      </h2>
      {shown.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">{t("followingEmpty")}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border-default)]">
          {shown.map((c) => (
            <li key={c.slug} className="flex min-h-12 items-center gap-3 py-2">
              <Link href={`/champions/${c.slug}`} className="min-w-0 flex-1 font-semibold hover:underline">
                {c.name}
              </Link>
              {c.alert && c.previous && fromPatch && (
                <span className="text-xs font-semibold" role="status">
                  {t("alertMoved", { patch: fromPatch, from: c.previous })}
                </span>
              )}
              {c.letter && <LetterChip kind="champion" letter={c.letter} thin={c.outlined} label={t("letterLabel", { champion: c.name, letter: c.letter })} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
