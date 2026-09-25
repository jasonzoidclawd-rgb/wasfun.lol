# Contract — slice `overlay-r34-shortest`

**Terminal state: COMPLETE (diagnostic).**

This slice **did not fix anything**, and completing is not a claim that it did.
It is a diagnostic slice: COMPLETE is a statement about gates, not about the
problem. The R3/R4 geometry collapse is still unfixed and still has exactly one
recorded instance. Phase 3's authorization test was evaluated and **0 of its 4
conditions held**, so no product code was modified.

Status line: `R34 SLICE COMPLETE — DIAGNOSIS NARROWED, BENCH NOT REPRODUCED`

## Verdicts

```
CADENCE: SELECTIVE
Q1_BLOCKING_FFI: NO
Q2_SINGLE_FLIGHT: YES
Q3_QUEUE_GATE: NO
BENCH: NOT_REPRODUCED
PRACTICE_TOOL_VIABLE: YES
```

## What shipped

Two new files, both untracked, neither product source. The Phase 2 cap was 3
files; 2 were used.

| Path | SHA-256 |
| --- | --- |
| `overlay/src-tauri/examples/geometry_dispatch_bench.rs` | `90e49a403bcf17fd6d1c63094ff4726547820c2e0bba5c24eba360bfb5d4ac79` |
| `overlay/scripts/analyze-geometry-bench.mjs` | `328fa7d549f27c004be8a5edf83791a3acf1af1173af599e1dc7c0e6cb68a196` |

Together they replace "one lucky 25-minute Mayhem game that reaches Round 3"
with `cargo run --example geometry_dispatch_bench -- 20`, repeatable on demand,
with no League process. That was the stated purpose of Phase 2 and it is the
slice's only durable deliverable.

Plus the gate package in `.codex/gates/overlay-r34-shortest/` and the pinned
evidence in `.codex/evidence/overlay-r34-shortest/`.

## What did NOT ship

- **No fix.** Phase 3's four conditions: `CADENCE` is SELECTIVE not GLOBAL;
  `Q1` is NO and `Q2` is YES, so the disjunction fails; `BENCH` is
  NOT_REPRODUCED; and no off-game red test is writable because there is no
  reproduction to assert against. Zero of four.
- **No red test.** §5 forbids substituting a reachable downstream seam for an
  upstream defect. With no reproduction, any test that failed today would be
  asserting on something other than the defect — the synthetic-green failure
  mode.
- **No product-source change of any kind**, including no `pub` widening to let
  the bench reach the real capture path. That widening was the one thing that
  would have made the harness fully faithful, and it is exactly what the
  authorization forbids.
- **No touching of the do-not-touch list**: `src/` untouched;
  `.github/workflows/` untouched; no file in the
  `overlay-minimal-v2-confluence-gated-v4` bundle touched; `STATE.json`
  untouched; the `validCardCount` 3→2 reroll defect neither fixed nor
  investigated nor mentioned in any phase report.
- No merge, no push, no tag, no Vercel-touching change.

## The mechanism as currently understood

The collapse is a **capture-path-specific stall, not global executor
starvation**, and the geometry loop does not cause it by itself.

1. **Phase 0, from raw log lines.** During R3 and R4 the foreground poll held
   cadence to within 1.002x and 1.001x of the healthy median, and **zero** of
   2290 inter-arrival intervals across the entire run exceeded 4995 ms — while
   R3 carried stale geometry with a `rust_wait` median of 8157.5 ms and R4
   produced **no record of any tag other than `[foreground-poll]`**. Verdict
   `CADENCE: SELECTIVE`.

   The correction that matters: a flat foreground poll measures the **main
   thread**, not the tokio runtime. It proves the main thread was alive. It does
   **not** by itself separate capture-path serialization from async-runtime
   starvation, and reading it as though it did would overstate what Phase 0
   settled.

2. **Phase 1, from source.** No FFI runs in an async task body on the capture or
   foreground-state path (`Q1: NO`). In-flight dispatches are bounded three
   independent ways — the JS outstanding cap of 1 (raised to 2 only for a wedged
   replacement), the JS in-flight token guard, and Rust's
   `MAX_CONCURRENT_CAPTURES = 4` — so the unbounded-queue hypothesis is
   **refuted at both HEAD and the run-B build** (`Q2: YES`). Neither capture nor
   geometry consults queue id or `gameMode`, so Practice Tool clears every gate
   (`Q3: NO`, `PRACTICE_TOOL_VIABLE: YES`). The capture path holds exactly one
   lock, in two short synchronous critical sections, never across an `.await`,
   with no leakable permit and no semaphore or channel anywhere.

   Phase 1's one open candidate was `sysinfo::System::new_all()` reached through
   `discover_lcu_credentials` on the async LCU commands — the only blocking FFI
   in an async task body in the crate.

