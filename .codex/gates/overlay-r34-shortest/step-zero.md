# Step Zero — inherited claims, re-derived

Slice `overlay-r34-shortest`. Every claim below comes from the caller's own
prompt or from a prior gate report. None is carried forward on trust.

Verification base: `.codex/evidence/overlay-r34-shortest/` (see
`pinned-manifest.md`), re-verified by
`/usr/bin/shasum -a 256 -c .../pinned.sha256` — all 8 files `OK`.

---

## C1 — "Classification A is formally settled: no current geometry look existed during the R3/R4 windows."

**CONFIRMED**, re-derived independently of the prior report.

Extraction over the authoritative windows (trace elapsed
`660000-672000` and `952000-971000`):

- R3: 2 `[geometry-timing]` records, **both `"stale":true`**, 0 accepted.
- R4: **0** `[geometry-timing]` records; 0 records of *any* tag other than
  `[foreground-poll]` in the entire 19 s window.
- Last `"stale":false` `[offer-session]` anywhere in the trace: `624275` ms.
  449 such records exist, spanning `133629`-`624275`; none after.

Command: `phase0-raw-numbers.txt`, section `ANCHOR` and per-window blocks.

## C2 — "`rust_wait` median 1 ms → 73.7 s while capture closure work stays flat at ~700 ms."

**CONFIRMED**, with the band definitions made explicit (the prompt states the
endpoints without them).

| Band (trace elapsed) | n | closure work median | `rust_wait` median | `rust_wait` max |
| --- | --- | --- | --- | --- |
| `400-520 s` | 108 | **717.5 ms** | **1.5 ms** | 126 ms |
| `1000 s-end (1502 s)` | 5 | **714 ms** | **73690 ms** | **166522 ms** |

`rust_wait = nativeElapsedMs - (preCaptureMs + captureMs + analysisMs)`, the
same definition the prior Phase 1 used. Closure work moves by 0.5 %; the wait
moves by a factor of 4.9 x 10^4. Source: `phase0-raw-numbers-2.txt`.

## C3 — "The dispatch/resume decomposition instrumentation is already shipped."

**CONFIRMED** at the frozen worktree HEAD `4eb271b`, in three places:

- Rust emission: `overlay/src-tauri/src/lib.rs:1516` (`dispatch_wait_ms`),
  `:1551` (`resume_wait_ms`); field declarations
  `overlay/src-tauri/src/surface_probe.rs:204,211`.
- Async-runtime heartbeat: `overlay/src-tauri/src/lib.rs:2398`
  (`spawn_async_runtime_heartbeat`), with a `#[cfg]` no-op at `:2436` and the
  call site at `:2489`.
- TypeScript consumption: `overlay/src/App.tsx:2056-2082`,
  `overlay/src/surfaceGeometry.ts:104-342`.

Live-emission proof, not just source presence — from the 08-06 trace:

```
179623 [geometry-timing] {"probeSeq":5,...,"dispatchWaitMs":0,"resumeWaitMs":0,"closureWorkMs":1502,"unattributedNativeMs":0,"transportMs":78,"asyncRuntimeMs":78}
```

## C4 / C7 — "633 heartbeat records, 1-2 ms drift, ended early to an AFK, never reached R3/R4."

**CONFIRMED with one correction.**

- `/usr/bin/grep -c 'async-runtime-heartbeat' diag-20260806-raw.log` → **633**. ✅
- Drift over all 633: `lastDriftMs` median **1**, `maxDriftMs` median **2** —
  the prompt's "1-2 ms" is the *typical* value and is right. ✅
- **CORRECTION:** the worst observed drift in that healthy run is
  `maxDriftMs` = **223 ms** (and `lastDriftMs` max = 73 ms), not 1-2 ms. The
  healthy noise floor for this instrument is therefore ~0.2 s, not ~2 ms.
  This matters: a bench "reproduction" threshold set at a few ms of drift
  would fire on healthy noise.
- Trace span ends at `580657` ms. R3 in run-B opened at `660000` ms of an
  equivalent timeline, so the run stopped **79 s short** of the earliest point
  a comparable R3 could appear. Never reached R3/R4. ✅

## C5 — "The last current look landed at 624.3 s, roughly the ten-minute mark, and R3 opened 35.7 s later."

**CONFIRMED on the numbers; CORRECTED on "the ten-minute mark".**

- Last `stale:false` at `624275` ms; R3 opens at `660000` ms;
  `660000 - 624275 = 35725` ms = **35.7 s**. ✅
- `624.3 s` is **trace/video elapsed**, not game clock. `offer-windows.txt`
  pins `offset_video_minus_game_s=137`, so game clock at that moment is
  `624.3 - 137 = 487.3 s` = **8:07 game time**, not ten minutes.
