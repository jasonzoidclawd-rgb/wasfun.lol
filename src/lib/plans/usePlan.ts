"use client";

import { useSyncExternalStore } from "react";
import type { PlanId } from "./config";

const KEY = "wasfun:plan";
let current: PlanId | null = null;
let started = false;
const listeners = new Set<() => void>();

/** The cached plan worth acting on before the server answers: a paid plan only. */
export function trustedCachedPlan(cached: string | null): PlanId | null {
  return cached === "member" || cached === "vip" ? cached : null;
}

function load(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    // A cached paid plan hides ads sooner. A cached "free" is never trusted:
    // the visitor may have signed in since, and an ad must wait for the server.
    current = trustedCachedPlan(sessionStorage.getItem(KEY));
  } catch {
    // storage blocked: ask the server
  }
  fetch("/api/me/plan", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : { plan: null }))
    .then((body: { plan?: string | null }) => {
      // an unknown plan (failed lookup) stays null: no ads, nothing unlocked
      const plan = trustedCachedPlan(body.plan ?? null) ?? (body.plan === "free" ? "free" : null);
      current = plan ?? current;
      try {
        if (plan) sessionStorage.setItem(KEY, plan);
      } catch {
        // fine: asked again next page
      }
      listeners.forEach((l) => l());
    })
    .catch(() => {
      // offline or failed: the plan stays unknown (or the cached paid plan)
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
