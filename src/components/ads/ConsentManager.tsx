"use client";

import { Link, usePathname } from "@/i18n/navigation";
import { shouldPromptConsent } from "@/lib/ads/consent";
import { recordConsent, useAdConsent } from "@/lib/ads/useAdConsent";

interface ConsentCopy {
  title: string;
  body: string;
  accept: string;
  decline: string;
  privacyLink: string;
}

const ADS_ENABLED = process.env.NEXT_PUBLIC_ADS_ENABLED;

export function ConsentManager({ copy }: { copy: ConsentCopy }) {
  const consent = useAdConsent();
  const pathname = usePathname();

  // Inert unless ads are enabled for this deployment and no choice was made.
  if (!shouldPromptConsent(ADS_ENABLED, consent)) return null;
  // The Pick screen is used in game and carries no ads, so nothing to consent to there.
  if (/^\/pick(\/|$)/.test(pathname)) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-black/90 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-white/80">
          <span className="font-semibold">{copy.title}.</span> {copy.body}{" "}
          <Link href="/privacy" className="underline">
            {copy.privacyLink}
          </Link>
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => recordConsent("denied")}
            className="rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/5"
          >
            {copy.decline}
          </button>
          <button
            onClick={() => recordConsent("granted")}
            className="rounded-lg bg-amber-400/90 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-300"
          >
            {copy.accept}
          </button>
        </div>
      </div>
    </div>
  );
}