- There is a *third* clock, and it is the one the bench actually needs.
  `[game-poll]` carries `monotonicMilliseconds`, which is the webview's
  `performance.now()` (`overlay/src/App.tsx:3629`). Paired against trace
  elapsed at five points:

  | trace elapsed | `monotonicMilliseconds` | difference |
  | --- | --- | --- |
  | 600839 | 684789 | 83950 |
  | 610046 | 694081 | 84035 |
  | 625356 | 709311 | 83955 |
  | 934013 | 1017973 | 83960 |
  | 1090682 | 1174613 | 83931 |

  Median offset **83955 ms**. So **webview uptime ≈ trace elapsed + 84.0 s**:

  | Event | trace elapsed | webview uptime |
  | --- | --- | --- |
  | `rust_wait` departs baseline (seq 432) | 546236 | **630.2 s = 10.50 min** |
  | last current look | 624275 | 708.2 s = 11.80 min |
  | R3 opens | 660000 | 744.0 s = 12.40 min |
  | R4 opens | 952000 | 1036.0 s = 17.27 min |

  **The "ten-minute mark" is real, but it is ten minutes of *process/webview
  uptime*, and it dates the *onset*, not the last current look.** This is the
  form of the claim the Phase 2 bench must test, and it is what makes a
  20-minute League-free run sufficient. Marked INFERRED: `performance.now()`
  is page-load-relative, so a vite HMR full reload during `tauri dev` would
  reset it and shorten the true process uptime.

## C6 — "the authoritative offer windows [are in] `.codex/gates/overlay-collapse-fix/`"

**CORRECTED (path only).** The authoritative file is
`.codex/evidence/round34-live/offer-windows.txt` (mtime Aug 5 13:34:22 2026,
sha `a8ad2904...`). `overlay-collapse-fix/` holds the *reports* that consume
it. Contents used, verbatim:

```
R3 game=08:43-08:55
R4 game=13:35-13:54
offset_video_minus_game_s=137
```

Converted: R3 = `660000-672000` ms, R4 = `952000-971000` ms trace elapsed.
No window file anywhere conflicts with this; the one earlier, narrower set
(R3 `08:43-08:54`, R4 `13:35-13:45`) was already superseded and is recorded as
superseded in `prior-phase0-settlement.md`.

## C8 — Worktree identity

**CONFIRMED.** `.claude/worktrees/overlay-tier-card` resolves to
`/Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card`,
branch `feat/overlay-tier-card`, HEAD `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71`,
`git status --porcelain | wc -l` = **4**.

## C9 — ".gitignore lists `.claude/` twice (lines 38 and 40)"

**CONFIRMED.** Lines 38 and 40 are both `.claude/`; lines 39 and 41 are both
`claude-flow.config.json`. A duplicated block, not a typo. Untouched, per the
prompt's instruction.

## C10 — "bots are only available in Summoner's Rift custom games"

**UNVERIFIABLE from the pinned artifacts.** This is a claim about the League
client's lobby options; no artifact in this slice records it. It is *not*
load-bearing for any decision here: Q3 is answered from source, and Phase 2's
bench is required to need no League process at all, which makes the bot
question moot either way. Carried as UNVERIFIED context, used for nothing.

## C11 — "one lucky 25-minute Mayhem game that reaches level 15"

**UNVERIFIABLE, and partly contradicted as a *precondition*.** No pinned
artifact records champion level. What the artifacts do show is that the
`rust_wait` departure at trace `546236` ms is dated by clock, and that the
prior Phase 1 tested and **rejected** all three round/event-coupled triggers
(R2 advance, last OCR, first LCU flap). Re-derived here: onset precedes the
first LCU flap (`600839`) by 54.6 s, and follows R2 (`384442`) by 161.8 s.
Nothing in the evidence ties the onset to a round boundary or a level. Treated
as narrative, not as a constraint on the bench.

---

## Load-bearing consequence

One inherited framing is **discarded wholesale** rather than repaired, and it
changes how Phase 0's verdict may be read:

> the caller's gloss: *"If foreground-poll tasks were still being polled
> normally while the capture task waited 73 seconds, the failure is not global
> executor starvation."*

`prior-phase1-root-cause.md` §1 already establishes — and Phase 1 of this
slice re-verifies from source — that `get_foreground_state` is a **sync**
`#[tauri::command] fn`, while `probe_augment_surface` is an **`async fn`**.
They do not share an executor. A healthy foreground poll therefore cannot, on
its own, discriminate "capture-path-specific stall" from "global tokio async
runtime starvation", because the foreground poll never touches the tokio
async runtime.

Phase 0 below reports the cadence measurement the caller asked for, under the
caller's own verdict definition, and states separately and explicitly what
that measurement can and cannot decide. The distinction is carried into
Phase 3's authorization test rather than being silently resolved.
