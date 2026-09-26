/**
 * Plan tiers. Prices are configuration, never code: they come from the
 * environment, and a tier without a monthly price is not offered. With no
 * prices set the Plans page does not render.
 */
export type PlanId = "free" | "member" | "vip";

export interface PlanTier {
  id: PlanId;
  /** price per month and per year in `currency`; null for free, or when not configured */
  monthly: number | null;
  yearly: number | null;
}

export interface PlanCatalog {
  currency: string;
  tiers: PlanTier[];
}

export function parsePrice(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** The catalog, or null when the paid tiers aren't priced (then nothing is offered). */
export function planCatalog(env: Record<string, string | undefined> = process.env): PlanCatalog | null {
  const member = { monthly: parsePrice(env.WASFUN_PRICE_MEMBER_MONTHLY), yearly: parsePrice(env.WASFUN_PRICE_MEMBER_YEARLY) };
  const vip = { monthly: parsePrice(env.WASFUN_PRICE_VIP_MONTHLY), yearly: parsePrice(env.WASFUN_PRICE_VIP_YEARLY) };
  if (member.monthly === null || vip.monthly === null) return null;
  return {
    currency: env.WASFUN_PRICE_CURRENCY?.trim() || "USD",
    tiers: [
      { id: "free", monthly: null, yearly: null },
      { id: "member", ...member },
      { id: "vip", ...vip },
    ],
  };
}

/** What each tier gets, as message keys under `plans.features` (the copy lives in messages/*.json). */
export const PLAN_FEATURES: Record<PlanId, string[]> = {
  free: ["everyLetter", "pickFull", "overlayBasic", "recent", "currentPatch"],
  member: ["everythingFree", "noAds", "thisGame", "rerollOdds", "pandora", "offlinePacks", "following", "history"],
  vip: ["everythingMember", "overlayFull"],
};
