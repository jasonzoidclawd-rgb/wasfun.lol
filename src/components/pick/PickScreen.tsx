"use client";

/**
 * The Pick screen (v3). Everything it needs is in the payload, so once the page
 * is loaded it works with no network. No ads and no upgrade prompts render
 * here, for anyone: a mis-tap during a death timer costs a real decision.
 */
import { useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { LetterChip } from "@/components/grades/LetterChip";
import type { Rarity } from "@/lib/score/engine";
import type { PickCard, PickPayload } from "@/lib/score/pick-payload";
import { rememberChampion } from "@/lib/recent-champions";
import { memberPickEnabled } from "@/lib/plans/flags";
import { usePlan } from "@/lib/plans/usePlan";
import { initialPickState, pickReducer, readScreen, SCREEN_SIZE } from "@/lib/score/pick-state";
import { bandOf } from "@/lib/score/grade";
import { heldIds, logScreen, newGame, nextLevel, PANDORAS_BOX, seenIds, undoLast } from "@/lib/score/this-game";
import { saveGame, setThisGame, useThisGame } from "@/lib/member/local-store";

const RARITIES: Rarity[] = ["prismatic", "gold", "silver"];
const RARITY_RING: Record<Rarity, string> = {
  prismatic: "border-[var(--color-rarity-prismatic)]",
  gold: "border-[var(--color-rarity-gold)]",
  silver: "border-[var(--color-rarity-silver)]",
};
export const LAST_CHAMPION_KEY = "wasfun:pick:champion";

type Card = PickCard & { rarity: Rarity };

function Icon({ src, rarity, size = 40 }: { src: string | null; rarity?: Rarity; size?: number }) {
  const ring = rarity ? `border-2 ${RARITY_RING[rarity]}` : "border border-[var(--color-border-default)]";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-bg-elevated)] ${ring}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- build-time local asset, fixed size
        <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" />
      ) : (
        <span className="h-3 w-3 rotate-45 rounded-sm bg-[var(--color-text-muted)]" />
      )}
    </span>
  );
}

