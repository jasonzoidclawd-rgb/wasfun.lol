import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { formatPatchDate } from "@/lib/patch-notes/chrome";
import { patchChangeState } from "@/lib/patch-notes/digest";
import {
  normalizeChangeKind,
  normalizePatchObjectType,
} from "@/lib/patch-notes/labels";
import {
  patchNoteAnchor,
  patchNoteSectionAnchor,
} from "@/lib/patch-notes/seo";
import { patchDetailRoute } from "@/lib/patch-notes/routes";
import { describeFreshness } from "@/lib/patch-notes/freshness";
import type {
  PatchChange,
  PatchEntityRef,
  PatchNote,
  PatchSection,
} from "@/lib/types";
import { ChangeBadge } from "./ChangeBadge";

type DataLocale = "en" | "zh-tw" | "zh-cn" | "ja-jp" | "ko-kr";

const LOCALE_CHAIN: Record<string, DataLocale[]> = {
  en: ["en"],
  "zh-CN": ["zh-cn", "en"],
  "zh-TW": ["zh-tw", "zh-cn", "en"],
  ja: ["ja-jp", "en"],
  ko: ["ko-kr", "en"],
};

function pickLocaleText(
  field: PatchChange["text"] | PatchChange["subject"],
  chain: DataLocale[],
): string {
  for (const loc of chain) {
    const v = field[loc];
    if (v) return v;
  }
  return field.en ?? "";
}

export async function PatchCard({
  patch,
  locale,
  isCurrent = false,
  compact = false,
  linkTitle = true,
  explainEmpty = true,
}: {
  patch: PatchNote;
  locale: string;
  isCurrent?: boolean;
  compact?: boolean;
  linkTitle?: boolean;
  /** Off where a summary card above the list already explains the empty body. */
  explainEmpty?: boolean;
}) {
  const t = await getTranslations("patchNotes");
  const chain: DataLocale[] = LOCALE_CHAIN[locale] ?? ["en"];

  return (
    <article id={patchNoteAnchor(patch.version)} className="glass-card overflow-hidden">
      <header className="border-b border-[var(--color-border)] px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold">
            {linkTitle ? (
              <Link
                href={patchDetailRoute(patch.version)}
                className="hover:text-[var(--color-accent)]"
              >
                {t("patchLabel", { patch: patch.version })}
              </Link>
            ) : (
              t("patchLabel", { patch: patch.version })
            )}
          </h2>
          <div className="flex items-center gap-1.5">
            {isCurrent ? (
              <span className="inline-flex items-center rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]">
                {t("currentBadge")}
              </span>
            ) : null}
            {patch.sourceUrl ? (
              <a
                href={patch.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-8 items-center rounded-full border border-[var(--color-border)] px-2 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                {t("riotSourceShort")}
              </a>
            ) : null}
          </div>
        </div>
        {patch.released ? (
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {t("releasedOn", { date: formatPatchDate(patch.released, locale) })}
          </p>
        ) : null}
      </header>

      <div className={compact ? "space-y-4 px-5 py-5" : "space-y-6 px-5 py-5"}>
        {explainEmpty && patch.sections.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            {/* An empty body means one of two different things. Say which. */}
            {patchChangeState(patch) === "no-changes"
              ? t("diffNoChangesBody")
              : t("diffUnavailableBody")}
          </p>
        ) : null}
        {patch.sections.map((section, idx) => (
          <Section
            key={`${section.id}-${idx}`}
            patchVersion={patch.version}
            section={section}
            chain={chain}
            compact={compact}
          />
        ))}
      </div>
    </article>
  );
}

async function Section({
  patchVersion,
  section,
  chain,
  compact,
}: {
  patchVersion: string;
  section: PatchSection;
  chain: DataLocale[];
  compact: boolean;
}) {
  const t = await getTranslations("patchNotes");
  const sectionTitle =
    typeof section.id === "string" && section.id in SECTION_KEYS
      ? t(`sections.${section.id as SectionKey}`)
      : section.title;

  return (
    <section id={patchNoteSectionAnchor(patchVersion, section.id)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent)]">
          {sectionTitle}
        </h3>
        <span className="text-xs text-[var(--color-text-muted)]">
          {section.changes.length}
        </span>
      </div>
      <ul className={compact ? "space-y-2" : "space-y-3"}>
        {section.changes.slice(0, compact ? 12 : undefined).map((change, idx) => (
          <ChangeRow key={idx} change={change} chain={chain} compact={compact} />
        ))}
      </ul>
    </section>
  );
}

const SECTION_KEYS = {
  highlights: true,
  general: true,
  new_items: true,
  augments: true,
  champions: true,
  bugfixes: true,
} as const;

