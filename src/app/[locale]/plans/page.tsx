import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Locale } from "@/i18n/routing";
import { PLAN_FEATURES, planCatalog, type PlanTier } from "@/lib/plans/config";
import { plansEnabled } from "@/lib/plans/flags";
import { languageAlternates, localizedUrl } from "@/lib/site";

// Rendered per request so the flag and prices are read at runtime, not baked in.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "plans" });
  return {
    title: t("title"),
    description: t("lead"),
    alternates: { canonical: localizedUrl("/plans", locale as Locale), languages: languageAlternates("/plans") },
  };
}

/**
 * Plans (v3): Free, Member and VIP. Off unless NEXT_PUBLIC_WASFUN_PLANS is "on"
 * and both paid tiers are priced in the environment. Nothing can be bought
 * here yet: taking payments waits on the owner.
 */
export default async function PlansPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const catalog = planCatalog();
  if (!plansEnabled() || !catalog) notFound();
  const t = await getTranslations("plans");
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: catalog.currency });
  const price = (tier: PlanTier) =>
    tier.monthly === null
      ? t("free")
      : tier.yearly === null
        ? t("perMonth", { price: money.format(tier.monthly) })
        : t("perMonthOrYear", { month: money.format(tier.monthly), year: money.format(tier.yearly) });

  return (
    <div className="mx-auto max-w-5xl py-8">
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-[var(--color-text-secondary)]">{t("lead")}</p>
      <ul className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-3" role="list">
        {catalog.tiers.map((tier) => (
          <li key={tier.id} className="glass-card flex min-w-0 flex-col p-5" data-plan={tier.id}>
            <h2 className="text-xl font-bold">{t(`name_${tier.id}`)}</h2>
            <p className="mt-1 font-semibold">{price(tier)}</p>
            <ul className="mt-4 flex-1 space-y-2 text-sm" role="list">
              {PLAN_FEATURES[tier.id].map((f) => (
                <li key={f}>• {t(`features.${f}`)}</li>
              ))}
            </ul>
            {tier.id !== "free" && (
              <button type="button" disabled className="mt-5 min-h-11 rounded-lg border border-[var(--color-border-hover)] px-4 text-sm text-[var(--color-text-muted)]">
                {t("notOnSale")}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-6 text-xs text-[var(--color-text-muted)]">{t("freeParity")}</p>
    </div>
  );
}
