import { LinkDeviceForm, RedeemForm } from "@/components/membership/AccountClient";
import { AuthErrorBanner } from "@/components/auth/AuthErrorBanner";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import { Link } from "@/i18n/navigation";
import {
  pickActiveEntitlement,
  pickActiveOverlayDownloadEntitlement,
  type EntitlementRow,
} from "@/lib/entitlements/core";
import { createClient } from "@/lib/supabase/server";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SavedGames } from "@/components/member/SavedGames";
import { memberExtrasEnabled } from "@/lib/plans/flags";
import { readAugmentsFile, readChampionsFile } from "@/lib/data/read-public-file";
import { localizedName, type LocalizedNameRecord } from "@/lib/i18n/localized-name";

/** Champion and augment names for saved games: names only, no statistics. */
async function savedGameNames(locale: string): Promise<Record<string, string>> {
  const [{ augments }, { champions }] = await Promise.all([
    readAugmentsFile<{ augments: (LocalizedNameRecord & { augmentId?: string })[] }>(),
    readChampionsFile<{ champions: (LocalizedNameRecord & { slug: string })[] }>(),
  ]);
  const names: Record<string, string> = {};
  for (const a of augments) if (a.augmentId) names[a.augmentId] = localizedName(a, locale);
  for (const c of champions) names[c.slug] = localizedName(c, locale);
  return names;
}

interface SessionRow {
  id: string;
  champion_slug: string;
  mode: string;
  round: number;
  created_at: string;
  result_summary: { candidates?: Array<{ augmentSlug: string; grade: string }> };
}

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { locale } = await params;
  const { error } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("membership");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <div className="mt-4">
          <AuthErrorBanner error={error} />
        </div>
        <p className="mt-4 text-white/70">{t("signInPrompt")}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <GoogleSignInButton next="/account" label={t("signInCta")} />
          <Link
            href="/membership"
            className="inline-block rounded-lg border border-white/15 px-5 py-2.5 font-medium text-white/80 transition hover:bg-white/5"
          >
            {t("lockedCta")}
          </Link>
        </div>
      </main>
    );
  }

  const [{ data: entitlementRows }, { data: sessionRows }] = await Promise.all([
    supabase.from("entitlements").select("kind,status,starts_at,expires_at").eq("user_id", user.id),
    supabase
      .from("decision_sessions")
      .select("id,champion_slug,mode,round,created_at,result_summary")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const rows = (entitlementRows as EntitlementRow[]) ?? [];
  const now = new Date();
  const verdict = pickActiveEntitlement(rows, now);
  const downloadVerdict = pickActiveOverlayDownloadEntitlement(rows, now);
  const activeRow = verdict.active
    ? rows.find((row) => row.kind === verdict.entitlement.kind && row.status === "active")
    : undefined;
  const downloadRow = downloadVerdict.active
    ? rows.find((row) => row.kind === downloadVerdict.entitlement.kind && row.status === "active")
    : undefined;

  const statusLabel = !verdict.active
    ? t("statusInactive")
    : verdict.entitlement.kind === "member"
      ? t("statusActiveMember")
      : verdict.entitlement.kind === "overlay_tester"
        ? t("statusActiveOverlayTester")
        : t("statusActiveTrial");

  const history = (sessionRows as SessionRow[] | null) ?? [];

  // localePrefix is "as-needed": en lands on /, other locales keep their prefix.
  const signoutNext = locale === "en" ? "/" : `/${locale}`;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="mt-1 text-sm text-white/60">{t("subtitle")}</p>
        </div>
        <form action={`/api/auth/signout?next=${encodeURIComponent(signoutNext)}`} method="post">
          <button
            type="submit"
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
          >
            {t("signOut")}
          </button>
        </form>
      </header>

      <AuthErrorBanner error={error} />

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-sm uppercase tracking-widest text-white/50">{t("statusTitle")}</h2>
        <p className="mt-2 text-xl font-semibold">{statusLabel}</p>
        {verdict.active ? (
          <p className="mt-1 text-sm text-white/60">
            {t("expiresLabel")}: {activeRow?.expires_at
              ? new Date(activeRow.expires_at).toLocaleDateString(locale)
              : t("noExpiry")}
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <RedeemForm
          copy={{
            redeemTitle: t("redeemTestCode"),
            redeemPlaceholder: t("redeemPlaceholder"),
            redeemButton: t("redeemButton"),
            redeemSuccess: t("redeemSuccess"),
            redeemError: t("redeemError"),
            redeemInvalidExpired: t("redeemInvalidExpired"),
          }}
        />
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <LinkDeviceForm
          copy={{
            linkDeviceTitle: t("linkDeviceTitle"),
            linkDeviceHelp: t("linkDeviceHelp"),
            linkDevicePlaceholder: t("linkDevicePlaceholder"),
            linkDeviceButton: t("linkDeviceButton"),
            linkDeviceSuccess: t("linkDeviceSuccess"),
            linkDeviceError: t("linkDeviceError"),
            linkDeviceInvalidExpired: t("linkDeviceInvalidExpired"),
          }}
        />
      </section>

      {downloadVerdict.active ? (
        <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.04] p-5">
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-amber-100">{t("downloadsTitle")}</h2>
              <p className="mt-1 text-sm text-amber-100/75">
                {t("downloadExpires")}:{" "}
                {downloadRow?.expires_at
                  ? new Date(downloadRow.expires_at).toLocaleString(locale)
                  : t("noExpiry")}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route returns a file redirect, not an app page. */}
              <a
                href="/api/downloads/overlay?platform=windows"
                className="rounded-lg bg-amber-400/90 px-5 py-3 text-center font-semibold text-black transition hover:bg-amber-300"
              >
                {t("downloadWindows")}
              </a>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route returns a file redirect, not an app page. */}
              <a
                href="/api/downloads/overlay?platform=mac"
                className="rounded-lg border border-amber-300/40 px-5 py-3 text-center font-semibold text-amber-100 transition hover:bg-amber-400/10"
              >
                {t("downloadMac")}
              </a>
            </div>
            <div className="rounded-xl border border-amber-300/25 bg-black/20 p-4">
              <h3 className="text-sm font-semibold text-amber-100">{t("alphaWarningTitle")}</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-50/75">
                <li>{t("alphaWarningUnsigned")}</li>
                <li>{t("alphaWarningSmartScreen")}</li>
                <li>{t("alphaWarningTesterOnly")}</li>
                <li>{t("alphaWarningSensitiveLogs")}</li>
              </ul>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-lg font-semibold">{t("historyTitle")}</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-white/50">{t("historyEmpty")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/5">
            {history.map((row) => (
              <li key={row.id} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium capitalize">{row.champion_slug}</span>
                <span className="text-white/50">
                  R{row.round} · {row.mode} ·{" "}
                  {new Date(row.created_at).toLocaleDateString(locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!verdict.active ? (
        <Link href="/advisor" className="text-sm text-amber-300 hover:underline">
          {t("lockedCta")} →
        </Link>
      ) : null}
      {memberExtrasEnabled() && <SavedGames names={await savedGameNames(locale)} />}
    </main>
  );
}
