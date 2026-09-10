import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source guard for the foreground-poll wiring in App.tsx. The ownership loop is
 * behaviourally tested in `foregroundPollScheduler.test.ts` against a native
 * call that never settles; what cannot be proven there is that App.tsx actually
 * routes through that loop, and that the host it supplies publishes through the
 * one routine that performs the epoch bump and the blur `stopOcr()`.
 *
 * Getting this wrong restores the main-thread congestion (a second
 * `get_foreground_state` admitted every 1500 ms) or drops the blur handling
 * that hides the surface when focus leaves the game.
 */
describe("foreground poll wiring", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  it("delegates the whole poll to the tested ownership loop", () => {
    expect(src).toContain("pollForeground(foregroundPollHost)");
    // Exactly one native foreground call site, inside the host.
    expect(src.split('invoke<ForegroundState>("get_foreground_state")').length - 1).toBe(1);
  });

  it("owns the in-flight stamp only through the host's accessors", () => {
    // The loop is the sole writer. A direct assignment in App.tsx would be a
    // second, untested release path for physical ownership.
    const assignments = src.split(/foregroundNativeStartedAtRef\.current\s*=/).length - 1;
    expect(assignments).toBe(1);
    const setter = src.indexOf("setNativeStartedAt: (value) => {");
    expect(setter).toBeGreaterThan(-1);
    expect(src.indexOf("foregroundNativeStartedAtRef.current =")).toBeGreaterThan(setter);
  });

  it("no longer races the invoke against a timeout to release the guard", () => {
    // `resolveWithTimeout` + `foregroundPollMayStart` ARE the defect: the race
    // resolved at 1500 ms and the stuck-deadline override then handed out a
    // second main-thread slot. Both are deleted, not merely unused.
    expect(src).not.toContain("resolveWithTimeout");
    expect(src).not.toContain("foregroundPollMayStart");
    expect(src).not.toContain("foregroundPollStartedAtRef");
  });

  it("routes every publication through the shared routine", () => {
    // Both the settle and the degrade-to-unknown must perform the ref write,
    // the epoch bump and the blur `stopOcr()`. Publishing `unknown` by hand
    // would skip the blur and leave the surface painted after foreground truth
    // had already expired.
    expect(src).toContain("publish: publishForeground,");
    expect(src).toContain("publishForeground(unknownForegroundState())");
    const publisher = src.indexOf("const publishForeground = useCallback(");
    expect(publisher).toBeGreaterThan(-1);
    expect(src.indexOf("foregroundEpochRef.current += 1;", publisher)).toBeGreaterThan(publisher);
    expect(src.indexOf("stopOcr();", publisher)).toBeGreaterThan(publisher);
  });

  it("issues no follow-up invoke and keeps no pending-request state", () => {
    // A follow-up invoke fired from the settle handler would run the main
    // thread at a 100% duty cycle under a slow native call. The 250 ms interval
    // is the only demand signal.
    expect(src).not.toContain("pendingLatestRequest");
    expect(src).toContain("}, FOREGROUND_POLL_INTERVAL_MS);");
  });
});
