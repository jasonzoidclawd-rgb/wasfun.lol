/**
 * Phase 4 acceptance: the Pick screen stays ad-free, members see no ads
 * anywhere, and every money feature is off unless its flag is on. Prices are
 * configuration, never code.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

const plan = vi.hoisted(() => ({ current: "free" as "free" | "member" | "vip" | null }));
const route = vi.hoisted(() => ({ pathname: "/champions/yasuo" }));
vi.mock("@/lib/plans/usePlan", () => ({ usePlan: () => plan.current }));
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => route.pathname,
  Link: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never),
}));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => {},
  getTranslations: async () => Object.assign((k: string, v?: Record<string, string>) => (v ? `${k}:${Object.values(v).join("/")}` : k), {}),
}));
vi.mock("@/lib/entitlements/server", () => ({ requireActiveEntitlement: vi.fn() }));

import { AdSlot } from "@/components/ads/AdSlot";
import { V3AdSlot } from "@/components/ads/V3AdSlot";
import { requireActiveEntitlement } from "@/lib/entitlements/server";
import { planCatalog, parsePrice } from "@/lib/plans/config";
import { memberPickEnabled, overlayDownloadEnabled, plansEnabled, v3AdsEnabled } from "@/lib/plans/flags";
import { planFromEntitlement } from "@/lib/plans/plan";
import { GET as planApi } from "@/app/api/me/plan/route";
import PlansPage from "@/app/[locale]/plans/page";
import OverlayPage from "@/app/[locale]/overlay/page";

const FLAGS = ["NEXT_PUBLIC_WASFUN_PLANS", "NEXT_PUBLIC_WASFUN_V3_ADS", "NEXT_PUBLIC_WASFUN_OVERLAY_DOWNLOAD", "NEXT_PUBLIC_WASFUN_MEMBER_PICK"];
const params = Promise.resolve({ locale: "en" });

afterEach(() => {
  vi.unstubAllEnvs();
  plan.current = "free";
  route.pathname = "/champions/yasuo";
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("flags: off unless exactly \"on\"", () => {
  test("every money flag is off when unset, and only \"on\" turns it on", () => {
    for (const f of FLAGS) vi.stubEnv(f, undefined as unknown as string);
    expect([plansEnabled(), v3AdsEnabled(), overlayDownloadEnabled(), memberPickEnabled()]).toEqual([false, false, false, false]);
    for (const f of FLAGS) vi.stubEnv(f, "true");
    expect([plansEnabled(), v3AdsEnabled(), overlayDownloadEnabled(), memberPickEnabled()]).toEqual([false, false, false, false]);
    for (const f of FLAGS) vi.stubEnv(f, "on");
    expect([plansEnabled(), v3AdsEnabled(), overlayDownloadEnabled(), memberPickEnabled()]).toEqual([true, true, true, true]);
  });
});

describe("prices are configuration", () => {
  test("no catalog without both paid tiers priced; yearly prices are optional", () => {
    expect(planCatalog({})).toBeNull();
    expect(planCatalog({ WASFUN_PRICE_MEMBER_MONTHLY: "3" })).toBeNull();
    const c = planCatalog({ WASFUN_PRICE_MEMBER_MONTHLY: "3", WASFUN_PRICE_VIP_MONTHLY: "5", WASFUN_PRICE_VIP_YEARLY: "40" })!;
    expect(c.tiers.map((t) => [t.id, t.monthly, t.yearly])).toEqual([["free", null, null], ["member", 3, null], ["vip", 5, 40]]);
    expect(c.currency).toBe("USD");
    expect([parsePrice(""), parsePrice("abc"), parsePrice("-1"), parsePrice("2.5")]).toEqual([null, null, null, 2.5]);
  });

  test("no price is written into the source", () => {
    const hits = files(path.join(process.cwd(), "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"))
      .filter((f) => /\$\s?\d+\.\d\d|\b[1-9]\d*\.99\b/.test(readFileSync(f, "utf-8")));
    expect(hits).toEqual([]);
  });
});

describe("ads", () => {
  test("members see no ad slot at all; free visitors keep the reserved space", () => {
    plan.current = "member";
    expect(renderToStaticMarkup(createElement(AdSlot, { slot: "x" }))).toBe("");
    plan.current = "vip";
    expect(renderToStaticMarkup(createElement(AdSlot, { slot: "x" }))).toBe("");
    plan.current = "free";
    expect(renderToStaticMarkup(createElement(AdSlot, { slot: "x" }))).toContain("min-height");
  });

  test("v3 placements render nothing while their flag is off, and never on the Pick screen", () => {
    expect(renderToStaticMarkup(createElement(V3AdSlot, { slot: "v3-home" }))).toBe("");
    vi.stubEnv("NEXT_PUBLIC_WASFUN_V3_ADS", "on");
    expect(renderToStaticMarkup(createElement(V3AdSlot, { slot: "v3-home" }))).toContain("min-height");
    route.pathname = "/pick/yasuo";
    expect(renderToStaticMarkup(createElement(V3AdSlot, { slot: "v3-home" }))).toBe("");
  });

  test("nothing on the Pick route or in the Pick components imports an ad or a plan prompt", () => {
    const pick = [...files(path.join(process.cwd(), "src/app/[locale]/pick")), ...files(path.join(process.cwd(), "src/components/pick"))];
    for (const f of pick) expect(readFileSync(f, "utf-8"), f).not.toMatch(/AdSlot|components\/ads|PlanLine|["'`]\/plans/);
  });
});

describe("pages behind flags", () => {
  test("/plans is a 404 while off, and while the paid tiers are unpriced", async () => {
    await expect(PlansPage({ params })).rejects.toThrow();
    vi.stubEnv("NEXT_PUBLIC_WASFUN_PLANS", "on");
    await expect(PlansPage({ params })).rejects.toThrow();
    vi.stubEnv("WASFUN_PRICE_MEMBER_MONTHLY", "3");
    vi.stubEnv("WASFUN_PRICE_VIP_MONTHLY", "5");
    const html = renderToStaticMarkup(await PlansPage({ params }));
    expect(html.match(/data-plan="/g)).toHaveLength(3);
    // nothing can be bought yet
    expect(html).toContain("notOnSale");
    expect(html).not.toMatch(/<form|checkout|stripe/i);
  });

  test("/overlay has no download link while its flag is off", async () => {
    expect(renderToStaticMarkup(await OverlayPage({ params }))).not.toContain("/api/downloads/overlay");
    vi.stubEnv("NEXT_PUBLIC_WASFUN_OVERLAY_DOWNLOAD", "on");
    expect(renderToStaticMarkup(await OverlayPage({ params }))).toContain("/api/downloads/overlay?platform=windows");
  });
});

describe("the visitor's plan", () => {
  test("active membership entitlements map to Member; nothing maps to VIP yet", () => {
    expect(planFromEntitlement("member")).toBe("member");
    expect(planFromEntitlement("trial")).toBe("member");
    expect(planFromEntitlement(null)).toBe("free");
  });

  test("/api/me/plan answers free on any failure and is never cached", async () => {
    const guard = vi.mocked(requireActiveEntitlement);
    guard.mockResolvedValueOnce({ ok: true, user: { id: "u" }, entitlement: { kind: "member" } });
    const res = await planApi();
    expect(await res.json()).toEqual({ plan: "member" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    guard.mockResolvedValueOnce({ ok: false, status: 401, reason: "unauthenticated" });
    expect(await (await planApi()).json()).toEqual({ plan: "free" });
    guard.mockRejectedValueOnce(new Error("no supabase"));
    expect(await (await planApi()).json()).toEqual({ plan: "free" });
  });
});
