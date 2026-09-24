/**
 * The kill-switch crawl lets chips marked data-grade-kind="champion" through
 * when augment statistics are off. That is only sound if those chips carry
 * champion letters: this pins where the marker may appear and where their
 * letters come from.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const ALLOWED = [
  "src/app/[locale]/champions/[slug]/page.tsx",
  "src/components/champions/ChampionsIndex.tsx",
  "src/components/champions/SwapCheck.tsx",
  "src/components/home/HomeSearch.tsx",
  "src/components/home/MovedSinceLastPatch.tsx",
];

describe("champion-kind letter chips", () => {
  test('only the champion surfaces use kind="champion"', () => {
    const using = files(path.join(process.cwd(), "src"))
      .filter((f) => /\.tsx$/.test(f) && readFileSync(f, "utf-8").includes('kind="champion"'))
      .map((f) => path.relative(process.cwd(), f))
      .sort();
    expect(using).toEqual([...ALLOWED].sort());
  });

  test("the pages feeding those chips take letters from loadChampionLetters, not the augment pack", () => {
    for (const page of ["src/app/[locale]/page.tsx", "src/app/[locale]/champions/(list)/page.tsx", "src/app/[locale]/champions/[slug]/page.tsx"]) {
      expect(readFileSync(path.join(process.cwd(), page), "utf-8"), page).toContain("loadChampionLetters()");
    }
    const header = readFileSync(path.join(process.cwd(), "src/app/[locale]/champions/[slug]/page.tsx"), "utf-8");
    expect(header).toMatch(/kind="champion"\s+letter=\{championLetter\.letter\}/);
  });
});
