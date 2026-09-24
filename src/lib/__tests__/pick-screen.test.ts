/**
 * Phase 2 acceptance, rendered: a letter on every Pick card, no ads in the DOM,
 * tap targets at least 44 px, and card rates labelled as all-champion rates.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, test, vi } from "vitest";
import messages from "../../../messages/en.json";
import { PickScreen } from "@/components/pick/PickScreen";
import { loadScorePack } from "../score/pack";
import { buildPickPayload } from "../score/pick-payload";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));

const icons = { augment: () => null, champion: () => null, item: () => null };
const items = { name: (s: string) => s };

function render(slug: string) {
  const pack = loadScorePack()!;
  const payload = buildPickPayload({ pack, slug, locale: "en", championRecord: { name: slug }, icons, items })!;
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: "en", messages, children: createElement(PickScreen, { payload }) }),
  );
  return { payload, html };
}

describe("the Pick screen as rendered", () => {
  test("every card on the grid carries a letter, as text", () => {
    const { payload, html } = render("yasuo");
    const cards = [...html.matchAll(/<li><button[^>]*aria-pressed[^>]*>([\s\S]*?)<\/button><\/li>/g)];
    // the first rarity tab shown: every card in it renders
    const shown = Object.values(payload.rarities).find((set) => set.length === cards.length);
    expect(shown, "a rarity's full card set is on screen").toBeDefined();
    for (const [, body] of cards) expect(body).toMatch(/class="grade-chip[^"]*"[^>]*data-grade="[SABCD]"/);
    // and every card in the payload has a letter to show
    for (const set of Object.values(payload.rarities)) for (const c of set) expect(["S", "A", "B", "C", "D"]).toContain(c.letter);
  }, 120_000);

  test("no ads and no ad scripts in the DOM", () => {
    const { html } = render("lux");
    expect(html).not.toMatch(/adsbygoogle|data-ad-|googlesyndication|AdSlot/i);
  }, 120_000);

  test("tap targets are at least 44 px", () => {
    const { html } = render("jinx");
    const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(buttons.length).toBeGreaterThan(10);
    for (const cls of buttons) expect(cls, cls).toMatch(/min-h-11|min-h-\[88px\]|h-11/);
  }, 120_000);

  test("win rates read as all-champion rates; nothing reads as the champion's own win rate", () => {
    const { html } = render("yasuo");
    expect(html).toContain("across all champions");
    expect(html).not.toMatch(/estimated from other champions/);
  }, 120_000);
});
