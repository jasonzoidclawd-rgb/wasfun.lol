# Phase 1 — static read of the capture path

Zero files changed. Every answer below carries `file:line` citations; none
rests on naming.

**Build under read:** worktree HEAD `4eb271b`. Established first, because a
static read of the wrong build is worthless: `surfaceProbeScheduler.ts` does
**not appear** in `git diff --stat 812ee4f 4eb271b -- overlay/`, i.e. the
scheduler that produced run-B is byte-identical to the one read here. The only
overlay changes since the run-B build are commit `20c9dfe`
("add geometry starvation diagnostics") in `lib.rs`, `surface_probe.rs`,
`App.tsx`, `surfaceGeometry.ts` and three new test files. The static read is
therefore valid for run-B as well as for HEAD.

Pinned hashes re-verified at the start of this phase: 8/8 `OK`.

---

## Q1 `BLOCKING_FFI` — **NO**

> Do the macOS FFI calls on the capture and foreground-state paths execute
> directly inside an async task body, rather than under `spawn_blocking` or on a
> dedicated thread?

**No — on both named paths. Neither runs FFI in an async task body.**

### Capture path

`probe_augment_surface` (`overlay/src-tauri/src/lib.rs:1485-1486`, `async fn`)
does no FFI in its own body. Everything native is inside the closure passed to
`run_bounded_capture` (`lib.rs:1515-1521`), which reaches
`tokio::task::spawn_blocking` at `lib.rs:874`. The closure calls
`capture_and_analyze_surface` -> `capture_surface_frame` (`lib.rs:1399`), and
every FFI call sits inside it:

| FFI | Site |
| --- | --- |
| foreground gate (`CGWindowList` / NSWorkspace walk) | `lib.rs:1409` |
| `xcap` monitor enumeration | `lib.rs:1413` (`monitor_snapshots`) |
| `xcap::Window::all()` | `lib.rs:1416` -> `lib.rs:948` (`find_league_window`) |
| `monitor.capture_image()` | `lib.rs:1421-1424` |

`lib.rs:1401-1406` documents the fix by name: *"Foreground gate runs INSIDE the
bounded capture (off the async runtime) ... on the runtime it starved the
executor so the capture timeout could not fire."*

### OCR path (same shape, checked because it shares the executor)

`detect_augment_names` (`lib.rs:1217-1218`, `async fn`) also runs its
foreground gate inside `run_bounded_capture` (`lib.rs:1221-1231`). The latent
defect the prior Phase 1 flagged as item 4 — `collect_foreground_state()` on
the async task at the old `lib.rs:1220` — **has been fixed** at this HEAD.
Re-verified, not inherited.

### Foreground-state path

`get_foreground_state` (`lib.rs:2350-2353`) and `is_league_foreground`
(`lib.rs:2356-2359`) are **sync** `#[tauri::command] fn`. Tauri classifies a
non-`async` command `ExecutionContext::Blocking`
(`tauri-macros-2.5.5/src/command/wrapper.rs:49`, `:137-138`) and `body_blocking`
emits a direct inline call — `let result = $path(...)`, no spawn
(`wrapper.rs:384-390`). It never enters an async task body.

That is also written down in this repo, at
`overlay/src/foregroundPollScheduler.ts:5-8`:

> `get_foreground_state` is a NON-async Tauri command, so tauri classifies it
> Blocking and runs it INLINE on the IPC/main thread.

**Empirical corroboration, from raw lines rather than from the source claim.**
The >100 ms `[foreground-poll]` settlements are the `sysinfo::System::new_all()`
cache misses (`lib.rs:2211`, TTL `PROCESS_PRESENCE_TTL = 5000 ms` at
`lib.rs:2179`). Across the whole run their **spacing median is 5988 ms** — the
5 s TTL plus one poll tick — which identifies them positively. Their **cost is
flat**: median 275 ms in `HEALTHY_CORE`, 299.5 ms in `HEALTHY`, 306 ms in R3,
315 ms in R4, 299 ms (max 465 ms) in `DEEP_TAIL`. The full process-table walk
never degrades, anywhere, including 167 s deep into the collapse.

