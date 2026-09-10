#!/usr/bin/env node
// DEV-ONLY: analyze the geometry dispatch/resume bench stream produced by
// `cargo run --example geometry_dispatch_bench` (slice overlay-r34-shortest).
//
//   cd overlay/src-tauri
//   cargo run --example geometry_dispatch_bench -- 20 > bench.jsonl
//   node ../scripts/analyze-geometry-bench.mjs bench.jsonl
//
// Consumes only the bench's own timing stream. No OCR text, no game state.
//
// The reproduction criterion below is PRE-REGISTERED: it is derived from the
// live R3 numbers in .codex/gates/overlay-r34-shortest/phase0-cadence.md and
// from two product constants, not from this run's data. Read it before the
// table, so a threshold cannot be accused of having been fitted afterwards.
//
//   REPRODUCED requires BOTH, in the same 60 s bucket:
//     (a) median rust_wait >= 2000 ms. 2000 ms is PROBE_TIMEOUT_MS
//         (surfaceProbeScheduler.ts:34) — the point at which the product
//         abandons the probe and the displayed geometry goes stale. It is
//         also far below the live R3 stale-geometry rust_wait median of
//         8157.5 ms, so this is a GENEROUS bar: the bench may clear it while
//         being an order of magnitude milder than the live collapse.
//     (b) that bucket's median closureWorkMs within 2x of the whole run's
//         median. The live collapse held closure work flat while rust_wait
//         exploded; a bucket that is slow because the WORK got slower is a
//         different phenomenon and must not be scored as a reproduction.
//
// Anything else is NOT_REPRODUCED.
import { readFileSync } from "node:fs";

const REPRO_RUST_WAIT_MS = 2000;
const CLOSURE_FLATNESS_FACTOR = 2;
const BUCKET_MS = 60_000;

const path = process.argv[2];
if (!path) {
  console.error("usage: node ./scripts/analyze-geometry-bench.mjs <bench.jsonl>");
  process.exit(2);
}

let text;
try {
  text = readFileSync(path, "utf8");
} catch (error) {
  console.error(`cannot read ${path}: ${error.message}`);
  process.exit(2);
}

const records = { geometry: [], heartbeat: [], gamePoll: [], watchdog: [], start: null, end: null };
for (const line of text.split("\n")) {
  const match = /^\[([a-z-]+)\] (\{.*\})$/.exec(line.trim());
  if (!match) continue;
  let payload;
  try {
    payload = JSON.parse(match[2]);
  } catch {
    continue;
  }
  if (match[1] === "geometry-timing") records.geometry.push(payload);
  else if (match[1] === "async-runtime-heartbeat") records.heartbeat.push(payload);
  else if (match[1] === "bench-game-poll") records.gamePoll.push(payload);
  else if (match[1] === "geometry-watchdog") records.watchdog.push(payload);
  else if (match[1] === "bench-start") records.start = payload;
  else if (match[1] === "bench-end") records.end = payload;
}

const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
};
const median = (values) => quantile(values, 0.5);
const max = (values) => (values.length === 0 ? null : Math.max(...values));
const fmt = (value) => (value === null ? "-" : Number.isInteger(value) ? String(value) : value.toFixed(1));

const rustWait = (record) => record.dispatchWaitMs + record.resumeWaitMs;

