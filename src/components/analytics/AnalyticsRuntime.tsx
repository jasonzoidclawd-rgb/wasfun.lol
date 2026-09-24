"use client";

import { useLocale } from "next-intl";
import { usePathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { useAdConsent } from "@/lib/ads/useAdConsent";
import { enableAnalytics, track } from "@/lib/analytics";
import { useEffect, useRef } from "react";

type EntityDetail = {
  kind: "champion" | "augment";
  slug: string;
  event: "champion_open" | "augment_open";
};

function withoutLocale(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length > 0 && routing.locales.includes(parts[0] as (typeof routing.locales)[number])) {
    parts.shift();
  }
  return `/${parts.join("/")}`;
}

function detailFromPath(pathname: string): EntityDetail | null {
  const parts = withoutLocale(pathname).split("/").filter(Boolean);
  if (parts.length !== 2) return null;

  if (parts[0] === "champions") {
    return { kind: "champion", slug: parts[1], event: "champion_open" };
  }
  if (parts[0] === "augments") {
    return { kind: "augment", slug: parts[1], event: "augment_open" };
  }
  return null;
}

function resultCount(dialog: HTMLElement): number {
  const resultsList = Array.from(dialog.children).find((child) =>
    typeof child.className === "string" && child.className.includes("max-h-[46vh]"),
  );
  if (!resultsList) return 0;

  // Search rows contain spans; the localized no-results state is a plain div.
  return Array.from(resultsList.children).filter((child) => child.querySelector("span")).length;
}

function isCommandSearchDialog(dialog: HTMLElement): boolean {
  return Array.from(dialog.querySelectorAll("div")).some(
    (element) => typeof element.className === "string" && element.className.includes("max-h-[46vh]"),
  );
}

function isSameOriginPath(href: string): string | null {
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin ? withoutLocale(url.pathname) : null;
  } catch {
    return null;
  }
}

export function AnalyticsRuntime() {
  const consent = useAdConsent();
  const locale = useLocale();
  const pathname = usePathname();
  const lastPageView = useRef<string | null>(null);
  const trackedEntity = useRef<string | null>(null);

  useEffect(() => {
    if (consent !== "granted") return;

    const pageKey = `${locale}:${pathname}`;
    if (lastPageView.current === pageKey) return;
    lastPageView.current = pageKey;
    enableAnalytics();
    track("page_view");
  }, [consent, locale, pathname]);

  useEffect(() => {
    if (consent !== "granted") return;
    const detail = detailFromPath(pathname);
    if (!detail) return;

    const detailKey = `${locale}:${detail.event}:${detail.slug}`;
    if (trackedEntity.current === detailKey) return;
    let cancelled = false;

    void fetch(`/data/${detail.kind === "champion" ? "champions" : "augments"}.json`, {
      cache: "force-cache",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (cancelled || !payload || typeof payload !== "object") return;
        const rows = (payload as Record<string, unknown>)[detail.kind === "champion" ? "champions" : "augments"];
        if (!Array.isArray(rows) || !rows.some((row) => (
          row && typeof row === "object" && (row as { slug?: unknown }).slug === detail.slug
        ))) {
          return;
        }

        trackedEntity.current = detailKey;
        track(detail.event, { slug: detail.slug });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [consent, locale, pathname]);

  useEffect(() => {
    if (consent !== "granted") return;

    let searchTimer: number | null = null;
    const onInput = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      const dialog = target.closest('[role="dialog"]');
      if (!(dialog instanceof HTMLElement)) return;
      if (!isCommandSearchDialog(dialog)) return;

      if (searchTimer !== null) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        track("entity_search", { result_count: resultCount(dialog) });
      }, 250);
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const path = isSameOriginPath(anchor.href);
      if (!path) return;
      // /companion now redirects to /pick; the overlay CTA is the overlay download
      if (path.startsWith("/api/downloads/overlay")) {
        track("overlay_cta_click");
      } else if (path === "/api/auth/signin") {
        track("signup_start");
      }
    };

    document.addEventListener("input", onInput);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("input", onInput);
      document.removeEventListener("click", onClick, true);
      if (searchTimer !== null) window.clearTimeout(searchTimer);
    };
  }, [consent]);

  return null;
}
