# Phase 1 — what the run-3 trace proves, and the one thing it cannot

Evidence: `.codex/evidence/overlay-r34-spawn-origin/overlay-raw-20260827-000353.log`
(SHA-256 `298b19f5…`). Times are trace-relative; see the pinned manifest.

## OBSERVED

| | healthy (pre-14:30) | collapse peak | last sample read |
| --- | --- | --- | --- |
| `aliveTasks` | median 3 | 507,959 | 37,607 |
| `globalQueueDepth` | median 0 | 507,136 | 36,841 |
| `parkCount`/window | median 113 | 0 | 0 |
| `injectionLatencyMs` | median 0 | never lands | never lands |
| `injectionPendingMs` | ~0 | 26,092 | 81,501 |

Onset is one sample wide: 14:30:16 `park=687, busy=34%`; 14:30:17 `park=0`.
`parkCount` is 0 in EVERY subsequent sample — not one park in ~1,600 samples.

`roundOwner` reached 1 (n=71, last 14:24:16) and 2 (n=50, last 14:28:03), never
3 or 4. The collapse begins ~2 minutes after the last R2 record.

## What is refuted

- **LEAK** — the queue drains at ~950/s (508k → 37.6k). Tasks complete.
- **WAKE-UP FAILURE** — workers never park; there is nothing to wake.
- **Blocking FFI / `System::new_all`** — `lcu-credential-walk` holds a 5 ms
  median and ~350 ms max across the whole 15 h trace, including during the
  collapse. This was the PRIOR SLICE'S OWN NAMED SUSPECT, refuted by the
  instrument built to test it.
- **Geometry scheduler as cause** — the single-flight cap held
  (`nativeOutstanding` <= 2) and the watchdog correctly stopped issuing after
  10 restarts. It is a victim: probes time out because workers are saturated.
- **REFUTED TOKIO LOCALIZATION** does not fire; the localization holds.

## INFERRED — the mechanism

Injection-queue starvation. The asymmetry is the proof:

- `foreground-poll` is a SYNC command answered inline on the IPC thread and
  never touches the runtime → holds 5-15 ms throughout.
- `async-runtime-heartbeat` is already resident on a worker and is woken by
  `tokio::time::sleep` into a WORKER-LOCAL queue → keeps ticking, 200-500 ms
  drift.
- The injection probe (spawned from an OS thread) and every `async fn` command
  (Tauri routes each through `async_runtime::spawn`) land in the GLOBAL queue
  → 81 s pending, effectively never polled.

Worker-local work survives; anything injected from outside starves.

## UNVERIFIED — what supplies the arrivals

Only four spawn sites exist in this crate (`lib.rs:625/663/910/2516`) and none
is in a loop, so application code is not creating 508k tasks. Eliminated as
multipliers: `poll` has an in-flight guard (`pollInFlightRef`),
`refreshForeground` coalesces, and every `setInterval` is cleared.

Marker rates could not settle it either, and one earlier argument from them was
WRONG: `[geometry-timing]` is throttled to 1/s (`App.tsx:2050`), so its rate
never reflected the true probe rate.

This is what `spawn_origin` is built to answer. See `decision-matrix.md`.

## Two corrections to earlier reporting in this investigation

1. "Never recovers" was read off a truncated window. The queue DOES drain.
2. "No marker accounts for the rate, so the spawner is unmarked" is weaker
   than stated, because throttled markers cannot bound an underlying rate.