### The exception, off the named paths but on the same executor

Three commands **do** run a blocking, uncancellable, whole-system FFI directly
in an async task body:

```
lib.rs:111-115   async fn get_game_phase()          -> lcu::discover_lcu_credentials()
lib.rs:117-121   async fn get_lcu_gameflow_state()  -> lcu::discover_lcu_credentials()
lib.rs:123-126   async fn get_game_hash()           -> lcu::discover_lcu_credentials()
```

`discover_lcu_credentials` (`lcu.rs:145-147`) calls
`SysinfoLeagueProcessProvider::league_processes` (`lcu.rs:22-24`), whose first
statement is **`sysinfo::System::new_all()`** — a full refresh of every
process, disk, network and component. It is synchronous, it is not wrapped in
`spawn_blocking`, and it is on no cache. The 1.5 s game poll
(`App.tsx:3942-3944`) calls `get_lcu_gameflow_state` every tick
(`App.tsx:3576`) and `get_game_hash` conditionally (`App.tsx:3548`, `:3675`).

This is **not** on the capture or foreground-state path, so it does not change
the Q1 answer as asked. It is recorded here because it is the only blocking
FFI in an async task body anywhere in the crate, it fires on a fixed 1.5 s
cadence, and it shares the executor with `probe_augment_surface`. Two facts
bound how much it can explain, and both are stated rather than left for a
reader to assume:

- Tauri's global runtime is **multi-threaded** —
  `tauri-2.10.3/src/async_runtime.rs:213-220` builds `TokioRuntime::new()`,
  i.e. `new_multi_thread` with one worker per core — and this crate never
  overrides it (`grep -rn "async_runtime::set" src-tauri/src` is empty;
  `main.rs` is four lines). One blocked worker is not starvation.
- The game poll is physically single-flight (`App.tsx:3559-3563`, released in a
  `finally` at `:3852`), so at most one such call is outstanding at a time.

So this is a **candidate to carry into the next collapse recording, not a
proven trigger**, and this slice does not treat it as one.

---

## Q2 `SINGLE_FLIGHT` — **YES** (a bound exists; three independent ones)

> Is there any bound on in-flight capture dispatches?

| # | Bound | Value | Site |
| --- | --- | --- | --- |
| 1 | JS outstanding-native cap | **1**, raised to **2** only while the oldest outstanding call is >= 4000 ms old | `surfaceProbeScheduler.ts:59`, `:79`, `:66`; applied `:165-172` |
| 2 | JS in-flight guard | 1 logical probe; a tick during a flight returns `skip: "in-flight"` | `surfaceProbeScheduler.ts:173-184` |
| 3 | Rust per-channel capture permit | `MAX_CONCURRENT_CAPTURES = 4` via `CapturePermit::try_acquire`, a non-blocking atomic CAS | `lib.rs:798`, `:837-853`, acquired `:873` |

Because a bound exists, the caller's alternative — "if there is none, state the
tick interval and compare it against the ~700 ms closure work" — does not
decide this. It is answered anyway, because the *raw* rates do look pathological
and a reader deserves the reconciliation:

- **Tick interval is 150 ms, not 250 ms.** `PROBE_INTERVAL_MS = 250`
  (`surfaceProbeScheduler.ts:24`) is the default in `DEFAULT_PROBE_CONFIG`
  (`:120-123`) and **App.tsx does not use it**. The live config is
  `GEOMETRY_PROBE_CONFIG` with `intervalMs: GEOMETRY_INTERVAL_MS`
  (`App.tsx:228-232`), and `GEOMETRY_INTERVAL_MS = 150`
  (`surfaceGeometry.ts:30`). The React effect ticks on the same 150 ms
  (`App.tsx:3376-3381`).
- Raw arrival 1/0.150 s = **6.67/s**; service 1/0.703 s = **1.42/s**;
  utilization 4.7. Unbounded, that is textbook monotonic queue growth with flat
  service time — exactly the recorded signature.
- **The cap removes it.** With `MAX_OUTSTANDING_NATIVE_PROBES = 1`, ticks
  arriving during a flight coalesce into `skip`, so the *issued* rate is one
  per settle, and utilization is 1 by construction, never 4.7.

