import type { Dispatch, SetStateAction } from "react";
import type { AramggFixturePayload } from "./tierFixture";
import type { AramggFixtureState } from "./useAramggTierFixture";
import type { OverlayFixtureMode } from "./fixtureMode";
import type { OverlayCalibration } from "../calibration";
import type { ForegroundState } from "../overlayVisibility";
import type { DiagnosticCounters, OcrCardDiagnostic, OcrLifecycleSnapshot } from "./diagnostics";
import type { AuthoritativeSnapshot } from "../authoritativePublication";

export interface DevOverlayDiagnosticsProps {
  gameOverlayIsVisible: boolean;
  fixtureModeKind: OverlayFixtureMode["kind"];
  tierFixtureOn: boolean;
  geometryPreviewOn: boolean;
  isPreviewMode: boolean;
  debugCollapsed: boolean;
  setDebugCollapsed: Dispatch<SetStateAction<boolean>>;
  calibration: OverlayCalibration | null;
  calibrationError: string | null;
  aramgg: AramggFixtureState;
  diag: DiagnosticCounters;
  /** Render-authoritative snapshot (FIX 2) — the banner reads this, never the
   * raw OCR pipeline counts or the internal latch. */
  authoritative: AuthoritativeSnapshot;
  foregroundState: ForegroundState;
  ocrDiagnostics: OcrCardDiagnostic[];
  ocrLifecycle: OcrLifecycleSnapshot;
  fixturePayload: AramggFixturePayload | null;
}

const EMPTY_DIAGNOSTIC_REGIONS = [0, 1, 2];

function formatTimestamp(value: string | null): string {
  return value ?? "none";
}

