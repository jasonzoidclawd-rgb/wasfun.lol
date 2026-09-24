"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname, Link } from "@/i18n/navigation";

const PRIMARY_TABS = [
  { href: "/", glyph: "⌂", key: "tabHome" },
  { href: "/champions", glyph: "▤", key: "tabTiers" },
] as const;

const SECONDARY_TAB = { href: "/augments", glyph: "◆", key: "tabAugments" } as const;

// Routes that don't fit the five-slot tab bar; reachable via the More sheet.
// account is here too since Navbar's account icon is lg:flex-only below lg.
const MORE_LINKS = [
  { href: "/advisor", key: "advisor" },
  { href: "/items", key: "items" },
  { href: "/damage-sim", key: "damageSim" },
  { href: "/patch-notes", key: "patchNotes" },
  { href: "/account", key: "account" },
] as const;

export function MobileTabBar() {
  const t = useTranslations("dashboard");
  const tNav = useTranslations("nav");
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
  const moreActive = MORE_LINKS.some((item) => isActive(item.href));

  return (
    <>
      {moreOpen && (
        <button
          type="button"
          aria-label={t("dismiss")}
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        />
      )}

      {moreOpen && (
        <div
          role="dialog"
          aria-label={t("moreSheetTitle")}
          className="fixed inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-40
                     rounded-t-2xl border-t border-[var(--color-border-default)]
                     bg-[var(--color-bg-card)] p-2 pb-[max(8px,env(safe-area-inset-bottom))] lg:hidden"
        >
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            {t("moreSheetTitle")}
          </div>
          {MORE_LINKS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              onClick={() => setMoreOpen(false)}
              className="flex min-h-11 items-center rounded-lg px-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-card-hover)]"
            >
              {tNav(item.key)}
            </Link>
          ))}
        </div>
      )}

      <nav
        className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-[var(--color-border-default)]
                   bg-[var(--color-bg-primary)]/92 backdrop-blur-lg lg:hidden"
        style={{
          height: "calc(58px + env(safe-area-inset-bottom))",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {PRIMARY_TABS.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={isActive(tab.href) ? "page" : undefined}
            className={`grid min-h-11 place-items-center gap-0.5 text-[10.5px]
              ${isActive(tab.href) ? "text-[var(--color-neon-primary)]" : "text-[var(--color-text-secondary)]"}`}
          >
            <span className="text-lg leading-none" aria-hidden="true">{tab.glyph}</span>
            {t(tab.key)}
          </Link>
        ))}

        <Link
          href="/pick"
          aria-label={t("tabPick")}
          aria-current={isActive("/pick") ? "page" : undefined}
          className="grid h-14 w-14 -translate-y-3 place-items-center self-center rounded-full text-2xl text-[#06121a]
                     bg-[linear-gradient(135deg,var(--color-neon-secondary),var(--color-neon-primary))]
                     shadow-[0_8px_24px_-6px_rgba(0,212,255,0.55)]"
        >
          ⚡
        </Link>

        <Link
          href={SECONDARY_TAB.href}
          aria-current={isActive(SECONDARY_TAB.href) ? "page" : undefined}
          className={`grid min-h-11 place-items-center gap-0.5 text-[10.5px]
            ${isActive(SECONDARY_TAB.href) ? "text-[var(--color-neon-primary)]" : "text-[var(--color-text-secondary)]"}`}
        >
          <span className="text-lg leading-none" aria-hidden="true">{SECONDARY_TAB.glyph}</span>
          {t(SECONDARY_TAB.key)}
        </Link>

        <button
          type="button"
          aria-expanded={moreOpen}
          aria-current={!moreOpen && moreActive ? "page" : undefined}
          onClick={() => setMoreOpen((v) => !v)}
          className={`grid min-h-11 place-items-center gap-0.5 text-[10.5px]
            ${moreActive ? "text-[var(--color-neon-primary)]" : "text-[var(--color-text-secondary)]"}`}
        >
          <span className="text-lg leading-none" aria-hidden="true">☰</span>
          {t("tabMore")}
        </button>
      </nav>
    </>
  );
}
