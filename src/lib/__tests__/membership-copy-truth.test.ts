import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { pickActiveMemberEntitlement } from "@/lib/entitlements/core";

const locales = ["en", "zh-TW", "zh-CN", "ja", "ko"] as const;

function readMessages(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf-8"),
  );
}

function readChampionDetailPage(): string {
  return readFileSync(
    path.join(process.cwd(), "src/app/[locale]/champions/[slug]/page.tsx"),
    "utf-8",
  );
}

/**
 * Promises made to a signed-out reader that a free account is enough. Copy is
 * checked against the server's actual verdict, so a wording change that
 * re-introduces the promise fails here rather than in production.
 */
const FREE_ACCOUNT_PROMISES: Record<(typeof locales)[number], RegExp> = {
  en: /free account/i,
  "zh-TW": /免費帳號/,
  "zh-CN": /免费账号/,
  ja: /無料アカウント/,
  ko: /무료 계정/,
};

describe("the entitlement gate is unchanged", () => {
  test("a signed-in user with no entitlement row is not a member", () => {
    expect(pickActiveMemberEntitlement([], new Date()).active).toBe(false);
  });

  test("an expired entitlement is not a member", () => {
    const verdict = pickActiveMemberEntitlement(
      [
        {
          kind: "member",
          status: "active",
          starts_at: "2026-01-01T00:00:00Z",
          expires_at: "2026-02-01T00:00:00Z",
        },
      ],
      new Date("2026-09-18T00:00:00Z"),
    );

    expect(verdict.active).toBe(false);
  });

  test("an active entitlement is a member", () => {
    const verdict = pickActiveMemberEntitlement(
      [
        {
          kind: "member",
          status: "active",
          starts_at: "2026-01-01T00:00:00Z",
          expires_at: null,
        },
      ],
      new Date("2026-09-18T00:00:00Z"),
    );

    expect(verdict.active).toBe(true);
  });

  test("the champion pool is still gated on an active entitlement, not on sign-in", () => {
    const source = readChampionDetailPage();

    expect(source).toContain("requireActiveEntitlement()");
    expect(source).toContain('gate.reason !== "unauthenticated"');
    expect(source).toContain("const memberData = isMember ?");
  });
});

describe("pool gate copy matches the gate", () => {
  test("no locale promises that a free account unlocks the pool", () => {
    for (const locale of locales) {
      const champion = readMessages(locale).champion;
      const gateCopy = [
        champion.poolGateTitle,
        champion.poolGateDescription,
        champion.poolGateMemberTitle,
        champion.poolGateMemberDescription,
        champion.poolGateMemberCta,
      ].join(" ");

      expect(gateCopy, `${locale} pool gate`).not.toMatch(FREE_ACCOUNT_PROMISES[locale]);
    }
  });

  test("every locale has distinct copy for the signed-out and signed-in-non-member states", () => {
    for (const locale of locales) {
      const champion = readMessages(locale).champion;

      for (const key of [
        "poolGateTitle",
        "poolGateDescription",
        "poolGateSignIn",
        "poolGateMemberTitle",
        "poolGateMemberDescription",
        "poolGateMemberCta",
      ]) {
        expect(champion[key], `${locale}.champion.${key}`).toEqual(expect.any(String));
        expect(champion[key]!.trim(), `${locale}.champion.${key}`).not.toBe("");
      }
      // A signed-in reader must not be told to sign in again.
      expect(champion.poolGateMemberDescription, locale).not.toBe(
        champion.poolGateDescription,
      );
      expect(champion.poolGateMemberTitle, locale).not.toBe(champion.poolGateTitle);
    }
  });

  test("the signed-out state names membership, not just an account", () => {
    // Sign-in is a step toward access; it is never access itself.
    const en = readMessages("en").champion;

    expect(en.poolGateTitle.toLowerCase()).toContain("membership");
    expect(en.poolGateDescription.toLowerCase()).toContain("membership");
  });

  test("the signed-in non-member state points at activating membership", () => {
    const en = readMessages("en").champion;

    expect(en.poolGateMemberDescription.toLowerCase()).toMatch(/invite|trial|code/);
    expect(en.poolGateMemberCta.toLowerCase()).toMatch(/code/);
  });

  test("each of the three reader states renders its own copy", () => {
    const source = readChampionDetailPage();

    // member -> no gate; signed-in non-member -> member copy; logged out ->
    // sign-in copy. All three branches are present and distinct.
    expect(source).toContain('t("poolGateMemberTitle")');
    expect(source).toContain('t("poolGateMemberDescription")');
    expect(source).toContain('t("poolGateMemberCta")');
    expect(source).toContain('t("poolGateTitle")');
    expect(source).toContain('t("poolGateDescription")');
    expect(source).toContain('t("poolGateSignIn")');
    expect(source).toContain("gated={!isMember}");
    expect(source).toContain("signInNextPath={!isAuthenticated ?");
  });
});

describe("membership page copy is consistent with the gate", () => {
  test("the free tier never lists member-gated pool depth", () => {
    const members = JSON.parse(
      readFileSync(path.join(process.cwd(), "messages", "en.json"), "utf-8"),
    ).members as { freeFeatures: string[]; memberFeatures: string[] };

    expect(members.freeFeatures.join(" ").toLowerCase()).not.toMatch(/pool|advisor/);
    expect(members.memberFeatures.join(" ").toLowerCase()).toMatch(/pool/);
  });

  test("the membership page tells a signed-in non-member to redeem a code", () => {
    const members = JSON.parse(
      readFileSync(path.join(process.cwd(), "messages", "en.json"), "utf-8"),
    ).members as Record<string, string>;

    expect(members.signedInNote.toLowerCase()).toMatch(/invite|trial|code/);
  });
});
