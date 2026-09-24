"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { LAST_CHAMPION_KEY } from "./PickScreen";

export function PickChooser({ champions }: { champions: { slug: string; name: string; icon: string | null }[] }) {
  const t = useTranslations("pick");
  const router = useRouter();
  const [query, setQuery] = useState("");

  useEffect(() => {
    // Pick opens on the remembered champion.
    try {
      const last = localStorage.getItem(LAST_CHAMPION_KEY);
      if (last && champions.some((c) => c.slug === last) && !new URLSearchParams(location.search).has("change")) {
        router.replace(`/pick/${last}`);
      }
    } catch {
      // no storage: stay on the chooser
    }
  }, [champions, router]);

  const q = query.trim().toLowerCase();
  const shown = q ? champions.filter((c) => c.name.toLowerCase().includes(q) || c.slug.includes(q)) : champions;
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-bold">{t("chooseTitle")}</h1>
      <p className="mt-1 text-[var(--color-text-secondary)]">{t("chooseLead")}</p>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("searchPlaceholder")}
        aria-label={t("searchPlaceholder")}
        className="mt-4 min-h-11 w-full rounded-lg border border-[var(--color-border-hover)] bg-[var(--color-bg-card)] px-3"
      />
      <ul className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8" role="list">
        {shown.map((c) => (
          <li key={c.slug}>
            <Link href={`/pick/${c.slug}`} className="flex min-h-[88px] flex-col items-center gap-1 rounded-xl p-1.5 text-center">
              {c.icon ? (
                // eslint-disable-next-line @next/next/no-img-element -- build-time local asset
                <img src={c.icon} alt="" width={48} height={48} className="rounded-lg" loading="lazy" />
              ) : (
                <span className="h-12 w-12 rounded-lg bg-[var(--color-bg-elevated)]" aria-hidden="true" />
              )}
              <span className="text-[11px] leading-tight">{c.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
