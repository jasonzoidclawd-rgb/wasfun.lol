import { describe, expect, it } from "vitest";
import {
  SurfaceFixtureBuffer,
  buildSurfaceFixtureRecord,
  datasetCaptureEnabledFrom,
  serializeFixtureManifest,
  type SurfaceFixtureInput,
} from "./datasetCapture";

const rect = (i: number) => ({ x: 100 + i * 200, y: 250, width: 180, height: 60 });

function input(overrides: Partial<SurfaceFixtureInput> = {}): SurfaceFixtureInput {
  return {
    timestamp: "2026-07-18T00:00:00.000Z",
    capturedAt: 1000,
    label: "offer",
    present: true,
    confidence: 0.9,
    cropsCaptured: 3,
    titles: ["旋風鉤", "不祥契約", "靈光一閃"],
    cardRects: [rect(0), rect(1), rect(2)],
    rejectionReasons: [],
    ...overrides,
  };
}

describe("datasetCaptureEnabledFrom — disabled by default, dev + explicit flag only", () => {
  it("requires BOTH dev and the explicit flag", () => {
    expect(datasetCaptureEnabledFrom({ dev: true, flag: "1" })).toBe(true);
    expect(datasetCaptureEnabledFrom({ dev: true, flag: undefined })).toBe(false);
    expect(datasetCaptureEnabledFrom({ dev: true, flag: "0" })).toBe(false);
    expect(datasetCaptureEnabledFrom({ dev: false, flag: "1" })).toBe(false);
  });
});

describe("buildSurfaceFixtureRecord — redacts to card regions only", () => {
  it("keeps titles, rects, and verdict; caps to three regions", () => {
    const record = buildSurfaceFixtureRecord(
      input({ titles: ["a", "b", "c", "LEAK"], cardRects: [rect(0), rect(1), rect(2), rect(3)] }),
    );
    expect(record.titles).toEqual(["a", "b", "c"]);
    expect(record.cardRects).toHaveLength(3);
    expect(record.label).toBe("offer");
    expect(record.present).toBe(true);
    // No identity/full-screen keys ever leak into the record shape.
    expect(Object.keys(record).sort()).toEqual(
      [
        "capturedAt",
        "cardRects",
        "confidence",
        "cropsCaptured",
        "label",
        "present",
        "rejectionReasons",
        "timestamp",
        "titles",
      ].sort(),
    );
  });

  it("copies the rejectionReasons array (no shared mutable reference)", () => {
    const reasons = ["insufficient-crops"];
    const record = buildSurfaceFixtureRecord(input({ present: false, rejectionReasons: reasons }));
    reasons.push("mutated");
    expect(record.rejectionReasons).toEqual(["insufficient-crops"]);
  });
});

describe("SurfaceFixtureBuffer + serializeFixtureManifest — session-only JSONL", () => {
  it("accumulates records and serializes them as one JSON object per line", () => {
    const buffer = new SurfaceFixtureBuffer();
    expect(buffer.add(buildSurfaceFixtureRecord(input()))).toBe(1);
    expect(buffer.add(buildSurfaceFixtureRecord(input({ label: "combat", present: false })))).toBe(2);

    const lines = buffer.serialize().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).label).toBe("offer");
    expect(JSON.parse(lines[1]).label).toBe("combat");

    buffer.clear();
    expect(buffer.all()).toHaveLength(0);
    expect(serializeFixtureManifest([])).toBe("");
  });
});
