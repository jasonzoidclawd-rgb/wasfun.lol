import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("OCR accepted-round ownership wiring", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const probeStart = app.indexOf("const runIdentityProbe = useCallback");
  const probeEnd = app.indexOf("// ─── TRACK 1 scheduler tick", probeStart);
  const probe = app.slice(probeStart, probeEnd);

  it("stamps start and completion contexts from accepted offer ownership", () => {
    expect(probeStart).toBeGreaterThan(-1);
    expect(probeEnd).toBeGreaterThan(probeStart);

    const acceptedRoundSource =
      "offerRoundOwnershipRef.current.activeOwner?.round ?? null";
    expect(probe.split(acceptedRoundSource)).toHaveLength(3);
    expect(probe).not.toContain("roundDeliveryRef.current");
  });

  it("logs bounded accepted rounds at start and stale completion", () => {
    const startDiagnostic = probe.slice(
      probe.indexOf('logOverlayDiagnostic("[identity-start]"'),
      probe.indexOf("const currentOwnerContext"),
    );
    const staleDiagnostic = probe.slice(
      probe.indexOf('logOverlayDiagnostic("[identity-stale-reject]"'),
      probe.indexOf("const scanStart"),
    );

    expect(startDiagnostic).toContain("round: owner.round");
    expect(staleDiagnostic).toContain("roundAtStart: rejected.round");
    expect(staleDiagnostic).toContain("roundNow: context.round");
  });
});
