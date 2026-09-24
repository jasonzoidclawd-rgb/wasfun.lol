"use client";

import { useEffect } from "react";
import { rememberChampion } from "@/lib/recent-champions";

/** Adds the champion to the visitor's recent list (Home chips). Renders nothing. */
export function RememberChampion({ slug }: { slug: string }) {
  useEffect(() => rememberChampion(slug), [slug]);
  return null;
}