type SectionKey = keyof typeof SECTION_KEYS;

async function ChangeRow({
  change,
  chain,
  compact,
}: {
  change: PatchChange;
  chain: DataLocale[];
  compact: boolean;
}) {
  const t = await getTranslations("patchNotes");
  const subject = pickLocaleText(change.subject, chain);
  const text = pickLocaleText(change.text, chain);
  const normalizedKind = normalizeChangeKind(change.kind);
  const kindLabel = t(`kinds.${normalizedKind}`);
  const targets = change.targets ?? [];
  const related = change.relatedEntities ?? [];
  const metrics = change.metrics ?? [];
  const labels = change.labels ?? [];
  const engineRefs = change.impact?.engineRefs ?? [];
  const freshness = change.detectedAt
    ? describeFreshness("fresh", change.detectedAt)
    : null;
  const typeLabel = (type: string) =>
    t(`objectTypes.${normalizePatchObjectType(type)}`);

  return (
    <li className="rounded-lg border border-[var(--color-border)]/50 bg-[var(--color-bg-card)]/40 px-3 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <ChangeBadge kind={change.kind} label={kindLabel} />
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {subject ? (
              <div className="font-medium text-[var(--color-text-primary)]">
                {subject}
              </div>
            ) : null}
            {change.detail ? (
              <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">
                {change.detail}
              </span>
            ) : null}
            {change.isHotfix ? (
              <span className="rounded border border-amber-400/35 bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-200">
                {t("hotfixBadge")}
              </span>
            ) : null}
            {change.landedFromPbe ? (
              <span className="rounded border border-cyan-400/35 bg-cyan-400/10 px-1.5 py-0.5 text-[11px] font-medium text-cyan-200">
                {t("landedFromPbe")}
              </span>
            ) : null}
            {freshness ? (
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {freshness.state === "today"
                  ? t("freshnessToday")
                  : freshness.state === "days"
                    ? t("freshnessDays", { days: freshness.days ?? 0 })
                    : freshness.state === "stale"
                      ? t("freshnessStale")
                      : t("freshnessUnavailable")}
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[var(--color-text-secondary)]">{text}</div>
        </div>
      </div>

      {targets.length || related.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {targets.map((target) => (
            <EntityChip
              key={`${target.type}-${target.slug}`}
              entity={target}
              chain={chain}
              typeLabel={typeLabel}
            />
          ))}
          {related.slice(0, compact ? 2 : 5).map((entity) => (
            <EntityChip
              key={`rel-${entity.type}-${entity.slug}`}
              entity={entity}
              chain={chain}
              typeLabel={typeLabel}
              muted
            />
          ))}
        </div>
      ) : null}

      {metrics.length ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {metrics.map((metric) => (
            <div
              key={`${metric.label}-${metric.before}-${metric.after}`}
              className="rounded-md border border-[var(--color-border)]/60 bg-[var(--color-bg-primary)]/40 px-3 py-2 text-xs"
            >
              <div className="font-medium text-[var(--color-text-primary)]">
                {metric.label}
              </div>
              <div className="mt-1 text-[var(--color-text-muted)]">
                <span>{metric.before}</span>
                <span className="mx-2 text-[var(--color-accent)]">→</span>
                <span>{metric.after}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!compact && (labels.length || engineRefs.length) ? (
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          {labels.slice(0, 5).map((label) => (
            <span
              key={label}
              className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)]"
            >
              {label}
            </span>
          ))}
          {engineRefs.length ? (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-amber-300">
              {t("modelImpact", { count: engineRefs.length })}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function EntityChip({
  entity,
  chain,
  typeLabel,
  muted = false,
}: {
  entity: PatchEntityRef;
  chain: DataLocale[];
  typeLabel: (type: string) => string;
  muted?: boolean;
}) {
  const className = `inline-flex min-h-8 items-center rounded-full border px-2 text-xs ${
    muted
      ? "border-[var(--color-border)] text-[var(--color-text-muted)]"
      : entity.known
        ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
        : "border-rose-400/30 bg-rose-400/10 text-rose-300"
  }`;
  const label = `${typeLabel(entity.type)}: ${localizedEntityName(entity, chain)}`;

  if (entity.href && entity.known) {
    return (
      <Link href={entity.href} className={className}>
        {label}
      </Link>
    );
  }

  return <span className={className}>{label}</span>;
}

function localizedEntityName(entity: PatchEntityRef, chain: DataLocale[]): string {
  for (const locale of chain) {
    const name = entity.names?.[locale];
    if (name) return name;
  }
  return entity.name;
}
