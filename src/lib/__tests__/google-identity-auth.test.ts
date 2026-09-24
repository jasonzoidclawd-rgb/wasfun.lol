import { readFile } from "fs/promises";
import path from "path";
import { describe, expect, test, vi } from "vitest";
import {
  GOOGLE_IDENTITY_SCRIPT_SRC,
  getGoogleClientId,
  isGoogleIdentityAvailable,
  normalizeGoogleSignInNextPath,
  signInWithGoogleCredential,
} from "@/lib/auth/google-identity";

describe("Google Identity Services auth", () => {
  test("reads NEXT_PUBLIC_GOOGLE_CLIENT_ID for GIS initialization", () => {
    const previous = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "  google-web-client-id.apps.googleusercontent.com  ";

    expect(getGoogleClientId()).toBe("google-web-client-id.apps.googleusercontent.com");
    expect(isGoogleIdentityAvailable()).toBe(true);

    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    } else {
      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = previous;
    }
  });

  test("missing Google client ID prevents GIS initialization", () => {
    const previous = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

    expect(getGoogleClientId()).toBe("");
    expect(isGoogleIdentityAvailable()).toBe(false);

    if (previous !== undefined) {
      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = previous;
    }
  });

  test("credential callback signs in with Supabase Google ID token", async () => {
    const signInWithIdToken = vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null }));
    const supabase = { auth: { signInWithIdToken } };

    await expect(
      signInWithGoogleCredential(supabase, { credential: "google-id-token" }),
    ).resolves.toEqual({ user: { id: "user-1" } });

    expect(signInWithIdToken).toHaveBeenCalledWith({
      provider: "google",
      token: "google-id-token",
    });
  });

  test("missing credential reports an error before calling Supabase", async () => {
    const signInWithIdToken = vi.fn();
    const supabase = { auth: { signInWithIdToken } };

    await expect(signInWithGoogleCredential(supabase, {})).rejects.toThrow(
      "Missing Google credential",
    );
    expect(signInWithIdToken).not.toHaveBeenCalled();
  });

  test("Google auth button uses GIS and the public client ID", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/components/auth/GoogleSignInButton.tsx"),
      "utf-8",
    );

    expect(GOOGLE_IDENTITY_SCRIPT_SRC).toBe("https://accounts.google.com/gsi/client");
    expect(source).toContain("GOOGLE_IDENTITY_SCRIPT_SRC");
    expect(source).toContain("NEXT_PUBLIC_GOOGLE_CLIENT_ID");
    expect(source).toContain("accounts.id.initialize");
    expect(source).toContain("accounts.id.renderButton");
  });

  test("Google auth button copy is localized and never renders raw provider errors", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/components/auth/GoogleSignInButton.tsx"),
      "utf-8",
    );

    expect(source).toContain('useTranslations("auth")');
    expect(source).toContain('t("signIn.busy")');
    expect(source).toContain('t("signIn.unavailable")');
    expect(source).toContain('t("signIn.failed")');
    // Raw provider error text must go to the console, never the UI.
    expect(source).not.toMatch(/\.message\b/);
    expect(source).not.toContain("Signing in...");
    expect(source).not.toContain("Google sign-in is unavailable.");
    expect(source).not.toContain("Google sign-in failed");
  });

  test("Google sign-in copy exists in every locale message file", async () => {
    for (const locale of ["en", "zh-TW", "zh-CN", "ja", "ko"]) {
      const messages = JSON.parse(
        await readFile(path.join(process.cwd(), `messages/${locale}.json`), "utf-8"),
      ) as { auth: { signIn?: Record<string, string> } };

      for (const key of ["busy", "unavailable", "failed"]) {
        expect(messages.auth.signIn?.[key], `${locale}.auth.signIn.${key}`).toBeTruthy();
      }
    }
  });

  test("user-facing Google login path no longer starts Supabase OAuth", async () => {
    const files = [
      "src/app/api/auth/signin/route.ts",
      "src/app/[locale]/account/page.tsx",
      "src/app/[locale]/advisor/page.tsx",
      "src/app/[locale]/membership/page.tsx",
      "src/app/[locale]/champions/[slug]/page.tsx",
      "src/components/champions/PoolConstructionSection.tsx",
    ];

    const sources = await Promise.all(
      files.map((file) => readFile(path.join(process.cwd(), file), "utf-8")),
    );
    const combined = sources.join("\n");

    const oauthRedirectMethod = ["signIn", "With", "OAuth"].join("");
    expect(combined).not.toContain(oauthRedirectMethod);
    expect(combined).not.toContain("/api/auth/signin?next=");
    expect(combined).toContain("GoogleSignInButton");
  });

  test("Google sign-in call sites use unprefixed internal next paths", async () => {
    const files = [
      "src/app/[locale]/account/page.tsx",
      "src/app/[locale]/advisor/page.tsx",
      "src/app/[locale]/membership/page.tsx",
      "src/app/[locale]/champions/[slug]/page.tsx",
    ];
    const combined = (
      await Promise.all(files.map((file) => readFile(path.join(process.cwd(), file), "utf-8")))
    ).join("\n");

    expect(combined).not.toMatch(/GoogleSignInButton[\s\S]{0,120}next=\{`\/\$\{locale\}/);
    expect(combined).not.toContain('signInNextPath={!isAuthenticated ? `/${locale');
    expect(combined).not.toContain('signInUrl={`/${locale}/account`}');
    expect(combined).toContain('<GoogleSignInButton next="/account"');
    expect(combined).toContain('<GoogleSignInButton next="/advisor"');
    expect(combined).toContain('<GoogleSignInButton next="/membership"');
    expect(combined).toContain('signInNextPath={!isAuthenticated ? `/champions/${slug}` : undefined}');
  });

  test("non-default locale account redirects do not duplicate the locale prefix", () => {
    const routerPath = normalizeGoogleSignInNextPath("/zh-TW/account");
    const zhTwLocalizedPath = `/zh-TW${routerPath}`;

    expect(routerPath).toBe("/account");
    expect(zhTwLocalizedPath).toBe("/zh-TW/account");
    expect(zhTwLocalizedPath).not.toBe("/zh-TW/zh-TW/account");
  });

  test("strips every routing locale prefix so adding locales cannot break sign-in redirects", async () => {
    const { routing } = await import("@/i18n/routing");

    for (const locale of routing.locales) {
      expect(normalizeGoogleSignInNextPath(`/${locale}/account`), locale).toBe("/account");
      expect(normalizeGoogleSignInNextPath(`/${locale}`), locale).toBe("/");
    }
    // Non-locale prefixes that merely resemble one must pass through untouched.
    expect(normalizeGoogleSignInNextPath("/environment/account")).toBe("/environment/account");
  });

  test("locale prefix stripping has no hardcoded locale list", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/lib/auth/google-identity.ts"),
      "utf-8",
    );

    expect(source).not.toMatch(/zh-TW|zh-CN|\bja\b|\bko\b/);
    expect(source).toContain("routing.locales");
  });
});
