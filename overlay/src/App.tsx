import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  buildChampionPool,
} from "./scoring";
import {
  buildOverlayAugmentLookup,
  diagnoseAugmentMatch,
  normalizeAugmentNameForLookup,
  type AugmentMatchDiagnostic,
} from "./scoring/offer-lookup";
import {
  isCompleteThreeCardOffer,
  resolveGameflowCaptureAllowed,
  shouldClearOcrStateForGameflow,
} from "./augmentSelection";
import {
  applyGameOwnershipObservation,
  isBackwardGameTime,
  resolveLiveDataPoll,
  shouldAnnounceLiveActivation,
} from "./liveGamePoll";
import {
  resolveRoundDelivery,
  TOTAL_AUGMENT_ROUNDS,
  type RoundDeliveryDecision,
} from "./roundDelivery";
import {
  createOfferRoundOwnership,
  reduceOfferRoundOwnership,
  type OfferRoundOwnership,
} from "./offerRoundOwnership";
import {
  applyScanToOffer,
  emptyOfferState,
  offerActive,
  type OfferState,
} from "./offerLifecycle";
import {
  CollectorOverlayController,
  type CollectorSnapshot,
} from "./collector/CollectorStatus";
import {
  overlayShouldIgnoreMouseEvents,
} from "./collector/collectorWindows";
import { normalizeChampionName, resolveKnownChampionSlug } from "./championResolve";
import type {
  AbilityProfile,
  ChampionBaseStats,
  ChampionPoolBreakdown,
  ChampionTag,
  PoolAugment,
  PoolRules,
  ComboTier,
} from "./scoring";
import type {
  DecisionMode,
  DecisionResult,
} from "./contracts/decision";
import type { DecisionEngineData } from "./decision/evaluate";
import {
  bootstrapMember,
  disabledMember,
  IDLE_MEMBER_VERIFICATION_STATE,
  memberRecommendationsVisible,
  runMemberVerification,
  shouldStartMemberVerification,
  shouldVerifyGameStart,
  verifyMemberGameStart,
  type MemberSnapshot,
  type MemberVerificationRequest,
  type MemberVerificationState,
} from "./auth/member";
import { CoachPanel } from "./components/CoachPanel";
import { runLocalInference } from "./model/inference";
import { confirmPickedAugment } from "./model/presentation";
import { tierForGrade } from "./model/tier";
import {
  compactWinRateFromFraction,
  compactWinRateFromPercent,
} from "./winRateFormat";
import {
  buildAramggDecisionResult,
  isTierFixtureEnabled,
  type AramggFixtureCard,
} from "./dev/tierFixture";
import {
  useAramggTierFixture,
  type SlotAramggResolution,
} from "./dev/useAramggTierFixture";
import { isGeometryPreviewEnabled, resolveOverlayFixtureMode } from "./dev/fixtureMode";
import {
  realAugmentOverlayRenderable,
  type RealAugmentOverlayGate,
} from "./augmentOverlayGate";
import {
  badgeLayerSignature,
  describeBadgeLayerDecision,
  evaluateRoundContentCompletion,
  parseRoundContentAcknowledgements,
  reduceRoundContentEmission,
  reportBadgeLayerDecision,
  type RoundContentFailureCategory,
  type RoundContentOwner,
  type SemanticPublication,
} from "./badgeLayerDiagnostic";
import { DevOverlayDiagnostics } from "./dev/DevOverlayDiagnostics";
import { devPanelsVisible } from "./dev/productionSurfaces";
import {
  boundedDiagnosticHash,
  describeLiveClientStatusTransition,
  describeOfferAcquisitionDiagnostic,
  emitNativeDiagnostic,
  logOverlayDiagnostic,
} from "./dev/publicationDiagnostics";
import {
  SurfaceFixtureBuffer,
  buildSurfaceFixtureRecord,
  isDatasetCaptureEnabled,
  type DatasetLabel,
  type SurfaceFixtureInput,
} from "./dev/datasetCapture";
import {
  pollForeground,
  FOREGROUND_POLL_INTERVAL_MS,
  type ForegroundPollHost,
} from "./foregroundPollScheduler";
import { isPlausibleTitle } from "./surfacePresence";
import {
  DEFAULT_PROBE_CONFIG,
  PROBE_TIMEOUT_MS,
  WEDGED_NATIVE_PROBE_MS,
  nextProbeAction,
  oldestNativeStart,
  type ProbeSchedulerConfig,
} from "./surfaceProbeScheduler";
import {
  emptyVisibleFrame,
  frameResultIsCurrent,
  visibleFrameRenderable,
  type VisibleOfferFrame,
} from "./visibleOfferFrame";
import {
  GEOMETRY_INTERVAL_MS,
  GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS,
  IDENTITY_RETRY_MS,
  advanceGeometrySurface,
  buildGeometryVisibleFrame,
  classifyGeometryObservation,
  classifyProbeTimeout,
  completeGeometryAttempt,
  createGeometryHealthClocks,
  createGeometrySurfaceState,
  decomposeGeometryTiming,
  emptyGeometryObservation,
  fingerprintChanged,
  geometrySchedulerHealthy,
  hammingDistance,
  identityForSlot,
  markGeometryUnhealthyIfExpired,
  newOfferDetected,
  restartGeometryAttempt,
  startGeometryAttempt,
  type GeometryClassification,
  type GeometryHealthClocks,
  type GeometryHideReason,
  type GeometryObservation,
  type GeometrySurfaceState,
  type IdentityRecord,
} from "./surfaceGeometry";
import {
  advanceRerollConfirmation,
  advanceBaselineSettlement,
  beginBaselineSettlement,
  applyRerollInvalidation,
  createRerollPending,
  ocrRunSuperseded,
  type SlotRerollPending,
  type BaselineSettlement,
} from "./rerollInvalidation";
import { summarizeAuthoritativePublication } from "./authoritativePublication";
import {
  reconcileSlotIdentity,
  type SlotIdentity,
} from "./publicationOwnership";
import { refreshSameOfferData } from "./sameOfferDataRefresh";
import { decideOcrTrigger } from "./ocrTrigger";
import {
  OcrOwnerRegistry,
  executeOcrRun,
  failurePublication,
  ownerCurrent,
  classifyStaleReject,
  staleRejectSlotDrift,
  type OcrOwnerContext,
} from "./ocrOwner";
import {
  advanceOfferSurface,
  createOfferSurfaceState,
  type OfferSurfaceState,
} from "./offerSurfaceState";
import {
  EMPTY_SCAN_TIMINGS,
  type OcrCardDiagnostic as DevOcrCardDiagnostic,
  type OcrLifecycleSnapshot,
  type SlotDiagnosticState,
  type SlotRejectionStage,
} from "./dev/diagnostics";
import {
  gameOverlayVisible,
  unknownForegroundState,
  type ForegroundState,
} from "./overlayVisibility";
import {
  canRunOcr,
  createOcrAvailability,
  ocrAvailabilityFromError,
  type OcrAvailability,
} from "./ocrAvailability";
import { type OverlayCalibration } from "./calibration";
import { positionBadgeChips } from "./positionedBadgeChips";
import { BadgeChipLayer, type SlotChip } from "./BadgeChipLayer";
import "./App.css";

// The geometry track runs the SAME self-healing scheduler as OCR (start / skip /
// watchdog-restart) but on the fast cadence: presence/occlusion/visual freshness
// update independently of a slow OCR pass. Timeout is the shared
// bounded watchdog so a wedged capture re-arms within one cycle.
const GEOMETRY_PROBE_CONFIG: ProbeSchedulerConfig = {
  intervalMs: GEOMETRY_INTERVAL_MS,
  timeoutMs: PROBE_TIMEOUT_MS,
  wedgedNativeMs: WEDGED_NATIVE_PROBE_MS,
};

type GeometryDiagnosticHideReason = GeometryHideReason
  | "ttl-expired"
  | "foreground-lost"
  | "probe-timeout"
  | "other";

interface GeometryProbeDiagnostic {
  probeSeq: number;
  scheduledAt: number;
  startedAt: number;
  captureStartedAt: number;
  captureFinishedAt: number;
  analysisFinishedAt: number;
  publishedAt: number;
  preCaptureMs: number;
  captureMs: number;
  nativeTotalMs: number;
  ipcMs: number;
  analysisMs: number;
  totalProbeMs: number;
  gapSincePreviousStartMs: number | null;
  gapSincePreviousCompletedMs: number | null;
  inFlightMs: number;
  schedulerRestartCount: number;
  classification: GeometryClassification;
  present: boolean;
  occluded: boolean;
  confidence: number;
  cards: GeometryObservation["cards"];
  rejectionReasons: string[];
  previousSurfaceState: "present" | "hidden";
  nextSurfaceState: "present" | "hidden";
  hiddenReason: GeometryDiagnosticHideReason | null;
}

// ─── Types ───

interface LivePlayerData {
  champion: string;
  level: number;
  is_dead: boolean;
  game_time: number;
  game_mode: string;
}

interface LcuGameflowState {
  phase: string;
  liveCaptureAllowed: boolean;
}

interface DetectedAugment {
  text: string;
  region_index: number;
}

interface NativeOcrCardDiagnostic {
  regionIndex: number;
  cardRect: { x: number; y: number; width: number; height: number } | null;
  crop: { x: number; y: number; width: number; height: number } | null;
  captureSucceeded: boolean;
  rawText: string | null;
  error: string | null;
  captureWidth: number | null;
  captureHeight: number | null;
}

interface OcrScanResult {
  detected: DetectedAugment[];
  diagnostics: NativeOcrCardDiagnostic[];
  captureAttempted: boolean;
  cropCount: number;
  captureMs: number;
  ocrMs: number;
  totalMs: number;
}

interface MatchedCard {
  augment: PoolAugment;
  regionIndex: number;
  ocrText: string;
}

/**
 * Per-slot identity resolution, computed once when a slot's title fingerprint
 * changes and retained while the fingerprint is stable.
 */
interface SlotResolution {
  /** Local-catalog match (the real decision-engine path). */
  pool: PoolAugment | null;
  poolDiagnostic: AugmentMatchDiagnostic;
  /** Dev fixture: staged zh-TW Riot catalog → canonical ID → ARAMGG stats. */
  aramgg: SlotAramggResolution | null;
}

/**
 * Canonical augment ID of a resolved slot (empty while pending/unmatched). The
 * dev ARAMGG path carries the numeric Riot augment ID; the engine path uses the
 * local catalog slug. Used by the immutability guard to detect a conflicting
 * re-read of the same card (Phase A).
 */
function slotResolutionAugmentId(resolution: SlotResolution | null): string {
  if (!resolution) return "";
  const aramgg = resolution.aramgg;
  if (aramgg && aramgg.kind !== "unmatched") return aramgg.riot.augmentId;
  return resolution.pool?.slug ?? "";
}

/**
 * The one live reconciliation bridge. Canonical identity is immutable inside
 * an ownership scope; the derived resolution may refresh for the same id when
 * the current champion dataset moves from GLOBAL fallback to CHAMP.
 */
function reconcileIdentityRecord(
  previous: IdentityRecord<SlotResolution> | null,
  incoming: IdentityRecord<SlotResolution>,
): IdentityRecord<SlotResolution> {
  if (incoming.resolution === null || (incoming.augmentId ?? "").length === 0) {
    return previous?.resolution ? previous : incoming;
  }
  const asIdentity = (record: IdentityRecord<SlotResolution>): SlotIdentity<SlotResolution> => ({
    foregroundEpoch: record.foregroundEpoch ?? 0,
    gameEpoch: record.gameEpoch ?? 0,
    fingerprint: record.fingerprint,
    championGeneration: record.championGeneration ?? 0,
    offerGeneration: record.offerGeneration ?? 0,
    augmentId: record.augmentId ?? "",
    resolution: record.resolution as SlotResolution,
    slotGeneration: record.slotGeneration ?? 0,
    ocrRunId: record.ocrRunId ?? 0,
    conflictCount: record.conflictCount ?? 0,
  });
  const reconciled = reconcileSlotIdentity(
    previous?.resolution ? asIdentity(previous) : null,
    asIdentity(incoming),
  );
  if (reconciled.action === "keep") {
    return { ...previous!, conflictCount: reconciled.identity.conflictCount };
  }
  if (reconciled.action === "recompute-stat") {
    return {
      ...previous!,
      resolution: reconciled.identity.resolution,
      resolvedAt: incoming.resolvedAt,
      ocrRunId: incoming.ocrRunId,
      championRequestId: incoming.championRequestId,
      championPatch: incoming.championPatch,
    };
  }
  return incoming;
}

interface OverlayAugment {
  slug: string;
  name: string;
  name_zh_CN?: string;
  name_zh_TW?: string;
  name_ja?: string;
  name_ko?: string;
  rarity: "silver" | "gold" | "prismatic";
  win_rate: number | null;
  icon: string;
  description?: string;
  wikiDescription?: string;
  notes?: string[];
  set?: string;
  wikiSet?: string;
  kit_tags?: ChampionTag[];
  flags?: {
    system_breaker?: boolean;
    lifecycle?: string;
  };
}

interface OverlayChampion {
  slug: string;
  champion_key: string;
  name: string;
  name_zh_TW?: string;
  name_zh_CN?: string;
  name_ja?: string;
  name_ko?: string;
  win_rate: number | null;
  tags: string[];
  kit_tags?: ChampionTag[];
  baseStats?: ChampionBaseStats;
}

interface OverlayCombo {
  champion: string;
  augment: string;
  augmentSlug?: string;
  tier: string;
}

interface OverlayData {
  augments: OverlayAugment[];
  champions: OverlayChampion[];
  combos: OverlayCombo[];
  poolRules: PoolRules;
}

type Phase = "idle" | "client_found" | "in_game" | "augment_selection";

// ─── Constants ───

async function loadJson<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, window.location.origin));
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// ─── App ───

