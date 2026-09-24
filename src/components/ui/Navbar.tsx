"use client";

import { useTranslations, useLocale } from "next-intl";
import { useRouter, usePathname, Link } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";
import { CmdKSearch } from "@/components/dashboard/CmdKSearch";

const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  ja: "日本語",
  ko: "한국어",
};

const NAV_ITEMS = [
  { href: "/advisor", key: "advisor" },
  { href: "/champions", key: "champions" },
  { href: "/pick", key: "pick" },
  { href: "/augments", key: "augments" },
  { href: "/items", key: "items" },
  { href: "/damage-sim", key: "damageSim" },
  { href: "/patch-notes", key: "patchNotes" },
] as const;

export function Navbar() {
  const t = useTranslations("nav");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const switchLocale = (newLocale: string) => {
    router.replace(pathname, { locale: newLocale as Locale });
  };

  return (
    <nav className="fixed top-0 inset-x-0 z-50 border-b border-[var(--color-border-default)] bg-[var(--color-bg-primary)]/80 backdrop-blur-lg">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex items-center justify-between h-14">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 font-bold text-lg">
          <span className="text-[var(--color-neon-primary)]">⚡</span>
          <span className="hidden sm:inline">Mayhem Oracle</span>
          <span className="sm:hidden">MO</span>
        </Link>

        {/* Desktop nav links — below lg, MobileTabBar owns route navigation */}
        <div className="hidden lg:flex items-center gap-6 h-full">
          {NAV_ITEMS.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`relative text-sm transition-colors h-full flex items-center
                  ${isActive
                    ? "text-[var(--color-neon-primary)] after:absolute after:bottom-0 after:inset-x-0 after:h-0.5 after:bg-[var(--color-neon-primary)]"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"}`}
              >
                {t(item.key)}
              </Link>
            );
          })}
        </div>

        {/* Search + account + language switcher */}
        <div className="flex items-center gap-3">
          <CmdKSearch />
          <Link
            href="/account"
            aria-label={t("account")}
            title={t("account")}
            className={`hidden h-8 w-8 items-center justify-center rounded-full border transition-colors lg:flex
              ${pathname.startsWith("/account") || pathname.startsWith("/membership")
                ? "border-[var(--color-neon-primary)] text-[var(--color-neon-primary)]"
                : "border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-hover)] hover:text-[var(--color-text-primary)]"}`}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0 1.5c-3 0-6 1.6-6 4.2 0 .5.4.8.9.8h10.2c.5 0 .9-.3.9-.8 0-2.6-3-4.2-6-4.2z" />
            </svg>
          </Link>
          <select
            value={locale}
            onChange={(e) => switchLocale(e.target.value)}
            className="text-xs bg-[var(--color-bg-card)] text-[var(--color-text-secondary)]
                       border border-[var(--color-border-default)] rounded-md px-2 py-1.5
                       hover:border-[var(--color-border-hover)] transition-colors cursor-pointer"
          >
            {routing.locales.map((loc) => (
              <option key={loc} value={loc}>
                {LOCALE_LABELS[loc]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </nav>
  );
}