export function DevOverlayDiagnostics({
  gameOverlayIsVisible,
  fixtureModeKind,
  tierFixtureOn,
  geometryPreviewOn,
  isPreviewMode,
  debugCollapsed,
  setDebugCollapsed,
  calibration,
  calibrationError,
  aramgg,
  diag,
  authoritative,
  foregroundState,
  ocrDiagnostics,
  ocrLifecycle,
  fixturePayload,
}: DevOverlayDiagnosticsProps) {
  // ONE gate for every development surface below (calibration, OCR
  // diagnostic, ARAMGG debug panel). The 18:53 retest proved a bypass here
  // paints panels over Terminal — there is none anymore: when the canonical
  // predicate is false, this component renders NOTHING. The explicit
  // geometry-preview mode (League absent, watermarked PREVIEW) is the only
  // path that makes the predicate true without game foreground.
  if (!gameOverlayIsVisible) return null;

  const diagnostics: OcrCardDiagnostic[] = ocrDiagnostics.length > 0
    ? ocrDiagnostics
    : EMPTY_DIAGNOSTIC_REGIONS.map((regionIndex) => ({
      regionIndex,
      cardRect: null,
      crop: null,
      captureSucceeded: false,
      rawText: null,
      error: null,
      captureWidth: null,
      captureHeight: null,
      normalizedText: "",
      bestCandidate: null,
      confidence: null,
      rejectionReason: ocrLifecycle.noCropReason ?? "not-started",
      riotCanonicalName: null,
      riotAugmentId: null,
      riotMethod: null,
      aramggResult: null,
      slotState: "scanning" as const,
      rejectionStage: "capture" as const,
    }));

  return (
    <>
      {(calibration || calibrationError) && (
        <div className="calibration-panel" data-dev-only="calibration">
          <div className="calibration-title">
            Calibration{isPreviewMode && " · PREVIEW"}
          </div>
          {calibration ? (
            <>
              <div>Mode: {calibration.mode}</div>
              <div>
                Monitor: {calibration.monitor.x},{calibration.monitor.y}{" "}
                {calibration.monitor.width}x{calibration.monitor.height}
              </div>
              <div>
                League: {calibration.gameWindow
                  ? `${calibration.gameWindow.x},${calibration.gameWindow.y} ${calibration.gameWindow.width}x${calibration.gameWindow.height}`
                  : "not detected"}
              </div>
              <div>Scale: {calibration.monitor.scaleFactor.toFixed(2)}</div>
              <div>
                Viewport: {calibration.viewport.x},{calibration.viewport.y}{" "}
                {calibration.viewport.width}x{calibration.viewport.height}
              </div>
              {calibration.warnings.map((warning) => (
                <div className="calibration-warning" key={warning}>{warning}</div>
              ))}
            </>
          ) : (
            <div className="calibration-warning">{calibrationError}</div>
          )}
        </div>
      )}

      {fixtureModeKind === "ocr-unavailable" && (
        <div className="ocr-diagnostic" data-dev-only="ocr-diagnostic">
          {/* FIX 2 — this banner reads the render-authoritative snapshot, so it
              can never claim "no visible offer" while resolved badges render. */}
          {authoritative.offerVisible
            ? `Offer visible — cards ${authoritative.visibleCards}/3 · resolved ${authoritative.resolvedBadges}/3 · scanning ${authoritative.scanningSlots}/3`
            : "No visible offer"}
          {authoritative.retainedContinuity && " · retained-uncertainty"}
          {` · gen ${authoritative.offerGeneration} · geoseq ${authoritative.geometrySeq}`}
          {aramgg.status !== "ready" && ` · ARAMGG source ${aramgg.status}`}
        </div>
      )}

      {(tierFixtureOn || geometryPreviewOn) && (
        <div
          className="aramgg-debug-panel"
          data-dev-only="debug-panel"
          style={{
            position: "fixed",
            bottom: 8,
            right: 8,
            maxWidth: 520,
            padding: "8px 10px",
            font: "11px/1.4 ui-monospace, monospace",
            color: "#e5e7eb",
            background: "rgba(17,24,39,0.92)",
            border: "1px solid #f59e0b",
            borderRadius: 6,
            zIndex: 9999,
            pointerEvents: "auto",
          }}
        >
          <div style={{ color: "#fbbf24", fontWeight: 700 }}>
            ARAMGG {isPreviewMode ? "PREVIEW" : "TIER FIXTURE"} (dev) ·{" "}
            {aramgg.status === "ready"
              ? aramgg.fromCache
                ? "CACHED"
                : "LIVE"
              : aramgg.status.toUpperCase()}
            <button
              onClick={() => setDebugCollapsed((collapsed) => !collapsed)}
              style={{ marginLeft: 8, font: "inherit", cursor: "pointer" }}
            >
              {debugCollapsed ? "expand" : "collapse"}
            </button>
            <button
              onClick={aramgg.refresh}
              style={{ marginLeft: 4, font: "inherit", cursor: "pointer" }}
            >
              force-refresh
            </button>
          </div>
          {!debugCollapsed && (
            <>
              <div>Source: ARAMGG (aramgg.com static JSON)</div>
              {aramgg.status === "error" && (
                <div style={{ color: "#f87171" }}>ERROR: {aramgg.error}</div>
              )}
              <div style={{ marginTop: 4 }}>
                Phase: {ocrLifecycle.phase} · current round: {ocrLifecycle.currentRound ?? "none"}
              </div>
              <div>
                Probe active: {String(ocrLifecycle.active)} · seq: {ocrLifecycle.probeSeq}
                {" "}· in-flight since:{" "}
                {ocrLifecycle.probeInFlightSince != null
                  ? `${Math.round(ocrLifecycle.probeInFlightSince)}ms`
                  : "idle"}
              </div>
              <div>
                Scheduler: skip/last {ocrLifecycle.probeSkipReason} · restarts{" "}
                {ocrLifecycle.probeRestartCount}
                {ocrLifecycle.probeFailureReason && ` · failure: ${ocrLifecycle.probeFailureReason}`}
              </div>
              <div>
                Presence: plausible titles {ocrLifecycle.plausibleTitles}/3 · confidence{" "}
                {ocrLifecycle.surfaceConfidence.toFixed(2)} · frame age{" "}
                {ocrLifecycle.frameAgeMs != null ? `${Math.round(ocrLifecycle.frameAgeMs)}ms` : "?"}
                {ocrLifecycle.frameHiddenByTtl && " · HIDDEN-BY-TTL"}
              </div>
              <div
                style={{
                  color: ocrLifecycle.lifecycleDisagreement ? "#fbbf24" : undefined,
                }}
              >
                Visible frame: rev {ocrLifecycle.visibleFrameRevision} · surfaceValidated{" "}
                {String(ocrLifecycle.surfaceValidated)} · reason{" "}
                {ocrLifecycle.surfaceReason ?? "none"} · fresh rects{" "}
                {ocrLifecycle.freshRectCount}/3 · latch gen {ocrLifecycle.offerGeneration}
                {ocrLifecycle.lifecycleDisagreement &&
                  " · LATCH≠VISIBLE (grace, not rendered)"}
              </div>
              <div>
                Last scan: {formatTimestamp(ocrLifecycle.lastScanStart)} → {formatTimestamp(ocrLifecycle.lastScanEnd)}
              </div>
              <div>
                Capture attempted: {String(ocrLifecycle.captureAttempted)} · crop count: {ocrLifecycle.cropCount}
                {ocrLifecycle.noCropReason && ` · no-crop reason: ${ocrLifecycle.noCropReason}`}
              </div>
              <div>
                Offer generation: {ocrLifecycle.offerGeneration} · latency: capture{" "}
                {ocrLifecycle.timings.captureMs ?? "?"}ms · ocr {ocrLifecycle.timings.ocrMs ?? "?"}ms
                · native {ocrLifecycle.timings.nativeTotalMs ?? "?"}ms · match{" "}
                {ocrLifecycle.timings.matchMs ?? "?"}ms · end-to-end{" "}
                {ocrLifecycle.timings.endToEndMs ?? "?"}ms
              </div>
              <div style={{ marginTop: 4 }}>
                Pipeline: captured {diag.cardsCaptured} → titles {diag.titlesRead} → riot IDs{" "}
                {diag.riotResolved} → aramgg {diag.aramggMatched} · slots latched: {diag.ocrDetected}
              </div>
              <div>
                pool matched: {diag.offeredMatched} · preview injected: {diag.previewInjected} · catalog records resolved: {diag.catalogResolved}
              </div>
              <div>
                rendered real badges: {diag.renderedRealBadges} · rendered preview badges: {diag.renderedPreviewBadges}
              </div>
              <div style={{ marginTop: 4, opacity: 0.85 }}>
                Foreground: app={foregroundState.foregroundAppName ?? "?"} · bundle=
                {foregroundState.foregroundBundleIdentifier ?? "?"} · owner=
                {foregroundState.foregroundOwnerName ?? "?"} · title=
                {foregroundState.foregroundWindowTitle || "?"} · executable=
                {foregroundState.foregroundExecutablePath ?? "?"} · hwnd=
                {foregroundState.foregroundWindowHandle ?? "?"} · gameForeground=
                {String(foregroundState.gameWindowForeground)} · leagueClientForeground=
                {String(foregroundState.leagueClientForeground)} · riotClientForeground=
                {String(foregroundState.riotClientForeground)} · gameRunning=
                {String(foregroundState.gameRunning)} · gameWindowDetected=
                {String(foregroundState.gameWindowDetected)}
              </div>
              {diagnostics.map((diagnostic) => {
                const cardRect = diagnostic.cardRect
                  ? `${diagnostic.cardRect.x},${diagnostic.cardRect.y} ${diagnostic.cardRect.width}x${diagnostic.cardRect.height}`
                  : "none";
                const crop = diagnostic.crop
                  ? `${diagnostic.crop.x},${diagnostic.crop.y} ${diagnostic.crop.width}x${diagnostic.crop.height}`
                  : "none";
                const captureSize = diagnostic.captureWidth && diagnostic.captureHeight
                  ? `${diagnostic.captureWidth}x${diagnostic.captureHeight}`
                  : "none";
                const confidence = diagnostic.confidence === null
                  ? "?"
                  : diagnostic.confidence.toFixed(2);
                return (
                  <div key={`ocr-diagnostic-${diagnostic.regionIndex}`} style={{ marginTop: 2 }}>
                    card {diagnostic.regionIndex + 1} [{diagnostic.slotState}
                    {diagnostic.rejectionStage && ` @ ${diagnostic.rejectionStage}`}] · cardRect={cardRect} · crop={crop} · image={captureSize} · capture=
                    {String(diagnostic.captureSucceeded)} · raw={diagnostic.rawText ?? ""} · normalized={diagnostic.normalizedText} · riot=
                    {diagnostic.riotCanonicalName ?? "none"}
                    {diagnostic.riotAugmentId && ` (#${diagnostic.riotAugmentId}, ${diagnostic.riotMethod})`} · aramgg=
                    {diagnostic.aramggResult ?? "none"} · best=
                    {diagnostic.bestCandidate ?? "none"} · confidence={confidence} · reject=
                    {diagnostic.rejectionReason ?? "none"}
                  </div>
                );
              })}
              {aramgg.status === "ready" && (
                <>
                  <div>
                    Patch/version: {aramgg.patch ?? "?"} · fetched{" "}
                    {aramgg.fetchedAt
                      ? new Date(aramgg.fetchedAt).toISOString()
                      : "?"}
                    {aramgg.fromCache && " (cache — not live)"}
                  </div>
                  <div style={{ opacity: 0.7 }}>{aramgg.sourceUrls?.stats}</div>
                  <div style={{ opacity: 0.7 }}>{aramgg.sourceUrls?.catalog}</div>
                  {fixturePayload?.debugRows.map((row) => {
                    const lastResort = row.method === "localized-name";
                    return (
                      <div
                        key={row.slug}
                        style={{
                          marginTop: 2,
                          color: lastResort ? "#fbbf24" : undefined,
                        }}
                      >
                        {row.slug} · id={row.augmentId} ·{" "}
                        {lastResort
                          ? `${row.method} (LAST-RESORT fallback)`
                          : row.method}{" "}
                        · wr={row.rawWinRate} → {row.winRatePercent}% · n=
                        {row.numGames} · scope={row.statProvenance}
                        {row.championId && ` (#${row.championId})`} · tier {row.upstreamTier}→{row.cardTier}
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