const bucketsOf = (rows) => {
  const map = new Map();
  for (const row of rows) {
    const key = Math.floor(row.benchElapsedMs / BUCKET_MS);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

const geometryBuckets = bucketsOf(records.geometry);
const heartbeatBuckets = bucketsOf(records.heartbeat);
const pollBuckets = bucketsOf(records.gamePoll);
const overallClosure = median(records.geometry.map((r) => r.closureWorkMs));

console.log(`bench: ${path}`);
console.log(`config: ${JSON.stringify(records.start)}`);
console.log(`final:  ${JSON.stringify(records.end)}`);
console.log("");
console.log(
  `geometry records ${records.geometry.length} (stale ${records.geometry.filter((r) => r.stale).length})` +
    ` | heartbeat ${records.heartbeat.length} | game-poll ${records.gamePoll.length}` +
    ` | watchdog-abandons ${records.watchdog.length}`,
);
const realFrames = records.geometry.filter((r) => r.capturedRealFrame).length;
console.log(`captured real frames: ${realFrames}/${records.geometry.length}`);
console.log("");

// Inter-arrival of geometry records — the bench's analogue of the live
// "geometry stalled while the poll kept cadence" measurement.
const arrivals = records.geometry.map((r) => r.benchElapsedMs);
const gaps = arrivals.slice(1).map((value, index) => value - arrivals[index]);
console.log(
  `geometry inter-arrival ms: median=${fmt(median(gaps))} p95=${fmt(quantile(gaps, 0.95))} max=${fmt(max(gaps))}`,
);
console.log("");

const header = [
  "min",
  "n",
  "stale",
  "rustWait_med",
  "rustWait_p95",
  "rustWait_max",
  "disp_med",
  "disp_max",
  "resume_med",
  "resume_max",
  "closure_med",
  "transport_med",
  "hb_drift_max",
  "sysinfo_med",
  "sysinfo_max",
];
console.log(header.join("\t"));

const bucketKeys = [...geometryBuckets.keys()].sort((a, b) => a - b);
const bucketRows = [];
for (const key of bucketKeys) {
  const rows = geometryBuckets.get(key);
  const waits = rows.map(rustWait);
  const closure = median(rows.map((r) => r.closureWorkMs));
  const heartbeats = heartbeatBuckets.get(key) ?? [];
  const polls = pollBuckets.get(key) ?? [];
  const row = {
    minute: key,
    n: rows.length,
    stale: rows.filter((r) => r.stale).length,
    rustWaitMedian: median(waits),
    closureMedian: closure,
  };
  bucketRows.push(row);
  console.log(
    [
      key,
      rows.length,
      rows.filter((r) => r.stale).length,
      fmt(median(waits)),
      fmt(quantile(waits, 0.95)),
      fmt(max(waits)),
      fmt(median(rows.map((r) => r.dispatchWaitMs))),
      fmt(max(rows.map((r) => r.dispatchWaitMs))),
      fmt(median(rows.map((r) => r.resumeWaitMs))),
      fmt(max(rows.map((r) => r.resumeWaitMs))),
      fmt(closure),
      fmt(median(rows.map((r) => r.transportMs))),
      fmt(max(heartbeats.map((h) => h.maxDriftMs))),
      fmt(median(polls.map((p) => p.sysinfoMs))),
      fmt(max(polls.map((p) => p.sysinfoMs))),
    ].join("\t"),
  );
}

console.log("");
console.log(`whole-run closure median: ${fmt(overallClosure)} ms`);
console.log(
  `whole-run rust_wait: median=${fmt(median(records.geometry.map(rustWait)))}` +
    ` p95=${fmt(quantile(records.geometry.map(rustWait), 0.95))}` +
    ` max=${fmt(max(records.geometry.map(rustWait)))}`,
);
console.log(
  `whole-run heartbeat drift: max=${fmt(max(records.heartbeat.map((h) => h.maxDriftMs)))} ms` +
    ` | dropped ticks=${records.heartbeat.filter((h) => h.ticks < h.expectedTicks).length}/${records.heartbeat.length}`,
);
console.log("");

// Time-correlation check: does rust_wait trend upward with elapsed time?
// First half vs second half, on medians, so one spike cannot carry it.
const half = Math.floor(bucketRows.length / 2);
const firstHalf = median(bucketRows.slice(0, half).map((r) => r.rustWaitMedian));
const secondHalf = median(bucketRows.slice(half).map((r) => r.rustWaitMedian));
console.log(
  `time-correlation: first-half bucket-median rust_wait=${fmt(firstHalf)} ms,` +
    ` second-half=${fmt(secondHalf)} ms`,
);

const hits = bucketRows.filter(
  (r) =>
    r.rustWaitMedian !== null &&
    r.rustWaitMedian >= REPRO_RUST_WAIT_MS &&
    r.closureMedian !== null &&
    r.closureMedian <= overallClosure * CLOSURE_FLATNESS_FACTOR,
);
console.log(
  `criterion: buckets with median rust_wait >= ${REPRO_RUST_WAIT_MS} ms and flat closure work: ${hits.length}`,
);
if (hits.length > 0) {
  for (const hit of hits) {
    console.log(
      `  minute ${hit.minute}: rust_wait median ${fmt(hit.rustWaitMedian)} ms, closure median ${fmt(hit.closureMedian)} ms`,
    );
  }
}
console.log("");
console.log(`BENCH: ${hits.length > 0 ? "REPRODUCED" : "NOT_REPRODUCED"}`);
