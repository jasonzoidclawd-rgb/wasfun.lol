import { getTranslations, getLocale } from "next-intl/server";

export async function MetaAtAGlance({
  sPlusCount,
  championCount,
  liveAugmentCount,
  knownAugmentCount,
  changedAugmentCount,
  structuralPatch,
  statisticsPatch,
  updatedAt,
}: {
  sPlusCount: number;
  championCount: number;
  /** Augments currently offerable in game. */
  liveAugmentCount: number;
  /** Every augment entity we track, including disabled and historical ones. */
  knownAugmentCount: number;
  /** null when no structural diff covers this patch — unknown, not zero. */
  changedAugmentCount: number | null;
  structuralPatch: string | null;
  statisticsPatch: string | null;
  updatedAt: string;
}) {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const updated = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(updatedAt));

  // Two different augment populations used to share the label "Augments" —
  // 268 here and 198 on /augments. Each number now names what it counts.
  const rows: Array<[string, string | number]> = [
    [t("metaSPlus"), sPlusCount],
    [t("metaChampions"), championCount],
    [t("metaAugmentsLive"), liveAugmentCount],
    [t("metaAugmentsKnown"), knownAugmentCount],
    // "0 changed" is a measurement. Without a structural diff we have not
    // measured, so the row reads unknown rather than zero.
    [t("metaChangedAugments"), changedAugmentCount ?? t("metaChangedUnknown")],
    [t("metaPatchStructural"), structuralPatch ?? t("metaPatchUnknown")],
    [t("metaPatchStatistics"), statisticsPatch ?? t("metaPatchUnknown")],
    [t("metaUpdated"), updated],
  ];

  return (
    <div className="glass-card reveal p-4 md:col-span-3 lg:col-span-4">
      <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{t("metaTitle")}</h3>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
            <dd className="mt-0.5 text-sm font-medium text-[var(--color-text-primary)]">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
