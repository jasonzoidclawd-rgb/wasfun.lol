import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LetterChip } from "@/components/grades/LetterChip";
import type { Rarity } from "@/lib/score/engine";
import type { PickCard, PickPayload } from "@/lib/score/pick-payload";

const RARITIES: Rarity[] = ["prismatic", "gold", "silver"];

function Art({ src, size = 32 }: { src: string | null; size?: number }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- build-time local asset, fixed size
    <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-md" loading="lazy" />
  ) : (
    <span className="shrink-0 rounded-md bg-[var(--color-bg-elevated)]" style={{ width: size, height: size }} aria-hidden="true" />
  );
}

function signedWhole(x: number): string {
  const r = Math.round(x);
  return r === 0 ? "0" : `${r > 0 ? "+" : "−"}${Math.abs(r)}`;
}

/**
 * The champion page's decision hub (v3): the Plan card, graded augments per
 * rarity, graded boots, build orders ranked by win rate. Out of game, so lifts
 * show as whole points; letters and win rates are labelled across all champions.
 */
export async function ChampionHub({ payload }: { payload: PickPayload }) {
  const t = await getTranslations("hub");
  const tp = await getTranslations("pick");
  const champion = payload.champion.name;
  const rate = (c: PickCard) =>
    c.pick !== null
      ? tp("cardLine", { win: c.winRate.toFixed(1), pick: c.pick.toFixed(1), champion })
      : tp("cardLineUnlisted", { win: c.winRate.toFixed(1), champion });
  const label = (c: PickCard) => (c.outlined ? tp("gradeLabelThin", { letter: c.letter }) : tp("gradeLabel", { letter: c.letter }));

  const plan = RARITIES.map((r) => {
    const set = [...payload.rarities[r]].sort((a, b) => a.order - b.order);
    const top = set[0];
    const picks = top && (top.letter === "S" || top.letter === "A") ? set.filter((c) => c.letter === top.letter && c.plan).slice(0, 4) : [];
    return { r, letter: top?.letter, picks };
  });
  const boots = payload.boots[0];
  const builds = payload.builds;
  const core = builds.length ? [builds[0], ...(builds[1]?.closeCallWithAbove ? [builds[1]] : [])] : [];

  return (
    <div className="space-y-4">
      <section aria-labelledby="hub-plan" className="glass-card p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="hub-plan" className="text-lg font-bold">{t("planTitle")}</h2>
          <span className="text-xs text-[var(--color-text-muted)]">{t("takeOnSight")}</span>
        </div>
        <dl className="space-y-3">
          {plan.map(({ r, letter, picks }) => (
            <div key={r} className="flex min-w-0 gap-3">
              <dt className="w-24 shrink-0 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                {tp(`rarity_${r}`)}
                {picks.length > 0 && letter && (
                  <span className="mt-1 block">
                    <LetterChip letter={letter} label={tp("gradeLabel", { letter })} />
                  </span>
                )}
              </dt>
              <dd className="flex min-w-0 flex-1 flex-wrap gap-3 text-sm">
                {picks.length ? (
                  picks.map((c) => (
                    <span key={c.id} className="flex items-center gap-2">
                      <Art src={c.icon} />
                      {c.name}
                    </span>
                  ))
                ) : (
                  <span className="text-[var(--color-text-secondary)]">{t("noStandout")}</span>
                )}
              </dd>
            </div>
          ))}
          {boots && (
            <div className="flex min-w-0 gap-3">
              <dt className="w-24 shrink-0 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                {t("boots")}
                <span className="mt-1 block">
                  <LetterChip letter={boots.letter} thin={boots.outlined} label={tp("gradeLabelOwn", { letter: boots.letter })} />
                </span>
              </dt>
              <dd className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <Art src={boots.icons[0]} />
                {boots.names[0]}
              </dd>
            </div>
          )}
          {core.length > 0 && (
            <div className="flex min-w-0 gap-3">
              <dt className="w-24 shrink-0 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">{t("core")}</dt>
              <dd className="min-w-0 flex-1 space-y-2 text-sm">
                {core.map((b) => (
                  <div key={b.id}>
                    <div className="font-semibold">{b.names.join(" › ")}</div>
                  </div>
                ))}
                {core.length > 1 && <p className="text-xs text-[var(--color-text-secondary)]">{t("buildsCloseCall")}</p>}
              </dd>
            </div>
          )}
        </dl>
        <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">{t("planNote", { champion })}</p>
      </section>

      <section aria-labelledby="hub-augments" className="glass-card p-4">
        <h2 id="hub-augments" className="text-lg font-bold">{t("augmentsHeading")}</h2>
        {RARITIES.map((r) => (
          <details key={r} open={r === "gold"} className="mt-3">
            <summary className="min-h-11 cursor-pointer py-2 font-semibold">{tp(`rarity_${r}`)}</summary>
            <p className="mb-2 text-xs text-[var(--color-text-muted)]">{t("augmentsLead", { rarity: tp(`rarity_${r}`), champion })}</p>
            <p className="mb-1 text-right text-[11px] text-[var(--color-text-muted)]">{t("liftColumn", { rarity: tp(`rarity_${r}`) })} ↓</p>
            <ol className="divide-y divide-[var(--color-border-default)]">
              {[...payload.rarities[r]]
                .sort((a, b) => a.order - b.order)
                .map((c) => (
                  <li key={c.id} className="flex min-h-12 items-center gap-3 py-2">
                    <Art src={c.icon} />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{c.name}</div>
                      <div className="text-xs text-[var(--color-text-secondary)]">{rate(c)}</div>
                    </div>
                    <span className="w-8 text-right text-sm tabular-nums text-[var(--color-text-secondary)]" title={t("liftColumn", { rarity: tp(`rarity_${r}`) })}>{signedWhole(c.m)}</span>
                    <LetterChip letter={c.letter} thin={c.outlined} label={label(c)} />
                  </li>
                ))}
            </ol>
          </details>
        ))}
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">{tp("legendThin")}</p>
      </section>

      {payload.boots.length > 0 && (
        <section aria-labelledby="hub-boots" className="glass-card p-4">
          <h2 id="hub-boots" className="text-lg font-bold">{t("boots")}</h2>
          <p className="mb-2 text-xs text-[var(--color-text-muted)]">{t("bootsLead", { champion })}</p>
          <ol className="divide-y divide-[var(--color-border-default)]">
            {payload.boots.map((b) => (
              <li key={b.id} className="flex min-h-12 items-center gap-3 py-2">
                <Art src={b.icons[0]} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{b.names[0]}</div>
                  <div className="text-xs text-[var(--color-text-secondary)]">{tp("bootsLine", { win: b.winRate.toFixed(1), pick: b.pickRate.toFixed(1) })}</div>
                </div>
                <LetterChip letter={b.letter} thin={b.outlined} label={tp("gradeLabelOwn", { letter: b.letter })} />
              </li>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="hub-builds" className="glass-card p-4">
        <h2 id="hub-builds" className="text-lg font-bold">{t("buildsHeading")}</h2>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">{t("buildsLead", { champion })}</p>
        {builds.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">{tp("noBuilds")}</p>
        ) : (
          <ol className="divide-y divide-[var(--color-border-default)]">
            {builds.map((b) => (
              <li key={b.id} className="flex gap-3 py-2">
                <span className="w-5 font-bold">{b.rank}</span>
                <div className="min-w-0 flex-1 text-sm">
                  <div>{b.names.join(" › ")}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                    {b.mostBuilt && <span className="rounded border border-[var(--color-border-hover)] px-1">{tp("mostBuilt")}</span>}
                    {b.closeCallWithAbove && (
                      <span className="rounded border border-[var(--color-border-hover)] px-1">{tp("buildCloseCall", { a: b.rank - 1, b: b.rank })}</span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div className="font-bold">{tp("winShort", { win: b.winRate.toFixed(1) })}</div>
                  <div className="text-xs text-[var(--color-text-secondary)]">{tp("pickShort", { pick: b.pickRate.toFixed(1) })}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Link
        href={`/pick/${payload.champion.slug}`}
        className="flex min-h-12 items-center justify-center rounded-xl bg-[var(--color-text-primary)] font-bold text-[var(--color-bg-primary)]"
      >
        {tp("openPick", { champion })}
      </Link>
    </div>
  );
}