export function PickScreen({ payload }: { payload: PickPayload }) {
  // Member extras stay off unless their flag is on; the plan is only asked for then.
  const memberExtras = memberPickEnabled();
  const plan = usePlan(memberExtras);
  const member = memberExtras && (plan === "member" || plan === "vip");
  const showOdds = member;
  const t = useTranslations("pick");
  const champion = payload.champion.name;
  const cards = useMemo(() => {
    const map = new Map<string, Card>();
    for (const r of RARITIES) for (const c of payload.rarities[r]) map.set(c.id, { ...c, rarity: r });
    return map;
  }, [payload]);
  const firstRarity = RARITIES.find((r) => payload.rarities[r].length) ?? "gold";
  const [state, dispatch] = useReducer(pickReducer, initialPickState(firstRarity === "prismatic" ? "gold" : firstRarity));
  // This game (members): the log lives in this browser; another champion's log is not this game.
  const stored = useThisGame();
  const game = member && stored?.champion === payload.champion.slug ? stored : null;
  const reading = readScreen(state, cards, payload.meta.tau, game ? { seen: seenIds(game), held: heldIds(game) } : null);
  const takeCard = (id: string) => {
    const current = game ?? newGame(payload.champion.slug);
    // a finished game, or another champion's, is saved before a new one starts
    if (stored && stored !== game) saveGame(stored, payload.meta.patch);
    const logged = logScreen(current, {
      rarity: cards.get(id)!.rarity,
      onScreen: state.slots.map((s) => s.id),
      rerolledAway: state.rerolledAway,
      taken: id,
    });
    if (logged === current) return;
    setThisGame(logged);
    dispatch({ type: "clear" });
  };
  const startNewGame = () => {
    if (game) saveGame(game, payload.meta.patch);
    setThisGame(null);
    dispatch({ type: "clear" });
  };

  // No ads on the Pick screen, for anyone. The page renders no ad slot, but the
  // AdSense script can survive a client-side navigation from a page that had
  // one, and auto ads would then inject units here: remove any that appear.
  useEffect(() => {
    const AD = "ins.adsbygoogle, .google-auto-placed, iframe[id^='aswift_'], [data-ad-slot]";
    const sweep = () => document.querySelectorAll(AD).forEach((node) => node.remove());
    sweep();
    const observer = new MutationObserver(sweep);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LAST_CHAMPION_KEY, payload.champion.slug);
      rememberChampion(payload.champion.slug);
    } catch {
      // private mode: the screen still works, it just won't reopen here
    }
  }, [payload.champion.slug]);

  // Offline: a champion opened from the chooser arrives by client-side
  // navigation, which the service worker does not cache as a page. Ask for this
  // page as a document once, so the worker keeps its HTML for the next visit.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return;
    // a page loaded as a document was cached by that load already
    const landing = performance.getEntriesByType?.("navigation")[0]?.name;
    if (landing && new URL(landing).pathname === window.location.pathname) return;
    fetch(window.location.pathname, { credentials: "same-origin", headers: { Accept: "text/html" } }).catch(() => {});
  }, [payload.champion.slug]);

  const rateLine = (c: Card) =>
    c.pick !== null
      ? t("cardLine", { win: c.winRate.toFixed(1), pick: c.pick.toFixed(1), champion })
      : t("cardLineUnlisted", { win: c.winRate.toFixed(1), champion });
  const chipLabel = (c: Card) => (c.outlined ? t("gradeLabelThin", { letter: c.letter }) : t("gradeLabel", { letter: c.letter }));
  const named = reading?.verdict ?? null;
  const ordered = named ? [...state.slots].sort((a, b) => (a.id === named.pick ? -1 : b.id === named.pick ? 1 : 0)) : state.slots;

  const takePanel = (
    <section aria-labelledby="pick-take" className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4">
      <h2 id="pick-take" className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
        {t("take")}
      </h2>
      {state.slots.length === 0 && <p className="text-sm text-[var(--color-text-secondary)]">{t("emptyScreen")}</p>}
      <ol className="space-y-3" aria-live="polite">
        {ordered.map((slot) => {
          const c = cards.get(slot.id)!;
          const index = state.slots.findIndex((s) => s.id === slot.id);
          // a close call names no winner, so no card is enlarged
          const isPick = named !== null && !named.closeCall && named.pick === c.id;
          const pending = state.pendingReroll === index;
          return (
            <li key={slot.id} className={`flex items-center gap-3 ${isPick ? "" : "border-t border-[var(--color-border-default)] pt-3"}`}>
              <Icon src={c.icon} rarity={c.rarity} size={isPick ? 52 : 36} />
              <div className="min-w-0 flex-1">
                <div className={`font-bold leading-tight ${isPick ? "text-2xl" : "text-base"}`}>{c.name}</div>
                <div className="mt-1 flex items-center gap-2">
                  <LetterChip letter={c.letter} thin={c.outlined} label={chipLabel(c)} />
                  <span className="text-xs text-[var(--color-text-secondary)]">{rateLine(c)}</span>
                </div>
                {c.gamble && <span className="mt-1 inline-block text-[11px] uppercase text-[var(--color-text-muted)]">{t("gamble")}</span>}
                {c.id === PANDORAS_BOX &&
                  (reading?.pandorasBox ? (
                    <div className="mt-1 flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                      <LetterChip
                        letter={bandOf(reading.pandorasBox.m)}
                        thin
                        label={t("pandoraForGameLabel", { letter: bandOf(reading.pandorasBox.m) })}
                      />
                      <span>{t("pandoraForGame")}</span>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{t("pandoraDepends")}</p>
                  ))}
                {member && state.slots.length === SCREEN_SIZE && nextLevel(game ?? newGame(payload.champion.slug)) !== null && (
                  <button
                    type="button"
                    onClick={() => takeCard(c.id)}
                    className="mt-1 min-h-11 rounded-lg border border-[var(--color-border-hover)] px-3 text-sm font-semibold"
                  >
                    {t("tookThis")}
                  </button>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-center gap-1 text-right">
                {pending && <span className="text-[11px] text-[var(--color-neon-primary)]">{t("rerollPending")}</span>}
                {!slot.rerolled && reading?.reroll[c.id] && !pending && (
                  <span className="text-[11px] leading-tight text-[var(--color-text-secondary)]">
                    <b className="text-[var(--color-text-primary)]">{t("reroll")}</b>
                    <br />
                    {t("usuallyHelps")}
                  </span>
                )}
                {slot.rerolled ? (
                  <span className="text-[11px] text-[var(--color-text-muted)]">{t("noRerollLeft")}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "tapReroll", slot: index })}
                    aria-pressed={pending}
                    aria-label={t("rerollCard", { card: c.name })}
                    className={`h-11 w-11 rounded-lg border text-lg ${pending ? "border-[var(--color-neon-primary)]" : "border-[var(--color-border-hover)]"}`}
                  >
                    ↻
                  </button>
                )}
                {showOdds && reading && reading.odds[c.id] != null && (
                  <span className="text-[11px] text-[var(--color-text-secondary)]">
                    {t("oddsBetter", { pct: Math.round((reading.odds[c.id] as number) * 100) })}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {state.slots.length > 0 && state.slots.length < SCREEN_SIZE && (
        <p className="mt-3 text-sm text-[var(--color-text-secondary)]">{t("moreToTap", { count: SCREEN_SIZE - state.slots.length })}</p>
      )}
      {named?.closeCall && named.runnerUp && (
        <p className="mt-3 rounded-lg border border-[var(--color-border-hover)] p-3 text-sm font-semibold">
          {t("closeCall", { a: cards.get(named.pick)!.name, b: cards.get(named.runnerUp)!.name })}
        </p>
      )}
      {reading?.mixedRarities && (
        <p className="mt-3 rounded-lg border border-[var(--color-border-hover)] p-3 text-sm">{t("mixedRarities")}</p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--color-text-secondary)]">
        <span>{t("rerolledHint")}</span>
        <button type="button" onClick={() => dispatch({ type: "clear" })} className="min-h-11 px-2 underline">
          {t("clear")}
        </button>
      </div>
    </section>
  );

  const thisGame = member ? (
    <section aria-labelledby="pick-this-game" className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 id="pick-this-game" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
          {t("thisGame")}
        </h2>
        <span className="text-xs text-[var(--color-text-muted)]">
          {game && nextLevel(game) === null ? t("thisGameDone") : t("thisGameNext", { level: nextLevel(game ?? newGame("")) as number })}
        </span>
      </div>
      {!game || game.screens.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">{t("thisGameEmpty")}</p>
      ) : (
        <ol className="space-y-2">
          {game.screens.map((screen) => {
            const c = cards.get(screen.taken);
            return (
              <li key={screen.level} className="flex items-center gap-3">
                <span className="w-10 shrink-0 text-xs text-[var(--color-text-muted)]">{t("level", { level: screen.level })}</span>
                <Icon src={c?.icon ?? null} rarity={screen.rarity} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{c?.name ?? screen.taken}</div>
                  {c && <div className="text-xs text-[var(--color-text-secondary)]">{t("thisGameLine", { win: c.winRate.toFixed(1), offered: screen.offered.length })}</div>}
                </div>
                {c && <LetterChip letter={c.letter} thin={c.outlined} label={chipLabel(c)} />}
              </li>
            );
          })}
        </ol>
      )}
      <div className="mt-3 flex justify-end gap-3 text-xs">
        {game && game.screens.length > 0 && (
          <button type="button" onClick={() => setThisGame(undoLast(game))} className="min-h-11 px-2 underline">
            {t("undoLast")}
          </button>
        )}
        <button type="button" onClick={startNewGame} className="min-h-11 px-2 underline">
          {t("newGame")}
        </button>
      </div>
    </section>
  ) : null;

  const grid = (
    <section aria-labelledby="pick-grid" className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="pick-grid" className="text-lg font-bold">{t("tapPrompt")}</h2>
        <span className="text-xs text-[var(--color-text-muted)]">{t("fixedOrder")}</span>
      </div>
      <div role="tablist" className="mb-3 flex border-b border-[var(--color-border-default)]">
        {RARITIES.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            id={`pick-tab-${r}`}
            aria-controls="pick-grid"
            aria-selected={state.rarity === r}
            onClick={() => dispatch({ type: "tab", rarity: r })}
            className={`min-h-11 px-4 font-semibold ${state.rarity === r ? "border-b-2 border-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}
          >
            {t(`rarity_${r}`)}
          </button>
        ))}
      </div>
      <ul
        id="pick-grid"
        role="tabpanel"
        aria-labelledby={`pick-tab-${state.rarity}`}
        className="grid grid-cols-[repeat(4,minmax(0,1fr))] gap-2 sm:grid-cols-[repeat(6,minmax(0,1fr))]"
      >
        {payload.rarities[state.rarity].map((c) => {
          const card = cards.get(c.id)!;
          const selected = state.slots.some((s) => s.id === c.id);
          return (
            <li key={c.id} className="min-w-0">
              <button
                type="button"
                onClick={() => dispatch({ type: "tapCard", id: c.id })}
                aria-pressed={selected}
                className={`relative flex min-h-[88px] w-full flex-col items-center gap-1 rounded-xl p-1.5 text-center ${selected ? "outline outline-2 outline-[var(--color-text-primary)]" : ""}`}
              >
                <span className="relative">
                  <Icon src={c.icon} rarity={card.rarity} size={48} />
                  <span className="absolute -bottom-2 -right-3 scale-75">
                    <LetterChip letter={c.letter} thin={c.outlined} label={chipLabel(card)} />
                  </span>
                </span>
                <span className="mt-1 line-clamp-2 text-[11px] leading-tight">{c.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11px] leading-snug text-[var(--color-text-muted)]">
        {t("legendSource", { champion })} {t("legendThin")}
      </p>
    </section>
  );

  const bestBoots = payload.boots[0];
  const items = (
    <section aria-labelledby="pick-items" className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4">
      <h2 id="pick-items" className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">{t("items")}</h2>
      {bestBoots && (
        <div className="mb-3 flex items-center gap-3">
          <Icon src={bestBoots.icons[0]} size={32} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{bestBoots.names[0]}</div>
            <div className="text-xs text-[var(--color-text-secondary)]">
              {t("bootsLine", { win: bestBoots.winRate.toFixed(1), pick: bestBoots.pickRate.toFixed(1) })}
            </div>
          </div>
          <LetterChip letter={bestBoots.letter} thin={bestBoots.outlined} label={t("gradeLabelOwn", { letter: bestBoots.letter })} />
        </div>
      )}
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">{t("buildOrderHeading")}</h3>
      {payload.builds.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">{t("noBuilds")}</p>
      ) : (
        <ol className="divide-y divide-[var(--color-border-default)]">
          {payload.builds.slice(0, 3).map((b) => (
            <li key={b.id} className="flex gap-3 py-2">
              <span className="w-5 text-lg font-bold">{b.rank}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1" aria-hidden="true">
                  {b.icons.map((src, i) => (
                    <span key={i} className="flex items-center gap-1">
                      {i > 0 && <span className="text-[var(--color-text-muted)]">›</span>}
                      <Icon src={src} size={24} />
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-sm">{b.names.join(" › ")}</div>
                {b.mostBuilt && <span className="mt-1 inline-block rounded border border-[var(--color-border-hover)] px-1 text-[11px]">{t("mostBuilt")}</span>}
              </div>
              <div className="shrink-0 text-right text-sm">
                <div className="font-bold">{t("winShort", { win: b.winRate.toFixed(1) })}</div>
                <div className="text-xs text-[var(--color-text-secondary)]">{t("pickShort", { pick: b.pickRate.toFixed(1) })}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {payload.builds.slice(1, 3).map((b) =>
        b.closeCallWithAbove ? (
          <p key={b.id} className="mt-2 rounded-lg border border-[var(--color-border-hover)] p-2 text-sm font-semibold">
            {t("buildCloseCall", { a: b.rank - 1, b: b.rank })}
          </p>
        ) : null,
      )}
      <p className="mt-2 text-[11px] leading-snug text-[var(--color-text-muted)]">{t("buildCaveat", { champion })}</p>
    </section>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 pb-8 pt-4" data-pick-screen>
      <header className="mb-4 flex items-center gap-3">
        <Icon src={payload.champion.icon} size={48} />
        <div>
          <h1 className="text-2xl font-bold">{champion}</h1>
          <Link href="/pick?change=1" className="inline-flex min-h-11 items-center text-sm text-[var(--color-text-secondary)] underline">
            {t("notChampion", { champion })}
          </Link>
        </div>
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="order-2 min-w-0 lg:order-1">{grid}</div>
        <div className="order-1 min-w-0 space-y-4 lg:order-2">
          {takePanel}
          {thisGame}
          <div className="hidden lg:block">{items}</div>
        </div>
        <div className="order-3 min-w-0 lg:hidden">{items}</div>
      </div>
      <FreshnessLine patch={payload.meta.patch} dataDate={payload.meta.dataDate} provider={payload.meta.provider} />
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t("noAds")}</p>
    </div>
  );
}

const STALE_MS = 48 * 60 * 60 * 1000;
const noSubscribe = () => () => {};

/** "Patch 26.19 · updated Sep 21 · CN Mayhem aggregate via …"; a warning past 48 hours. */
function FreshnessLine({ patch, dataDate, provider }: { patch: string; dataDate: string; provider: string }) {
  const t = useTranslations("pick");
  const locale = useLocale();
  // Computed on the client (the page is static): stale once the data is 48 h old.
  const stale = useSyncExternalStore(
    noSubscribe,
    () => Date.now() - Date.parse(`${dataDate}T23:59:59Z`) > STALE_MS,
    () => false,
  );
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${dataDate}T12:00:00Z`));
  return (
    <p className={`mt-4 text-xs ${stale ? "font-semibold text-amber-300" : "text-[var(--color-text-muted)]"}`} role={stale ? "status" : undefined}>
      {stale ? "⚠ " : ""}
      {t("freshness", { patch, date, provider })}
      {stale ? ` · ${t("staleWarning")}` : ""}
    </p>
  );
}
