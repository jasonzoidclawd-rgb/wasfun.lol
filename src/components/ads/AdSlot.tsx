"use client";

import { shouldLoadAds } from "@/lib/ads/consent";
import { useAdConsent } from "@/lib/ads/useAdConsent";
import { track } from "@/lib/analytics";
import { usePlan } from "@/lib/plans/usePlan";
import { useEffect, useRef } from "react";

const ADS_ENABLED = process.env.NEXT_PUBLIC_ADS_ENABLED;
const AD_CLIENT = process.env.NEXT_PUBLIC_ADSENSE_CLIENT;

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

/**
 * A single AdSense unit for PUBLIC reference pages only. Never rendered on
 * Advisor, account, admin, auth, or member surfaces. The ad script loads
 * lazily and ONLY after consent — never on first paint. A fixed min-height is
 * always reserved so enabling ads later causes no layout shift.
 *
 * Members see no ads anywhere: for them the slot renders nothing. An ad loads
 * only once the plan is known to be free.
 */
export function AdSlot({ slot, minHeight = 100 }: { slot: string; minHeight?: number }) {
  const consent = useAdConsent();
  const plan = usePlan();
  const pushed = useRef(false);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const viewable = useRef(false);
  const visibilityRatio = useRef(0);
  const viewableTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const member = plan === "member" || plan === "vip";
  const active = shouldLoadAds(ADS_ENABLED, consent) && Boolean(AD_CLIENT) && plan === "free";

  useEffect(() => {
    if (!active || pushed.current) return;
    pushed.current = true;
    const scriptId = "adsbygoogle-js";
    if (!document.getElementById(scriptId)) {
      const script = document.createElement("script");
      script.id = scriptId;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${AD_CLIENT}`;
      document.head.appendChild(script);
    }
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // AdSense not ready yet; the script's own queue will flush.
    }
  }, [active]);

  useEffect(() => {
    viewable.current = false;
    visibilityRatio.current = 0;
    if (viewableTimer.current) clearTimeout(viewableTimer.current);
    viewableTimer.current = null;

    if (!active || typeof IntersectionObserver === "undefined" || !slotRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        visibilityRatio.current = entry?.isIntersecting ? entry.intersectionRatio : 0;
        if (visibilityRatio.current >= 0.5 && !viewable.current && !viewableTimer.current) {
          viewableTimer.current = setTimeout(() => {
            viewableTimer.current = null;
            if (visibilityRatio.current >= 0.5 && !viewable.current) {
              viewable.current = true;
              track("ad_slot_viewable", { slot });
            }
          }, 1000);
        } else if (visibilityRatio.current < 0.5 && viewableTimer.current) {
          clearTimeout(viewableTimer.current);
          viewableTimer.current = null;
        }
      },
      { threshold: [0, 0.5] },
    );

    observer.observe(slotRef.current);
    return () => {
      observer.disconnect();
      if (viewableTimer.current) clearTimeout(viewableTimer.current);
      viewableTimer.current = null;
    };
  }, [active, slot]);

  if (member) return null;
  // Reserve space regardless so the slot never shifts layout.
  return (
    <div ref={slotRef} style={{ minHeight }} aria-hidden={!active} className="my-4 w-full overflow-hidden">
      {active ? (
        <ins
          className="adsbygoogle"
          style={{ display: "block" }}
          data-ad-client={AD_CLIENT}
          data-ad-slot={slot}
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      ) : null}
    </div>
  );
}