The measured trace agrees with the bounded reading, not the unbounded one:
across the whole run `nativeOutstanding` never exceeds 2, and the geometry
record count per 60 s falls from ~55 to 1-2 as service time grows — output
tracking service rate, which is what a *bounded* queue does. An unbounded queue
would have kept issuing at 6.67/s.

**Therefore the unbounded-dispatch hypothesis the caller offered as the
"candidate trigger that needs no game to confirm" is refuted from source, and
refuted at HEAD *and* at the run-B build.** That is a real result: it removes
the one hypothesis this slice could have settled for free.

One honest qualification. The bound is on *dispatches*, not on *outstanding
native work*: an abandoned probe keeps running and keeps its Rust permit
(`lib.rs:874-882` — "the permit deliberately lives in the blocking worker"),
and the wedge discount admits one replacement behind it
(`surfaceProbeScheduler.ts:165-172`). The hard ceiling is two concurrent native
captures per channel, well under the Rust cap of four. Two is a bound; it is
not zero.

---

## Q3 `QUEUE_GATE` — **NO**

> Is capture or geometry gated on Mayhem queue id / gameMode?

The full gate chain for a geometry probe, each link cited:

| Gate | Predicate | Site |
| --- | --- | --- |
| `foreground` | `foregroundState.gameWindowForeground` — process/window identity match | `App.tsx:3206`; `foreground::is_actual_game_process` |
| `activeGame` | set from the live-data poll only | `App.tsx:735-737`, read `:3207` |
| `captureAllowed` | `resolveGameflowCaptureAllowed` -> `shouldRunOcrForGameflow` -> `gameflow.liveCaptureAllowed` | `augmentSelection.ts:169-187` |
| `liveCaptureAllowed` | **`phase == NormalizedGameflowPhase::InProgress`, and nothing else** | `lcu.rs:164` |
| Rust in-capture gate | `collect_foreground_state().game_window_foreground` | `lib.rs:1409` |

`lcu.rs:164` is the whole of it: `let live_capture_allowed = phase == NormalizedGameflowPhase::InProgress;`
No queue id, no `gameMode`, no map id appears anywhere in the chain.

Queue 2400 **does** appear in the crate — three times, all on the
*background match-collection and upload* paths, none of which gates capture or
geometry:

- `collector.rs:517` — skips a match detail whose `queueId != 2400`
- `collector.rs:558-560` — `extract_mayhem_match_ids` filters history to 2400
- `sanitize.rs:62-67` — refuses to sanitize a non-2400 match for upload

**`PRACTICE_TOOL_VIABLE: YES`**, on the code. Practice Tool reports LCU
gameflow `InProgress`, runs the same `LeagueClient`/`League of Legends` game
process and window, and serves Live Client Data on port 2999 — so every gate
above opens. Two limitations, stated so the operator is not surprised:

1. Practice Tool produces **no augment offers**, so it can exercise the probe
   loop, the latency series and the collapse, but it cannot validate offer
   capture, surface classification, or badge rendering.
2. It is a *fallback*, not the Phase 2 deliverable. The bench below is required
   to need no League process at all, which is strictly stronger.

The bot question in the caller's prompt (`step-zero.md` C10) is therefore moot
either way and was never used.

---

## Serialization points on the capture path

Complete enumeration. "Capture path" = `probe_augment_surface` ->
`run_bounded_capture` -> `capture_and_analyze_surface` ->
`capture_surface_frame` -> `analyze_surface`.

