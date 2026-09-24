import Image from "next/image";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import { Link } from "@/i18n/navigation";
import { Tooltip } from "@/components/ui/Tooltip";

export type PoolLayer = {
  key: string;
  label: string;
  detail: string;
  kept: number;
  removed: number;
};

export type PoolProfileChip = {
  label: string;
  value: string;
};

export type PoolRaritySummary = {
  key: "silver" | "gold" | "prismatic";
  label: string;
  count: number;
};

export type TailoredHighlight = {
  aug: {
    slug: string;
    name: string;
    icon: string;
    rarity: "silver" | "gold" | "prismatic";
    description?: string;
    wikiDescription?: string;
    kit_tags?: string[];
  };
  score: number;
};

type GateCopy = {
  title: string;
  description: string;
  signIn: string;
};

type PoolConstructionSectionProps = {
  title: string;
  subtitle: string;
  rarityTitle: string;
  filterTitle: string;
  highlightsTitle: string;
  keptLabel: (count: number) => string;
  removedLabel: (count: number) => string;
  profileChips: PoolProfileChip[];
  raritySummary: PoolRaritySummary[];
  layers: PoolLayer[];
  highlights: TailoredHighlight[];
  totalAugments: number;
  gated?: boolean;
  signInUrl?: string;
  signInNextPath?: string;
  gateCopy?: GateCopy;
};

const RARITY_BAR_STYLES: Record<PoolRaritySummary["key"], string> = {
  prismatic: "bg-purple-400",
  gold:      "bg-yellow-400",
  silver:    "bg-slate-400",
};

const RARITY_DOT_STYLES: Record<PoolRaritySummary["key"], string> = {
  prismatic: "bg-purple-400",
  gold:      "bg-yellow-400",
  silver:    "bg-slate-400",
};

function scoreColor(score: number) {
  if (score >= 80) return "text-amber-300";
  if (score >= 70) return "text-yellow-400";
  if (score >= 60) return "text-green-400";
  return "text-slate-400";
}

