import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { readPatchClocks } from "@/lib/data/clocks";

export async function Footer() {
  const t = await getTranslations("footer");
  const tc = await getTranslations("common");
  const tn = await getTranslations("nav");
  // A bare "Patch X" in the footer reads as the GAME patch, so it comes from
  // the structural clock — not from meta.json, which is the statistics clock
  // and legitimately trails the live game.
  const { structuralPatch: patch } = await readPatchClocks();
  const year = new Date().getFullYear();

  const columns: Array<{ title: string; links: Array<{ href: string; label: string }> }> = [
    {
      title: t("exploreTitle"),
      links: [
        { href: "/champions", label: tn("champions") },
        { href: "/augments", label: tn("augments") },
        { href: "/patch-notes", label: tn("patchNotes") },
      ],
    },
    {
      title: t("accountTitle"),
      links: [
        { href: "/membership", label: t("membership") },
        { href: "/advisor", label: tn("advisor") },
        { href: "/account", label: t("signIn") },
      ],
    },
    {
      title: t("legalTitle"),
      links: [
        { href: "/about", label: t("about") },
        { href: "/privacy", label: t("privacy") },
        { href: "/terms", label: t("terms") },
        { href: "/contact", label: t("contact") },
      ],
    },
  ];

  return (
    <footer className="mt-12 border-t border-[var(--color-border-default)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          {/* Brand */}
          <div className="col-span-2 sm:col-span-1">
            <div className="flex items-center gap-2 font-bold text-base text-[var(--color-text-primary)]">
              <span className="text-[var(--color-neon-primary)]">⚡</span>
              <span>Mayhem Oracle</span>
            </div>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t("tagline")}</p>
            {patch && (
              <span className="mt-3 inline-block rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-card)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
                {tc("patchLabel", { patch })}
              </span>
            )}
          </div>

          {/* Link columns */}
          {columns.map((col) => (
            <nav key={col.title} aria-label={col.title} className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
                {col.title}
              </h2>
              {col.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-neon-primary)]"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          ))}
        </div>

        {/* Disclaimer row */}
        <div className="mt-10 border-t border-[var(--color-border-default)] pt-6 text-xs text-[var(--color-text-muted)]">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span>{t("copyright", { year })}</span>
            <a
              href="https://arammayhem.com"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[var(--color-neon-primary)]"
            >
              {tc("dataSource")}
            </a>
          </div>
          <p className="mt-3 leading-relaxed text-[var(--color-text-muted)]/80">
            {t("riotDisclaimer")}
          </p>
        </div>
      </div>
    </footer>
  );
}
