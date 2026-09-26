import { requireActiveEntitlement } from "@/lib/entitlements/server";
import { planFromEntitlement } from "@/lib/plans/plan";

/**
 * The visitor's plan, for client-side decisions on static pages (members see
 * no ads). Never cached. When the membership lookup itself fails the plan is
 * unknown (null), not free: an unknown plan shows no ads and unlocks nothing,
 * so a member never sees an ad because a lookup failed.
 */
export async function GET(): Promise<Response> {
  let plan: "free" | "member" | "vip" | null;
  try {
    const result = await requireActiveEntitlement();
    if (result.ok) plan = planFromEntitlement(result.entitlement.kind);
    else plan = result.reason === "lookup-failed" ? null : "free";
  } catch {
    plan = null;
  }
  return Response.json({ plan }, { headers: { "Cache-Control": "private, no-store" } });
}
