"use client";

import type { ReactNode } from "react";
import { memberExtrasEnabled } from "@/lib/plans/flags";
import { usePlan } from "@/lib/plans/usePlan";

/**
 * Renders its children for members only, and only while the member-extras flag
 * is on. Nothing here is secret (every letter and number is free): it keeps
 * members' conveniences off free pages, and renders nothing before the plan is
 * known, so there is no locked or blurred placeholder.
 */
export function MemberOnly({ children }: { children: ReactNode }) {
  const enabled = memberExtrasEnabled();
  const plan = usePlan(enabled);
  if (!enabled || (plan !== "member" && plan !== "vip")) return null;
  return <>{children}</>;
}
