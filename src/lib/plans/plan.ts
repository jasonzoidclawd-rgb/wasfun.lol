import type { EntitlementKind } from "@/lib/entitlements/core";
import type { PlanId } from "./config";

/**
 * The plan an active entitlement maps to. Today's entitlements are the
 * existing membership kinds; none of them is VIP, which has no entitlement kind
 * until the owner decides the paid-tier path.
 */
export function planFromEntitlement(kind: EntitlementKind | null): PlanId {
  return kind === "member" || kind === "trial" || kind === "overlay_tester" ? "member" : "free";
}
