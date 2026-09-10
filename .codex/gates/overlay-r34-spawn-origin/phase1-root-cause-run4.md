# Phase 1 (run 4) — Root cause: unstable-default render loop in useCollectorStatus

Terminal claim: **SOURCE-PROVEN mechanism + MEASURED amplification.**
No fix shipped. No product file modified. Live confirmation is a HUMAN gate.

## The defect

`overlay/src/collector/CollectorStatus.tsx:42`

```ts
onStatus: (status: CollectorSnapshot) => void = () => {},
```

A default parameter expression is evaluated **on every call** when the argument
is `undefined`. `() => {}` therefore yields a **fresh function identity per
render**.

Two call sites pass `undefined`:

- `:263` `CollectorConsentWindow`  — `useCollectorStatus(undefined, { poll: false })`
- `:296` `CollectorControlsWindow` — `useCollectorStatus(undefined, { poll: false })`

## The loop (unconditional, no fixed point)

1. render N -> `onStatus` = fresh `() => {}`
2. `applyStatus = useCallback(..., [onStatus])` (:50) -> fresh identity
3. refresh effect deps `[applyStatus, poll, publishRefreshes]` (:84) -> re-runs.
   `void refresh(false)` (:75) executes **before** the `if (!poll) return`
   early exit, so `poll:false` does not suppress it -> `invoke("get_collector_status")`
4. listen effect deps `[applyStatus]` (:106) -> cleanup `unlisten?.()` then
   `listen(...)` -> **one matched `plugin:event|unlisten` + `|listen` pair per render**
5. command resolves -> `applyStatus(next)` -> `setStatus(next)`. `next` is
   freshly deserialized across the IPC boundary, so `Object.is` always fails
   and React commits -> render N+1 -> goto 1

Rate is bounded only by IPC round-trip. `get_collector_status`
(`src-tauri/src/collector.rs:685`) is `pub fn`, **not** `pub async fn`: a sync
command answers inline on the IPC thread, so the round trip is fast and the
call is **invisible to a tokio worker sample**.

CORRECTION to run-4 interim analysis: `get_collector_status` weighted 54 frames
was read as evidence the refresh effect was idle, exonerating `applyStatus`.
That inference is void — a sync command cannot appear there at any call rate.

## Why it saturates the runtime

`plugin:event|listen` / `|unlisten` are `async fn` commands
(`tauri-2.10.3/src/event/plugin.rs:14-31`) -> every call routes through
`tauri::async_runtime::spawn` -> `src/async_runtime.rs:200`, injected from the
off-runtime IPC thread into the **global injection queue**.

Matches the measured spawn census exactly: `src/async_runtime.rs:200` =
755,031 / 759,450 lifetime spawns (99.4%), 663,296 / 665,706 during collapse
windows (99.6%), peak 4,874/sec. hyper (`rt/tokio.rs:115`) only 3,326 ->
the reqwest / `Client::builder()` hypothesis is **REFUTED**.

## Why poll time escalates rather than plateauing

`Listeners::unlisten_js` (`tauri-2.10.3/src/event/listener.rs:239-252`):

```rust
let mut js_listeners = self.inner.js_event_listeners.lock().unwrap();
for js_listeners in js_listeners.values_mut() {        // every webview label
  if let Some(handlers) = js_listeners.get_mut(&event) {
    handlers.retain(|h| h.id != id);                   // O(n)
```

`listen_js` (:230) takes the same process-wide mutex. The map is
`Mutex<HashMap<WebviewLabel, HashMap<EventName, HashSet<JsHandler>>>>` (:63).

`listen()` is async, so at 4,800 renders/sec thousands of registrations are in
flight while their teardowns queue behind the storm. The HashSet grows ->
`retain` costs more -> poll time grows -> the queue drains slower -> more
backlog. Positive feedback.

Measured escalation: `meanPollUs` 261 -> 1,897 -> 2,235 -> 29,568.
Deep collapse (queue >20,000, n=453): meanPollUs median 23,139 (max 42,194);
maxWorkerMeanPollUs median 24,762 (max 47,098); pollsInWindow median 488.
Decision-matrix **row 6 fires — blocking-in-async CONFIRMED**, validating the
earlier INFERRED reading that `minWorkerBusyPct: 0` was the lazy
busy-duration accounting artifact, not an idle worker.

Live sample hot leaves: `__psynch_cvwait` 33,890, `__psynch_mutexwait` 24,965,
`hashbrown::RawIterRange::next_impl` 1,301, `HashMap::retain` 685.
Weighted: `listen_js` 15,768, `unlisten_js` 12,089 (registrations outrun
teardowns, as the model predicts).

## Onset trigger

`resolveCollectorWindowVisibility` (`collectorWindows.ts:65-80`):
`collectorControlsWindow = (status !== null && status.consent !== "pending")
&& controlsVisible`, where `controlsVisible` = `showPanel` =
`gameOverlayIsVisible` (`App.tsx:4112`).

So the moment the game overlay becomes visible, `openCollectorControlsWindow()`
mounts a webview that renders `main.tsx:26` -> `CollectorControlsWindow` ->
`:296` -> the loop starts. A window mount is a step function, which is what the
trace shows: 0-4/sec -> 1,872 -> 4,626/sec at t=00:09:45, with `aliveTasks`
still 2-8 and `globalQueueDepth` 0 (the runtime coped at first).

The loop runs in the child webview; the tokio runtime is **process-wide**, so
it starves the main overlay's geometry/augment tasks. R1/R2 land before queue
depth crosses threshold; by R3/R4 nothing gets through.

## Not the cause (refuted)

- LEAK — the queue does drain, at ~950/s
- WAKE-UP FAILURE — workers never park
- blocking FFI `lcu-credential-walk` — median 5ms across 15h
- geometry scheduler — single-flight cap held, `nativeOutstanding` <= 2
- reqwest `Client::builder()` — hyper spawns 3,326 of 759,450

## Exonerated

`App.tsx:4110` `CollectorOverlayController` receives
`onStatus={setCollectorStatus}`, a stable setState identity, so the **main
overlay window does not loop**. Only the two `undefined` call sites do.

## Live state at report time (PID 39097, still running, still collapsed)

```
aliveTasks 341,732  globalQueueDepth 341,048  injectionPendingMs 197,317
busyPct 74  parkCount 0  meanPollUs 15,372  pollsInWindow 488
```

Monotonic since first observation (queue 201,958 -> 341,048;
injectionPendingMs 79,685 -> 197,317). A task injected now waits 197 seconds.

## Status

Mechanism SOURCE-PROVEN and MEASURED. **No fix implemented — not authorized.**
