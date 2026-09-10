/**
 * DEVELOPMENT-ONLY, opt-in surface-fixture capture.
 *
 * Purpose: collect labeled fixtures of the Stage-1 surface probe so a future
 * geometry-based `SurfacePresenceProvider` (surfacePresence.ts) can be trained
 * and validated against the exact frames the OCR-title provider sees today —
 * WITHOUT changing the scheduler, freshness, or rendering contracts.
 *
 * Hard guarantees:
 *   - Disabled by default. Enabled ONLY under `import.meta.env.DEV` AND the
 *     explicit `MAYHEM_OVERLAY_DATASET_CAPTURE=1` flag — never in production.
 *   - Redacted to card regions ONLY: a record carries the three name-band
 *     rectangles, their OCR'd titles (augment names), and the presence verdict.
 *     No champion, player identity, game hash, or full-screen pixels ever enter
 *     a record.
 *   - Session-only and manual: records live in an in-memory buffer, are never
 *     auto-persisted, auto-uploaded, or committed. The collector exports a JSONL
 *     manifest by hand.
 *
 * Collection procedure lives in docs/handoffs/overlay-current-state.md.
 */
import type { PhysicalRect } from "../calibration";

/** Manual ground-truth label the collector assigns to a captured frame. */
export type DatasetLabel = "offer" | "combat" | "scoreboard" | "respawn" | "unknown";

export const DATASET_LABELS: readonly DatasetLabel[] = [
  "offer",
  "combat",
  "scoreboard",
  "respawn",
  "unknown",
];

/** One redacted, manually-labeled surface-probe fixture. */
export interface SurfaceFixtureRecord {
  /** ISO timestamp, caller-supplied (pure code never reads the wall clock). */
  timestamp: string;
  /** Monotonic capture clock (performance.now()) at probe time. */
  capturedAt: number;
  /** The collector's manual ground-truth label for this frame. */
  label: DatasetLabel;
  /** Stage-1 presence verdict and its evidence. */
  present: boolean;
  confidence: number;
  cropsCaptured: number;
  /** Per-region OCR'd name-band titles (augment names, may be null). */
  titles: Array<string | null>;
  /** Card-region rectangles ONLY — never full-screen geometry. */
  cardRects: Array<PhysicalRect | null>;
  rejectionReasons: string[];
}

export interface SurfaceFixtureInput {
  timestamp: string;
  capturedAt: number;
  label: DatasetLabel;
  present: boolean;
  confidence: number;
  cropsCaptured: number;
  titles: Array<string | null>;
  cardRects: Array<PhysicalRect | null>;
  rejectionReasons: string[];
}

/**
 * Build a redacted fixture record. Only the three card regions, their titles,
 * and the presence verdict survive — this is the redaction boundary.
 */
export function buildSurfaceFixtureRecord(input: SurfaceFixtureInput): SurfaceFixtureRecord {
  return {
    timestamp: input.timestamp,
    capturedAt: input.capturedAt,
    label: input.label,
    present: input.present,
    confidence: input.confidence,
    cropsCaptured: input.cropsCaptured,
    titles: input.titles.slice(0, 3),
    cardRects: input.cardRects.slice(0, 3),
    rejectionReasons: [...input.rejectionReasons],
  };
}

/** Serialize a manifest as JSONL (one record per line) for a `.jsonl` fixture. */
export function serializeFixtureManifest(records: readonly SurfaceFixtureRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

/** In-memory, session-only fixture buffer. Never persisted, uploaded, or committed. */
export class SurfaceFixtureBuffer {
  private readonly records: SurfaceFixtureRecord[] = [];

  add(record: SurfaceFixtureRecord): number {
    this.records.push(record);
    return this.records.length;
  }

  all(): readonly SurfaceFixtureRecord[] {
    return this.records;
  }

  clear(): void {
    this.records.length = 0;
  }

  serialize(): string {
    return serializeFixtureManifest(this.records);
  }
}

// ─── Enable predicate (separated from import.meta so it is unit-testable) ───

export function datasetCaptureEnabledFrom(input: {
  dev: boolean;
  flag: string | undefined;
}): boolean {
  return input.dev === true && input.flag === "1";
}

export function isDatasetCaptureEnabled(): boolean {
  const env = (import.meta as unknown as {
    env: { DEV: boolean; MAYHEM_OVERLAY_DATASET_CAPTURE?: string };
  }).env;
  return datasetCaptureEnabledFrom({ dev: env.DEV, flag: env.MAYHEM_OVERLAY_DATASET_CAPTURE });
}
