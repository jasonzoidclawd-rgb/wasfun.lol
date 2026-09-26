"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { usePlan } from "@/lib/plans/usePlan";

/** The one quiet plan line on Home, after the answer: free visitors only, never on Pick. */
export function PlanLine() {
  const t = useTranslations("plans");
  const plan = usePlan();
  if (plan !== "free") return null;
  return (
    <p className="col-span-full text-sm text-[var(--color-text-secondary)]">
      {t("homeLine")}{" "}
      <Link href="/plans" className="underline">
        {t("seePlans")}
      </Link>
    </p>
  );
}