| # | Primitive | Site | Hold scope | Held across `.await`? | Leakable? |
| --- | --- | --- | --- | --- | --- |
| 1 | `AtomicUsize` `GEOMETRY_CAPTURE_IN_FLIGHT` (+ `CapturePermit` RAII) | `lib.rs:803`, `:828-860` | `try_acquire` (`:873`) until the blocking closure returns (`:874-882`); the permit is **moved into** the closure | **N/A** — not a lock; `try_acquire` is a non-blocking CAS that returns `Busy` rather than waiting | **No.** `Drop` decrements (`:856-860`). Moved into the closure, so a closure panic still unwinds through it; a `spawn_blocking` failure drops the un-moved value. A timed-out `.await` deliberately does **not** release it — a long hold, bounded by the OS call, not a leak |
| 2 | `std::sync::Mutex` `PROCESS_PRESENCE_CACHE` | `lib.rs:2181-2182`; taken `:2196`, `:2219` | Two separate short critical sections: a read that copies the `Option` out (`:2194-2199`) and a write of the new value (`:2218-2222`) | **No.** `game_process_running` is a sync `fn` (`lib.rs:2193`) with no `.await` anywhere in it | No. Poison is absorbed via `PoisonError::into_inner` on both sites, so a panicking holder cannot wedge later callers |
| 3 | *(none)* `Semaphore` | — | The crate contains **no** `tokio::sync::Semaphore` and no `Semaphore` of any kind (`grep -rn "Semaphore" src-tauri/src` is empty) | — | — |
| 4 | *(none)* bounded channel | — | The only channels in the crate are `std::sync::mpsc` inside `#[cfg(test)]` modules (`lib.rs:334`, `:572`; sites `:367`, `:421`, `:448`, `:495`, `:523`, `:587`, `:626`). None is on a production path | — | — |
| 5 | *(none)* `RwLock` | — | The crate contains no `RwLock` | — | — |

`lib.rs:2206-2210` states the one design decision worth restating, because it
is the property that keeps #2 off the critical path: *"The lock is deliberately
NOT held across the enumeration. Concurrent callers ... would otherwise
serialize behind the slowest process-table walk."*

### Off the capture path, checked because the question is about starvation

| Primitive | Site | Finding |
| --- | --- | --- |
| `tokio::sync::Mutex<CollectorRuntime>` | `collector.rs:150`; taken `:596`, `:721`, `:763` | **Held across many `.await`s** (`:600`-`:679`). This is legal and non-blocking — an async mutex yields rather than parking a worker — and the collector is gated off during a live game (`blocks_background_collection` includes `InProgress`, `lcu.rs:165-173`). Not a worker-blocking point |
| `std::sync::Mutex<CollectorSettings>` / `<Option<String>>` | `collector.rs:149`, `:153` | Short sync critical sections only |
| `std::sync::Mutex<MemberSnapshot>` | `member.rs:93`; taken `:124`, `:182`, `:226` | `:182` is inside `async fn game_start`, but the guard is a temporary within one expression (`.lock()?.clone()`) and is dropped at the end of the statement — no `.await` while held |

**A general argument closes the "std lock across await" question rather than
resting on the three cases above.** `std::sync::MutexGuard` is `!Send`, and
Tauri requires a command future to be `Send`
(`tauri-2.10.3/src/ipc/mod.rs:343-346`: `F: Future<...> + Send + 'static`). A
`std::sync::Mutex` held across an `.await` inside any `#[tauri::command]
async fn` or `tauri::async_runtime::spawn` task is therefore a **compile
error**, not a latent bug. The class is structurally excluded from this crate.

---

## What Phase 1 did and did not settle

**Settled, from source:**

1. No FFI executes in an async task body on the capture or foreground-state
   path (Q1 = NO).
2. In-flight capture dispatches are bounded three ways, and the
   unbounded-queue hypothesis is refuted at both builds (Q2 = YES).
3. Neither capture nor geometry consults queue id or `gameMode` (Q3 = NO), so
   Practice Tool clears every gate.
4. The capture path holds exactly one lock, for two short sync critical
   sections, never across an `.await`, with no leakable permit and no
   semaphore or channel anywhere.

**Not settled.** Nothing here names what occupies the async runtime from
`t ~ 546 s`. The strongest remaining candidate is the `sysinfo::System::new_all()`
call in `discover_lcu_credentials` on the async LCU commands (`lib.rs:117-126`,
`lcu.rs:145`, `lcu.rs:24`) — but single-flighting and a multi-threaded runtime
both argue against it being sufficient on its own, and the one directly
comparable measurement available (the *main-thread* `new_all()` on the
foreground path) shows that walk **flat at ~300 ms throughout the collapse**.
Naming it would be a guess, and Phase 3's authorization test does not license
one.