3. **Phase 2, from a 20-minute off-game run.** `rust_wait` maximum **1 ms**
   across 1598 dispatches; bucket median 0 ms in all 20 minutes; heartbeat drift
   max 6 ms with zero dropped ticks in 1190 windows; no RSS growth; and the
   `System::new_all()` candidate measured at median 3 ms / max 62 ms over 800
   calls with none above 100 ms. Elapsed time alone does not produce the
   collapse.

**What remains unexplained** is what occupies the capture path from t ≈ 546 s in
the live run. Naming it now would be a guess, and the caller's instruction
forbids acting on one: with `CADENCE: SELECTIVE`, an await timeout or a
capture-stream rebuild would mask the symptom and destroy the only reproduction
path that exists.

The honest boundary on Phase 2's negative result: the bench is a **replica**,
because `probe_augment_surface`, `run_bounded_capture_with_gate`,
`capture_surface_frame`, `CapturePermit` and `GEOMETRY_CAPTURE_IN_FLIGHT` are
all private to `lib.rs`. It also ran on an idle machine with no game — the same
`System::new_all()` costing 3 ms here was measured flat at ~300 ms during the
live collapse, a hundredfold difference. A negative from a milder harness bounds
what has been ruled out; it is not a clean bill of health.

## Invariants preserved

- **ARAM Mayhem augment cardinality invariant** (`CLAUDE.md`) — untouched and
  unaffected. This slice contains no augment-count, round-progression, or
  final-ownership logic of any kind; it measures dispatch latency only.
- **Web ↔ overlay scoring parity** — no scoring twin touched on either side.
- **Locale key parity** — no `messages/*.json` touched, no user-facing string
  added.
- **`public/data/` is generated** — not touched.
- **Disclosure ladder** — no data crosses a tier. The bench writes only its own
  timing stream, to stdout, redirected to the gate directory.

## Compliance

Overlay work is compliance-sensitive, and this slice stayed inside the line:

- **No game automation.** Nothing sends input to any process.
- **No hidden-information access.** The harness reads no game memory, no client
  state, and no network traffic. It never launched League, and no League process
  ran during the bench.
- **No client injection.**
- The only capture is of the operator's own screen, via the same `xcap` call the
  shipped overlay already makes. Frames are analyzed in memory and dropped —
  nothing is written to disk and nothing is transmitted. No OCR text or champion
  identity appears in any artifact in this package.
- **No git write ran.** Every git invocation in this slice used `/usr/bin/git`,
  and every one was read-only (`rev-parse`, `status`, `diff`, `check-ignore`).
  The operator owns the commit.

## Verification findings and their disposition

| Finding | Disposition |
| --- | --- |
| The caller's `BENCH: REPRODUCED` threshold — "≥ 10x its opening median" — is **degenerate**: the opening bucket median is 0 ms, and 10 × 0 = 0. | Reported rather than worked around. Evaluated against a pre-registered absolute bar (median `rust_wait` ≥ 2000 ms = `PROBE_TIMEOUT_MS`, with closure work flat) written into the analyzer before the run. Both criteria return NOT_REPRODUCED. |
| One quoted raw log line in the draft of `phase2-bench.md` had a mis-transcribed field (`captureWidth` 1280 where the file says 2560). | Caught by an automated verbatim check of every quoted line against the source, and corrected. All 9 quoted lines now match byte-for-byte. Gate 7. |
| `.codex/` was expected to be a git-ignored path; it is **not** ignored in this worktree. | Confirmed by `git check-ignore -v` returning no match. The §14 "ignored but intended" branch does not apply, and no force-add instruction is needed or given. |
| `harness/verify-task.sh` and `scripts/gate.sh` are absent from this worktree. | Gates run directly and each named explicitly in `gate-log.md`, with the uncovered suites listed rather than assumed covered. |
| The captured monitor changed resolution mid-run (1280x720 → 2560x1440 for 161 s → back), raising real closure work ~20 %. | Kept and reported as an unplanned natural experiment. `rust_wait` still never exceeded 1 ms through it. |
| Phase 0's ~300 ms figure for the live `System::new_all()` walk versus 3 ms in the bench. | Not a contradiction — it is the load-fidelity gap, and it is stated as the primary limit on the strength of the NOT_REPRODUCED verdict. |
| A closing audit of every numeric claim against its source found three stale or unit-ambiguous figures: a jsonl line count read while the run was still writing, RSS reported in decimal MB from KiB inputs, and a rounded byte size. | All three corrected and the full gate set re-run afterwards. None was load-bearing for a verdict. Gates 9 and 10. |

## Live validation is a HUMAN gate

Nothing in this package has been verified against a live game, and nothing in it
should be read as claiming so. There is no fix to verify. The next live
recording, whenever the operator chooses to take one, is what would extend the
evidence base — this slice's contribution is that the off-game half of that
search can now be repeated on demand instead of waited for.
