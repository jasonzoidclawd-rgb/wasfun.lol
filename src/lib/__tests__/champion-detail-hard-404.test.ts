import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Regression: unknown champion slugs returned HTTP 200 (a soft 404) while
 * /augments/<unknown> and /items/<unknown> returned a hard 404.
 *
 * Two independent causes, both covered here:
 *
 * 1. The page read the entitlement (and therefore cookies) BEFORE deciding
 *    whether the champion existed, so a nonexistent slug performed auth work
 *    and the 404 depended on session state.
 * 2. `champions/loading.tsx` put a Suspense boundary ABOVE the detail page.
 *    Because the route renders dynamically (the entitlement read opts it out
 *    of prerendering, so `dynamicParams = false` is never enforced at the
 *    routing layer the way it is for augments/items), the loading shell was
 *    streamed — committing HTTP 200 — before `notFound()` resolved. The
 *    response carried the skeleton AND the not-found body under a 200.
 */

const ROOT = process.cwd();

const entitlementCalls = vi.fn();

vi.mock("@/lib/entitlements/server", () => ({
  requireActiveEntitlement: async (...args: unknown[]) => {
    entitlementCalls(...args);
    return { ok: false as const, status: 401 as const, reason: "unauthenticated" };
  },
}));

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => {},
  getTranslations: async () => (key: string) => key,
}));

// The page's component graph reaches next-intl's client navigation, whose
// `next/navigation` import does not resolve under the node test environment.
// Only <Link> is used, and this suite asserts control flow, not markup.
vi.mock("@/i18n/navigation", () => ({
  Link: "a",
  redirect: () => {},
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  getPathname: () => "/",
}));

async function renderChampionPage(slug: string) {
  const { default: ChampionPage } = await import(
    "@/app/[locale]/champions/[slug]/page"
  );
  return ChampionPage({ params: Promise.resolve({ locale: "en", slug }) });
}

function isNotFoundError(error: unknown): boolean {
  const digest = (error as { digest?: string })?.digest ?? "";
  return typeof digest === "string" && digest.includes("404");
}

describe("champion detail resolves existence before request-scoped work", () => {
  beforeEach(() => {
    entitlementCalls.mockClear();
    // The page skips the gate entirely when Supabase is unconfigured. Without
    // these the "not called" assertion below would hold no matter what order
    // the page used, so the regression would pass unnoticed.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("an unknown slug triggers notFound() without any entitlement read", async () => {
    await expect(renderChampionPage("zzz-not-real")).rejects.toSatisfy(
      isNotFoundError,
    );

    expect(entitlementCalls).not.toHaveBeenCalled();
  });

  test("a known slug still renders and still consults the entitlement gate", async () => {
    const element = await renderChampionPage("locke");

    expect(element).toBeTruthy();
    expect(entitlementCalls).toHaveBeenCalledTimes(1);
  });
});

describe("no streaming boundary sits above the champion detail route", () => {
  /**
   * Every segment directory on the way to the detail page. A `loading.tsx` in
   * any of them wraps the page in Suspense, which flushes a 200 shell before
   * `notFound()` can set the status — the exact soft-404 this suite guards.
   * The champions list keeps its skeleton via the `(list)` route group, which
   * is not on this path.
   */
  const segmentsAboveDetailPage = [
    "src/app",
    "src/app/[locale]",
    "src/app/[locale]/champions",
    "src/app/[locale]/champions/[slug]",
  ];

  test.each(segmentsAboveDetailPage)(
    "%s declares no loading.tsx",
    (segment) => {
      const entries = readdirSync(path.join(ROOT, segment));

      expect(entries.filter((entry) => entry.startsWith("loading."))).toEqual([]);
    },
  );

  test("the champions list keeps its loading skeleton inside the route group", () => {
    const entries = readdirSync(
      path.join(ROOT, "src/app/[locale]/champions/(list)"),
    );

    expect(entries).toContain("loading.tsx");
    expect(entries).toContain("page.tsx");
  });
});
