import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The 2026-07/09 publishing outage had two causes. One was a source shape
 * change. The other was ordering: the freshness gate ran BEFORE the commit and
 * exited non-zero on drift, so a run that acquired good data but still trailed
 * upstream published nothing — the stale-data detector blocked its own fix.
 */
describe("update-data workflow ordering", () => {
  const workflow = readFileSync(
    path.join(process.cwd(), ".github/workflows/update-data.yml"),
    "utf-8",
  );
  const stepNames = [...workflow.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1].trim());
  const indexOfStep = (fragment: string) =>
    stepNames.findIndex((name) => name.toLowerCase().includes(fragment));

  test("publishes before it evaluates freshness", () => {
    const commit = indexOfStep("commit and push");
    const freshness = indexOfStep("freshness");
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(freshness).toBeGreaterThanOrEqual(0);
    expect(commit).toBeLessThan(freshness);
  });

  test("freshness reporting cannot be skipped by an earlier failure", () => {
    const section = workflow.slice(workflow.indexOf("- name: Report freshness"));
    expect(section).toMatch(/if:\s*always\(\)/);
  });

  test("the tracking issue closes only on a bounded-healthy state", () => {
    // Closing on any statistics lag is what auto-resolved the 59-day outage
    // every single day it continued.
    expect(workflow).toContain('"$healthy" = "yes"');
    expect(workflow).not.toContain('"$status" = "statistics_behind"');
    expect(workflow).toContain("statistics_stale");
  });
});
