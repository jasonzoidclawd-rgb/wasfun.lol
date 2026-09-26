import type { EntitlementKind } from "@/lib/entitlements/core";
import type { PlanId } from "./config";

/**
 * The plan an active entitlement maps to. Today's membership kinds (member,
 * trial) get Member's benefits; overlay_tester is a download permission, not a
 * membership. None is VIP, which has no entitlement kind until the owner
 * decides the paid-tier path. Moving members' billing to the new plans waits
 * on checkout, which is off.
 */
export function planFromEntitlement(kind: EntitlementKind | null): PlanId {
  return kind === "member" || kind === "trial" ? "member" : "free";
}
