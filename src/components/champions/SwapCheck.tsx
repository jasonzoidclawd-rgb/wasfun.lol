"use client";

/**
 * Swap check (champion select): keep your champion or swap from the bench?
 * Ranks the entered champions by their graded lift against the field and names
 * one only when it beats the next by 0.5 pp with at least 80% certainty; the
 * values are the champions' own win rates, so no champion-specific spread is added.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { LetterChip } from "@/components/grades/LetterChip";
import type { Letter } from "@/lib/score/grade";
import { verdict } from "@/lib/score/verdict";

export interface SwapChampion {
  slug: string;
  name: string;
  letter: Letter;
  outlined: boolean;
  m: number;
  v: number;
}

const MAX = 6;

export function SwapCheck({ champions }: { champions: SwapChampion[] }) {
  const t = useTranslations("swap");
  const tl = useTranslations("championsIndex");
  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const bySlug = new Map(champions.map((c) => [c.slug, c]));
  const q = query.trim().toLowerCase();
  const matches = q ? champions.filter((c) => !chosen.includes(c.slug) && c.name.toLowerCase().includes(q)).slice(0, 6) : [];
  const entered = chosen.map((s) => bySlug.get(s)!).filter(Boolean);
  const v = entered.length >= 2 ? verdict(entered.map((c) => ({ id: c.slug, m: c.m, v: c.v }))) : null;
  const mine = entered[0];
  const answer = !v
    ? null
    : v.closeCall && v.runnerUp
      ? t("closeCall", { a: bySlug.get(v.pick)!.name, b: bySlug.get(v.runnerUp)!.name })
      : v.pick === mine.slug
        ? t("keep", { champion: mine.name })
        : t("swap", { champion: bySlug.get(v.pick)!.name });

  return (
    <section aria-labelledby="swap-check" className="glass-card mb-6 p-4">
      <h2 id="swap-check" className="text-lg font-bold">{t("title")}</h2>
      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{t("lead")}</p>
      {chosen.length < MAX && (
        <div className="relative mt-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("add")}
            aria-label={t("add")}
            className="min-h-11 w-full rounded-lg border border-[var(--color-border-hover)] bg-[var(--color-bg-card)] px-3"
          />
          {matches.length > 0 && (
            <ul className="mt-1 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)]" role="list">
              {matches.map((c) => (
                <li key={c.slug}>
                  <button
                    type="button"
                    className="min-h-11 w-full px-3 text-left"
                    onClick={() => {
                      setChosen([...chosen, c.slug]);
                      setQuery("");
                    }}
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {entered.length > 0 && (
        <ol className="mt-3 flex flex-wrap gap-2" aria-live="polite">
          {entered.map((c) => (
            <li key={c.slug} className={`flex items-center gap-2 rounded-lg border px-2 ${v?.pick === c.slug && !v.closeCall ? "border-[var(--color-text-primary)]" : "border-[var(--color-border-default)]"}`}>
              <LetterChip letter={c.letter} thin={c.outlined} label={tl("letterLabel", { letter: c.letter })} />
              <span>{c.name}</span>
              <button
                type="button"
                aria-label={t("remove", { champion: c.name })}
                className="h-11 w-11 text-[var(--color-text-muted)]"
                onClick={() => setChosen(chosen.filter((s) => s !== c.slug))}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      {answer && <p className="mt-3 rounded-lg border border-[var(--color-border-hover)] p-3 font-semibold">{answer}</p>}
      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">{t("hint")}</p>
    </section>
  );
}
