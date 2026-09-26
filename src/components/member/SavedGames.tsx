"use client";

import { useTranslations } from "next-intl";
import { useSavedGames, useThisGame } from "@/lib/member/local-store";
import { MemberOnly } from "./MemberOnly";

/**
 * Members: games logged with This game on the Pick screen, kept in this
 * browser. Names and letters come from the Pick screen at play time, so this
 * list shows the picks and levels only.
 */
export function SavedGames({ names }: { names: Record<string, string> }) {
  return (
    <MemberOnly>
      <Inner names={names} />
    </MemberOnly>
  );
}

function Inner({ names }: { names: Record<string, string> }) {
  const t = useTranslations("member");
  const saved = useSavedGames();
  const current = useThisGame();
  const games = [...(current && current.screens.length ? [{ ...current, patch: null as string | null, savedAt: null as string | null }] : []), ...saved];
  return (
    <section aria-labelledby="saved-games" className="mt-8">
      <h2 id="saved-games" className="mb-2 text-lg font-bold">
        {t("savedTitle")}
      </h2>
      {games.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">{t("savedEmpty")}</p>
      ) : (
        <ol className="space-y-3">
          {games.map((g, i) => (
            <li key={g.savedAt ?? `current-${i}`} className="rounded-lg border border-[var(--color-border-default)] p-3">
              <div className="text-sm font-semibold">
                {g.savedAt ? t("savedGame", { champion: names[g.champion] ?? g.champion, patch: g.patch ?? "" }) : t("currentGame", { champion: names[g.champion] ?? g.champion })}
              </div>
              <ul className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {g.screens.map((s) => (
                  <li key={s.level}>{t("savedPick", { level: s.level, augment: names[s.taken] ?? s.taken })}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
