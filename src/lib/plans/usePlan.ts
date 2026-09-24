"use client";

import { useSyncExternalStore } from "react";
import type { PlanId } from "./config";

const KEY = "wasfun:plan";
let current: PlanId | null = null;
let started = false;
const listeners = new Set<() => void>();

function load(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    const cached = sessionStorage.getItem(KEY);
    if (cached === "free" || cached === "member" || cached === "vip") current = cached;
  } catch {
    // storage blocked: ask the server
  }
  fetch("/api/me/plan", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : { plan: "free" }))
    .then((body: { plan?: string }) => {
      const plan: PlanId = body.plan === "member" || body.plan === "vip" ? body.plan : "free";
      current = plan;
      try {
        sessionStorage.setItem(KEY, plan);
      } catch {
        // fine: asked again next page
      }
      listeners.forEach((l) => l());
    })
    .catch(() => {
      if (current === null) current = "free";
      listeners.forEach((l) => l());
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

// A caller that doesn't need the plan (its feature flag is off) never asks the server.
const idle = () => () => {};

/** The visitor's plan; null until known (server render and first paint), and always null when `active` is false. */
export function usePlan(active = true): PlanId | null {
  return useSyncExternalStore(active ? subscribe : idle, () => (active ? current : null), () => null);
}
