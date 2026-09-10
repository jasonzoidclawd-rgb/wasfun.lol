import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { readPatchClocks } from "@/lib/data/clocks";

/**
 * "Patch X is live" is a claim about the GAME, so it may only be made from the
 * structural clock (Riot patch notes). It was previously rendered from the
 * statistics scrape, which is how the site announced a four-patch-old release
 * as live for 59 days.
 */
export async function PatchPulseBanner() {
  const t = await getTranslations("dashboard");
  const clocks = await readPatchClocks();

  return (
    <div className="glass-card reveal col-span-full flex flex-wrap items-center gap-3 px-4 py-3">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          clocks.structuralPatch ? "bg-[var(--color-neon-primary)]" : "bg-amber-400"
        }`}
        aria-hidden="true"
      />
      <span className="text-sm font-medium text-[var(--color-text-primary)]">
        {clocks.structuralPatch
          ? t("patchLive", { patch: clocks.structuralPatch })
          : t("patchUnconfirmed")}
      </span>
      <Link
        href="/patch-notes"
        className="ml-auto flex min-h-11 items-center text-sm text-[var(--color-neon-primary)] hover:underline"
      >
        {t("seeWhatChanged")} →
      </Link>
    </div>
  );
}
