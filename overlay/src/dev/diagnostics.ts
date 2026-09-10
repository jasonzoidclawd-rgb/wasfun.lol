export type SlotDiagnosticState =
  | "scanning"
  | "matched"
  | "no-data"
  | "loading"
  | "error"
  | "unmatched";

export type SlotRejectionStage =
  | "capture"
  | "ocr"
  | "riot-catalog"
  | "aramgg"
  | null;

export interface OcrCardDiagnostic {
  regionIndex: number;
  cardRect: { x: number; y: number; width: number; height: number } | null;
  crop: { x: number; y: number; width: number; height: number } | null;
  captureSucceeded: boolean;
  rawText: string | null;
  error: string | null;
  captureWidth: number | null;
  captureHeight: number | null;
  normalizedText: string;
  bestCandidate: string | null;
  confidence: number | null;
  rejectionReason: string | null;
  /** Riot zh-TW catalog candidate (canonical name), when resolution ran. */
  riotCanonicalName: string | null;
  /** Canonical numeric augment ID resolved through the Riot catalog. */
  riotAugmentId: string | null;
  /** Riot title-resolution method (riot-zh-tw-exact / -fuzzy / -zh-cn-exact). */
  riotMethod: string | null;
  /** ARAMGG stat summary for the resolved ID, or null when missing. */
  aramggResult: string | null;
  /** Current per-slot lifecycle state. */
  slotState: SlotDiagnosticState;
  /** First pipeline stage that rejected this card (null when fully matched). */
  rejectionStage: SlotRejectionStage;
}

export interface OcrScanTimings {
  /** Native screenshot + crop extraction, ms. */
  captureMs: number | null;
  /** Native OCR recognition (all cards concurrently), ms. */
  ocrMs: number | null;
  /** Whole native scan, ms. */
  nativeTotalMs: number | null;
  /** Frontend catalog matching + state publication, ms. */
  matchMs: number | null;
  /** Scan start → state published, ms. */
  endToEndMs: number | null;
}

export interface OcrLifecycleSnapshot {
  phase: string;
  currentRound: number | null;
  active: boolean;
  lastScanStart: string | null;
  lastScanEnd: string | null;
  scanRunId: number | null;
  captureAttempted: boolean;
  cropCount: number;
  noCropReason: string | null;
  /** Monotonic latched-offer generation (bumps on reroll / new offer). */
  offerGeneration: number;
  /** VisibleOfferFrame: the current capture independently validated a surface. */
  surfaceValidated: boolean;
  /** Why the surface was / wasn't accepted this scan (multi-signal validator). */
  surfaceReason: string | null;
  /** Regions whose fresh crop backed a renderable slot in the latest frame. */
  freshRectCount: number;
  /** Monotonic visible-frame revision (bumps on every publish, fresh or empty). */
  visibleFrameRevision: number;
  /** Internal latch remembers an offer but the visible frame is empty. */
  lifecycleDisagreement: boolean;
  // ─── Self-healing surface probe (Stage 1) ───
  /** Monotonic probe sequence claimed at the last probe START. */
  probeSeq: number;
  /** performance.now() when the last probe STARTED / FINISHED (ms, monotonic). */
  lastProbeStartedAt: number | null;
  lastProbeFinishedAt: number | null;
  /** Monotonic clock the current in-flight probe started at, or null. */
  probeInFlightSince: number | null;
  /** Times the watchdog restarted a stuck probe scheduler this session. */
  probeRestartCount: number;
  /** Why the most recent scheduler tick skipped, or the last failure reason. */
  probeSkipReason: string;
  probeFailureReason: string | null;
  /** Stage-1 title-presence: confidence 0..1 and plausible-title count. */
  surfaceConfidence: number;
  plausibleTitles: number;
  /** Age of the current visible frame (ms) and whether the TTL hides it. */
  frameAgeMs: number | null;
  frameHiddenByTtl: boolean;
  timings: OcrScanTimings;
}

export const EMPTY_SCAN_TIMINGS: OcrScanTimings = {
  captureMs: null,
  ocrMs: null,
  nativeTotalMs: null,
  matchMs: null,
  endToEndMs: null,
};

export interface DiagnosticCounters {
  /** Cards whose crop capture succeeded in the latest scan. */
  cardsCaptured: number;
  /** Cards whose OCR produced a readable title. */
  titlesRead: number;
  /** Cards resolved to a canonical Riot augment ID. */
  riotResolved: number;
  /** Cards with a live ARAMGG stat record. */
  aramggMatched: number;
  ocrDetected: number;
  previewInjected: number;
  offeredMatched: number;
  catalogResolved: number;
  renderedRealBadges: number;
  renderedPreviewBadges: number;
}
