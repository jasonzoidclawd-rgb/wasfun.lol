"use client";

import { usePathname } from "@/i18n/navigation";
import { v3AdsEnabled } from "@/lib/plans/flags";
import { AdSlot } from "./AdSlot";

/**
 * A v3 ad placement: one per out-of-game page, after the page's answer. Off
 * until NEXT_PUBLIC_WASFUN_V3_ADS is "on" (it reserves no space while off).
 * Never on the Pick screen, even if placed there by mistake. Members see none
 * (AdSlot).
 */
export function V3AdSlot({ slot }: { slot: string }) {
  const pathname = usePathname();
  if (!v3AdsEnabled() || /^\/pick(\/|$)/.test(pathname)) return null;
  return <AdSlot slot={slot} />;
}
