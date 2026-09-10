#!/usr/bin/env node
// DEV-ONLY: replay a tee'd overlay diagnostic log into an OCR-lifecycle summary.
//
//   MAYHEM_OVERLAY_TIER_FIXTURE=1 MAYHEM_OVERLAY_TRACE=1 \
//     npm run tauri dev 2>&1 | tee /tmp/overlay-trace.log
//   node ./scripts/replay-trace.mjs /tmp/overlay-trace.log
//
// Consumes only the privacy-bounded diagnostic stream (never OCR text/names).
import { readFileSync } from "node:fs";
import { parseOverlayTrace, summarizeOcrTrace } from "../src/dev/traceReplay.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: node ./scripts/replay-trace.mjs <tee'd-overlay-log>");
  process.exit(2);
}

let text;
try {
  text = readFileSync(path, "utf8");
} catch (error) {
  console.error(`cannot read ${path}: ${error.message}`);
  process.exit(2);
}

const events = parseOverlayTrace(text);
const s = summarizeOcrTrace(events);
const ms = (n) => `count=${n.count} min=${n.min} median=${n.median} max=${n.max}`;

console.log(`trace: ${path}`);
console.log(`diagnostic events: ${events.length}`);
console.log("");
console.log("OCR identity lifecycle:");
console.log(`  triggers          ${s.triggers}`);
console.log(`  starts            ${s.starts}`);
console.log(`  native-finishes   ${s.nativeFinishes}`);
console.log(`  publishes         ${s.publishes}   <- resolved slots`);
console.log(`  timeouts          ${s.timeouts}`);
console.log(`  retries           ${s.retries}`);
console.log(`  stale-rejects     ${s.staleRejects}`);
console.log(`  watchdog-restarts ${s.watchdogRestarts}`);
console.log("");
console.log("native capture (from identity-native-finish):");
console.log(`  samples           ${s.capture.samples}`);
console.log(`  captureAttempted  ${s.capture.captureAttempted}`);
console.log(`  zero-crop samples ${s.capture.zeroCropCount}`);
console.log(`  cropCount         ${ms(s.capture.cropCount)}`);
console.log(`  ocrMs             ${ms(s.capture.ocrMs)}`);
console.log(`  captureMs         ${ms(s.capture.captureMs)}`);
console.log("");
console.log("geometry-stall confirming signals:");
console.log(`  geometry-watchdogs  ${s.geometryWatchdogs}   <- geometry probe restarts`);
console.log(`  geometry inFlightMs ${ms(s.geometryInFlightMs)}   <- how long geometry was blocked`);
console.log(`  native OCR returns  ${s.nativeReturns}`);
console.log(`  native OCR ms       ${ms(s.nativeMs)}   <- true native runtime (incl. past JS timeout)`);
console.log("");
console.log("geometry authority:");
console.log(`  timing samples       ${s.geometryTimings}`);
console.log(`  preCaptureMs         ${ms(s.geometryPreCaptureMs)}`);
console.log(`  captureMs            ${ms(s.geometryCaptureMs)}`);
console.log(`  analysisMs           ${ms(s.geometryAnalysisMs)}`);
console.log(`  nativeElapsedMs      ${ms(s.geometryNativeElapsedMs)}`);
console.log(`  roundTripMs          ${ms(s.geometryRoundTripMs)}`);
console.log(`  stale results        ${s.staleGeometryResults}`);
console.log(`  timeout classes      ${JSON.stringify(s.geometryTimeoutClassifications)}`);
console.log(`  stale-hide events    ${s.geometryStaleHides}`);
console.log(`  recoveries           ${s.geometryRecoveries}`);
console.log(`  unhealthy age ms     ${ms(s.continuousUnhealthyAgeMs)}`);
console.log(`  accepted age ms      ${ms(s.acceptedGeometryAgeMs)}`);
console.log("");
console.log("foreground poll (single-flight invariant):");
console.log(`  settles              ${s.foregroundSettles}`);
console.log(`  late-rejects         ${s.foregroundLateRejects}   <- payload too old or epoch moved`);
console.log(`  logical timeouts     ${s.foregroundLogicalTimeouts}   <- degraded to unknown mid-flight`);
console.log(`  nativeMs             ${ms(s.foregroundNativeMs)}   <- main-thread occupancy per poll`);
console.log(`  in-flight age ms     ${ms(s.foregroundPhysicalInFlightAgeMs)}   <- age at a coalesced tick`);
console.log("");
console.log("all markers:");
for (const [marker, count] of Object.entries(s.markerCounts).sort()) {
  console.log(`  ${marker.padEnd(28)} ${count}`);
}
