import { requireActiveEntitlement } from "@/lib/entitlements/server";
import { planFromEntitlement } from "@/lib/plans/plan";

/**
 * The visitor's plan, for client-side decisions on static pages (members see
 * no ads). Never cached; any failure reads as "free", which only means ads may
 * show, never that a member feature unlocks.
 */
export async function GET(): Promise<Response> {
  let plan: "free" | "member" | "vip" = "free";
  try {
    const result = await requireActiveEntitlement();
    if (result.ok) plan = planFromEntitlement(result.entitlement.kind);
  } catch {
    plan = "free";
  }
  return Response.json({ plan }, { headers: { "Cache-Control": "private, no-store" } });
}
