"use client";

import { useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { LetterChip } from "@/components/grades/LetterChip";
import type { Letter } from "@/lib/score/grade";
import { RECENT_CHAMPIONS_KEY, readRecentChampions } from "@/lib/recent-champions";

export interface HomeChampion {
  slug: string;
  name: string;
  grade: Letter | null;
  outlined: boolean;
}

function subscribe(onChange: () => void) {
  const handler = (e: StorageEvent) => e.key === RECENT_CHAMPIONS_KEY && onChange();
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

/** Champion search with the visitor's last three champions as chips. */
export function HomeSearch({ champions }: { champions: HomeChampion[] }) {
  const t = useTranslations("home");
  const tl = useTranslations("championsIndex");
  const [query, setQuery] = useState("");
  const recentKey = useSyncExternalStore(subscribe, () => readRecentChampions().join(","), () => "");
  const bySlug = new Map(champions.map((c) => [c.slug, c]));
  const recent = recentKey ? recentKey.split(",").map((s) => bySlug.get(s)).filter((c): c is HomeChampion => !!c) : [];
  const q = query.trim().toLowerCase();
  const matches = q ? champions.filter((c) => c.name.toLowerCase().includes(q) || c.slug.includes(q)).slice(0, 8) : [];
  const chip = (c: HomeChampion) =>
    c.grade ? <LetterChip kind="champion" letter={c.grade} thin={c.outlined} label={tl("letterLabel", { letter: c.grade })} /> : null;

  return (
    <section aria-labelledby="home-search" className="glass-card col-span-full p-4">
      <h1 id="home-search" className="text-xl font-bold">{t("searchTitle")}</h1>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("searchPlaceholder")}
        aria-label={t("searchPlaceholder")}
        className="mt-3 min-h-12 w-full rounded-lg border border-[var(--color-border-hover)] bg-[var(--color-bg-card)] px-3 text-base"
      />
      {q && matches.length === 0 && <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{t("noResults")}</p>}
      {matches.length > 0 && (
        <ul className="mt-2 divide-y divide-[var(--color-border-default)] rounded-lg border border-[var(--color-border-default)]" role="list">
          {matches.map((c) => (
            <li key={c.slug}>
              <Link href={`/champions/${c.slug}`} className="flex min-h-11 items-center gap-3 px-3">
                {chip(c)}
                <span>{c.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {recent.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--color-text-muted)]">{t("recent")}</span>
          {recent.map((c) => (
            <Link
              key={c.slug}
              href={`/champions/${c.slug}`}
              className="flex min-h-11 items-center gap-2 rounded-full border border-[var(--color-border-hover)] px-3 text-sm"
            >
              {chip(c)}
              {c.name}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