export function PoolConstructionSection({
  title,
  subtitle,
  rarityTitle,
  filterTitle,
  highlightsTitle,
  keptLabel,
  removedLabel,
  profileChips,
  raritySummary,
  layers,
  highlights,
  totalAugments,
  gated = false,
  signInUrl = "/account",
  signInNextPath,
  gateCopy,
}: PoolConstructionSectionProps) {
  return (
    <section className="glass-card p-4 mb-3 sm:mb-6">
      <h2 className="text-sm font-bold mb-1 border-l-2 border-[var(--color-neon-primary)] pl-2">
        {title}
      </h2>
      <p className="text-[10px] text-[var(--color-text-muted)] mb-3 pl-3">
        {subtitle}
      </p>

      {/* Profile chips — always visible */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {profileChips.map((chip) => (
          <div key={chip.label} className="min-w-0 rounded-lg border border-[var(--color-border-default)]/60 px-2 py-2 bg-[var(--color-bg-card)]/40">
            <div className="text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]">
              {chip.label}
            </div>
            <div className="text-xs font-semibold text-[var(--color-text-primary)] truncate">
              {chip.value}
            </div>
          </div>
        ))}
      </div>

      {/* Rarity summary — always visible; filter + highlights gated */}
      {gated ? (
        <div>
          {/* Rarity bars teaser */}
          <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">
            {rarityTitle}
          </h3>
          <div className="space-y-2 mb-4">
            {raritySummary.map((rarity) => {
              const pct = totalAugments > 0 ? Math.round((rarity.count / totalAugments) * 100) : 0;
              return (
                <div key={rarity.key}>
                  <div className="flex items-center justify-between gap-2 mb-1 text-[10px]">
                    <span className="text-[var(--color-text-secondary)]">{rarity.label}</span>
                    <span className="font-semibold text-[var(--color-text-primary)]">{rarity.count}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--color-border-default)]/40 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${RARITY_BAR_STYLES[rarity.key]}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Gate overlay covering filter stack + highlights */}
          <div className="relative rounded-lg overflow-hidden">
            <div className="blur-sm pointer-events-none select-none opacity-40" aria-hidden>
              <div className="grid gap-4 sm:grid-cols-[0.8fr_1.2fr] mb-4">
                <div>
                  <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">{filterTitle}</h3>
                  <div className="space-y-1">
                    {layers.map((layer) => (
                      <div key={layer.key} className="flex items-center gap-2 rounded-lg border border-[var(--color-border-default)]/50 px-2 py-1.5 h-8" />
                    ))}
                  </div>
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">{highlightsTitle}</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {[...Array(6)].map((_, i) => (
                      <div key={i} className="h-8 rounded-lg border border-[var(--color-border-default)]/50" />
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg-card)]/70 backdrop-blur-[2px] rounded-lg p-6 text-center">
              <svg className="w-5 h-5 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
              {gateCopy && (
                <>
                  <p className="text-sm font-semibold text-[var(--color-text-primary)]">{gateCopy.title}</p>
                  <p className="text-xs text-[var(--color-text-muted)] max-w-xs">{gateCopy.description}</p>
                  {signInNextPath ? (
                    <GoogleSignInButton
                      next={signInNextPath}
                      label={gateCopy.signIn}
                      size="medium"
                    />
                  ) : (
                    <Link
                      href={signInUrl}
                      className="mt-1 inline-flex items-center gap-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] px-4 py-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                    >
                      {gateCopy.signIn}
                    </Link>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
        <div className="grid gap-4 sm:grid-cols-[0.8fr_1.2fr] mb-4">
        <div>
          <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">
            {rarityTitle}
          </h3>
          <div className="space-y-2">
            {raritySummary.map((rarity) => {
              const pct = totalAugments > 0 ? Math.round((rarity.count / totalAugments) * 100) : 0;
              return (
                <div key={rarity.key}>
                  <div className="flex items-center justify-between gap-2 mb-1 text-[10px]">
                    <span className="text-[var(--color-text-secondary)]">{rarity.label}</span>
                    <span className="font-semibold text-[var(--color-text-primary)]">{rarity.count}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--color-border-default)]/40 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${RARITY_BAR_STYLES[rarity.key]}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">
            {filterTitle}
          </h3>
          <div className="space-y-1">
            {layers.map((layer) => (
              <div key={layer.key} className="flex items-center gap-2 rounded-lg border border-[var(--color-border-default)]/50 px-2 py-1.5">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-[var(--color-text-primary)] truncate">
                    {layer.label}
                  </div>
                  <div className="text-[9px] text-[var(--color-text-muted)] truncate">
                    {layer.detail}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10px] font-semibold text-[var(--color-text-primary)]">
                    {keptLabel(layer.kept)}
                  </div>
                  <div className="text-[9px] text-red-300/80">
                    {removedLabel(layer.removed)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {highlights.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">
            {highlightsTitle}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {highlights.map(({ aug, score }) => (
              <Tooltip key={aug.slug} content={aug.wikiDescription ?? aug.description}>
                <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border-default)]/50 px-2 py-1.5 cursor-default">
                  <div className="relative w-6 h-6 rounded shrink-0">
                    <Image
                      src={aug.icon}
                      alt={aug.name}
                      fill
                      className="object-contain"
                      sizes="24px"
                      unoptimized
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate">{aug.name}</span>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${RARITY_DOT_STYLES[aug.rarity]}`} />
                    </div>
                    {(aug.kit_tags ?? []).length > 0 && (
                      <div className="text-[9px] text-[var(--color-text-muted)] truncate">
                        {(aug.kit_tags ?? []).join(", ")}
                      </div>
                    )}
                  </div>
                  <span className={`text-sm font-bold w-10 text-right shrink-0 ${scoreColor(score)}`}>
                    {Math.round(score)}
                  </span>
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      )}
        </>
      )}
    </section>
  );
}
