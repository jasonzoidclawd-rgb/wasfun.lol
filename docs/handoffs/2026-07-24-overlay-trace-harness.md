# Handoff — Overlay trace harness (record the OCR lifecycle, replay it offline)

**Date:** 2026-07-24 · **Author:** Claude (implemented + verified) · **Status:**
DONE on `feat/overlay-tier-card` (uncommitted working tree). No push/PR/merge.

## Why

Live 11/15 (death-triggered R3/R4) offers now REACH `augment_selection` (the
death-outage fix works — see `2026-07-24-death-outage-badges-fix.md`), but badges
stall at `resolved 0/3`, cycling `SCANNING → OCR ERROR`. The OCR-identity
lifecycle that would explain *why* is emitted via `logOverlayDiagnostic`, which
was **WebView-console-only** — invisible during a live game. So the failure was a
black box.

## What (additive, dev-only, compliance-clean)

The `[identity-*]` / `[slot-publication]` / `[offer-state]` payloads are already
privacy-bounded (OCR text hashed via `boundedDiagnosticHash`, champion carried as
`championId`, everything else counts/enums/millis). A raw-probe recorder would
have breached the no-names/no-OCR-text boundary; routing the ALREADY-sanitized
stream to the terminal does not.

1. **Record** — `src/dev/publicationDiagnostics.ts`: new pure predicate
   `traceForwardingEnabledFrom({dev, flag})` + `MAYHEM_OVERLAY_TRACE=1` gate. When
   set (dev only), `logOverlayDiagnostic` ALSO forwards to the terminal stderr
   sink (`emit_overlay_diagnostic`, same path `emitNativeDiagnostic` uses; the two
   now share `forwardToNativeSink`). Off by default → zero behavior change.
2. **Replay** — `src/dev/traceReplay.ts`: `parseOverlayTrace(log)` +
   `summarizeOcrTrace(events)` reduce a tee'd log to an OCR-lifecycle tally
   (starts / native-finishes / publishes / timeouts / retries / stale-rejects /
   watchdog-restarts + capture stats: cropCount, ocrMs, captureMs). CLI:
   `scripts/replay-trace.mjs`.

Nothing in the OCR track, geometry, scoring, offer-surface, App.tsx, or Rust was
touched. Inert in production (`!import.meta.env.DEV` early-return; Rust sink
`#[cfg(not(debug_assertions))]`).

## Use

```bash
cd overlay
MAYHEM_OVERLAY_TIER_FIXTURE=1 MAYHEM_OVERLAY_TRACE=1 \
  npm run tauri dev 2>&1 | tee /tmp/overlay-trace-$(date +%H%M).log
# play until a level-11/15 death-triggered offer stalls, then:
node ./scripts/replay-trace.mjs /tmp/overlay-trace-<HHMM>.log
```

Reading the summary (localizes `resolved N/3`):
- `starts ≫ native-finishes` → native OCR call not returning (timeouts).
- `native-finishes` but high `zero-crop samples` → capture produced no crops.
- crops present but `publishes 0` → matching/ownership rejection (`stale-rejects`)
  or champion-data gap.
- large `ocrMs` → the OCR call itself is starved/slow.

## Do not regress

- Keep the `MAYHEM_OVERLAY_TRACE` forward in `logOverlayDiagnostic`. The wiring is
  pinned by a source-guard test in `publicationDiagnostics.test.ts`
  (`"if (isTraceForwardingEnabled()) forwardToNativeSink(marker, serialized);"`).
- `boundedDiagnosticHash` on OCR text and `championId` (not champion name) are the
  compliance boundary — never widen a diagnostic payload to raw text/names.

## Verification (all green)

```
cd overlay
npx vitest run                # 389 passed / 0 failed
npx tsc --noEmit              # clean
npx eslint <changed files>    # clean
npm run build                 # ✓ built (dev modules aliased out)
node ./scripts/replay-trace.mjs <synthetic log>   # summary renders
```

## Update (14:xx) — confirming instruments for the geometry-stall diagnosis

Trace `overlay-trace-1403.log` showed: death-triggered offer gen 193 renders
cleanly, its OCR run (runId 7) times out at 2000 ms, and the geometry probe
**freezes** (`[offer-session]` goes silent, geoseq frozen at 707) → stuck
`scanning 3/3`, no recovery. JS scheduler is provably independent, so the stall
is native-layer capture contention (neither `capture_card_name_crops` nor
`probe_augment_surface`'s `capture_image` is `spawn_blocking`'d). Two signals
were invisible; now routed to the trace sink (TS-only, no Rust change):

- **`[geometry-watchdog]`** (App.tsx geometryProbeTick) — was `console.info`-only;
  now `logOverlayDiagnostic`. Its `inFlightMs` = how long geometry was blocked.
- **`[identity-native-return]`** (App.tsx OCR call site) — chained on the
  `detect_augment_names` invoke so it logs the true native runtime **even after
  the JS 2000 ms race abandoned the promise** (`executeOcrRun` can't cancel it).

`traceReplay.ts` now summarizes both (`geometryWatchdogs`, `geometryInFlightMs`,
`nativeReturns`, `nativeMs`); `replay-trace.mjs` prints a "geometry-stall
confirming signals" block. Confirming capture must **dwell in the stall ~30 s**
(do not Ctrl-C at the first timeout). Read: watchdog `inFlightMs` multi-second +
`nativeMs` ≫ 2000 coincident with the frozen geoseq → contention confirmed.

## Still open (the harness exists to close these)

- **OCR-starvation at 11/15**: capture a traced level-11 run, replay, root-cause.
  Likely candidates: native OCR throughput during the death sequence, or
  ownership churn rejecting late publishes. Fix belongs in the OCR track — a
  sensitive subsystem; investigate from the trace before changing it.
- **Hanging badges over combat** (badges persist after the offer is gone, tab
  won't clear): separate offer-teardown/persistence thread.

## 2026-07-26 trace contract extension

The analyzer now also summarizes the geometry authority path:

- `preCaptureMs`, `captureMs`, `analysisMs`, `nativeElapsedMs`, `roundTripMs`;
- stale result count and timeout classification;
- attempt generation;
- continuous unhealthy age and accepted-geometry age;
- watchdog restarts, stale hides, and recoveries.

`[geometry-hidden]` is emitted by the independent health clock, so a trace can
prove that stale presentation was hidden even when no native probe completed.
`[geometry-recovery]` is emitted only after a fresh owner-current authoritative
geometry result resets the continuous unhealthy period. Payloads remain bounded
numbers, booleans, enums, and irreversible hashes; no names, raw OCR text,
screenshots, frames, chat, account identifiers, or raw Live Client Data were
added.
