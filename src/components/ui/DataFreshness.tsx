import { getTranslations } from "next-intl/server";
import { readPatchClocks } from "@/lib/data/clocks";

/**
 * States the two clocks separately, and says so when the data cannot be proven
 * current. Statistics lagging the live game by a patch is the NORMAL state for
 * this mode, not an error — so it is reported plainly rather than hidden or
 * flattened into a single "current patch" number.
 */
export async function DataFreshness() {
  const t = await getTranslations("freshness");
  const clocks = await readPatchClocks();

  const rows: Array<{ key: string; text: string; warn: boolean }> = [];

  if (clocks.structuralPatch) {
    rows.push({
      key: "structural",
      text: t("structural", { patch: clocks.structuralPatch }),
      warn: false,
    });
  } else {
    rows.push({ key: "structural", text: t("structuralUnproven"), warn: true });
  }

  if (clocks.statisticsPatch) {
    rows.push({
      key: "statistics",
      text: t("statistics", { patch: clocks.statisticsPatch }),
      warn: false,
    });
    if (clocks.structuralPatch && !clocks.aligned) {
      rows.push({
        key: "lag",
        text: t("statisticsBehind", { patch: clocks.structuralPatch }),
        warn: true,
      });
    }
  }

  if (clocks.degraded) {
    rows.push({ key: "degraded", text: t("degraded"), warn: true });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      {rows.map((row) => (
        <span
          key={row.key}
          className={
            row.warn
              ? "rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-amber-200"
              : "rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-card)] px-2 py-0.5 text-[var(--color-text-muted)]"
          }
        >
          {row.text}
        </span>
      ))}
    </div>
  );
}