function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [playerData, setPlayerData] = useState<LivePlayerData | null>(null);
  const [championSlug, setChampionSlug] = useState<string | null>(null);
  const [pickedAugments, setPickedAugments] = useState<string[]>([]);
  const [offerState, setOfferState] = useState<OfferState<SlotResolution>>(
    () => emptyOfferState(),
  );
  const offerStateRef = useRef(offerState);
  const [offerSurface, setOfferSurface] = useState<OfferSurfaceState>(
    () => createOfferSurfaceState(),
  );
  const offerSurfaceRef = useRef(offerSurface);
  // VisibleOfferFrame — the ONLY state rendered chips/placeholders read. The
  // internal latch above (offerState) is nonvisual grace bookkeeping and never
  // renders directly. Every scan publishes a fresh-or-empty frame here; the
  // render gate is `visibleFrameRenderable`. See visibleOfferFrame.ts.
  const [visibleFrame, setVisibleFrame] = useState<VisibleOfferFrame<SlotResolution> | null>(null);
  const visibleFrameRef = useRef<VisibleOfferFrame<SlotResolution> | null>(null);
  // Monotonic probe sequence: bumped at every probe START, every synchronous
  // clear, and every watchdog restart. A probe result may publish its frame
  // only while its seq is still the latest AND its foreground epoch is unchanged
  // — a delayed/stuck probe can never restore a superseded frame.
  const scanSeqRef = useRef(0);
  const visibleRevisionRef = useRef(0);
  // Foreground epoch: bumped whenever gameWindowForeground flips, so a probe
  // that captured under an earlier focus can never publish after a change.
  const foregroundEpochRef = useRef(0);
  // Active-game epoch changes on every capture-allowed game transition or
  // reconnect. Async work from a previous game can never publish into the next.
  const gameEpochRef = useRef(0);
  const confirmedGameOwnershipRef = useRef({ ownsGame: false, gameEpoch: 0 });
  // P2 fix (focus-loss-before-clear ordering): the offer generation whose
  // badges the final gate certifies visible RIGHT NOW, or null. Read
  // synchronously by publishForeground's foreground-loss branch so the
  // deterministic [focus-transition] record can name the correct generation
  // before stopOcr() runs.
  const visibleBadgeGenerationRef = useRef<number | null>(null);
  // Self-healing surface-probe scheduler bookkeeping (a single probe at a time).
  const probeInFlightRef = useRef(false);
  const probeInFlightSinceRef = useRef<number | null>(null);
  // Native `detect_augment_names` calls issued but not yet settled, INCLUDING
  // ones whose logical ownership the watchdog already released. The OCR run
  // races a JS timeout, and a JS deadline cannot cancel an OS capture, so the
  // logical guard going free says nothing about whether the native call still
  // holds one of the four Rust capture permits.
  const ocrNativeOutstandingRef = useRef(0);
  // Ownership token: the captureSeq of the probe that currently holds the
  // in-flight guard. Only that probe may release the guard in its finally, so a
  // watchdog-superseded probe returning late can never free the guard held by
  // its replacement (which would let two probes overlap).
  const ocrOwnersRef = useRef(new OcrOwnerRegistry());
  const lastProbeStartedAtRef = useRef<number | null>(null);
  const lastProbeFinishedAtRef = useRef<number | null>(null);
  const probeRestartCountRef = useRef(0);
  const lastProbeSkipReasonRef = useRef<string>("idle");
  const lastProbeFailureReasonRef = useRef<string | null>(null);
  // ─── Round-6 geometry track (presence/occlusion/visual-freshness authority) ───
  // A cheap Rust pixel probe (probe_augment_surface) runs on its own fast
  // scheduler with its own single-in-flight guard, ownership token, seq, and
  // watchdog — a mirror of the OCR guards above so the two tracks never stall
  // each other. Geometry owns whether an offer is present, whether a modal has
  // occluded it, and the current card geometry/fingerprints. Scheduler health
  // independently owns fail-closed expiry. OCR NEVER decides those; it only
  // fills identity.
  const geometryInFlightRef = useRef(false);
  const geometryInFlightSinceRef = useRef<number | null>(null);
  const geometryInFlightTokenRef = useRef<number | null>(null);
  // Throttle (1 s) for the [geometry-timing] trace signal: splits a probe's cost
  // into enumeration (preCaptureMs) vs capture_image (captureMs) vs round-trip so
  // a cross-game slowdown is attributable without flooding the log.
  const lastGeometryTimingEpochRef = useRef(0);
  /** Native geometry invokes issued but not yet settled (abandonment ≠ cancel). */
  const geometryNativeOutstandingRef = useRef(0);
  /** Per-request native call start times, keyed by captureSeq — each settling
   *  request deletes only its own entry (see runGeometryProbe / the settle
   *  `finally` below); `oldestNativeStart` reduces this to the true minimum. */
  const geometryNativeStartsRef = useRef<Map<number, number>>(new Map());
  const geometrySeqRef = useRef(0);
  const lastGeometryStartedAtRef = useRef<number | null>(null);
  const geometryRestartCountRef = useRef(0);
  const geometryObservationRef = useRef<GeometryObservation | null>(null);
  const geometrySurfaceStateRef = useRef<GeometrySurfaceState>(
    createGeometrySurfaceState(),
  );
  // Render health is certified only by accepted authoritative geometry. These
  // five clocks deliberately separate attempt churn, native liveness, accepted
  // ownership, and render authority so watchdog replacement cannot make stale
  // badges healthy merely by starting another promise.
  const geometryHealthRef = useRef<GeometryHealthClocks>(
    createGeometryHealthClocks(),
  );
  const geometryDiagnosticsRef = useRef<GeometryProbeDiagnostic[]>([]);
  const lastRawGeometryClassificationRef = useRef<GeometryClassification | null>(null);
  const lastGeometryRenderableRef = useRef(false);
  const geometryFreshnessWarningSeqRef = useRef<number | null>(null);
  const geometryExpiryWarningSeqRef = useRef<number | null>(null);
  // Render generation, bumped on each NEW offer (absent→present or a queued
  // round replacement) so chip keys reset between offers.
  const geometryGenerationRef = useRef(0);
  // Per-slot identity keyed by the GEOMETRY fingerprint it was resolved against.
  // identityForSlot returns a record only while its fingerprint still matches the
  // live card, so a late OCR result from a superseded generation can never paint
  // the new card (the identity stale-result guard).
  const identityStoreRef = useRef<Array<IdentityRecord<SlotResolution> | null>>([null, null, null]);
  // Champion generation: bumps on every final-champion change so each resolved
  // slot recomputes against the new champion's dataset, while within a
  // generation the reconcile guard keeps each verified identity immutable.
  const championGenerationRef = useRef(0);
  const championIdRef = useRef<string | null>(null);
  // Per-slot generation: bumps ONLY for the slot whose fingerprint changed
  // (a single-slot reroll), so an OCR run stamped with the old generation is
  // rejected atomically and cannot repaint the new card (Phase B).
  const slotGenerationsRef = useRef<number[]>([0, 0, 0]);
  const acceptedSlotFingerprintsRef = useRef<string[]>(["", "", ""]);
  // Sustained-confirmation (hysteresis) state: a resolved slot's fingerprint
  // drift is hover/animation noise until a distinct replacement persists
  // REROLL_CONFIRM_PROBES probes. `heldRerollSlotsRef` are slots drifting but
  // not yet confirmed — the render holds their resolved tier (no SCANNING).
  const rerollPendingRef = useRef<SlotRerollPending[]>(createRerollPending());
  const heldRerollSlotsRef = useRef<number[]>([]);
  /**
   * Provisional reroll baseline while a freshly appeared offer's cards animate
   * in. Null outside an offer; cleared on close, confirmed absence, occlusion,
   * foreground/game invalidation and champion change so no later offer inherits it.
   */
  const baselineSettlementRef = useRef<BaselineSettlement | null>(null);
  // Cross-track OCR-trigger coordination: the geometry track decides which slots
  // need a (re)read and stamps the fingerprints those reads are keyed to.
  const ocrPendingSlotsRef = useRef<number[]>([]);
  const ocrTriggerFingerprintsRef = useRef<string[]>(["", "", ""]);
  const forceOcrSlotsRef = useRef<number[]>([]);
  // DEV-only geometry latency ring (capture+analyze ms) for p50/p95/p99 logging.
  const geometryLatenciesRef = useRef<number[]>([]);
  const geometryProbeCountRef = useRef(0);
  // Whether the last poll saw an active, capture-allowed game (coarse gate).
  const activeGameRef = useRef(false);
  // DEV-only: whether this live-ownership span already emitted its one
  // confirmed [game-poll] activation record. Reset when ownership is released.
  const liveOwnershipAnnouncedRef = useRef(false);
  const lastAcceptedOfferRef = useRef<{
    gameEpoch: number;
    monotonicMilliseconds: number;
  } | null>(null);
  const priorLiveClientStatusRef = useRef<{
    gameEpoch: number;
    status: "ready" | "unavailable" | "error";
  } | null>(null);
  const phaseRef = useRef<Phase>("idle");
  // Rounds completed on STRONG evidence only (confirmed pick / queued-offer
  // replacement) — can only undercount, which keeps probing alive and never
  // suppresses a real offer. See roundDelivery.ts.
  const completedRoundsRef = useRef(0);
  const roundDeliveryRef = useRef<RoundDeliveryDecision | null>(null);
  const offerRoundOwnershipRef = useRef<OfferRoundOwnership>(
    createOfferRoundOwnership(),
  );
  const [semanticOwner, setSemanticOwner] = useState<RoundContentOwner | null>(null);
  const [roundDelivery, setRoundDelivery] = useState<RoundDeliveryDecision | null>(null);
  const ocrSelectionCompletedRef = useRef(false);
  const gameflowCaptureAllowedRef = useRef(false);
  const liveDataFailureStartedAtRef = useRef<number | null>(null);
  const pollInFlightRef = useRef(false);
  const pollPendingRef = useRef(false);
  const pollRef = useRef<() => Promise<void>>(async () => {});
  // Physical single-flight ownership of the foreground invoke. Written only
  // where a poll starts and in that poll's `finally` — never by a clock.
  const foregroundNativeStartedAtRef = useRef<number | null>(null);
  const foregroundLogicalTimeoutFiredForRef = useRef<number | null>(null);
  const [showStartupTip, setShowStartupTip] = useState(true);
  const [foregroundState, setForegroundState] = useState<ForegroundState>(
    unknownForegroundState(),
  );
  const foregroundStateRef = useRef<ForegroundState>(unknownForegroundState());
  const [ocrDiagnostics, setOcrDiagnostics] = useState<DevOcrCardDiagnostic[]>([]);
  const [ocrLifecycle, setOcrLifecycle] = useState<OcrLifecycleSnapshot>({
    phase: "idle",
    currentRound: null,
    active: false,
    lastScanStart: null,
    lastScanEnd: null,
    scanRunId: null,
    captureAttempted: false,
    cropCount: 0,
    noCropReason: "not-started",
    offerGeneration: 0,
    surfaceValidated: false,
    surfaceReason: null,
    freshRectCount: 0,
    visibleFrameRevision: 0,
    lifecycleDisagreement: false,
    probeSeq: 0,
    lastProbeStartedAt: null,
    lastProbeFinishedAt: null,
    probeInFlightSince: null,
    probeRestartCount: 0,
    probeSkipReason: "idle",
    probeFailureReason: null,
    surfaceConfidence: 0,
    plausibleTitles: 0,
    frameAgeMs: null,
    frameHiddenByTtl: false,
    timings: EMPTY_SCAN_TIMINGS,
  });
  const [overlayData, setOverlayData] = useState<OverlayData | null>(null);
  const [abilityProfiles, setAbilityProfiles] = useState<Record<string, AbilityProfile | null>>({});
  const [dataError, setDataError] = useState<string | null>(null);
  const [ocrAvailability, setOcrAvailability] = useState<OcrAvailability>(
    createOcrAvailability(true),
  );
  const [calibration, setCalibration] = useState<OverlayCalibration | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  // CSS size of the overlay window as the webview itself reports it — one leg
  // of the anchor-ratio conversion (see cssRectFromCalibratedRect).
  const [cssWindow, setCssWindow] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const surfaceProbeTickRef = useRef<() => void>(() => {});
  // DEV-ONLY, opt-in dataset capture (disabled by default). When on, each probe
  // stashes its REDACTED surface evidence here for manual, session-only fixture
  // export. The leading import.meta.env.DEV lets the production build statically
  // fold this to false and dead-code-eliminate the whole wire. See dev/datasetCapture.
  const datasetCaptureOn = import.meta.env.DEV && isDatasetCaptureEnabled();
  const lastFixtureInputRef = useRef<Omit<SurfaceFixtureInput, "timestamp" | "label"> | null>(null);
  // Reactive scheduler-health gate. It remains true while a normal newer probe
  // is in flight, then fails closed if probe activity exceeds the derived bound.
  const [geometrySchedulerIsHealthy, setGeometrySchedulerIsHealthy] = useState(false);
  const lastGameTimeRef = useRef<number | null>(null);
  const lastRecordedRoundRef = useRef("");
  const [collectorStatus, setCollectorStatus] = useState<CollectorSnapshot | null>(null);
  const [memberSnapshot, setMemberSnapshot] = useState<MemberSnapshot | null>(null);
  const [mode, setMode] = useState<DecisionMode>("competitive");
  const [coachOpen, setCoachOpen] = useState(false);
  // Dev debug panel (tier-fixture / preview only): starts collapsed so it
  // cannot obscure a badge. Its visibility always goes through the single
  // devPanelsVisible gate — there is no pin/bypass that can keep it painted
  // when the game loses foreground.
  const [debugCollapsed, setDebugCollapsed] = useState(true);
  const activeGameHashRef = useRef<string | null>(null);
  const memberBootstrapCompleteRef = useRef(false);
  // Monotonic token for the in-poll member-verification request: bumped by
  // beginNewGameEpoch (any confirmed epoch boundary — new hash, backward
  // game_time, or a confirmed close) so an in-flight verification for a
  // superseded game can never publish, and bumped again on every new
  // verification kickoff so an older overlapping request within the SAME
  // epoch is superseded by a newer one. See the verifyGameHash branch in
  // poll() for the capture/compare.
  const memberVerificationTokenRef = useRef(0);
  // Explicit per-game member-verification lifecycle (idle/pending/verified/
  // retryable), separate from activeGameHashRef. Reset to idle only by
  // beginNewGameEpoch — an inconclusive recheck marks the SAME hash
  // retryable here without touching activeGameHashRef, so a later poll can
  // start another verification attempt for the same game.
  const memberVerificationStateRef = useRef<MemberVerificationState>(
    IDLE_MEMBER_VERIFICATION_STATE,
  );
  const gameWindowForeground = foregroundState.gameWindowForeground;
  const collectorEnabled = collectorStatus?.consent === "accepted";
  const collectorCaptureEnabled = collectorEnabled && !collectorStatus?.paused;
  // Development fixtures never alter the real member snapshot. The optional
  // member coach stays authenticated; the local geometry/OCR badge pipeline
  // gets its render allowance at realFrameRenderable ONLY under this explicit
  // fixture flag — a plain dev launch authorizes nothing.
  const tierFixtureOn = isTierFixtureEnabled();
  const geometryPreviewOn = isGeometryPreviewEnabled();
  const memberCoachEnabled = memberRecommendationsVisible(
    collectorEnabled,
    memberSnapshot,
  );

  const updatePhase = useCallback((nextPhase: Phase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
    setOcrLifecycle((previous) => ({ ...previous, phase: nextPhase }));
  }, []);

  // The coarse "is a game currently active" render/capture gate. This is
  // NEVER a source of epoch or activation-latch changes on its own — a
  // telemetry outage fails this closed (see
  // suspendGameRuntimeForUnavailableTelemetry) without proving the match
  // ended, so toggling it here must not look like a new game to the
  // analyzer. Epoch/latch resets happen only through beginNewGameEpoch,
  // defined below, called exclusively from a CONFIRMED game-identity
  // boundary.
  const setActiveGame = useCallback((active: boolean) => {
    activeGameRef.current = active;
  }, []);

  // Atomic offer publication: the ref and the rendered state always hold the
  // same complete snapshot, so no consumer can observe a mixed generation.
  const publishOffer = useCallback((next: OfferState<SlotResolution>) => {
    offerStateRef.current = next;
    setOfferState(next);
    setOcrLifecycle((previous) => ({ ...previous, offerGeneration: next.generation }));
  }, []);

  const resetOffer = useCallback(() => {
    publishOffer(emptyOfferState(offerStateRef.current.generation + 1));
  }, [publishOffer]);

  // Advance the probe sequence (a new probe started, a synchronous clear, or a
  // watchdog restart) — invalidates any in-flight probe's late result.
  const bumpScanSeq = useCallback(() => (scanSeqRef.current += 1), []);

  // Publish an EXPLICIT empty visible frame: zero chips, zero placeholders,
  // zero card rects. Called whenever probing stops or the current capture finds
  // insufficient title-presence, so the previous frame is never left painted.
  const publishEmptyVisibleFrame = useCallback((captureSeq: number, capturedAt: number) => {
    const frame = emptyVisibleFrame<SlotResolution>(
      (visibleRevisionRef.current += 1),
      captureSeq,
      offerStateRef.current.generation,
      capturedAt,
    );
    visibleFrameRef.current = frame;
    setVisibleFrame(frame);
    setOcrLifecycle((previous) => ({
      ...previous,
      surfaceValidated: false,
      surfaceConfidence: 0,
      plausibleTitles: 0,
      freshRectCount: 0,
      visibleFrameRevision: frame.revision,
    }));
  }, []);

  // Publish the visible frame FROM THE GEOMETRY OBSERVATION. This is the single
  // authority for what renders: presence/occlusion/rects/fingerprints come from
  // the pixel probe, per-slot identity is layered via identityForSlot (null →
  // SCANNING). Called by the geometry track every probe (it always has the
  // newest seq) and by the OCR track after it writes new identities (with the
  // current geometry seq, so it repaints the live frame). Stale geometry results
  // are rejected by frameResultIsCurrent(captureSeq, geometrySeqRef).
  const republishGeometryFrame = useCallback((captureSeq: number) => {
    const observation = geometryObservationRef.current;
    if (observation == null) return;
    if (!frameResultIsCurrent(captureSeq, geometrySeqRef.current)) return;
    const frame = buildGeometryVisibleFrame<SlotResolution>({
      revision: (visibleRevisionRef.current += 1),
      captureSeq,
      observation,
      generation: geometryGenerationRef.current,
      // SLOT GENERATION IS THE ONLY IDENTITY AUTHORITY HERE.
      //
      // These two closures used to compare the live frame's fingerprint against
      // the stored record's — a scalar chasing a signal that is bistable while a
      // card animates or the cursor sits on it. In the 2026-07-27 trace slot 1
      // oscillated 17 bits between two poles that BOTH read augment 1051 / S /
      // 52.0%, and the chip fell back to SCANNING on 24 of the offer's 72 frames
      // (38% of its wall time) while the card never changed. Worse, publishing
      // re-armed the mismatch: the record was stamped with whichever pole the
      // ~1-2 s OCR read landed on, so the next frame at the other pole blanked
      // it again. Phase B's confirmed-reroll path already owns replacement
      // detection and already bumps the generation; comparing raw fingerprints
      // here was a second, noisier authority racing it.
      //
      // Fingerprint evidence is NOT disabled and no threshold moved — it still
      // drives `advanceRerollConfirmation`, which is where the hysteresis lives.
      resolveIdentity: (regionIndex) => {
        const record = identityStoreRef.current[regionIndex];
        // Sustained-confirmation hold: a resolved slot whose fingerprint drift
        // is not yet a CONFIRMED reroll keeps its tier instead of flashing
        // SCANNING through hover glow / card animation. Phase B is the sole
        // authority that clears it, once the replacement is confirmed.
        if (record?.resolution != null && heldRerollSlotsRef.current.includes(regionIndex)) {
          return record.resolution;
        }
        return identityForSlot(record, slotGenerationsRef.current[regionIndex] ?? 0);
      },
      resolveUnresolvedState: (regionIndex) => {
        const record = identityStoreRef.current[regionIndex];
        if (
          !record
          || (record.slotGeneration ?? 0) !== (slotGenerationsRef.current[regionIndex] ?? 0)
          || record.resolution !== null
        ) {
          return "scanning";
        }
        return record.unresolvedState ?? "scanning";
      },
    });
    visibleFrameRef.current = frame;
    setVisibleFrame(frame);
    setOcrLifecycle((previous) => ({
      ...previous,
      surfaceValidated: frame.surfaceValidated,
      surfaceReason: observation.present
        ? (observation.occluded ? "occluded" : "present")
        : observation.rejectionReasons[0] ?? "absent",
      surfaceConfidence: observation.confidence,
      plausibleTitles: observation.cards.filter((card) => card.present).length,
      freshRectCount: frame.slots.filter((slot) => slot.cardRect !== null).length,
      visibleFrameRevision: frame.revision,
    }));
  }, []);

  const updateOfferRoundOwnership = useCallback((next: OfferRoundOwnership) => {
    offerRoundOwnershipRef.current = next;
    setSemanticOwner(next.activeOwner == null ? null : {
      gameEpoch: gameEpochRef.current,
      round: next.activeOwner.round,
      offerGeneration: next.activeOwner.offerGeneration,
    });
    completedRoundsRef.current = next.completedOwners.length;
    const current = roundDeliveryRef.current;
    if (!current) return;
    const nextDelivery: RoundDeliveryDecision = {
      ...current,
      pendingRounds: Math.max(0, current.eligibleRounds - completedRoundsRef.current),
      activeOfferRound: next.activeOwner?.round ?? Math.min(
        completedRoundsRef.current + 1,
        TOTAL_AUGMENT_ROUNDS,
      ),
    };
    roundDeliveryRef.current = nextDelivery;
    setRoundDelivery(nextDelivery);
  }, []);

  // Slots whose title resolved to a local-catalog augment — the decision-engine
  // path. Derived from the latched offer; always a single generation.
  const matchedCards = useMemo(
    (): MatchedCard[] =>
      offerState.slots.flatMap((slot) =>
        slot.resolution?.pool && slot.title
          ? [{
              augment: slot.resolution.pool,
              regionIndex: slot.regionIndex,
              ocrText: slot.title,
            }]
          : [],
      ),
    [offerState],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [augmentsFile, championsFile, combosFile, poolRulesFile] =
          await Promise.all([
            loadJson<{ augments: OverlayAugment[] }>("/data/augments.json"),
            loadJson<{ champions: OverlayChampion[] }>("/data/champions.json"),
            loadJson<{ combos: OverlayCombo[] }>("/data/combos.json"),
            loadJson<PoolRules>("/data/pool-rules.json"),
          ]);

        if (cancelled) return;

        setOverlayData({
          augments: augmentsFile.augments,
          champions: championsFile.champions,
          combos: combosFile.combos,
          poolRules: poolRulesFile,
        });
      } catch (error) {
        if (!cancelled) {
          setDataError(error instanceof Error ? error.message : "Failed to load overlay data");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void bootstrapMember()
      .then((snapshot) => {
        memberBootstrapCompleteRef.current = true;
        if (!cancelled) setMemberSnapshot(snapshot);
      })
      .catch((error) => {
        memberBootstrapCompleteRef.current = true;
        if (!cancelled) {
          setMemberSnapshot(
            disabledMember(error instanceof Error ? error.message : "member-bootstrap-failed"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!championSlug || abilityProfiles[championSlug] !== undefined) return;

    let cancelled = false;

    void loadJson<AbilityProfile>(`/data/abilities/${championSlug}.json`)
      .then((profile) => {
        if (cancelled) return;
        setAbilityProfiles((prev) => ({ ...prev, [championSlug]: profile }));
      })
      .catch(() => {
        if (cancelled) return;
        // Degrade to kit-agnostic scoring instead of a hard error banner —
        // a missing per-champion profile must not break augment screens.
        setAbilityProfiles((prev) => ({ ...prev, [championSlug]: null }));
        console.warn(`ability profile unavailable for ${championSlug}; scoring without kit fit`);
      });

    return () => {
      cancelled = true;
    };
  }, [abilityProfiles, championSlug]);

  // On mount: check local OCR and capture prerequisites.
  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("check_ocr").then((ok) => {
      if (!cancelled) setOcrAvailability(createOcrAvailability(ok));
    }).catch(() => {
      if (!cancelled) setOcrAvailability(createOcrAvailability(false));
    });
    invoke<boolean>("check_screen_capture_available").then((ok) => {
      if (!ok) invoke("open_screen_recording_settings");
    });
    const tipTimer = setTimeout(() => setShowStartupTip(false), 6000);
    return () => {
      cancelled = true;
      clearTimeout(tipTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshCalibration = async () => {
      try {
        const nextCalibration = await invoke<OverlayCalibration>("get_overlay_calibration");
        if (!cancelled) {
          setCalibration(nextCalibration);
          setCalibrationError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setCalibrationError(
            error instanceof Error ? error.message : "overlay-calibration-unavailable",
          );
        }
      }
    };

    void refreshCalibration();
    const intervalId = setInterval(() => {
      void refreshCalibration();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!collectorStatus) return;
    invoke("set_dock_visible", { visible: collectorStatus.consent === "pending" });
  }, [collectorStatus]);

  const championSlugByName = useMemo(() => {
    const map = new Map<string, string>();
    const champs = overlayData?.champions ?? [];

    for (const champion of champs) {
      map.set(champion.name.toLowerCase(), champion.slug);
      map.set(normalizeChampionName(champion.name), champion.slug);
      if (champion.name_zh_TW) map.set(champion.name_zh_TW, champion.slug);
      if (champion.name_zh_CN) map.set(champion.name_zh_CN, champion.slug);
      if (champion.name_ja) map.set(champion.name_ja, champion.slug);
      if (champion.name_ko) map.set(champion.name_ko, champion.slug);
    }

    return map;
  }, [overlayData]);

  const knownChampionSlugs = useMemo(
    () => new Set((overlayData?.champions ?? []).map((champion) => champion.slug)),
    [overlayData],
  );

  const champNameToSlug = useCallback(
    (name: string): string | null =>
      resolveKnownChampionSlug(name, championSlugByName, knownChampionSlugs),
    [championSlugByName, knownChampionSlugs],
  );

  const comboBySlug = useMemo(() => {
    if (!championSlug || !overlayData) return new Map<string, ComboTier>();

    return new Map<string, ComboTier>(
      overlayData.combos
        .filter((combo) => combo.champion === championSlug)
        .map((combo) => [
          combo.augmentSlug ?? combo.augment.replace(/ /g, "-"),
          combo.tier as ComboTier,
        ]),
    );
  }, [championSlug, overlayData]);

  // Build champion pool
  const poolData = useMemo((): ChampionPoolBreakdown | null => {
    if (!championSlug || !overlayData) return null;

    const champ = overlayData.champions.find((c) => c.slug === championSlug);
    if (!champ) return null;

    const abilityProfileState = abilityProfiles[championSlug];
    if (abilityProfileState === undefined) return null;

    const abilityProfile = abilityProfileState ?? undefined;

    return buildChampionPool(
      championSlug,
      overlayData.augments,
      {
        win_rate: champ.win_rate,
        tags: champ.tags,
        kit_tags: champ.kit_tags,
        baseStats: champ.baseStats,
      },
      abilityProfile,
      comboBySlug,
      overlayData.poolRules,
    );
  }, [abilityProfiles, championSlug, comboBySlug, overlayData]);

  // Build all-name lookup for OCR matching. Champion-pool scores override fallback
  // scores, but real in-game offers outside the predicted pool still match.
  const nameLookup = useMemo(() => {
    if (!championSlug || !overlayData) return new Map<string, PoolAugment>();

    const champ = overlayData.champions.find((c) => c.slug === championSlug);
    if (!champ) return new Map<string, PoolAugment>();

    const abilityProfileState = abilityProfiles[championSlug];
    if (abilityProfileState === undefined) return new Map<string, PoolAugment>();

    return buildOverlayAugmentLookup({
      allAugments: overlayData.augments,
      championWinRate: champ.win_rate,
      comboTiers: comboBySlug,
      poolData,
      abilityProfile: abilityProfileState ?? undefined,
    });
  }, [abilityProfiles, championSlug, comboBySlug, overlayData, poolData]);

  const decisionData = useMemo((): DecisionEngineData | null => {
    if (!championSlug || !overlayData) return null;
    const champion = overlayData.champions.find((entry) => entry.slug === championSlug);
    const abilityProfileState = abilityProfiles[championSlug];
    if (!champion || abilityProfileState === undefined) return null;
    return {
      champion: {
        slug: champion.slug,
        winRate: champion.win_rate,
        kitTags: champion.kit_tags ?? [],
        abilityProfile: abilityProfileState ?? undefined,
        baseStats: champion.baseStats,
      },
      augments: overlayData.augments as DecisionEngineData["augments"],
      poolRules: overlayData.poolRules,
      comboTiers: Object.fromEntries(comboBySlug),
    };
  }, [abilityProfiles, championSlug, comboBySlug, overlayData]);

  const winRateBySlug = useMemo(
    () =>
      Object.fromEntries(
        (overlayData?.augments ?? []).map((augment) => [augment.slug, augment.win_rate]),
      ),
    [overlayData],
  );

  const ocrKnownNames = useMemo(() => {
    if (!overlayData) return [];

    return overlayData.augments.flatMap((augment) =>
      [
        augment.name,
        augment.name_zh_TW,
        augment.name_zh_CN,
        augment.name_ja,
        augment.name_ko,
      ].filter((name): name is string => Boolean(name)),
    );
  }, [overlayData]);

  const decisionResult = useMemo((): DecisionResult | null => {
    if (
      !memberCoachEnabled ||
      !memberSnapshot?.modelConfig ||
      !decisionData ||
      !roundDelivery ||
      !isCompleteThreeCardOffer(matchedCards)
    ) {
      return null;
    }
    const screenRarity = matchedCards[0].augment.rarity;
    return runLocalInference(
      {
        championSlug: decisionData.champion.slug,
        round: roundDelivery.activeOfferRound as 1 | 2 | 3 | 4,
        screenRarity,
        mode,
        ownedAugmentSlugs: pickedAugments,
        currentItemIds: [],
        plannedItemIds: [],
        offeredAugmentSlugs: matchedCards.map((card) => card.augment.slug),
        rerollsRemaining: 1,
        goldenRerollAvailable: false,
      },
      decisionData,
      memberSnapshot.modelConfig,
    );
  }, [
    decisionData,
    matchedCards,
    memberCoachEnabled,
    memberSnapshot,
    mode,
    pickedAugments,
    roundDelivery,
  ]);

  // ─── Dev ARAMGG fixture / geometry preview (dev flags only) ───
  // TIER_FIXTURE: canonical ARAMGG stats over REAL OCR-detected cards — never
  // injects geometry, never forces focus/phase, so it can never mask real OCR.
  // GEOMETRY_PREVIEW: synthetic cards, ONLY when League is absent, watermarked.
  const currentChampionId =
    overlayData?.champions.find((champion) => champion.slug === championSlug)?.champion_key ?? null;
  const aramgg = useAramggTierFixture(
    tierFixtureOn || geometryPreviewOn,
    overlayData?.augments,
    currentChampionId,
  );
  // A final-champion change starts a new champion generation and invalidates
  // every resolved slot, so each re-resolves against the new champion's own
  // dataset (Section 6: champion change recomputes every resolved slot). Within
  // a generation the reconcile guard then holds each verified identity immutable.
  useEffect(() => {
    championGenerationRef.current += 1;
    championIdRef.current = currentChampionId;
    baselineSettlementRef.current = null;
    ocrOwnersRef.current.invalidate();
    probeInFlightRef.current = false;
    probeInFlightSinceRef.current = null;
    identityStoreRef.current = [null, null, null];
    // Advance every slot generation so any in-flight OCR run from the previous
    // champion is superseded and rejected on completion (Phase B).
    slotGenerationsRef.current = slotGenerationsRef.current.map((g) => g + 1);
  }, [championSlug, currentChampionId]);

  // Ref so the OCR loop always resolves against the freshest ARAMGG source
  // without re-creating the scan callback when the source loads.
  const aramggResolveRef = useRef(aramgg.resolveSlotTitle);
  useEffect(() => {
    aramggResolveRef.current = aramgg.resolveSlotTitle;
  }, [aramgg.resolveSlotTitle]);

  // Champion-dataset meta for privacy-safe diagnostics (completeness, load size,
  // status). Kept in refs so the OCR scan callback reads the freshest values
  // without re-creating on every dataset change.
  const championDataMetaRef = useRef({
    status: aramgg.championDataStatus,
    completeness: aramgg.championCompleteness,
    loadedCount: aramgg.championLoadedCount,
  });
  useEffect(() => {
    championDataMetaRef.current = {
      status: aramgg.championDataStatus,
      completeness: aramgg.championCompleteness,
      loadedCount: aramgg.championLoadedCount,
    };
  }, [aramgg.championDataStatus, aramgg.championCompleteness, aramgg.championLoadedCount]);

  const fixtureMode = resolveOverlayFixtureMode({
    tierFixtureOn,
    previewOn: geometryPreviewOn,
    gameWindowForeground,
    phase,
    offerActive: offerActive(offerState),
    aramggReady: aramgg.status === "ready",
  });

  // Synthetic cards exist ONLY in explicit preview mode (League absent). They
  // are never used to fill a real offer or a transient OCR gap.
  const previewCards = useMemo((): MatchedCard[] => {
    if (fixtureMode.kind !== "preview" || !overlayData) return [];
    const chosen = overlayData.augments
      .filter((a) => aramgg.resolvedBySlug.has(a.slug))
      .sort((l, r) => l.slug.localeCompare(r.slug))
      .slice(0, 3);
    if (chosen.length < 3) return [];
    return chosen.map((a, regionIndex) => ({
      regionIndex,
      ocrText: a.name,
      augment: {
        slug: a.slug,
        name: a.name,
        name_zh_TW: a.name_zh_TW,
        lifecycle: a.flags?.lifecycle,
        win_rate: a.win_rate ?? 50,
        score: 0,
        tier: "A",
        rarity: a.rarity,
        probability: 0,
        probabilityWithReroll: 0,
      },
    }));
  }, [fixtureMode.kind, aramgg.resolvedBySlug, overlayData]);

  const isPreviewMode = fixtureMode.kind === "preview";
  const gameOverlayIsVisible = gameOverlayVisible({
    gameWindowForeground,
    previewMode: isPreviewMode,
  });

  // The full-screen visual overlay must not capture the desktop. Bounded
  // consent/collector windows own their own mouse interaction.
  useEffect(() => {
    invoke("set_click_through", {
      ignore: overlayShouldIgnoreMouseEvents({
        coachOpen: coachOpen && gameOverlayIsVisible,
      }),
    });
  }, [coachOpen, gameOverlayIsVisible]);

  // Build the ARAMGG-backed decision result from whichever cards are active.
  const fixturePayload = useMemo(() => {
    const round = (roundDelivery?.activeOfferRound ?? 1) as 1 | 2 | 3 | 4;
    if (fixtureMode.kind === "real-offer") {
      // Latched slots whose staged resolution reached a live ARAMGG record.
      const cards = offerState.slots.flatMap((slot): AramggFixtureCard[] => {
        const staged = slot.resolution?.aramgg;
        if (!staged || staged.kind !== "matched") return [];
        const slug =
          staged.localSlug ??
          staged.riot.canonicalName ??
          `riot-${staged.riot.augmentId}`;
        return [{ slug, stat: staged.stat, method: staged.riot.method }];
      });
      if (cards.length === 0) return null;
      return buildAramggDecisionResult(cards, round);
    }
    if (fixtureMode.kind === "preview") {
      const cards = [...previewCards]
        .sort((left, right) => left.regionIndex - right.regionIndex)
        .map((card): AramggFixtureCard | null => aramgg.resolvedBySlug.get(card.augment.slug) ?? null)
        .filter((card): card is AramggFixtureCard => card !== null);
      if (cards.length === 0) return null;
      return buildAramggDecisionResult(cards, round);
    }
    return null;
  }, [fixtureMode.kind, offerState, previewCards, aramgg.resolvedBySlug, roundDelivery]);

  const isFixtureBacked = fixturePayload != null; // ARAMGG-backed → no fake P:50%

  const badgeDecisionResult = fixturePayload?.result ?? decisionResult;
  const badgeWinRateBySlug: Record<string, number | string | null> =
    fixturePayload?.winRateDisplayBySlug ?? winRateBySlug;

  // Real per-slot chips: driven SOLELY by the VisibleOfferFrame — the current
  // capture's fresh, multi-signal-validated evidence — never by the internal
  // latch. A slot renders only when this capture supplied it a card rect; a
  // capture that does not validate the surface yields an empty frame, so no
  // chip or placeholder can linger over combat, respawn, the scoreboard, or a
  // new map. Preview chips: only in preview mode.
  const augmentOverlayGate: RealAugmentOverlayGate = {
    devBuild: import.meta.env.DEV,
    // The development bypass needs the EXPLICIT fixture flag; a plain dev
    // launch is not authorization. See localOverlayAuthorized.
    tierFixtureEnabled: tierFixtureOn,
    memberCoachEnabled,
    previewMode: isPreviewMode,
    visibleFrameRenderable: visibleFrameRenderable(visibleFrame, gameWindowForeground),
    offerSurfaceRenderable: offerSurface.render,
    // Only a recent accepted authoritative geometry result certifies rendering.
    // Attempt starts/watchdog replacements never refresh this gate.
    geometrySchedulerHealthy: geometrySchedulerIsHealthy,
  };
  const realFrameRenderable = realAugmentOverlayRenderable(augmentOverlayGate);
  const previewBadgesReady =
    isPreviewMode && fixturePayload != null && previewCards.length === 3;
  const showBadgeLayer = realFrameRenderable || previewBadgesReady;

  const slotChips = useMemo((): SlotChip[] => {
    if (previewBadgesReady && fixturePayload) {
      return previewCards.flatMap((card): SlotChip[] => {
        const candidate = fixturePayload.result.candidates.find(
          (entry) => entry.augmentSlug === card.augment.slug,
        );
        if (!candidate) return [];
        return [{
          regionIndex: card.regionIndex,
          key: `preview-${card.regionIndex}-${card.augment.slug}`,
          state: "tier",
          tier: tierForGrade(candidate.grade),
          winRateText: compactWinRateFromPercent(
            fixturePayload.winRateDisplayBySlug[card.augment.slug],
          ),
          isNew: card.augment.lifecycle === "added",
          // Champion-only: a resolved stat is always champion-specific.
          statScope:
            aramgg.resolvedBySlug.get(card.augment.slug)?.stat.provenance === "champion"
              ? "champion"
              : null,
        }];
      });
    }
    if (!realFrameRenderable || !visibleFrame) return [];
    const publicationOwner = semanticOwner?.offerGeneration === offerSurface.offerGeneration
      ? semanticOwner
      : null;
    return visibleFrame.slots.flatMap((slot): SlotChip[] => {
      // A slot with no fresh rect from THIS capture is never rendered — the
      // rectangle must belong to the current frame's generation, not history.
      if (slot.cardRect === null) return [];
      const base = {
        regionIndex: slot.regionIndex,
        key: `slot-${slot.regionIndex}-g${visibleFrame.generation}`,
      };
      const semanticPublication = (
        terminalState: SemanticPublication["terminalState"],
        noDataVerified: boolean,
        failureCategory: RoundContentFailureCategory,
      ): SemanticPublication | undefined => publicationOwner == null ? undefined : {
        ...publicationOwner,
        slot: slot.regionIndex,
        publicationGeneration: visibleFrame.generation,
        terminalState,
        noDataVerified,
        failureCategory,
      };
      if (slot.resolution === null) {
        // Geometry confirms a card here, but its identity is pending (fresh
        // trigger, reroll re-read in flight, or unreadable) — show SCANNING, not
        // nothing: the chip must never vanish merely because OCR hasn't caught up.
        return [{
          ...base,
          state: slot.unresolvedState ?? "scanning",
          tier: null,
          winRateText: null,
          isNew: false,
          statScope: null,
          semanticPublication: semanticPublication(
            slot.unresolvedState === "scanning" || slot.unresolvedState == null
              ? "loading-data"
              : "error",
            false,
            slot.unresolvedState === "scanning" || slot.unresolvedState == null
              ? null
              : "FAIL_IDENTITY",
          ),
        }];
      }
      const staged = slot.resolution?.aramgg;
      if (staged) {
        if (staged.kind === "matched") {
          return [{
            ...base,
            state: "tier",
            tier: staged.stat.tierLetter,
            // Exact string pipeline from the raw ARAMGG fraction ("0.5915" →
            // "59.2%"); the raw value stays on the stat for diagnostics.
            winRateText: compactWinRateFromFraction(staged.stat.rawWinRate),
            isNew: slot.resolution?.pool?.lifecycle === "added",
            // Champion-only: a matched stat is always champion-specific.
            statScope: staged.stat.provenance === "champion" ? "champion" : null,
            semanticPublication: semanticPublication("resolved", false, null),
          }];
        }
        if (staged.kind === "no-data") {
          // Identity resolved; the COMPLETE champion dataset has no row → NO CHAMP DATA.
          return [{ ...base, state: "no-data", tier: null, winRateText: null, isNew: false, statScope: null, semanticPublication: semanticPublication("no-data", true, null) }];
        }
        if (staged.kind === "loading") {
          // Champion dataset still loading (or partial): absence is unproven.
          return [{ ...base, state: "loading-data", tier: null, winRateText: null, isNew: false, statScope: null, semanticPublication: semanticPublication("loading-data", false, null) }];
        }
        if (staged.kind === "error") {
          // Champion dataset fetch failed — never fall back to a global value.
          return [{ ...base, state: "data-error", tier: null, winRateText: null, isNew: false, statScope: null, semanticPublication: semanticPublication("error", false, "FAIL_DATA") }];
        }
        return [{ ...base, state: "unmatched", tier: null, winRateText: null, isNew: false, statScope: null, semanticPublication: semanticPublication("error", false, "FAIL_IDENTITY") }];
      }
      // Engine path (no dev fixture): the local-catalog match backs the chip.
      const pool = slot.resolution?.pool ?? null;
      if (!pool) {
        return [{ ...base, state: "unmatched", tier: null, winRateText: null, isNew: false, statScope: null, semanticPublication: semanticPublication("error", false, "FAIL_IDENTITY") }];
      }
      const candidate = decisionResult?.candidates.find(
        (entry) => entry.augmentSlug === pool.slug,
      );
      return [{
        ...base,
        state: "tier",
        tier: candidate ? tierForGrade(candidate.grade) : pool.tier,
        winRateText: compactWinRateFromPercent(pool.win_rate),
        isNew: pool.lifecycle === "added",
        statScope: null,
        semanticPublication: semanticPublication("resolved", false, null),
      }];
    });
  }, [previewBadgesReady, fixturePayload, previewCards, realFrameRenderable, visibleFrame, semanticOwner, offerSurface.offerGeneration, decisionResult, aramgg.resolvedBySlug]);

  // THE render-ready badge collection. A chip only appears here once it has a
  // real screen position, so this — not `slotChips` — is what the JSX maps and
  // what the diagnostic counts. Missing calibration, a slot the current capture
  // supplied no rect for, and a placement helper that finds nowhere to put the
  // chip all drop it from BOTH at once, which is the only way the reported
  // count can equal the number of badge elements actually on screen.
  const positionedChips = useMemo(
    () =>
      positionBadgeChips({
        chips: slotChips,
        calibration,
        slots: visibleFrame?.slots ?? null,
        cssWindow,
      }),
    [slotChips, calibration, visibleFrame, cssWindow],
  );

  // DEV-only: the FINAL badge-layer gate — the ONE decision that knows whether
  // augment badges actually reached the screen. `[offer-session].render` is an
  // intermediate offer-surface decision taken before authorization, preview
  // mode, the visible frame, and geometry-scheduler health are consulted, so it
  // can never certify a visible badge; only this record can. Bounded booleans /
  // enums / small counts only — no augment names, OCR text, identifiers, or raw
  // geometry. One record per logical decision change, so a steady overlay does
  // not flood the trace. The leading `import.meta.env.DEV` lets the production
  // build fold the tag, the reason strings, and the helpers out of the bundle.
  const badgeLayerVisibleFrame = augmentOverlayGate.visibleFrameRenderable;
  const badgeLayerOfferSurface = augmentOverlayGate.offerSurfaceRenderable;
  const badgeLayerOfferGeneration = offerSurface.offerGeneration;
  // Counted from the positioned collection, never from `slotChips`: a chip with
  // no DOM position paints nothing, so counting it would let the analyzer
  // certify `rendered` for a badge layer that was never drawn.
  const badgeLayerRealCount = realFrameRenderable ? positionedChips.length : 0;
  const badgeLayerPreviewCount = previewBadgesReady ? positionedChips.length : 0;
  const lastBadgeLayerSignatureRef = useRef<string | null>(null);
  const emittedRoundContentOwnerKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const decision = describeBadgeLayerDecision({
      devBuild: import.meta.env.DEV,
      tierFixtureEnabled: tierFixtureOn,
      memberCoachEnabled,
      previewMode: isPreviewMode,
      visibleFrameRenderable: badgeLayerVisibleFrame,
      offerSurfaceRenderable: badgeLayerOfferSurface,
      geometrySchedulerHealthy: geometrySchedulerIsHealthy,
      offerGeneration: badgeLayerOfferGeneration,
      renderedBadgeCount: badgeLayerRealCount,
      previewBadgeCount: badgeLayerPreviewCount,
    });
    // Mirrors the analyzer's own `visibleBadgeGeneration`: the offer
    // generation whose badges are certified visible RIGHT NOW, or null.
    // publishForeground reads this synchronously (P2 fix) to name the
    // generation a foreground-loss transition applies to, before stopOcr()
    // tears anything down.
    visibleBadgeGenerationRef.current = decision.badgeLayerVisible
      ? decision.offerGeneration
      : null;
    const signature = badgeLayerSignature(decision, gameEpochRef.current);
    if (lastBadgeLayerSignatureRef.current === signature) return;
    lastBadgeLayerSignatureRef.current = signature;
    reportBadgeLayerDecision(decision, gameEpochRef.current);
  }, [
    tierFixtureOn,
    memberCoachEnabled,
    isPreviewMode,
    badgeLayerVisibleFrame,
    badgeLayerOfferSurface,
    geometrySchedulerIsHealthy,
    badgeLayerOfferGeneration,
    badgeLayerRealCount,
    badgeLayerPreviewCount,
  ]);

  useEffect(() => {
    if (!import.meta.env.DEV || isPreviewMode) return;
    if (semanticOwner?.offerGeneration !== offerSurface.offerGeneration) return;
    const root = document.querySelector<HTMLElement>(".overlay-root");
    if (!root) return;
    const expectedPublications = positionedChips.flatMap(({ chip }) =>
      chip.semanticPublication ? [chip.semanticPublication] : []
    );
    const domAcknowledgements = parseRoundContentAcknowledgements(root);
    const renderedContainerCount = root.querySelectorAll(".badge-chip").length;
    const decision = evaluateRoundContentCompletion({
      owner: {
        gameEpoch: semanticOwner.gameEpoch,
        round: semanticOwner.round,
        offerGeneration: semanticOwner.offerGeneration,
      },
      expectedPublications,
      domAcknowledgements,
      renderedContainerCount,
      schedulerHealthy: geometrySchedulerIsHealthy,
    });
    const emission = reduceRoundContentEmission(
      emittedRoundContentOwnerKeyRef.current,
      semanticOwner,
      decision,
    );
    emittedRoundContentOwnerKeyRef.current = emission.emittedOwnerKey;
    if (!emission.emit) return;
    emitNativeDiagnostic("[round-content-complete]", {
      gameEpoch: semanticOwner.gameEpoch,
      round: semanticOwner.round,
      offerGeneration: semanticOwner.offerGeneration,
      result: decision.result,
    });
  }, [
    isPreviewMode,
    semanticOwner,
    offerSurface.offerGeneration,
    positionedChips,
    geometrySchedulerIsHealthy,
  ]);

  // Staged diagnostics counters (never conflate injected with detected).
  const diag = {
    cardsCaptured: ocrDiagnostics.filter((d) => d.captureSucceeded).length,
    titlesRead: ocrDiagnostics.filter((d) => d.rawText).length,
    riotResolved: offerState.slots.filter(
      (slot) => slot.resolution?.aramgg && slot.resolution.aramgg.kind !== "unmatched",
    ).length,
    aramggMatched: offerState.slots.filter(
      (slot) => slot.resolution?.aramgg?.kind === "matched",
    ).length,
    ocrDetected: offerState.slots.filter((slot) => slot.fingerprint !== null).length,
    previewInjected: isPreviewMode ? previewCards.length : 0,
    offeredMatched: matchedCards.length,
    catalogResolved: aramgg.resolvedBySlug.size,
    // Positioned, not merely intended: the dev banner reports what is painted.
    renderedRealBadges: realFrameRenderable
      ? positionedChips.filter(({ chip }) => chip.state === "tier").length
      : 0,
    renderedPreviewBadges: previewBadgesReady ? positionedChips.length : 0,
  };

  // FIX 2 — the render-authoritative publication snapshot. The dev banner reads
  // THIS (never the raw OCR pipeline counts in `diag`, nor the internal latch),
  // so it can never claim "no visible offer" while resolved badges render. The
  // geometry seq is the accepted frame's own captureSeq.
  const authoritative = summarizeAuthoritativePublication({
    renderable: realFrameRenderable,
    slots: slotChips.map((chip) => ({
      hasRect: true,
      resolved: chip.state === "tier",
      scanning: chip.state === "scanning",
    })),
    offerGeneration: offerSurface.offerGeneration,
    geometrySeq: visibleFrame?.captureSeq ?? 0,
    retainedContinuity: offerSurface.state === "UNCERTAIN",
  });

  // Synchronously clear the visible surface. Advancing the probe seq invalidates
  // any in-flight probe's late result (it can never repaint a stale frame), then
  // an explicit empty frame is published immediately — no wait for the next
  // probe, two misses, or a telemetry poll. `clearLatch` also drops the internal
  // identity latch (game exit / focus loss); otherwise the latch stays as
  // nonvisual grace for brief restoration.
  const clearSurface = useCallback((clearLatch: boolean) => {
    updateOfferRoundOwnership(reduceOfferRoundOwnership(
      offerRoundOwnershipRef.current,
      {
        type: "presentation-cleared",
        offerGeneration: offerSurfaceRef.current.offerGeneration,
      },
    ));
    const closedSurface: OfferSurfaceState = {
      ...createOfferSurfaceState(),
      offerGeneration: offerSurfaceRef.current.offerGeneration + 1,
      captureValid: true,
    };
    offerSurfaceRef.current = closedSurface;
    geometryGenerationRef.current = closedSurface.offerGeneration;
    setOfferSurface(closedSurface);
    if (clearLatch) {
      resetOffer();
      setOcrDiagnostics([]);
      // Drop the geometry-keyed identity store and last observation so a stale
      // present result cannot repaint after a game exit / focus loss. Advancing
      // the geometry seq stale-rejects any in-flight geometry probe too.
      identityStoreRef.current = [null, null, null];
      acceptedSlotFingerprintsRef.current = ["", "", ""];
      geometryObservationRef.current = null;
      geometrySurfaceStateRef.current = createGeometrySurfaceState();
      geometryHealthRef.current = createGeometryHealthClocks();
      ocrPendingSlotsRef.current = [];
    }
    lastGeometryRenderableRef.current = false;
    setGeometrySchedulerIsHealthy(false);
    geometryFreshnessWarningSeqRef.current = null;
    geometryExpiryWarningSeqRef.current = null;
    bumpScanSeq();
    baselineSettlementRef.current = null;
    ocrOwnersRef.current.invalidate();
    probeInFlightRef.current = false;
    probeInFlightSinceRef.current = null;
    geometrySeqRef.current += 1;
    // The cleared frame carries the GEOMETRY capture sequence it was published
    // under — never scanSeqRef, the OCR track's counter. The two advance ~20x
    // apart, so publishing the OCR one sent the HUD's geoseq BACKWARD (590 → 90
    // live) and left it frozen there, reading as healthy geometry during a stall.
    publishEmptyVisibleFrame(geometrySeqRef.current, performance.now());
    setOcrLifecycle((previous) => ({
      ...previous,
      phase: phaseRef.current,
      currentRound: roundDeliveryRef.current?.activeOfferRound ?? null,
      active: false,
      scanRunId: null,
      captureAttempted: false,
      cropCount: 0,
      noCropReason: "surface-cleared",
    }));
  }, [bumpScanSeq, publishEmptyVisibleFrame, resetOffer, updateOfferRoundOwnership]);

  const stopOcr = useCallback(() => {
    clearSurface(true);
  }, [clearSurface]);

  const finishOcr = useCallback(() => {
    clearSurface(false);
  }, [clearSurface]);

  /**
   * The ONLY way foreground truth reaches the app. A real settle and the
   * logical-freshness degrade-to-unknown must both run every consequence of a
   * classification change: the ref write, the epoch bump that invalidates
   * in-flight probes, the setState change-detect, and the blur `stopOcr()`.
   * Publishing `unknown` by hand from the timeout path would skip the blur and
   * leave the surface painted after foreground truth had already expired.
   */
  const publishForeground = useCallback((nextForeground: ForegroundState): ForegroundState => {
    const previousForeground = foregroundStateRef.current;
    foregroundStateRef.current = nextForeground;
    if (nextForeground.gameWindowForeground !== previousForeground.gameWindowForeground) {
      // A focus flip starts a new foreground epoch: a probe that captured
      // under the old focus can never publish after the change.
      foregroundEpochRef.current += 1;
    }
    const changed = [
      "gameWindowForeground",
      "leagueClientForeground",
      "riotClientForeground",
      "gameRunning",
      "gameWindowDetected",
      "foregroundAppName",
      "foregroundBundleIdentifier",
      "foregroundOwnerName",
      "foregroundWindowTitle",
      "foregroundExecutablePath",
      "foregroundWindowHandle",
    ].some((key) => (
      nextForeground[key as keyof ForegroundState] !==
      previousForeground[key as keyof ForegroundState]
    ));
    if (changed) setForegroundState(nextForeground);
    if (
      import.meta.env.DEV &&
      nextForeground.gameWindowForeground !== previousForeground.gameWindowForeground
    ) {
      // DEV-only: dump the full native candidate walk (every window, its
      // exclusion verdict, the selected authority, the decision reason)
      // whenever the classification flips. Compiled out of production.
      void invoke("get_foreground_diagnostic")
        .then((diagnostic) => {
          console.info("[foreground-diagnostic]", JSON.stringify(diagnostic));
        })
        .catch(() => {});
    }
    if (!nextForeground.gameWindowForeground && previousForeground.gameWindowForeground) {
      // P2 fix (focus-loss-before-clear ordering): record the deterministic
      // foreground-loss transition BEFORE stopOcr() tears anything down, so
      // the analyzer has an unambiguous, generation-bound trigger to open
      // focus loss even when this is the ONLY trace evidence of the alt-tab
      // (OCR stopping immediately means no later offer-session foreground:false
      // record, and the scheduler halting means native geometry may never
      // accumulate a qualifying not-foreground streak). Only fires when
      // badges were actually certified visible — nothing to lose otherwise.
      if (visibleBadgeGenerationRef.current !== null) {
        emitNativeDiagnostic("[focus-transition]", {
          transition: "foreground-loss",
          offerGeneration: visibleBadgeGenerationRef.current,
          gameEpoch: gameEpochRef.current,
        });
      }
      // Focus left the game: hide the surface immediately (the probe would
      // skip anyway, but we must not wait for the health clock on a blur).
      stopOcr();
    }
    return nextForeground;
  }, [stopOcr]);

  /**
   * Bridge from the component's refs to the ownership loop. The loop itself
   * lives in `foregroundPollScheduler` so that "one unsettled invoke, released
   * only by the settle" is proven against a native call that never returns —
   * `get_foreground_state` is a sync Tauri command executing inline on the
   * IPC/main thread, so a second concurrent invoke queues in front of every
   * geometry probe rather than running beside it.
   */
  const foregroundPollHost = useMemo<ForegroundPollHost<ForegroundState>>(() => ({
    now: () => Date.now(),
    read: () => ({
      nativeStartedAt: foregroundNativeStartedAtRef.current,
      logicalTimeoutFiredForStartedAt: foregroundLogicalTimeoutFiredForRef.current,
    }),
    setNativeStartedAt: (value) => {
      foregroundNativeStartedAtRef.current = value;
    },
    latchLogicalTimeout: (startedAt) => {
      foregroundLogicalTimeoutFiredForRef.current = startedAt;
    },
    epoch: () => foregroundEpochRef.current,
    invoke: () => invoke<ForegroundState>("get_foreground_state")
      .catch(() => unknownForegroundState()),
    publish: publishForeground,
    publishUnknown: () => {
      publishForeground(unknownForegroundState());
    },
    log: (action, fields) => logOverlayDiagnostic("[foreground-poll]", { action, ...fields }),
  }), [publishForeground]);

  const refreshForeground = useCallback(
    (): Promise<ForegroundState | null> => pollForeground(foregroundPollHost),
    [foregroundPollHost],
  );

  // The single place that advances gameEpochRef and resets every per-game
  // latch that must not cross a CONFIRMED game boundary: a changed
  // authoritative game/session hash, backward valid game_time, or a
  // confirmed non-live close. Callers are responsible for also calling
  // stopOcr() to fail closed the offer/badge/publication/scheduler surface
  // at the same boundary (closeConfirmedGame already does, via
  // clearGameRenderState). An unconfirmed telemetry outage must never reach
  // this function — see suspendGameRuntimeForUnavailableTelemetry.
  const beginNewGameEpoch = useCallback(() => {
    gameEpochRef.current += 1;
    liveOwnershipAnnouncedRef.current = false;
    ocrSelectionCompletedRef.current = true;
    completedRoundsRef.current = 0;
    offerRoundOwnershipRef.current = createOfferRoundOwnership();
    setPickedAugments([]);
    lastRecordedRoundRef.current = "";
    memberVerificationTokenRef.current += 1;
    memberVerificationStateRef.current = IDLE_MEMBER_VERIFICATION_STATE;
  }, []);

  // Clears rendered/runtime UI and the OCR/geometry pipeline only. Never
  // touches game identity (lastGameTimeRef/activeGameHashRef) or the
  // activation latch by itself — callers decide whether this is a confirmed
  // close or a fail-closed suspend of an unconfirmed outage.
  const clearGameRenderState = useCallback((nextPhase: Phase) => {
    ocrSelectionCompletedRef.current = true;
    setActiveGame(false);
    setPlayerData(null);
    setChampionSlug(null);
    completedRoundsRef.current = 0;
    roundDeliveryRef.current = null;
    setRoundDelivery(null);
    setPickedAugments([]);
    setCoachOpen(false);
    stopOcr();
    updatePhase(nextPhase);
  }, [setActiveGame, stopOcr, updatePhase]);

  // CONFIRMED non-live gameflow: the match actually ended. Close game
  // identity ownership and reset the activation latch, so a later confirmed
  // game announces a fresh live-active.
  const closeConfirmedGame = useCallback((nextPhase: Phase) => {
    clearGameRenderState(nextPhase);
    lastGameTimeRef.current = null;
    lastRecordedRoundRef.current = "";
    activeGameHashRef.current = null;
    beginNewGameEpoch();
  }, [clearGameRenderState, beginNewGameEpoch]);

  // UNCONFIRMED telemetry outage past the fail-closed grace window: LCU
  // and/or Live Client Data are unavailable, so rendering/capture fail
  // closed operationally — but this alone is never proof the match ended.
  // Game identity ownership and the activation latch are preserved, so
  // recovery of the SAME match resumes instead of announcing a second
  // live-active or opening a new analyzer epoch.
  const suspendGameRuntimeForUnavailableTelemetry = useCallback((nextPhase: Phase) => {
    clearGameRenderState(nextPhase);
  }, [clearGameRenderState]);

  // Stage 2 per-slot identity resolution: maps a plausible title to its catalog
  // (Riot/ARAMGG) identity for chip content. Presence (Stage 1) never depends on
  // this succeeding — an offer whose names don't resolve is still a live offer.
  const resolveSlotTitle = useCallback((title: string): SlotResolution => {
    const match = diagnoseAugmentMatch(title, nameLookup);
    return {
      pool: match.augment,
      poolDiagnostic: match,
      aramgg: aramggResolveRef.current ? aramggResolveRef.current(title) : null,
    };
  }, [nameLookup]);

  // Stage 2 latch predicate: an offer latches on plausible TITLE presence, never
  // on catalog identity (an offer whose names are unknown is still an offer).
  const titlePresent = useCallback(() => true, []);

  // Champion-data completion may legitimately change only the statistic for
  // an already-verified canonical augment (LOADING/NO CHAMP DATA → the champion
  // row, once the complete dataset arrives). Reconcile the stored OCR identity
  // without invoking OCR again.
  useEffect(() => {
    if (!aramgg.resolveSlotTitle) return;
    const refreshedAt = performance.now();
    const refreshed = refreshSameOfferData({
      identityRecords: identityStoreRef.current,
      offer: offerStateRef.current,
      resolveByCanonicalId: (canonicalAugmentId, regionIndex) => {
        const record = identityStoreRef.current[regionIndex];
        if (!record?.ocrTitle) return null;
        const resolution = resolveSlotTitle(record.ocrTitle);
        return {
          canonicalAugmentId: slotResolutionAugmentId(resolution),
          resolution,
        };
      },
      recordMetadata: () => ({
        resolvedAt: refreshedAt,
        championGeneration: championGenerationRef.current,
        championRequestId: aramgg.championRequestId,
        championPatch: aramgg.championPatch,
        foregroundEpoch: foregroundEpochRef.current,
        gameEpoch: gameEpochRef.current,
      }),
    });
    if (!refreshed.changed) return;
    identityStoreRef.current = refreshed.identityRecords;
    publishOffer(refreshed.offer);
    if (refreshed.republish) republishGeometryFrame(geometrySeqRef.current);
  }, [
    aramgg.championPatch,
    aramgg.championRequestId,
    aramgg.resolveSlotTitle,
    publishOffer,
    republishGeometryFrame,
    resolveSlotTitle,
  ]);

  // ─── TRACK 1: geometry probe — presence / occlusion / visual freshness ──────
  // A cheap Rust PIXEL probe classifies the surface (present / occluded / absent)
  // and feeds a three-state hysteresis reducer. A single uncertain observation
  // preserves the last accepted frame; explicit absence/occlusion clears. It
  // NEVER runs OCR — it only decides which slots the OCR track should (re)read.
  const runGeometryProbe = useCallback(async (scheduledAt: number) => {
    // Counted BEFORE the invoke and released in the finally, so the scheduler
    // sees calls the watchdog abandoned but the platform never cancelled.
    geometryNativeOutstandingRef.current += 1;
    geometryInFlightRef.current = true;
    const startedAt = performance.now();
    const previousStartedAt = lastGeometryStartedAtRef.current;
    const previousCompletedAt = geometryHealthRef.current.lastNativeCompletionAt;
    geometryInFlightSinceRef.current = startedAt;
    lastGeometryStartedAtRef.current = startedAt;
    const captureSeq = (geometrySeqRef.current += 1);
    // Record THIS request's own start time, keyed by its capture sequence —
    // per-request ownership, not a single "oldest so far" scalar. A scalar
    // that is only set-if-null and only cleared once nativeOutstanding hits
    // zero cannot represent two concurrent native calls: if probe A settles
    // first while a wedge-recovery replacement B is still outstanding,
    // outstanding drops 2 -> 1 (never 0), so the scalar would keep reporting
    // A's stale start forever and silently keep the wedge discount
    // permanently active. Deleting only this request's own entry on settle
    // (below) makes that failure structurally impossible.
    geometryNativeStartsRef.current.set(captureSeq, startedAt);
    geometryInFlightTokenRef.current = captureSeq;
    geometryHealthRef.current = startGeometryAttempt(
      geometryHealthRef.current,
      captureSeq,
      startedAt,
    );
    const foregroundEpoch = foregroundEpochRef.current;
    const gameEpoch = gameEpochRef.current;
    const capturedAt = performance.now();
    try {
      let observation: GeometryObservation;
      try {
        observation = await invoke<GeometryObservation>("probe_augment_surface", {
          probeSeq: captureSeq,
          capturedAt,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "geometry-probe-failed";
        observation = emptyGeometryObservation(captureSeq, performance.now(), reason);
      }
      const completedAt = performance.now();
      // Stale-result rejection: apply only while this probe's seq is still newest,
      // the foreground epoch it captured under is unchanged, AND the game epoch it
      // captured under is unchanged. The seq bump in clearSurface()/stopOcr() is
      // paired synchronously with every confirmed epoch change today, but that
      // pairing is an implementation detail elsewhere in this file, not a contract
      // this function should depend on — the explicit check makes the guarantee
      // self-evident, matching runIdentityProbe's proven pattern.
      const stale =
        captureSeq !== geometrySeqRef.current ||
        foregroundEpoch !== foregroundEpochRef.current ||
        gameEpoch !== gameEpochRef.current;
      const captureValid =
        observation.captureWidth > 0 && observation.captureHeight > 0;
      const classification = classifyGeometryObservation(observation);
      const previousSurface = geometrySurfaceStateRef.current;
      if (stale && import.meta.env.DEV) {
        const priorPositive = previousSurface.lastPositiveObservation;
        let fingerprintChangeCount = 0;
        if (priorPositive != null) {
          for (let i = 0; i < observation.cards.length; i += 1) {
            if (observation.cards[i]?.present && fingerprintChanged(
              priorPositive.cards[i]?.fingerprint ?? "",
              observation.cards[i]?.fingerprint ?? "",
            )) fingerprintChangeCount += 1;
          }
        }
        const staleResult = { stale: true } as const;
        emitNativeDiagnostic("[offer-session]", describeOfferAcquisitionDiagnostic({
          roundOwner: offerRoundOwnershipRef.current.activeOwner?.round ?? null,
          offerGeneration: offerSurfaceRef.current.offerGeneration,
          geometrySequence: captureSeq,
          stale: staleResult.stale,
          surfaceClassification: classification,
          offerState: offerSurfaceRef.current.state,
          geometryAction: null,
          validCardCount: observation.cards.filter((card) => card.present).length,
          blueControlConfidence: observation.blueControl?.confidence ?? 0,
          fingerprints: observation.cards.map((card) => card.fingerprint || null) as [
            string | null,
            string | null,
            string | null,
          ],
          fingerprintChangeCount,
          confirmedRerollCount: 0,
          baselineSettling: baselineSettlementRef.current != null &&
            !baselineSettlementRef.current.latched,
          newOfferDetected: false,
          gameEpoch,
          foregroundEpoch,
          timeSinceLastAcceptedOfferMs: lastAcceptedOfferRef.current == null ||
            lastAcceptedOfferRef.current.gameEpoch !== gameEpoch
            ? null
            : Math.round(Math.max(
              0,
              completedAt - lastAcceptedOfferRef.current.monotonicMilliseconds,
            )),
        }));
      }
      const transition = stale
        ? null
        : advanceGeometrySurface(previousSurface, observation);
      const renderAuthoritative =
        captureValid &&
        transition != null &&
        transition.action !== "preserve" &&
        transition.hideReason !== "uncertain-without-positive";
      const healthBeforeCompletion = geometryHealthRef.current;
      geometryHealthRef.current = completeGeometryAttempt(
        healthBeforeCompletion,
        {
          attemptGeneration: captureSeq,
          completedAt,
          accepted: renderAuthoritative,
          renderAuthoritative,
        },
      );
      const healthAfterCompletion = geometryHealthRef.current;
      const continuousUnhealthyAgeMs =
        healthAfterCompletion.continuousUnhealthyStartedAt == null
          ? null
          : completedAt - healthAfterCompletion.continuousUnhealthyStartedAt;
      const acceptedGeometryAgeMs =
        healthAfterCompletion.lastAcceptedGeometryAt == null
          ? null
          : completedAt - healthAfterCompletion.lastAcceptedGeometryAt;

      // [geometry-timing] — throttled to 1/s, logged BEFORE the stale return. A
      // wedge supersedes EVERY probe (the 2 s watchdog restarts the seq first), so
      // logging after the return is silent in exactly the failure this diagnoses.
      // `nativeElapsedMs` (Rust probe total) vs `roundTripMs` (JS invoke
      // round-trip) is the decisive split: a large gap means the native work
      // finished fast and the delay is IPC/main-thread (sync commands run on the
      // main thread); a small gap means the capture path itself is slow.
      // Bounded numerics only; no names/text.
      const timingEpoch = Math.floor(completedAt / 1000);
      if (!captureValid || timingEpoch !== lastGeometryTimingEpochRef.current) {
        lastGeometryTimingEpochRef.current = timingEpoch;
        const roundTripMs = Math.round(completedAt - startedAt);
        // Attribution, not a decision: the split between the closure's own work
        // and the segments only a tokio async-runtime worker can advance is what
        // turns the next controlled game into a decisive experiment.
        const timing = decomposeGeometryTiming({
          roundTripMs,
          nativeElapsedMs: observation.elapsedMs,
          preCaptureMs: observation.preCaptureMs,
          captureMs: observation.captureMs,
          analysisMs: observation.analysisMs,
          dispatchWaitMs: observation.dispatchWaitMs,
          resumeWaitMs: observation.resumeWaitMs,
        });
        logOverlayDiagnostic("[geometry-timing]", {
          probeSeq: captureSeq,
          stale,
          preCaptureMs: observation.preCaptureMs,
          captureMs: observation.captureMs,
          analysisMs: observation.analysisMs,
          nativeElapsedMs: observation.elapsedMs,
          roundTripMs,
          timeoutClassification: classifyProbeTimeout({
            captureWidth: observation.captureWidth,
            captureHeight: observation.captureHeight,
            rejectionReasons: observation.rejectionReasons,
            roundTripMs,
            nativeElapsedMs: observation.elapsedMs,
          }),
          attemptGeneration: captureSeq,
          continuousUnhealthyAgeMs,
          acceptedGeometryAgeMs,
          dispatchWaitMs: timing.dispatchWaitMs,
          resumeWaitMs: timing.resumeWaitMs,
          closureWorkMs: timing.closureWorkMs,
          unattributedNativeMs: timing.unattributedNativeMs,
          transportMs: timing.transportMs,
          asyncRuntimeMs: timing.asyncRuntimeMs,
        });
      }

      if (stale) return;
      const healthy = geometrySchedulerHealthy({
        now: completedAt,
        foreground: foregroundStateRef.current.gameWindowForeground,
        activeGame: activeGameRef.current,
        lastAcceptedGeometryAt: healthAfterCompletion.lastAcceptedGeometryAt,
      });
      setGeometrySchedulerIsHealthy(healthy);
      if (
        renderAuthoritative &&
        healthBeforeCompletion.continuousUnhealthyStartedAt != null
      ) {
        logOverlayDiagnostic("[geometry-recovery]", {
          attemptGeneration: captureSeq,
          continuousUnhealthyAgeMs:
            completedAt - healthBeforeCompletion.continuousUnhealthyStartedAt,
          acceptedGeometryAgeMs: 0,
          renderAuthoritativeGeometryAgeMs: 0,
          classification,
        });
      }

      if (transition == null) return;
      geometrySurfaceStateRef.current = transition.state;
      geometryObservationRef.current = transition.action === "preserve"
        ? previousSurface.visualObservation
        : transition.action === "publish"
          ? transition.state.visualObservation
          : observation;

      // A NEW offer (absent→present or ≥2 slots swapped) bumps the render
      // generation; a queued-round REPLACEMENT (previous offer was present) is
      // strong round-completion evidence. A first appearance is NOT a completion.
      // A genuine close (a fresh valid zero-card frame → clear →
      // lastPositiveObservation nulled) is the session boundary; a single
      // capture failure or preserved borderline frame is NOT, so a
      // one-slot reroll that coincides with a dropped frame stays the same
      // session and only that slot re-arms.
      const publishedObservation = transition.state.visualObservation;
      // SUSTAINED CONFIRMATION (hysteresis) — the gate that feeds Phase B. On a
      // present→present offer a resolved slot holds through hover / animation
      // drift; a distinct replacement fingerprint must persist
      // REROLL_CONFIRM_PROBES probes before it counts as a reroll. A genuine
      // absent→present appearance resets the streak and is handled atomically.
      const priorPositive = previousSurface.lastPositiveObservation;
      const genuineAppear = priorPositive == null || !priorPositive.present;
      // BASELINE SETTLEMENT — a freshly appeared offer's cards ANIMATE IN. Seeding
      // the accepted reroll baseline from that first frame let the animation
      // confirm itself as a three-slot reroll ~3 frames later, wiping badges that
      // had already published (trace seq 21978 publish → 21979
      // `invalidatedSlots:[0,1,2]`). While settling we hold a PROVISIONAL baseline:
      // no confirmation, no invalidation, no offer-generation bump. Rendering and
      // slot-local OCR are untouched, so SCANNING and badges appear immediately.
      const wasLatched = baselineSettlementRef.current?.latched ?? false;
      if (transition.action === "publish" && publishedObservation != null) {
        baselineSettlementRef.current =
          genuineAppear || baselineSettlementRef.current == null
            ? beginBaselineSettlement(publishedObservation, performance.now())
            : advanceBaselineSettlement({
              settlement: baselineSettlementRef.current,
              observation: publishedObservation,
              now: performance.now(),
            });
      }
      const settlement = baselineSettlementRef.current;
      const settling = settlement != null && !settlement.latched;
      // Adopt the settled cards as the accepted baseline exactly once. Without
      // this the baseline would stay pinned to the first animation frame and the
      // very next probe would read the settled cards as a fresh three-slot
      // reroll — the same spurious new offer, one frame later.
      if (settlement != null && settlement.latched && !wasLatched) {
        acceptedSlotFingerprintsRef.current = settlement.provisional.slice();
        rerollPendingRef.current = createRerollPending();
      }
      let confirmedRerollSlots: number[] = [];
      if (
        transition.action === "publish" &&
        publishedObservation != null &&
        !genuineAppear &&
        !settling
      ) {
        const confirmation = advanceRerollConfirmation({
          pending: rerollPendingRef.current,
          acceptedFingerprints: acceptedSlotFingerprintsRef.current,
          observation: publishedObservation,
        });
        rerollPendingRef.current = confirmation.pending;
        confirmedRerollSlots = confirmation.confirmed;
        heldRerollSlotsRef.current = confirmation.held;
      } else {
        rerollPendingRef.current = createRerollPending();
        heldRerollSlotsRef.current = [];
      }
      // A new offer (absent→present) is immediate; a present→present frame is a
      // new offer only when ≥2 slots' replacements are CONFIRMED, so transient
      // multi-slot drift can no longer churn the offer generation.
      const detectedNewOffer =
        transition.action === "publish" &&
        publishedObservation != null &&
        (genuineAppear
          ? newOfferDetected(priorPositive, publishedObservation)
          : confirmedRerollSlots.length >= 2);
      // Count how many present slots swapped identity vs the last positive
      // observation — the same signal newOfferDetected thresholds on (≥2). Kept
      // for the [offer-session] diagnostic so a controlled retest can see whether
      // a blank frame was a genuine multi-slot re-offer or a one-slot reroll.
      let changedFingerprintCount = 0;
      if (publishedObservation != null && previousSurface.lastPositiveObservation != null) {
        const priorObs = previousSurface.lastPositiveObservation;
        for (let i = 0; i < publishedObservation.cards.length; i += 1) {
          const prev = priorObs.cards[i]?.fingerprint ?? "";
          const curr = publishedObservation.cards[i]?.fingerprint ?? "";
          if (publishedObservation.cards[i]?.present && fingerprintChanged(prev, curr)) {
            changedFingerprintCount += 1;
          }
        }
      }
      const priorOfferSurface = offerSurfaceRef.current;
      // FIX 1 — during bounded negative continuity (a preserved 0/3 or 1-card
      // frame) the offer-surface machine must see the PRESERVED visible surface,
      // not the raw negative capture, so it stays OFFER_VISIBLE in lock-step with
      // geometry instead of independently flipping to NO_OFFER and blanking the
      // resolved badges. On a clear, publishedObservation is null → the raw
      // (0-card) observation drives the correct clear.
      const effectiveObservation = publishedObservation ?? observation;
      const nextOfferSurface = advanceOfferSurface(priorOfferSurface, {
        now: completedAt,
        captureValid,
        blueControlPresent: effectiveObservation.blueControl?.present === true,
        blueControlConfidence: effectiveObservation.blueControl?.confidence ?? 0,
        validCardCount: effectiveObservation.cards.filter((card) => card.present).length,
        occlusionReason: observation.occluded
          ? observation.rejectionReasons.find((reason) => reason.startsWith("occluded-")) ?? "opaque-surface"
          : null,
        // No genuine collapsed-offer fixture exists yet. Never infer hidden from
        // the control alone; keep OFFER_HIDDEN gated pending controlled evidence.
        hiddenEvidence: false,
        newOfferEvidence: detectedNewOffer,
      });
      offerSurfaceRef.current = nextOfferSurface;
      geometryGenerationRef.current = nextOfferSurface.offerGeneration;
      setOfferSurface(nextOfferSurface);
      if (import.meta.env.DEV && (
        priorOfferSurface.state !== nextOfferSurface.state ||
        priorOfferSurface.render !== nextOfferSurface.render
      )) {
        logOverlayDiagnostic("[offer-state]", {
          priorState: priorOfferSurface.state,
          nextState: nextOfferSurface.state,
          blueControlConfidence: nextOfferSurface.blueControlConfidence,
          validCardCount: nextOfferSurface.validCardCount,
          occlusionReason: nextOfferSurface.occlusionReason,
          captureValid: nextOfferSurface.captureValid,
          renderDecision: nextOfferSurface.render,
          offerGeneration: nextOfferSurface.offerGeneration,
        });
      }
      const roundBefore = offerRoundOwnershipRef.current.activeOwner?.round ?? null;
      if (nextOfferSurface.state === "OFFER_VISIBLE") {
        updateOfferRoundOwnership(reduceOfferRoundOwnership(
          offerRoundOwnershipRef.current,
          {
            type: "accepted-offer",
            offerGeneration: nextOfferSurface.offerGeneration,
          },
        ));
      }
      let invalidatedSlots: number[] = [];
      if (
        nextOfferSurface.state === "NO_OFFER" &&
        priorOfferSurface.state !== "NO_OFFER"
      ) {
        updateOfferRoundOwnership(reduceOfferRoundOwnership(
          offerRoundOwnershipRef.current,
          {
            type: "offer-closed",
            offerGeneration: priorOfferSurface.offerGeneration,
          },
        ));
        identityStoreRef.current = [null, null, null];
        acceptedSlotFingerprintsRef.current = ["", "", ""];
        slotGenerationsRef.current = slotGenerationsRef.current.map((generation) => generation + 1);
        ocrPendingSlotsRef.current = [];
        baselineSettlementRef.current = null;
        ocrOwnersRef.current.invalidate();
        probeInFlightRef.current = false;
        probeInFlightSinceRef.current = null;
        bumpScanSeq();
        resetOffer();
      } else if (nextOfferSurface.state === "OCCLUDED") {
        // Retain identities internally, but invalidate every async render owner.
        ocrPendingSlotsRef.current = [];
        baselineSettlementRef.current = null;
        ocrOwnersRef.current.invalidate();
        probeInFlightRef.current = false;
        probeInFlightSinceRef.current = null;
        bumpScanSeq();
      }

      // PHASE B — atomic per-slot reroll invalidation. The first published
      // observation whose slot fingerprint changed clears ONLY that slot's
      // identity (→ SCANNING) and bumps ONLY its generation, so no stale chip
      // can paint the new card and any OCR run keyed to the old slot generation
      // is rejected on completion. Neighbours are retained untouched.
      if (transition.action === "publish" && publishedObservation != null) {
        const priorAcceptedFingerprints = acceptedSlotFingerprintsRef.current;
        const reroll = applyRerollInvalidation({
          store: identityStoreRef.current,
          acceptedFingerprints: acceptedSlotFingerprintsRef.current,
          slotGenerations: slotGenerationsRef.current,
          observation: publishedObservation,
          championGeneration: championGenerationRef.current,
          now: performance.now(),
          // Genuine appearance → atomic all-present invalidation (legacy path).
          // Present→present → invalidate EXACTLY the confirmed reroll slots; a
          // held (unconfirmed-drift) slot keeps its resolved tier.
          newOffer: genuineAppear,
          invalidateSlots: genuineAppear ? undefined : confirmedRerollSlots,
        });
        identityStoreRef.current = reroll.store;
        slotGenerationsRef.current = reroll.slotGenerations;
        acceptedSlotFingerprintsRef.current = reroll.acceptedFingerprints;
        invalidatedSlots = reroll.invalidated;
        if (import.meta.env.DEV) {
          for (const slot of reroll.invalidated) {
            const previousFingerprint = priorAcceptedFingerprints[slot] ?? "";
            const currentFingerprint = publishedObservation.cards[slot]?.fingerprint ?? "";
            logOverlayDiagnostic("[slot-publication]", {
              foregroundEpoch: foregroundEpochRef.current,
              gameEpoch: gameEpochRef.current,
              championId: championIdRef.current,
              championGeneration: championGenerationRef.current,
              championDatasetRequestId: aramgg.championRequestId,
              offerGeneration: nextOfferSurface.offerGeneration,
              geometrySequence: captureSeq,
              slot,
              slotGeneration: reroll.slotGenerations[slot],
              fingerprint: boundedDiagnosticHash(currentFingerprint),
              fingerprintHammingDistance: hammingDistance(previousFingerprint, currentFingerprint),
              ocrRunId: null,
              normalizedOcrTitleHash: null,
              canonicalAugmentId: null,
              statProvenance: null,
              rawWinRate: null,
              tier: null,
              publicationReason: detectedNewOffer ? "new-offer-invalidated" : "reroll-invalidated",
            });
          }
        }
        if (reroll.invalidated.length > 0) {
          ocrOwnersRef.current.invalidate();
          probeInFlightRef.current = false;
          probeInFlightSinceRef.current = null;
          bumpScanSeq();
        }
        if (import.meta.env.DEV && reroll.invalidated.length > 0) {
          console.info(
            "[slot-reroll]",
            JSON.stringify({
              invalidated: reroll.invalidated,
              slotGenerations: reroll.slotGenerations,
            }),
          );
        }
      }

      // Publish/preserve/clear from the hysteresis result. A preserved uncertain
      // frame retains its resolved chip content; geometry uncertainty alone never
      // degrades the three slots to SCANNING.
      republishGeometryFrame(captureSeq);
      const publishedAt = performance.now();

      const acquisitionDiagnostic = import.meta.env.DEV
        ? describeOfferAcquisitionDiagnostic({
          roundOwner: offerRoundOwnershipRef.current.activeOwner?.round ?? null,
          offerGeneration: nextOfferSurface.offerGeneration,
          geometrySequence: captureSeq,
          stale: false,
          surfaceClassification: classification,
          offerState: nextOfferSurface.state,
          geometryAction: transition.action,
          validCardCount: effectiveObservation.cards.filter((card) => card.present).length,
          blueControlConfidence: effectiveObservation.blueControl?.confidence ?? 0,
          fingerprints: effectiveObservation.cards.map((card) => card.fingerprint || null) as [
            string | null,
            string | null,
            string | null,
          ],
          fingerprintChangeCount: changedFingerprintCount,
          confirmedRerollCount: confirmedRerollSlots.length,
          baselineSettling: settling,
          newOfferDetected: detectedNewOffer,
          gameEpoch,
          foregroundEpoch,
          timeSinceLastAcceptedOfferMs: lastAcceptedOfferRef.current == null ||
            lastAcceptedOfferRef.current.gameEpoch !== gameEpoch
            ? null
            : Math.round(Math.max(
              0,
              completedAt - lastAcceptedOfferRef.current.monotonicMilliseconds,
            )),
        })
        : null;

      // [offer-session] — native-visible (terminal stderr) diagnostic for the
      // controlled Level 11/15 retest. Every field is a bounded count / boolean /
      // enum; no OCR text, names, or identifiers are emitted. This is the single
      // line that lets a live retest see WHY a fully-visible offer produced no
      // rendered badge (the "zero render reason") and whether session identity
      // moved or held.
      const foreground = foregroundStateRef.current.gameWindowForeground;
      const zeroRenderReason = nextOfferSurface.render
        ? "rendered"
        : !foreground
          ? "game-window-not-foreground"
          : nextOfferSurface.state === "OCCLUDED"
            ? `occluded:${nextOfferSurface.occlusionReason ?? "unknown"}`
            : nextOfferSurface.state === "NO_OFFER"
              ? "no-offer-surface"
              : !nextOfferSurface.captureValid
                ? "capture-invalid"
                : publishedObservation == null
                  ? `no-published-observation:${transition.action}/${transition.hideReason ?? "none"}`
                  : nextOfferSurface.validCardCount < 2
                    ? `insufficient-valid-cards:${nextOfferSurface.validCardCount}`
                    : `render-suppressed:${nextOfferSurface.state}`;
      if (import.meta.env.DEV && acquisitionDiagnostic != null) {
        emitNativeDiagnostic("[offer-session]", {
          ...acquisitionDiagnostic,
          consecutiveWeakNegatives: previousSurface.consecutiveWeakNegatives,
          precededByNegative: previousSurface.consecutiveWeakNegatives > 0,
          changedFingerprintCount,
          offerGenerationBefore: priorOfferSurface.offerGeneration,
          offerGenerationAfter: nextOfferSurface.offerGeneration,
          roundBefore,
          roundAfter: offerRoundOwnershipRef.current.activeOwner?.round ?? null,
          invalidatedSlots,
          render: nextOfferSurface.render,
          foreground,
          zeroRenderReason,
        });
        if (detectedNewOffer) {
          lastAcceptedOfferRef.current = {
            gameEpoch,
            monotonicMilliseconds: completedAt,
          };
        }
      }

      // Phase follows the visible SURFACE: a present, unoccluded offer opens
      // selection; confirmed absence returns to in-game. Occlusion is transient
      // and an initial uncertainty is not evidence the selection closed.
      if (transition.state.visualObservation != null) {
        if (phaseRef.current !== "augment_selection") {
          ocrSelectionCompletedRef.current = false;
          updatePhase("augment_selection");
        }
      } else if (
        transition.hideReason !== "occluded" &&
        transition.hideReason !== "uncertain-without-positive" &&
        phaseRef.current === "augment_selection"
      ) {
        ocrSelectionCompletedRef.current = true;
        updatePhase("in_game");
      }

      // Tell the OCR track which slots need a (re)read this cycle, keyed to the
      // live geometry fingerprints.
      if (transition.action === "publish" && publishedObservation != null) {
        const decision = decideOcrTrigger<SlotResolution>({
          observation: publishedObservation,
          identities: identityStoreRef.current,
          // Read AFTER Phase B has applied this frame's confirmed rerolls, so a
          // slot cleared this tick is already sitting at its new generation.
          slotGenerations: slotGenerationsRef.current,
          now: performance.now(),
          retryMs: IDENTITY_RETRY_MS,
          forceSlots: forceOcrSlotsRef.current,
        });
        forceOcrSlotsRef.current = [];
        ocrPendingSlotsRef.current = decision.slots;
        if (decision.slots.length > 0) {
          ocrTriggerFingerprintsRef.current = publishedObservation.cards.map(
            (card) => card.fingerprint,
          );
          if (import.meta.env.DEV) {
            logOverlayDiagnostic("[identity-trigger]", {
              foregroundEpoch: foregroundEpochRef.current,
              gameEpoch: gameEpochRef.current,
              championId: championIdRef.current,
              championGeneration: championGenerationRef.current,
              offerGeneration: nextOfferSurface.offerGeneration,
              geometrySequence: captureSeq,
              requestedSlots: decision.slots,
              slotGenerations: decision.slots.map((slot) => slotGenerationsRef.current[slot]),
              fingerprints: decision.slots.map((slot) =>
                boundedDiagnosticHash(publishedObservation.cards[slot]?.fingerprint ?? null)),
              reason: decision.reason,
            });
            if (decision.reason.includes("retry:")) {
              logOverlayDiagnostic("[identity-retry]", {
                requestedSlots: decision.slots,
                reason: decision.reason,
                offerGeneration: nextOfferSurface.offerGeneration,
              });
            }
          }
        }
      } else if (transition.action === "clear") {
        ocrPendingSlotsRef.current = [];
      }

      if (datasetCaptureOn) {
        // DEV-only redacted capture: card-region rects, the geometry presence
        // verdict, and rejection reasons only — never identity or full-screen data.
        lastFixtureInputRef.current = {
          capturedAt,
          present: observation.present && !observation.occluded,
          confidence: observation.confidence,
          cropsCaptured: observation.cards.filter((card) => card.present).length,
          titles: [null, null, null],
          cardRects: observation.cards.map((card) => card.cardRect),
          rejectionReasons: observation.rejectionReasons,
        };
      }

      if (import.meta.env.DEV) {
        const totalProbeMs = publishedAt - startedAt;
        const diagnostic: GeometryProbeDiagnostic = {
          probeSeq: captureSeq,
          scheduledAt,
          startedAt,
          captureStartedAt: startedAt + observation.preCaptureMs,
          captureFinishedAt:
            startedAt + observation.preCaptureMs + observation.captureMs,
          analysisFinishedAt:
            startedAt + observation.preCaptureMs + observation.captureMs + observation.analysisMs,
          publishedAt,
          preCaptureMs: observation.preCaptureMs,
          captureMs: observation.captureMs,
          nativeTotalMs: observation.elapsedMs,
          ipcMs: Math.max(0, completedAt - startedAt - observation.elapsedMs),
          analysisMs: observation.analysisMs,
          totalProbeMs,
          gapSincePreviousStartMs:
            previousStartedAt == null ? null : startedAt - previousStartedAt,
          gapSincePreviousCompletedMs:
            previousCompletedAt == null ? null : completedAt - previousCompletedAt,
          inFlightMs: completedAt - startedAt,
          schedulerRestartCount: geometryRestartCountRef.current,
          classification,
          present: observation.present,
          occluded: observation.occluded,
          confidence: observation.confidence,
          cards: observation.cards,
          rejectionReasons: observation.rejectionReasons,
          previousSurfaceState:
            previousSurface.visualObservation == null ? "hidden" : "present",
          nextSurfaceState:
            transition.state.visualObservation == null ? "hidden" : "present",
          hiddenReason: transition.action === "clear" ? transition.hideReason : null,
        };
        const diagnostics = geometryDiagnosticsRef.current;
        diagnostics.push(diagnostic);
        if (diagnostics.length > 200) diagnostics.shift();

        const ring = geometryLatenciesRef.current;
        ring.push(totalProbeMs);
        if (ring.length > 200) ring.shift();
        geometryProbeCountRef.current += 1;
        const classificationChanged =
          lastRawGeometryClassificationRef.current !== classification;
        const chipsHidden =
          diagnostic.previousSurfaceState === "present" &&
          diagnostic.nextSurfaceState === "hidden";
        if (classificationChanged || chipsHidden || totalProbeMs > 250) {
          console.info("[geometry-probe]", JSON.stringify(diagnostic));
        }
        lastRawGeometryClassificationRef.current = classification;
        if (geometryProbeCountRef.current % 40 === 0 && ring.length > 0) {
          const sorted = [...ring].sort((a, b) => a - b);
          const at = (q: number) => sorted[Math.min(
            sorted.length - 1,
            Math.floor(q * sorted.length),
          )];
          console.info(
            `[geometry-full-latency] n=${sorted.length} p50=${at(0.5).toFixed(1)} ` +
              `p95=${at(0.95).toFixed(1)} p99=${at(0.99).toFixed(1)} ms`,
          );
        }
      }
    } finally {
      // This native call has settled, whether or not it still owns the guard.
      // Abandoned-but-unsettled calls are exactly what the backlog cap counts.
      geometryNativeOutstandingRef.current = Math.max(
        0,
        geometryNativeOutstandingRef.current - 1,
      );
      // Remove ONLY this request's own start-time entry — per-request
      // ownership, not a count-gated scalar clear. A sibling request (e.g. a
      // wedge-recovery replacement still outstanding) keeps its own entry
      // untouched, so `oldestNativeStart` always reflects the true minimum
      // across whatever is still actually unsettled. This is what makes the
      // old failure mode structurally impossible: a stale oldest-start
      // silently keeping the wedge discount permanently active and doubling
      // native capture load for the rest of the game (see runGeometryProbe
      // above) — there is no shared scalar left to go stale.
      geometryNativeStartsRef.current.delete(captureSeq);
      // Release the guard ONLY if this probe still owns it — the watchdog may
      // already have released ownership on its behalf, in which case there is
      // nothing here to free.
      //
      // Under bounded overlap (the wedge-recovery discount above), a
      // replacement CAN now start before this probe settles, bumping
      // `geometrySeqRef` ahead of `captureSeq`. When that happens this probe's
      // late result correctly fails `frameResultIsCurrent` in the result
      // handler and is discarded rather than overwriting newer state — that is
      // the intended fail-safe for a wedged call, not a regression.
      if (geometryInFlightTokenRef.current === captureSeq) {
        geometryInFlightSinceRef.current = null;
        geometryInFlightRef.current = false;
        geometryInFlightTokenRef.current = null;
      }
    }
  }, [aramgg.championRequestId, bumpScanSeq, datasetCaptureOn, republishGeometryFrame, resetOffer, updateOfferRoundOwnership, updatePhase]);

  // ─── TRACK 2: OCR/identity probe — TRIGGERED by the geometry track ───────────
  // Supplies per-slot identity ONLY: never presence, occlusion, or visual freshness. It
  // reads just the slots geometry flagged (new / reroll / retry / force) and
  // writes each result into the geometry-fingerprint-keyed identity store, so a
  // late result from a superseded generation can never paint the live card.
  const runIdentityProbe = useCallback(async (
    slots: number[],
    triggerFingerprints: string[],
    triggerSlotGenerations: number[],
  ) => {
    probeInFlightRef.current = true;
    const startedAt = performance.now();
    probeInFlightSinceRef.current = startedAt;
    lastProbeStartedAtRef.current = startedAt;
    const captureSeq = bumpScanSeq();
    const foregroundEpoch = foregroundEpochRef.current;
    const gameEpoch = gameEpochRef.current;
    const championGenerationAtStart = championGenerationRef.current;
    const championIdAtStart = championIdRef.current;
    const offerGenerationAtStart = geometryGenerationRef.current;
    const acceptedRoundAtStart = offerRoundOwnershipRef.current.activeOwner?.round ?? null;
    const championRequestIdAtStart = aramgg.championRequestId;
    const championPatchAtStart = aramgg.championPatch;
    const owner = ocrOwnersRef.current.start({
      foregroundEpoch,
      gameEpoch,
      championGeneration: championGenerationAtStart,
      championId: championIdAtStart,
      offerGeneration: offerGenerationAtStart,
      round: acceptedRoundAtStart,
      requestedSlots: slots,
      slotGenerations: triggerSlotGenerations,
      fingerprints: triggerFingerprints,
    }, startedAt);
    if (import.meta.env.DEV) {
      logOverlayDiagnostic("[identity-start]", {
        runId: owner.runId,
        foregroundEpoch: owner.foregroundEpoch,
        gameEpoch: owner.gameEpoch,
        championId: owner.championId,
        championGeneration: owner.championGeneration,
        offerGeneration: owner.offerGeneration,
        round: owner.round,
        requestedSlots: owner.requestedSlots,
        slotGenerations: owner.requestedSlots.map((slot) => owner.slotGenerations[slot]),
        fingerprints: owner.requestedSlots.map((slot) =>
          boundedDiagnosticHash(owner.fingerprints[slot] ?? null)),
        startedAt: owner.startedAt,
        timeoutDeadline: owner.timeoutDeadline,
      });
    }
    const currentOwnerContext = (): OcrOwnerContext => ({
      foregroundEpoch: foregroundEpochRef.current,
      gameEpoch: gameEpochRef.current,
      championGeneration: championGenerationRef.current,
      championId: championIdRef.current,
      offerGeneration: geometryGenerationRef.current,
      round: offerRoundOwnershipRef.current.activeOwner?.round ?? null,
      requestedSlots: slots,
      slotGenerations: slotGenerationsRef.current,
      fingerprints: acceptedSlotFingerprintsRef.current,
    });
    /**
     * A completed run that may not publish. The 2026-07-26 trace logged all 11
     * of these as `{runId, reason}` alone, which could not answer whether the
     * card legitimately changed (a replacement read is already queued) or OCR
     * silently gave up — so the run was misread as zero recovery. Everything
     * here is a bounded count / integer / enum: the fingerprints themselves and
     * every OCR string stay out of the log.
     */
    const logStaleReject = (
      rejected: typeof owner,
      seq: number,
      stage: "before-publication" | "during-failure",
    ) => {
      const context = currentOwnerContext();
      const captureSeqStale = seq !== scanSeqRef.current;
      logOverlayDiagnostic("[identity-stale-reject]", {
        runId: rejected.runId,
        stage,
        // `cause` is the FIRST violated authority; the legacy opaque string is
        // retained as `reason` so older replay tooling keeps parsing this line.
        cause: classifyStaleReject(
          rejected,
          ocrOwnersRef.current.current,
          context,
          captureSeqStale,
        ),
        reason: `owner-superseded-${stage}`,
        requestedSlots: rejected.requestedSlots,
        slotGenerationsAtStart: rejected.requestedSlots.map((s) => rejected.slotGenerations[s]),
        slotGenerationsNow: rejected.requestedSlots.map((s) => context.slotGenerations[s]),
        slotFingerprintDrift: staleRejectSlotDrift(rejected, context, hammingDistance),
        // Was the slot already showing a resolved identity? A rejection over a
        // RESOLVED slot costs nothing; over an unresolved one it is a real gap.
        slotResolved: rejected.requestedSlots.map(
          (s) => identityStoreRef.current[s]?.resolution != null),
        offerGenerationAtStart: rejected.offerGeneration,
        offerGenerationNow: context.offerGeneration,
        roundAtStart: rejected.round,
        roundNow: context.round,
        foregroundEpochAtStart: rejected.foregroundEpoch,
        foregroundEpochNow: context.foregroundEpoch,
        gameEpochAtStart: rejected.gameEpoch,
        gameEpochNow: context.gameEpoch,
        championGenerationAtStart: rejected.championGeneration,
        championGenerationNow: context.championGeneration,
        currentOwnerRunId: ocrOwnersRef.current.current?.runId ?? null,
        captureSeqStale,
        elapsedMs: Math.round(performance.now() - rejected.startedAt),
      });
    };
    const scanStart = new Date().toISOString();
    setOcrLifecycle((previous) => ({
      ...previous,
      phase: phaseRef.current,
      currentRound: owner.round,
      active: true,
      lastScanStart: scanStart,
      lastScanEnd: null,
      scanRunId: owner.runId,
      probeSeq: captureSeq,
      lastProbeStartedAt: startedAt,
      probeInFlightSince: startedAt,
      probeRestartCount: probeRestartCountRef.current,
      probeSkipReason: lastProbeSkipReasonRef.current,
      captureAttempted: false,
      cropCount: 0,
      noCropReason: "capture-pending",
    }));

    const scanStartMs = performance.now();
    try {
      const execution = await executeOcrRun(
        () => {
          // Chained on the invoke itself so it still fires when the outer race
          // has already timed out and abandoned this promise — that is exactly
          // the case we need to see (how long the native OCR really ran).
          const nativeStartedAt = performance.now();
          ocrNativeOutstandingRef.current += 1;
          return invoke<OcrScanResult>("detect_augment_names", {
            knownNames: ocrKnownNames,
          }).then((scan) => {
            logOverlayDiagnostic("[identity-native-return]", {
              runId: owner.runId,
              nativeMs: Math.round(performance.now() - nativeStartedAt),
              cropCount: scan.cropCount,
              captureMs: scan.captureMs,
              ocrMs: scan.ocrMs,
              nativeTotalMs: scan.totalMs,
            });
            return scan;
          }).finally(() => {
            // Chained on the INVOKE, not on the outer race, so the count falls
            // when the native call truly returns its capture permit rather than
            // when the 2 s JS deadline gives up on it.
            ocrNativeOutstandingRef.current = Math.max(
              0,
              ocrNativeOutstandingRef.current - 1,
            );
          });
        },
        (scan) => scan,
      );
      if (execution.kind === "failure") throw new Error(execution.reason);
      const scan = execution.value;
      if (import.meta.env.DEV) {
        logOverlayDiagnostic("[identity-native-finish]", {
          runId: owner.runId,
          captureAttempted: scan.captureAttempted,
          cropCount: scan.cropCount,
          captureMs: scan.captureMs,
          ocrMs: scan.ocrMs,
          nativeTotalMs: scan.totalMs,
        });
      }

      // Stale-result rejection: publish only while this probe's seq is still the
      // newest AND the foreground epoch it captured under is unchanged. A delayed
      // or watchdog-superseded probe can never restore an already-cleared frame.
      if (
        captureSeq !== scanSeqRef.current ||
        !ownerCurrent(owner, ocrOwnersRef.current.current, currentOwnerContext())
      ) {
        if (import.meta.env.DEV) {
          logStaleReject(owner, captureSeq, "before-publication");
        }
        return;
      }
      if (foregroundEpoch !== foregroundEpochRef.current) return;
      if (gameEpoch !== gameEpochRef.current) return;
      if (championGenerationAtStart !== championGenerationRef.current) return;
      if (championIdAtStart !== championIdRef.current) return;
      if (offerGenerationAtStart !== geometryGenerationRef.current) return;
      if (championRequestIdAtStart !== aramgg.championRequestId) return;
      if (championPatchAtStart !== aramgg.championPatch) return;
      if (slots.some((regionIndex) => ocrRunSuperseded(
        triggerSlotGenerations[regionIndex] ?? 0,
        slotGenerationsRef.current[regionIndex] ?? 0,
      ))) return;
      const matchStartMs = performance.now();

      const rawTitles: Array<string | null> = [0, 1, 2].map(
        (regionIndex) =>
          scan.detected.find((entry) => entry.region_index === regionIndex)?.text ?? null,
      );
      // Re-read ONLY the triggered slots; untouched slots keep their prior title
      // so applyScanToOffer leaves their identity intact (geometry already
      // confirmed those cards did not reroll). A triggered slot with no plausible
      // title this pass resolves to null → SCANNING → retry after the deadline.
      const titlesForScan: Array<string | null> = [0, 1, 2].map((regionIndex) => {
        if (!slots.includes(regionIndex)) return offerStateRef.current.slots[regionIndex].title;
        const raw = rawTitles[regionIndex];
        return raw != null && isPlausibleTitle(normalizeAugmentNameForLookup(raw)) ? raw : null;
      });
      // The offer LATCH (feeds the decision engine + collector) keeps grace; the
      // identity STORE (what renders) is strict and geometry-fingerprint-keyed.
      const applied = applyScanToOffer(
        offerStateRef.current,
        titlesForScan,
        normalizeAugmentNameForLookup,
        resolveSlotTitle,
        titlePresent,
      );
      publishOffer(applied.state);
      // Write the identity store for the triggered slots, keyed to the geometry
      // fingerprint that triggered the read. Resolve STRICTLY from this pass's
      // plausible title (never applyScanToOffer's grace) so a rerolled slot whose
      // new title was unreadable stays SCANNING instead of showing the stale one.
      const resolvedAt = performance.now();
      const championGeneration = championGenerationRef.current;
      for (const regionIndex of slots) {
        const raw = rawTitles[regionIndex];
        const readable = raw != null && isPlausibleTitle(normalizeAugmentNameForLookup(raw));
        // Reject a run whose slot rerolled again during the read: its generation
        // is now behind. The store was already invalidated to SCANNING by the
        // geometry track, and this stale read must not repaint the new card.
        if (ocrRunSuperseded(
          triggerSlotGenerations[regionIndex] ?? 0,
          slotGenerationsRef.current[regionIndex] ?? 0,
        )) continue;
        const fingerprint = triggerFingerprints[regionIndex] ?? "";
        const prev = identityStoreRef.current[regionIndex];
        const resolution = readable ? resolveSlotTitle(raw as string) : null;
        const failure = resolution === null
          ? failurePublication((prev?.failureCount ?? 0) + 1, resolvedAt)
          : null;
        const incoming: IdentityRecord<SlotResolution> = {
          fingerprint,
          resolution,
          resolvedAt,
          championGeneration,
          augmentId: slotResolutionAugmentId(resolution),
          ocrTitle: readable ? raw : null,
          foregroundEpoch,
          gameEpoch,
          offerGeneration: offerGenerationAtStart,
          slotGeneration: triggerSlotGenerations[regionIndex] ?? 0,
          ocrRunId: owner.runId,
          championRequestId: championRequestIdAtStart,
          championPatch: championPatchAtStart,
          conflictCount: 0,
          unresolvedState: failure?.state,
          failureCount: failure?.failureCount ?? 0,
          retryAt: failure?.retryAt,
        };
        const stored = reconcileIdentityRecord(prev, incoming);
        identityStoreRef.current[regionIndex] = stored;
        if (import.meta.env.DEV) {
          const aramggKind = stored.resolution?.aramgg?.kind ?? null;
          const stat = stored.resolution?.aramgg?.kind === "matched"
            ? stored.resolution.aramgg.stat
            : null;
          // Champion-only invariant: a published statistic is ALWAYS champion
          // provenance. A global source reaching a badge is a policy violation.
          const selectionStatus =
            aramggKind === "matched"
              ? "champion-resolved"
              : aramggKind === "no-data"
                ? "champion-no-data"
                : aramggKind === "loading"
                  ? "champion-loading"
                  : aramggKind === "error"
                    ? "champion-fetch-error"
                    : aramggKind === "unmatched"
                      ? "riot-unmatched"
                      : null;
          const meta = championDataMetaRef.current;
          const diagnostic = {
            foregroundEpoch,
            gameEpoch,
            championId: championIdAtStart,
            championGeneration,
            championDatasetRequestId: championRequestIdAtStart,
            datasetCompleteness: meta.completeness,
            datasetLoadedCount: meta.loadedCount,
            endpointKind: "champion-augments-file",
            selectionStatus,
            offerGeneration: offerGenerationAtStart,
            geometrySequence: geometrySeqRef.current,
            slot: regionIndex,
            slotGeneration: triggerSlotGenerations[regionIndex] ?? 0,
            fingerprint: boundedDiagnosticHash(fingerprint),
            fingerprintHammingDistance: prev
              ? hammingDistance(prev.fingerprint, fingerprint)
              : null,
            ocrRunId: owner.runId,
            normalizedOcrTitleHash: boundedDiagnosticHash(readable ? raw : null),
            canonicalAugmentId: stored.augmentId ?? null,
            statisticsAugmentId: stat?.augmentId ?? null,
            statProvenance: stat?.provenance ?? null,
            rawWinRate: stat?.rawWinRate ?? null,
            formattedWinRate: stat ? compactWinRateFromFraction(stat.rawWinRate) : null,
            tier: stat?.tierLetter ?? null,
            rejectionReason:
              aramggKind === "no-data"
                ? "champion-no-data"
                : aramggKind === "loading"
                  ? "champion-data-loading"
                  : aramggKind === "error"
                    ? "champion-data-error"
                    : null,
            publicationReason: stored === prev ? "identity-conflict-rejected" : "identity-published",
          };
          // A global-sourced statistic must never publish (removed by policy).
          if (stat && stat.provenance !== "champion") {
            logOverlayDiagnostic("[slot-publication-violation]", {
              slot: regionIndex,
              rejectionReason: "statistics-source-global",
            });
          }
          logOverlayDiagnostic("[identity-publish]", diagnostic);
          logOverlayDiagnostic("[slot-publication]", diagnostic);
        }
      }
      // Clear the pending queue; the next geometry tick re-populates it if any
      // slot is still unresolved past the retry deadline (or rerolls again).
      ocrPendingSlotsRef.current = [];
      // Repaint the LIVE geometry frame with the new identities (geometry owns
      // presence/freshness; this only refreshes chip content).
      republishGeometryFrame(geometrySeqRef.current);
      const matchMs = performance.now() - matchStartMs;

      setOcrLifecycle((previous) => ({
        ...previous,
        lastScanEnd: new Date().toISOString(),
        captureAttempted: scan.captureAttempted,
        cropCount: scan.cropCount,
        noCropReason: scan.cropCount === 0
          ? scan.diagnostics.find((diagnostic) => diagnostic.error)?.error ?? "no-crops-returned"
          : null,
        offerGeneration: applied.state.generation,
        timings: {
          captureMs: scan.captureMs,
          ocrMs: scan.ocrMs,
          nativeTotalMs: scan.totalMs,
          matchMs: Math.round(matchMs),
          endToEndMs: Math.round(performance.now() - scanStartMs),
        },
      }));
      setOcrDiagnostics(
        scan.diagnostics.map((diagnostic) => {
          const slot = applied.state.slots[diagnostic.regionIndex];
          const resolution = slot?.resolution ?? null;
          const aramggResolution = resolution?.aramgg ?? null;
          const slotState: SlotDiagnosticState =
            !slot || slot.fingerprint === null
              ? "scanning"
              : aramggResolution
                ? aramggResolution.kind
                : resolution?.pool
                  ? "matched"
                  : "unmatched";
          const rejectionStage: SlotRejectionStage = !diagnostic.captureSucceeded
            ? "capture"
            : !diagnostic.rawText
              ? "ocr"
              : slotState === "unmatched"
                ? "riot-catalog"
                : slotState === "no-data"
                  ? "aramgg"
                  : null;
          const poolDiagnostic = resolution?.poolDiagnostic;
          return {
            ...diagnostic,
            normalizedText: slot?.fingerprint ?? poolDiagnostic?.normalizedText ?? "",
            bestCandidate: poolDiagnostic?.bestCandidate ?? null,
            confidence:
              aramggResolution && aramggResolution.kind !== "unmatched"
                ? aramggResolution.riot.confidence
                : poolDiagnostic?.confidence ?? null,
            rejectionReason: !diagnostic.rawText
              ? diagnostic.error ?? "no-text-recognized"
              : aramggResolution?.kind === "unmatched"
                ? `${aramggResolution.rejection.reason}${
                    "detail" in aramggResolution.rejection && aramggResolution.rejection.detail
                      ? `: ${aramggResolution.rejection.detail}`
                      : ""
                  }`
                : aramggResolution?.kind === "no-data"
                  ? "champion-no-data"
                  : aramggResolution?.kind === "loading"
                    ? "champion-data-loading"
                    : aramggResolution?.kind === "error"
                      ? "champion-data-error"
                      : poolDiagnostic?.rejectionReason ?? null,
            riotCanonicalName:
              aramggResolution && aramggResolution.kind !== "unmatched"
                ? aramggResolution.riot.canonicalName
                : null,
            riotAugmentId:
              aramggResolution && aramggResolution.kind !== "unmatched"
                ? aramggResolution.riot.augmentId
                : null,
            riotMethod:
              aramggResolution && aramggResolution.kind !== "unmatched"
                ? aramggResolution.riot.method
                : null,
            aramggResult:
              aramggResolution?.kind === "matched"
                ? `wr=${aramggResolution.stat.winRatePercent}% n=${aramggResolution.stat.numGames} tier=${aramggResolution.stat.tierLetter}`
                : aramggResolution?.kind === "no-data"
                  ? "no-record"
                  : null,
            slotState,
            rejectionStage,
          };
        }),
      );

      const matched: MatchedCard[] = applied.state.slots.flatMap((slot) =>
        slot.resolution?.pool && slot.title
          ? [{
              augment: slot.resolution.pool,
              regionIndex: slot.regionIndex,
              ocrText: slot.title,
            }]
          : [],
      );
      if (
        collectorCaptureEnabled &&
        isCompleteThreeCardOffer(matched) &&
        playerData
      ) {
        const round = owner.round ?? 0;
        const offeredAugmentSlugs = matched
          .map((card) => card.augment.slug)
          .sort();
        const roundKey = `${round}:${offeredAugmentSlugs.join(",")}`;
        if (round > 0 && roundKey !== lastRecordedRoundRef.current) {
          lastRecordedRoundRef.current = roundKey;
          void invoke("record_contributor_round", {
            round,
            offeredAugmentSlugs,
            ocrConfidence: matched.length / 3,
          });
        }
      }

      // Presence, occlusion, and clearing are the geometry track's job — this
      // identity pass only refreshed chip content on the live geometry frame.
    } catch (error) {
      // A stale or superseded OCR probe (newer seq, or a foreground flip) must not
      // write identities — geometry, not OCR, decides presence and clearing.
      if (
        captureSeq !== scanSeqRef.current ||
        !ownerCurrent(owner, ocrOwnersRef.current.current, currentOwnerContext())
      ) {
        if (import.meta.env.DEV) {
          logStaleReject(owner, captureSeq, "during-failure");
        }
        return;
      }
      if (foregroundEpoch !== foregroundEpochRef.current) return;
      if (gameEpoch !== gameEpochRef.current) return;
      if (championGenerationAtStart !== championGenerationRef.current) return;
      if (championIdAtStart !== championIdRef.current) return;
      if (offerGenerationAtStart !== geometryGenerationRef.current) return;
      if (slots.some((regionIndex) => ocrRunSuperseded(
        triggerSlotGenerations[regionIndex] ?? 0,
        slotGenerationsRef.current[regionIndex] ?? 0,
      ))) return;
      const unavailable = ocrAvailabilityFromError(error);
      if (unavailable) setOcrAvailability(unavailable);
      // Identity-only failure: mark the triggered slots unresolved (retry after
      // the deadline). Presence/freshness are unaffected — the geometry track
      // keeps publishing, so a readable offer still shows SCANNING chips.
      //
      // Routed through `reconcileIdentityRecord`, whose first rule is that an
      // unresolved incoming record never displaces a resolved one. This block
      // used to assign the store slot directly, so ANY failed read — including
      // one the operator never asked for — downgraded an already-published
      // augment to SCANNING with no generation bump and no card change. During
      // the R4 duplicate-OCR storm (runIds 36-42, all timing out on saturated
      // capture permits) that is what made already-painted badges vanish.
      const failedAt = performance.now();
      for (const regionIndex of slots) {
        const previous = identityStoreRef.current[regionIndex];
        const priorFailures = previous?.failureCount ?? 0;
        const failure = failurePublication(priorFailures + 1, failedAt);
        identityStoreRef.current[regionIndex] = reconcileIdentityRecord(previous, {
          fingerprint: triggerFingerprints[regionIndex] ?? "",
          resolution: null,
          resolvedAt: failedAt,
          championGeneration: championGenerationAtStart,
          foregroundEpoch,
          gameEpoch,
          offerGeneration: offerGenerationAtStart,
          slotGeneration: triggerSlotGenerations[regionIndex] ?? 0,
          ocrRunId: owner.runId,
          championRequestId: championRequestIdAtStart,
          championPatch: championPatchAtStart,
          unresolvedState: failure.state,
          failureCount: failure.failureCount,
          retryAt: failure.retryAt,
        });
      }
      ocrPendingSlotsRef.current = [];
      republishGeometryFrame(geometrySeqRef.current);
      const message = error instanceof Error ? error.message : "ocr-scan-failed";
      if (import.meta.env.DEV) {
        logOverlayDiagnostic(
          message === "timeout" ? "[identity-timeout]" : "[identity-retry]",
          {
            runId: owner.runId,
            requestedSlots: slots,
            reason: message,
            failures: slots.map((slot) => identityStoreRef.current[slot]?.failureCount ?? 0),
          },
        );
      }
      setOcrDiagnostics(
        [0, 1, 2].map((regionIndex) => ({
          regionIndex,
          cardRect: null,
          crop: null,
          captureSucceeded: false,
          rawText: null,
          error: message,
          captureWidth: null,
          captureHeight: null,
          normalizedText: "",
          bestCandidate: null,
          confidence: null,
          rejectionReason: message,
          riotCanonicalName: null,
          riotAugmentId: null,
          riotMethod: null,
          aramggResult: null,
          slotState: "scanning" as const,
          rejectionStage: "capture" as const,
        })),
      );
      lastProbeFailureReasonRef.current = message;
      setOcrLifecycle((previous) => ({
        ...previous,
        lastScanEnd: new Date().toISOString(),
        captureAttempted: false,
        cropCount: 0,
        noCropReason: message,
        probeFailureReason: message,
      }));
    } finally {
      // Release the in-flight guard on EVERY path — success, stale-reject return,
      // throw, or timeout — so a single stuck capture can never wedge the
      // scheduler asleep. This try/finally is the permanent-sleep fix. Release
      // ONLY if this probe still owns the guard: a watchdog restart hands
      // ownership to the replacement probe, whose guard a late return must not
      // free (that would let two probes overlap).
      if (ocrOwnersRef.current.release(owner.runId)) {
        const finishedAt = performance.now();
        lastProbeFinishedAtRef.current = finishedAt;
        probeInFlightSinceRef.current = null;
        probeInFlightRef.current = false;
        setOcrLifecycle((previous) => ({
          ...previous,
          active: false,
          lastProbeFinishedAt: finishedAt,
          probeInFlightSince: null,
        }));
      }
    }
  }, [aramgg.championPatch, aramgg.championRequestId, bumpScanSeq, collectorCaptureEnabled, ocrKnownNames, playerData, publishOffer, republishGeometryFrame, resolveSlotTitle, titlePresent]);

  // ─── TRACK 1 scheduler tick: the fast geometry probe ─────────────────────────
  // Same pure reducer (nextProbeAction) as OCR — start / skip / watchdog-restart
  // from live refs ONLY (foreground, active-game, in-flight timing), never
  // telemetry — but on the geometry config and the geometry guards. The restart
  // branch IS the watchdog: a wedged geometry probe is invalidated (seq bumped →
  // late return stale-rejects), its guard reset, and a fresh probe starts.
  const geometryProbeTick = useCallback(() => {
    const scheduledAt = performance.now();
    const action = nextProbeAction(
      {
        foreground: foregroundStateRef.current.gameWindowForeground,
        activeGame: activeGameRef.current,
        inFlight: geometryInFlightRef.current,
        inFlightSince: geometryInFlightSinceRef.current,
        lastProbeStartedAt: lastGeometryStartedAtRef.current,
        nativeOutstanding: geometryNativeOutstandingRef.current,
        oldestNativeStartedAt: oldestNativeStart(geometryNativeStartsRef.current),
      },
      GEOMETRY_PROBE_CONFIG,
      scheduledAt,
    );
    if (action.kind === "skip") return;
    if (action.kind === "abandon") {
      const attemptGeneration =
        geometryHealthRef.current.currentAttemptGeneration ??
        geometrySeqRef.current;
      geometryHealthRef.current = restartGeometryAttempt(
        geometryHealthRef.current,
        attemptGeneration,
        scheduledAt,
      );
      const continuousUnhealthyAgeMs =
        geometryHealthRef.current.continuousUnhealthyStartedAt == null
          ? null
          : scheduledAt - geometryHealthRef.current.continuousUnhealthyStartedAt;
      const acceptedGeometryAgeMs =
        geometryHealthRef.current.lastAcceptedGeometryAt == null
          ? null
          : scheduledAt - geometryHealthRef.current.lastAcceptedGeometryAt;
      logOverlayDiagnostic("[geometry-watchdog]", {
        probeSeq: geometrySeqRef.current,
        attemptGeneration,
        scheduledAt,
        inFlightSince: geometryInFlightSinceRef.current,
        inFlightMs:
          geometryInFlightSinceRef.current == null
            ? null
            : scheduledAt - geometryInFlightSinceRef.current,
        schedulerRestartCount: geometryRestartCountRef.current + 1,
        hiddenReason: "probe-timeout",
        continuousUnhealthyAgeMs,
        acceptedGeometryAgeMs,
        nativeOutstanding: geometryNativeOutstandingRef.current,
        action: action.kind,
      });
      // NOTE: `geometrySeqRef` is deliberately NOT advanced here.
      //
      // The sequence exists so a REPLACEMENT probe's result beats the one it
      // replaced. Abandonment issues no replacement, so bumping it had exactly
      // one effect: the still-running probe's own result failed
      // `frameResultIsCurrent` and returned at the top of the result handler —
      // above the surface commit, the offer FSM, the slot publications and
      // decideOcrTrigger. In the 2026-07-27 R4 window all 6 geometry results
      // that landed were `stale:true`, the FSM froze at NO_OFFER for 32.657 s
      // with three cards on screen, and the overlay painted neither a badge nor
      // SCANNING. The watchdog was invalidating the very work it was waiting
      // for: goodput zero at 100% utilization.
      //
      // Releasing ownership alone is enough to stop a late result from
      // publishing under a new offer, because every publication is additionally
      // gated on offerGeneration / slotGeneration / foregroundEpoch.
      geometryInFlightRef.current = false;
      geometryInFlightSinceRef.current = null;
      geometryInFlightTokenRef.current = null;
      geometryRestartCountRef.current += 1;
      // Ownership released so a slow probe cannot wedge the logical track — but
      // the native call is still running and still holding its Rust capture
      // permit, so we must NOT add another invoke. Issuing one is what grew
      // roundTripMs to 47–63 s while the native side stayed healthy at ~650 ms.
      return;
    }
    // Geometry owns presence even when the OS OCR backend is unavailable. The
    // native probe reports screen-capture failures explicitly (as uncertain,
    // never confirmed combat), so OCR capability must never suppress this track.
    void runGeometryProbe(scheduledAt);
  }, [runGeometryProbe]);

  // ─── TRACK 2 scheduler tick: the TRIGGERED OCR/identity probe ────────────────
  // Its "active game" gate is whether the geometry track queued any slots — OCR
  // NEVER runs on a fixed cadence. It reuses the OCR guards + watchdog so a slow
  // read can never wedge either track, and it still honours the OCR interval so a
  // burst of triggers cannot hammer the capture pipeline.
  const identityProbeTick = useCallback(() => {
    const action = nextProbeAction(
      {
        foreground: foregroundStateRef.current.gameWindowForeground,
        activeGame: ocrPendingSlotsRef.current.length > 0,
        inFlight: probeInFlightRef.current,
        inFlightSince: probeInFlightSinceRef.current,
        lastProbeStartedAt: lastProbeStartedAtRef.current,
        // OCR is TRIGGERED rather than timed, which was the argument for pinning
        // this at 0 — but the trigger fires off the geometry cadence, so it is
        // timed by proxy. In the 2026-07-27 R4 collapse that produced SEVEN
        // copies of one identical job (runIds 36-42, same requestedSlots [1,2],
        // same fingerprints, 2109 ms apart — exactly the watchdog quantum) until
        // they saturated the Rust MAX_CONCURRENT_CAPTURES = 4 gate and starved
        // geometry. Counting the real outstanding natives caps the OCR track at
        // one in flight — deliberately stricter than the geometry track, which
        // now permits one presumed-wedged zombie plus one replacement.
        nativeOutstanding: ocrNativeOutstandingRef.current,
      },
      DEFAULT_PROBE_CONFIG,
      performance.now(),
    );
    if (action.kind === "skip") {
      lastProbeSkipReasonRef.current = action.reason;
      return;
    }
    if (action.kind === "abandon") {
      // Release the LOGICAL guard only, and issue nothing. The previous branch
      // bumped the scan sequence, invalidated the owner token and then fell
      // through to `runIdentityProbe` — a replacement it could not cancel and
      // whose predecessor it had just made unpublishable. At the 2109 ms
      // watchdog quantum that emitted runIds 36-42: seven identical reads of
      // slots [1,2] against four Rust capture permits.
      //
      // Neither `bumpScanSeq()` nor `invalidate()` happens now, so the
      // outstanding read may still publish when it lands — it is the newest
      // evidence there is, and offerGeneration / slotGeneration /
      // foregroundEpoch / championGeneration all still gate it. The
      // native-outstanding cap keeps a second read from starting underneath it,
      // and this run's own `finally` releases the owner when it truly settles.
      if (import.meta.env.DEV) {
        logOverlayDiagnostic("[identity-watchdog-abandon]", {
          runId: ocrOwnersRef.current.current?.runId ?? null,
          inFlightSince: probeInFlightSinceRef.current,
          nativeOutstanding: ocrNativeOutstandingRef.current,
          reason: action.reason,
        });
      }
      probeInFlightRef.current = false;
      probeInFlightSinceRef.current = null;
      probeRestartCountRef.current += 1;
      lastProbeFailureReasonRef.current = action.reason;
      return;
    }
    if (!canRunOcr(ocrAvailability)) {
      lastProbeSkipReasonRef.current = "ocr-unavailable";
      return;
    }
    if (!nameLookup.size) {
      lastProbeSkipReasonRef.current = "names-not-loaded";
      return;
    }
    const slots = ocrPendingSlotsRef.current;
    if (slots.length === 0) return;
    lastProbeSkipReasonRef.current = "due";
    void runIdentityProbe(
      slots,
      ocrTriggerFingerprintsRef.current,
      slotGenerationsRef.current.slice(),
    );
  }, [nameLookup, ocrAvailability, runIdentityProbe]);

  // The single tick drives BOTH tracks: geometry (fast, authoritative) first so a
  // fresh trigger decision is in place before the identity track reads it.
  const surfaceProbeTick = useCallback(() => {
    geometryProbeTick();
    identityProbeTick();
  }, [geometryProbeTick, identityProbeTick]);

  useEffect(() => {
    surfaceProbeTickRef.current = surfaceProbeTick;
  }, [surfaceProbeTick]);

  // The single scan clock: fires on the fast GEOMETRY cadence for the life of the
  // component and is never cleared by telemetry, phase, or cancellation. Each
  // tick drives both tracks (geometry every tick; OCR only when triggered). It
  // only ever calls the latest tick via the ref, so re-created callbacks never
  // orphan it.
  useEffect(() => {
    const intervalId = setInterval(() => {
      surfaceProbeTickRef.current();
    }, GEOMETRY_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, []);

  // Independent render-health clock. It runs even when no probe promise
  // completes and certifies presentation only from the wall-clock age of the
  // last accepted authoritative geometry. Starting/restarting an attempt never
  // extends stale badges or SCANNING placeholders.
  useEffect(() => {
    const intervalId = setInterval(() => {
      const now = performance.now();
      const inFlightSince = geometryInFlightSinceRef.current;
      geometryHealthRef.current = markGeometryUnhealthyIfExpired(
        geometryHealthRef.current,
        now,
      );
      const health = geometryHealthRef.current;
      const healthy = geometrySchedulerHealthy({
        now,
        foreground: foregroundStateRef.current.gameWindowForeground,
        activeGame: activeGameRef.current,
        lastAcceptedGeometryAt: health.lastAcceptedGeometryAt,
      });
      setGeometrySchedulerIsHealthy(healthy);
      if (import.meta.env.DEV) {
        const frame = visibleFrameRef.current;
        const acceptedGeometryAgeMs =
          health.lastAcceptedGeometryAt == null
            ? null
            : now - health.lastAcceptedGeometryAt;
        const renderAuthoritativeGeometryAgeMs =
          health.lastRenderAuthoritativeGeometryAt == null
            ? null
            : now - health.lastRenderAuthoritativeGeometryAt;
        const continuousUnhealthyAgeMs =
          health.continuousUnhealthyStartedAt == null
            ? null
            : now - health.continuousUnhealthyStartedAt;
        const structurallyVisible =
          frame != null &&
          frame.surfaceValidated &&
          foregroundStateRef.current.gameWindowForeground;
        const renderable = structurallyVisible && healthy;
        const probeSeq = geometrySeqRef.current;
        if (
          structurallyVisible &&
          acceptedGeometryAgeMs != null &&
          acceptedGeometryAgeMs >= GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS * 0.75 &&
          geometryFreshnessWarningSeqRef.current !== probeSeq
        ) {
          geometryFreshnessWarningSeqRef.current = probeSeq;
          console.info("[geometry-freshness-75]", JSON.stringify({
            probeSeq,
            acceptedGeometryAgeMs,
            deadlineMs: GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS,
            inFlight: inFlightSince != null,
          }));
        }
        if (
          lastGeometryRenderableRef.current &&
          !renderable &&
          geometryExpiryWarningSeqRef.current !== probeSeq
        ) {
          geometryExpiryWarningSeqRef.current = probeSeq;
          const hiddenReason: GeometryDiagnosticHideReason =
            !foregroundStateRef.current.gameWindowForeground
              ? "foreground-lost"
              : continuousUnhealthyAgeMs != null
                ? "probe-timeout"
                : "ttl-expired";
          logOverlayDiagnostic("[geometry-stale-hide]", {
            probeSeq,
            attemptGeneration: health.currentAttemptGeneration,
            hiddenReason,
            staleHide: structurallyVisible,
            continuousUnhealthyAgeMs,
            acceptedGeometryAgeMs,
            renderAuthoritativeGeometryAgeMs,
            deadlineMs: GEOMETRY_SCHEDULER_HEALTH_DEADLINE_MS,
            inFlightMs: inFlightSince == null ? null : now - inFlightSince,
            schedulerRestartCount: geometryRestartCountRef.current,
          });
        }
        lastGeometryRenderableRef.current = renderable;
        setOcrLifecycle((previous) => ({
          ...previous,
          frameAgeMs: acceptedGeometryAgeMs,
          frameHiddenByTtl: structurallyVisible && !healthy,
        }));
      }
    }, GEOMETRY_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, []);

  // Development-only rolling access to the last 200 complete geometry probes.
  // The production build folds this branch away with all diagnostic strings.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hooks = window as unknown as {
      __getGeometryProbeDiagnostics?: () => GeometryProbeDiagnostic[];
    };
    hooks.__getGeometryProbeDiagnostics = () => [...geometryDiagnosticsRef.current];
    return () => {
      delete hooks.__getGeometryProbeDiagnostics;
    };
  }, []);

  // DEV-ONLY, opt-in fixture capture (disabled by default). Exposes manual,
  // console-driven hooks to snapshot the current REDACTED surface evidence with
  // a ground-truth label and export a JSONL manifest by hand. Nothing is
  // persisted, uploaded, or committed; the effect no-ops in production.
  useEffect(() => {
    if (!datasetCaptureOn) return;
    const buffer = new SurfaceFixtureBuffer();
    const hooks = window as unknown as {
      __captureOfferFixture?: (label: DatasetLabel) => number;
      __exportOfferFixtures?: () => string;
      __clearOfferFixtures?: () => void;
    };
    hooks.__captureOfferFixture = (label) => {
      const stashed = lastFixtureInputRef.current;
      if (!stashed) return 0;
      return buffer.add(
        buildSurfaceFixtureRecord({ ...stashed, label, timestamp: new Date().toISOString() }),
      );
    };
    hooks.__exportOfferFixtures = () => {
      const manifest = buffer.serialize();
      console.info(`[dataset-capture] ${buffer.all().length} record(s)\n${manifest}`);
      return manifest;
    };
    hooks.__clearOfferFixtures = () => buffer.clear();
    console.info(
      "[dataset-capture] enabled — window.__captureOfferFixture('offer'|'combat'|" +
        "'scoreboard'|'respawn'|'unknown') to label the current frame, then " +
        "window.__exportOfferFixtures() for the JSONL manifest.",
    );
    return () => {
      delete hooks.__captureOfferFixture;
      delete hooks.__exportOfferFixtures;
      delete hooks.__clearOfferFixtures;
    };
  }, [datasetCaptureOn]);

  // P1 fix (member verification must not block game-boundary invalidation):
  // detached, non-blocking member verification. poll() fires this with
  // `void startMemberVerification(request)` and never awaits it, so
  // pollInFlightRef releases immediately and every later poll stays free to
  // detect a confirmed non-live gameflow, a changed game hash, or backward
  // game_time while this request is still in flight. Any of those bump
  // gameEpochRef/activeGameHashRef/memberVerificationTokenRef via
  // beginNewGameEpoch (or the token alone, for a superseding verification
  // request) — so the post-await checks below discard a stale success or
  // failure rather than publish it into a game this request no longer owns.
  const startMemberVerification = useCallback(
    (request: MemberVerificationRequest) =>
      runMemberVerification(
        request,
        {
          epoch: () => gameEpochRef.current,
          gameHash: () => activeGameHashRef.current,
          token: () => memberVerificationTokenRef.current,
          gameActive: () => activeGameRef.current,
          verificationState: () => memberVerificationStateRef.current,
          now: () => performance.now(),
        },
        {
          setMemberSnapshot,
          verifyMemberGameStart,
          recheckGameHash: () => invoke<string | null>("get_game_hash").catch(() => null),
          setVerificationState: (state) => {
            memberVerificationStateRef.current = state;
          },
        },
      ),
    [],
  );

  // Main polling loop
  const poll = useCallback(async () => {
    if (pollInFlightRef.current) {
      pollPendingRef.current = true;
      return;
    }
    pollInFlightRef.current = true;

    try {
      if (!collectorEnabled) {
        liveDataFailureStartedAtRef.current = null;
        setActiveGame(false);
        stopOcr();
        updatePhase("idle");
        return;
      }

      await refreshForeground();

      const gameflow = await invoke<LcuGameflowState | null>("get_lcu_gameflow_state")
        .catch(() => null);
      // The scheduler's coarse "active game" gate: capture is compliant only in
      // a live game. This is the ONLY telemetry the probe scheduler consults.
      // A missing sample (LCU read failure/timeout) is not a confirmed
      // transition — carry the last confirmed value forward instead of
      // collapsing to false, or a single transient blip mid-game instantly
      // sleeps the geometry scheduler for a round that is actually still live.
      gameflowCaptureAllowedRef.current = resolveGameflowCaptureAllowed(
        gameflowCaptureAllowedRef.current,
        gameflow,
      );
      if (shouldClearOcrStateForGameflow(gameflow)) {
        liveDataFailureStartedAtRef.current = null;
        emitNativeDiagnostic("[game-poll]", {
          gameflowPhase: gameflow?.phase ?? "unavailable",
          gameflowConfirmed: gameflow != null,
          captureAllowed: gameflowCaptureAllowedRef.current,
          liveDataStatus: "not-requested",
          action: "clear-confirmed-non-live",
          failureAgeMs: 0,
        });
        const clientFound = await invoke<boolean>("detect_league_client").catch(() => false);
        // On the first owned close, the boundary invokes
        // closeConfirmedGame(clientFound ? "client_found" : "idle");
        applyGameOwnershipObservation({
          ownershipRef: confirmedGameOwnershipRef,
          observation: "confirmed-non-live",
          closeOwnedGame: () => closeConfirmedGame(clientFound ? "client_found" : "idle"),
        });
        return;
      }

      let data: LivePlayerData | null = null;
      let liveDataStatus: "ready" | "unavailable" | "error" = "unavailable";
      {
        const liveDataResult: {
          data: LivePlayerData | null;
          status: "ready" | "unavailable" | "error";
        } = await invoke<LivePlayerData | null>("get_live_player_data").then(
          (value) => ({ data: value, status: value ? "ready" : "unavailable" }),
          () => ({ data: null, status: "error" }),
        );
        data = liveDataResult.data;
        liveDataStatus = liveDataResult.status;
        if (import.meta.env.DEV) {
          const statusTransition = describeLiveClientStatusTransition({
            previousStatus: priorLiveClientStatusRef.current?.gameEpoch === gameEpochRef.current
              ? priorLiveClientStatusRef.current.status
              : null,
            nextStatus: liveDataStatus,
            gameEpoch: gameEpochRef.current,
            foregroundEpoch: foregroundEpochRef.current,
            monotonicMilliseconds: performance.now(),
          });
          priorLiveClientStatusRef.current = {
            gameEpoch: gameEpochRef.current,
            status: liveDataStatus,
          };
          if (statusTransition != null) {
            emitNativeDiagnostic("[game-poll]", {
              gameflowPhase: gameflow?.phase ?? "unavailable",
              gameflowConfirmed: gameflow != null,
              captureAllowed: gameflowCaptureAllowedRef.current,
              liveDataStatus,
              action: "live-data-status-transition",
              ...statusTransition,
            });
          }
        }
        if (data && gameflowCaptureAllowedRef.current) {
          if (gameflow != null) {
            applyGameOwnershipObservation({
              ownershipRef: confirmedGameOwnershipRef,
              observation: "confirmed-live",
              closeOwnedGame: () => closeConfirmedGame("idle"),
            });
          }
          const priorFailureStartedAt = liveDataFailureStartedAtRef.current;
          liveDataFailureStartedAtRef.current = null;
          setActiveGame(true);
          if (priorFailureStartedAt != null) {
            emitNativeDiagnostic("[game-poll]", {
              gameflowPhase: gameflow?.phase ?? "unavailable",
              gameflowConfirmed: gameflow != null,
              captureAllowed: true,
              liveDataStatus,
              action: "recover",
              failureAgeMs: Math.round(Math.max(0, performance.now() - priorFailureStartedAt)),
            });
          }
          // Detect every confirmed new-game boundary — a changed authoritative
          // game/session hash, or backward valid game_time — BEFORE the
          // activation check below and before any downstream game-two offer,
          // member-verification, geometry, or badge diagnostic is scheduled.
          // Otherwise a boundary detected mid-poll doesn't get beginNewGameEpoch
          // (and its fresh live-active) until the NEXT poll, by which time
          // game-two evidence has already published under the still-open
          // game-one epoch.
          const gameHash = await invoke<string | null>("get_game_hash").catch(() => null);
          let verifyGameHash: string | null = null;
          let newGameBoundaryDetected = false;
          if (!gameHash) {
            setMemberSnapshot(disabledMember("game-hash-unavailable"));
          } else if (
            memberBootstrapCompleteRef.current &&
            shouldVerifyGameStart(activeGameHashRef.current, gameHash)
          ) {
            // A changed game hash while ownership never released is an
            // explicit game/session identity change — its own epoch boundary,
            // independent of the backward-game_time signal below. Member
            // verification is deferred until after the activation emission —
            // it is downstream game-two work, not part of boundary detection.
            if (activeGameHashRef.current !== null) {
              newGameBoundaryDetected = true;
            }
            activeGameHashRef.current = gameHash;
            verifyGameHash = gameHash;
          } else if (
            memberBootstrapCompleteRef.current &&
            shouldStartMemberVerification({
              currentGameHash: gameHash,
              verificationState: memberVerificationStateRef.current,
              nowMs: performance.now(),
              gameEpoch: gameEpochRef.current,
              runtimeEligible: gameflowCaptureAllowedRef.current,
            })
          ) {
            // Same authoritative hash as before, but a prior verification for
            // it went inconclusive (null/throwing recheck) and its retry
            // deadline has elapsed. activeGameHashRef is already this hash —
            // it must NOT be reassigned or cleared here, since that would
            // read as a new game boundary rather than a retry of this one.
            verifyGameHash = gameHash;
          }
          const lastGameTime = lastGameTimeRef.current;
          if (isBackwardGameTime({ lastGameTime, gameTime: data.game_time })) {
            newGameBoundaryDetected = true;
          }
          lastGameTimeRef.current = data.game_time;
          if (newGameBoundaryDetected) {
            beginNewGameEpoch();
            stopOcr();
          }
          if (newGameBoundaryDetected) {
            confirmedGameOwnershipRef.current.gameEpoch = gameEpochRef.current;
          }

          // [game-poll] — the ONLY authoritative proof that a healthy live game
          // activated. This success branch returns early, so a session with no
          // Live Client Data outage otherwise emits no in-progress record at all
          // and a correct run reads as incomplete coverage. See
          // shouldAnnounceLiveActivation for the authority rules. Positioned
          // AFTER both boundary checks above, so a boundary crossed THIS poll
          // announces in THIS poll — before any game-two offer/member/geometry/
          // badge diagnostic is scheduled or emitted. Bounded
          // enums/booleans/numbers only; DEV-only via emitNativeDiagnostic.
          if (
            shouldAnnounceLiveActivation({
              devBuild: import.meta.env.DEV,
              liveDataReady: liveDataStatus === "ready",
              gameflowConfirmed: gameflow != null,
              captureAllowed: gameflowCaptureAllowedRef.current,
              alreadyAnnounced: liveOwnershipAnnouncedRef.current,
            })
          ) {
            liveOwnershipAnnouncedRef.current = true;
            emitNativeDiagnostic("[game-poll]", {
              gameflowPhase: gameflow?.phase ?? "unavailable",
              gameflowConfirmed: true,
              captureAllowed: true,
              liveDataStatus,
              action: "live-active",
              failureAgeMs: 0,
            });
          }

          if (verifyGameHash) {
            // Capture the owning context here, synchronously, at the exact
            // boundary that determined verification is needed — then hand it
            // to the DETACHED startMemberVerification helper via `void`. This
            // poll never awaits it: pollInFlightRef releases as soon as the
            // rest of THIS poll finishes, so a later poll can still detect a
            // confirmed non-live close, a changed hash, or backward
            // game_time while this request is in flight (see
            // startMemberVerification for the stale-rejection checks).
            const verificationRequest: MemberVerificationRequest = {
              epoch: gameEpochRef.current,
              gameHash: verifyGameHash,
              token: ++memberVerificationTokenRef.current,
            };
            void startMemberVerification(verificationRequest);
          }

          setPlayerData(data);
          const slug = champNameToSlug(data.champion);
          if (slug !== championSlug) {
            ocrSelectionCompletedRef.current = true;
            setChampionSlug(slug);
            completedRoundsRef.current = 0;
            setPickedAugments([]);
            stopOcr();
          }

          // Round DELIVERY: level thresholds only create eligibility. R1 is
          // delivered at the level-3 timing; R2/R3/R4 deliver during a death
          // sequence after crossing 7/11/15 — reaching a threshold while
          // ALIVE never enters selection, never renders chips, never consumes
          // a round, and never suppresses the future death-triggered offer.
          const decision = resolveRoundDelivery({
            playerLevel: data.level,
            isDead: data.is_dead,
            completedRounds: completedRoundsRef.current,
            offerLatched: offerActive(offerStateRef.current),
          });
          roundDeliveryRef.current = decision;
          setRoundDelivery((previous) =>
            previous &&
            previous.eligibleRounds === decision.eligibleRounds &&
            previous.pendingRounds === decision.pendingRounds &&
            previous.scanMode === decision.scanMode &&
            previous.activeOfferRound === decision.activeOfferRound
              ? previous
              : decision,
          );

          // A confirmed pick (keydown) set selectionCompleted: close the offer
          // and return to in-game. Scanning itself is NOT gated here — the
          // independent 250 ms scheduler keeps probing; the poll only labels
          // rounds and reconciles phase on strong completion evidence.
          if (phaseRef.current === "augment_selection" && ocrSelectionCompletedRef.current) {
            updatePhase("in_game");
            finishOcr();
          }
          return;
        }
      }
      const liveDataDecision = resolveLiveDataPoll({
        now: performance.now(),
        captureAllowed: gameflowCaptureAllowedRef.current,
        liveDataAvailable: data != null,
        failureStartedAt: liveDataFailureStartedAtRef.current,
        // A non-null gameflow here is a FRESH confirmation of a live match: a
        // confirmed non-live phase already returned via
        // shouldClearOcrStateForGameflow above, so reaching this point with a
        // sample means the LCU reports the game in progress. That authoritatively
        // survives an arbitrarily long port-2999 outage (e.g. a death/respawn),
        // which would otherwise fail closed after grace and suspend the geometry
        // probe — blanking the death-triggered augment badges.
        gameflowConfirmedLive: gameflow != null,
      });
      liveDataFailureStartedAtRef.current = liveDataDecision.failureStartedAt;

      emitNativeDiagnostic("[game-poll]", {
        gameflowPhase: gameflow?.phase ?? "unavailable",
        gameflowConfirmed: gameflow != null,
        captureAllowed: gameflowCaptureAllowedRef.current,
        liveDataStatus,
        action: liveDataDecision.action,
        failureAgeMs: Math.round(liveDataDecision.failureAgeMs),
      });
      if (liveDataDecision.action === "preserve") return;

      // This "clear" is an UNCONFIRMED telemetry outage past the fail-closed
      // grace window (or a carried-forward capture gate), not a confirmed
      // non-live gameflow phase — that already returned early above via
      // shouldClearOcrStateForGameflow. Fail rendering/capture closed without
      // touching game identity or the activation latch, so recovery of the
      // SAME match resumes instead of opening a new analyzer epoch.
      try {
        const clientFound = await invoke<boolean>("detect_league_client");
        suspendGameRuntimeForUnavailableTelemetry(clientFound ? "client_found" : "idle");
      } catch {
        suspendGameRuntimeForUnavailableTelemetry("idle");
      }
    } finally {
      pollInFlightRef.current = false;
      if (pollPendingRef.current) {
        pollPendingRef.current = false;
        void pollRef.current();
      }
    }
  }, [
    beginNewGameEpoch,
    champNameToSlug,
    championSlug,
    closeConfirmedGame,
    collectorEnabled,
    finishOcr,
    refreshForeground,
    setActiveGame,
    startMemberVerification,
    stopOcr,
    suspendGameRuntimeForUnavailableTelemetry,
    updatePhase,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key.toLowerCase() === "c" && memberCoachEnabled) {
        setCoachOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        setCoachOpen(false);
        return;
      }
      const regionIndex = Number(event.key) - 1;
      if (
        !memberCoachEnabled ||
        phase !== "augment_selection" ||
        !isCompleteThreeCardOffer(matchedCards) ||
        !Number.isInteger(regionIndex) ||
        regionIndex < 0 ||
        regionIndex > 2
      ) {
        return;
      }
      const offered = [...matchedCards]
        .sort((left, right) => left.regionIndex - right.regionIndex)
        .map((card) => card.augment.slug);
      setPickedAugments((current) =>
        confirmPickedAugment(current, offered, regionIndex),
      );
      const selectedAugmentSlug = offered[regionIndex];
      const confirmedOfferGeneration = offerSurfaceRef.current.offerGeneration;
      const confirmRound = offerRoundOwnershipRef.current.activeOwner?.round ?? null;
      if (selectedAugmentSlug && confirmRound) {
        void invoke("confirm_contributor_round_selection", {
          round: confirmRound,
          selectedAugmentSlug,
        });
      }
      // A confirmed choice is STRONG completion evidence and ends the offer:
      // count the round, clear the latched state, and return to in-game
      // immediately instead of waiting for surface absence.
      updateOfferRoundOwnership(reduceOfferRoundOwnership(
        offerRoundOwnershipRef.current,
        {
          type: "pick-confirmed",
          offerGeneration: confirmedOfferGeneration,
        },
      ));
      ocrSelectionCompletedRef.current = true;
      stopOcr();
      updatePhase("in_game");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [matchedCards, memberCoachEnabled, phase, stopOcr, updateOfferRoundOwnership, updatePhase]);

  useEffect(() => {
    // The only demand signal for foreground polling. Ticks that land during an
    // unsettled invoke coalesce into nothing, so this clock is also what
    // re-polls after a settle and what enforces the logical freshness deadline.
    const foregroundIntervalId = setInterval(() => {
      void refreshForeground();
    }, FOREGROUND_POLL_INTERVAL_MS);
    void refreshForeground();
    return () => clearInterval(foregroundIntervalId);
  }, [refreshForeground]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      void poll();
    }, 1500);
    const initialPollId = setTimeout(() => {
      void poll();
    }, 0);
    return () => {
      clearInterval(intervalId);
      clearTimeout(initialPollId);
    };
  }, [poll]);

  // Fix #5: force an immediate scan the instant the game regains focus, rather
  // than waiting up to 1.5s for the next poll tick. Stale matched cards were
  // already cleared on blur (foreground refresh → stopOcr()), so refocus rebuilds
  // the three-card offer atomically from a fresh OCR pass; badges stay hidden
  // until all three current cards are confidently matched.
  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);
  useEffect(() => {
    if (gameWindowForeground) void pollRef.current();
  }, [gameWindowForeground]);

  // Component teardown: invalidate any in-flight probe (its late return will be
  // stale-rejected) and release the scheduler guard so a remount starts clean.
  // Clearing the token also no-ops the wedged probe's finally (no setState on an
  // unmounted component). Also bumps memberVerificationTokenRef so a detached
  // startMemberVerification request in flight at teardown is stale-rejected
  // the same way, instead of calling setState after unmount.
  useEffect(() => {
    const ocrOwners = ocrOwnersRef.current;
    return () => {
      bumpScanSeq();
      probeInFlightRef.current = false;
      probeInFlightSinceRef.current = null;
      ocrOwners.invalidate();
      geometrySeqRef.current += 1;
      geometryInFlightRef.current = false;
      geometryInFlightSinceRef.current = null;
      geometryInFlightTokenRef.current = null;
      memberVerificationTokenRef.current += 1;
    };
  }, [bumpScanSeq]);

  useEffect(() => {
    const onResize = () =>
      setCssWindow({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ─── Render ───
  return (
    <div className="overlay-root">
      {/* Status dot */}
      {collectorEnabled && gameOverlayIsVisible && <div
        className={`status-dot ${
          phase === "augment_selection"
            ? "status-ocr"
            : phase === "in_game"
              ? "status-connected"
              : phase === "client_found"
                ? "status-waiting"
                : "status-disconnected"
        }`}
      />}

      {/* Per-slot badge chips rendered OUTSIDE the card frames (above the
          derived card frame, side-anchored as fallback). Rendered ONLY for a
          real focused LATCHED offer (realBadgesReady) or explicit League-absent
          preview (previewBadgesReady). Each chip reflects its slot's own
          pipeline state — never stale, never invented. See fixtureMode.ts. */}
      {showBadgeLayer && (
        <BadgeChipLayer
          positionedChips={positionedChips}
          isPreviewMode={isPreviewMode}
        />
      )}

      {/* Minimal HUD when in-game but not selecting */}
      {memberCoachEnabled && phase === "in_game" && championSlug && gameOverlayIsVisible && (
        <div className="hud">
          <span className="champion-tag">
            {playerData?.champion ?? championSlug}
          </span>
          <span className="hud-level">
            Lv.{playerData?.level ?? "?"}
            {roundDelivery && roundDelivery.eligibleRounds > 0 &&
              ` · R${roundDelivery.activeOfferRound}`}
          </span>
        </div>
      )}

      {/* Idle / waiting */}
      {collectorEnabled && gameOverlayIsVisible && phase === "idle" && (
        <div className="idle-panel">Waiting for League client...</div>
      )}
      {collectorEnabled && gameOverlayIsVisible && phase === "client_found" && (
        <div className="idle-panel">Client found — waiting for game...</div>
      )}
      {collectorEnabled && gameOverlayIsVisible && dataError && (
        <div className="idle-panel">Overlay data failed to load: {dataError}</div>
      )}
      {collectorEnabled && gameOverlayIsVisible && memberSnapshot?.error && (
        <div className="member-error">Member coach unavailable: {memberSnapshot.error}</div>
      )}
      {devPanelsVisible({ devBuild: import.meta.env.DEV, gameOverlayIsVisible }) && (
        <DevOverlayDiagnostics
          gameOverlayIsVisible={gameOverlayIsVisible}
          fixtureModeKind={fixtureMode.kind}
          tierFixtureOn={tierFixtureOn}
          geometryPreviewOn={geometryPreviewOn}
          isPreviewMode={isPreviewMode}
          debugCollapsed={debugCollapsed}
          setDebugCollapsed={setDebugCollapsed}
          calibration={calibration}
          calibrationError={calibrationError}
          aramgg={aramgg}
          diag={diag}
          authoritative={authoritative}
          foregroundState={foregroundState}
          ocrDiagnostics={ocrDiagnostics}
          ocrLifecycle={ocrLifecycle}
          fixturePayload={fixturePayload}
        />
      )}

      {/* Startup tip — auto-dismisses after 6s */}
      {collectorEnabled && gameOverlayIsVisible && showStartupTip && (
        <div className="startup-tip">
          <img src="/icon.png" alt="" className="startup-icon" />
          <div className="startup-tip-text">
            <div className="startup-title">Mayhem Oracle</div>
            <div className="startup-hint">⌘Q disabled — use menu bar icon to exit</div>
            <div className="startup-hint">Or ⌘⌥⎋ (Force Quit)</div>
          </div>
        </div>
      )}
      <CoachPanel
        open={memberCoachEnabled && coachOpen && gameOverlayIsVisible}
        result={badgeDecisionResult}
        mode={mode}
        onModeChange={setMode}
        winRateBySlug={badgeWinRateBySlug}
        rawWinRate={isFixtureBacked}
      />
      <CollectorOverlayController
        onStatus={setCollectorStatus}
        showPanel={gameOverlayIsVisible}
      />
    </div>
  );
}

export default App;
