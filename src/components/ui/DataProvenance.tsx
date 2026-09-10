import { getTranslations } from "next-intl/server";
import { readFile } from "fs/promises";
import path from "path";

async function getMeta(): Promise<{ patch?: string; scraped_at?: string }> {
  try {
    const raw = await readFile(
      path.join(process.cwd(), "public/data/meta.json"),
      "utf-8",
    );
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Inline provenance line for data pages. The methodology sentence must describe
 * what this page ACTUALLY publishes: the public augment catalog carries no win
 * rates (they are member-only), so the previous claim that "rankings are
 * derived from win-rate data for the current patch" was untrue on both counts.
 */
export async function DataProvenance({ locale }: { locale: string }) {
  const t = await getTranslations("common");
  const { scraped_at } = await getMeta();

  let updated: string | null = null;
  if (scraped_at) {
    const d = new Date(scraped_at);
    if (!Number.isNaN(d.getTime())) {
      updated = new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(d);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-muted)]">
      {updated && (
        <span className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-card)] px-2 py-0.5">
          {t("lastUpdated", { date: updated })}
        </span>
      )}
      <a
        href="https://arammayhem.com"
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-[var(--color-neon-primary)] transition-colors"
      >
        {t("dataSource")}
      </a>
      <span className="basis-full text-[var(--color-text-muted)]/80">
        {t("methodology")}
      </span>
    </div>
  );
}
