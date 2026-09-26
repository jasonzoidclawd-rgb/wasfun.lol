"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { memberExtrasEnabled, plansEnabled } from "@/lib/plans/flags";
import { usePlan } from "@/lib/plans/usePlan";
import { toggleFollow, useFollowing } from "@/lib/member/local-store";

/**
 * An offline pack: ask for the champion's Pick page as a document, so the
 * service worker keeps it (public/sw.js caches Pick pages it sees).
 */
export function pickPageFor(championPath: string): string | null {
  const pick = championPath.replace(/\/champions\/([^/]+)\/?$/, "/pick/$1");
  return pick === championPath ? null : pick;
}

function cacheOffline(championPath: string): void {
  const pick = pickPageFor(championPath);
  if (!pick || typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return;
  fetch(pick, { credentials: "same-origin", headers: { Accept: "text/html" } }).catch(() => {});
}

/**
 * Follow a champion (members): its letter joins the Home card, with an alert
 * when it moves beyond noise after a patch. For free visitors this is the
 * champion page's one quiet member line, and only while Plans is on.
 */
export function FollowButton({ slug, champion }: { slug: string; champion: string }) {
  const t = useTranslations("member");
  const enabled = memberExtrasEnabled();
  const plan = usePlan(enabled);
  const following = useFollowing();
  const pathname = usePathname();
  if (!enabled || plan === null) return null;
  if (plan === "free") {
    if (!plansEnabled()) return null;
    return (
      <p className="mt-4 text-sm text-[var(--color-text-secondary)]">
        {t("followFree", { champion })}{" "}
        <Link href="/plans" className="underline">
          {t("seePlans")}
        </Link>
      </p>
    );
  }
  const on = following.includes(slug);
  return (
    <button
      type="button"
      onClick={() => {
        if (!on) cacheOffline(pathname);
        toggleFollow(slug);
      }}
      aria-pressed={on}
      className="mt-4 min-h-11 rounded-lg border border-[var(--color-border-hover)] px-4 text-sm font-semibold"
    >
      {on ? t("following", { champion }) : t("follow", { champion })}
    </button>
  );
}
