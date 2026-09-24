import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export async function CompanionLauncher() {
  const t = await getTranslations("dashboard");

  return (
    <div className="glass-card reveal col-span-full flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{t("companionTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{t("companionBody")}</p>
      </div>
      <Link
        href="/pick"
        className="flex min-h-11 shrink-0 items-center rounded-lg bg-[var(--color-neon-primary)] px-4 text-sm font-medium text-[var(--color-bg-primary)] transition-opacity hover:opacity-90"
      >
        ⚡ {t("companionCta")}
      </Link>
    </div>
  );
}
