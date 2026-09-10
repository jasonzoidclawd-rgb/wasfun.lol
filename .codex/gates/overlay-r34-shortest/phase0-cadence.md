# Phase 0 — foreground-poll cadence inside the R3/R4 collapse

**Verdict: `CADENCE: SELECTIVE`**

Foreground-poll cadence inside both offer windows is statistically
indistinguishable from the healthy control — median drift **1.002x** and
**1.001x**, and **zero** gaps exceeding 5x the healthy median — while the
geometry path in the same windows returns nothing current at all.

Zero files changed in this phase.

---

## 1. Sources and admissibility

Every number below is computed from **raw log lines only**, in
`.codex/evidence/overlay-r34-shortest/runB-20260805-trace.timestamped.jsonl`
(sha `b85a5e3a...`, 3616 records, elapsed span `520`-`1502074` ms), and from
`.codex/evidence/overlay-r34-shortest/diag-20260806-raw.log` (sha
`d98d3b5e...`) where the 08-06 control is cited.

`prior-phase0-settlement.md` and `prior-phase1-root-cause.md` are pinned and
are cited **as context only**. No verdict below rests on them; each is
independently re-derived. Where this phase and a prior report agree, that is a
replication, not an inheritance.

Machine output backing every cell: `phase0-raw-numbers.txt`,
`phase0-raw-numbers-2.txt`. Quoted lines: `phase0-quotes.txt`.

### Which runs contain an R3 or R4 window

Exactly one. `pinned-manifest.md` §"Sessions surveyed" enumerates every
preserved session under `~/Desktop/wt-snapshots/`: two carry traces, and the
08-06 trace ends at `580657` ms, before R3 could open. The 08-06 run is used
here only as an *instrument* control (heartbeat noise floor), never as a
window sample.

### Window definitions

`offer-windows.txt` is the authoritative source and nothing conflicts with it.
The one narrower earlier set (R3 `08:43-08:54`, R4 `13:35-13:45`) is recorded
as superseded inside `prior-phase0-settlement.md`; this phase uses the wider
authoritative windows, and says so here as required.

| Window | Definition | Trace elapsed (ms) | Duration |
| --- | --- | --- | --- |
| `HEALTHY` | the 120 s ending at the last accepted **current** geometry look (`624275`) | `504275`-`624275` | 120.0 s |
| `R3_WINDOW` | `offer-windows.txt` game `08:43-08:55`, `+137 s` | `660000`-`672000` | 12.0 s |
| `R4_WINDOW` | `offer-windows.txt` game `13:35-13:54`, `+137 s` | `952000`-`971000` | 19.0 s |

Two supplementary bands are reported as corroboration and are **not** part of
the verdict test: `HEALTHY_CORE` (`400000`-`520000`, geometry unambiguously
healthy) and `DEEP_TAIL` (`1000000`-`1502074`, geometry maximally collapsed).

---

## 2. The table

`rust_wait = nativeElapsedMs - (preCaptureMs + captureMs + analysisMs)`.
5x threshold = 5 x 999.0 = **4995.0 ms**, from the `HEALTHY` median.

| | `HEALTHY` | `R3_WINDOW` | `R4_WINDOW` | *(HEALTHY_CORE)* | *(DEEP_TAIL)* |
| --- | --- | --- | --- | --- | --- |
| foreground-poll count | **129** | **12** | **19** | 316 | 710 |
| fg inter-arrival median | **999.0 ms** | **1001 ms** | **1000.0 ms** | 274 ms | 829 ms |
| fg inter-arrival p95 | **1309.3 ms** | **1249.5 ms** | **1299.0 ms** | 1029.6 ms | 1303.0 ms |
| fg inter-arrival max | **1601 ms** | **1304 ms** | **1305 ms** | 1377 ms | 1583 ms |
| gaps > 5x HEALTHY median | **0** | **0** | **0** | 0 | 0 |
| geometry record count | **68** (61 accepted / 7 `stale:true`) | **2** (0 accepted / 2 `stale:true`) | **0** | 108 (108 / 0) | 5 (0 / 5) |
| `rust_wait` median | **5.5 ms** | **8157.5 ms** | *no record* | 1.5 ms | 73690 ms |
| closure work median | 726 ms | 670.5 ms | *no record* | 717.5 ms | 714 ms |

Two derived facts stated once, because they carry the verdict:

- **R3 median drift vs HEALTHY = 1001 / 999.0 = 1.002x.**
  **R4 median drift vs HEALTHY = 1000.0 / 999.0 = 1.001x.** Both far below the
  2x bar.
- **Across the entire 1502 s run there are 2290 foreground-poll intervals and
  ZERO exceed 4995 ms.** Not zero-inside-the-windows — zero anywhere. The
  foreground poll never once missed a beat, including while a geometry probe
  was 166.5 s into a single call.

### Note on the `HEALTHY` band, stated rather than hidden

The `HEALTHY` window as the caller defines it (120 s ending at the last
current look) **straddles the degradation onset**: its `rust_wait` values run
`2, 12, 3, ... 1, 22, 39, 66, 114, 248, 1294, ... 5353, 2626, 1479, 2289, 2429`
(`phase0-raw-numbers.txt`). Its `rust_wait` median of 5.5 ms is therefore a
mixture, not a clean healthy figure — `HEALTHY_CORE` gives the clean value,
1.5 ms.

This does **not** weaken the verdict, and is worth being precise about why:
the *foreground* cadence in that same straddling window is 999.0 ms median
with a 1601 ms max, i.e. flat across the exact interval in which `rust_wait`
climbs from 1 ms to 5.3 s. The two series diverge inside one shared window.

### The foreground poll runs in two cadence modes, and both are reported

A per-60 s sweep of the whole run (`phase0-cadence-buckets.txt`) shows the
foreground poll alternating between a **~210 ms** mode and a **~1000 ms** mode:

| bucket start (s) | n | gap median | gap max | `nativeMs` median | n geometry | `rust_wait` median |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 60 | 992 | 1141 | 7 | 0 | - |
| 120 | 237 | **209.0** | 1055 | 11 | 47 | 1 |
| 180 | 195 | **210.0** | 1208 | 11 | 58 | 1.0 |
| 240 | 60 | 1006 | 1393 | 15 | 54 | 1.0 |
| 300 | 60 | 1002 | 1489 | 14 | 53 | 1 |
| 360 | 187 | **210.5** | 1303 | 11 | 58 | 2.0 |
| 420 | 184 | **211** | 1377 | 12 | 52 | 1.5 |
| 480 | 60 | 1000 | 1312 | 12 | 56 | 2.0 |
| 540 | 67 | 998.0 | 1601 | 13 | 28 | 365.5 |
| 600 | 65 | 995.5 | 1495 | 13 | 7 | 2626 |
| **660 (R3)** | 62 | **999** | 1311 | 14.5 | 6 | 9984.0 |
| 720 | 61 | 999.0 | 1491 | 12 | 3 | 16730 |
| 780 | 61 | 1005.5 | 1879 | 16 | 2 | 25915.0 |
| 840 | 61 | 1000.5 | 1496 | 14 | 2 | 28131.5 |
| 900 | 60 | 1004 | 1530 | 12 | 2 | 35644.5 |
| **960 (R4)** | 61 | 1002.5 | 1456 | 13 | 1 | 46001 |
| 1020 | 60 | 1005 | 1486 | 15 | 1 | 51469 |
| 1080 | 61 | 1004.5 | 1583 | 15 | 1 | 65086 |
| 1140 | 60 | 1000 | 1510 | 14 | 1 | 73690 |
| 1200 | 60 | 995 | 1577 | 14 | 0 | - |
| 1260 | 61 | 1006.5 | 1430 | 14 | 0 | - |
| 1320 | 60 | 995 | 1507 | 13 | 1 | 164635 |
| 1380 | 80 | 990 | 1492 | 12 | 0 | - |
| **1440** | 239 | **210.0** | 580 | **4** | 1 | **166522** |
| 1500 | 9 | 208.5 | 359 | 3 | 0 | - |

This is reported rather than smoothed away, because a reader who saw only the
three verdict windows could reasonably suspect a 4x degradation had been hidden
by choosing bands inside one mode. Three things about it:

1. **The comparison is within-mode.** `HEALTHY` (999.0), R3 (1001) and R4
   (1000.0) are all in the ~1000 ms mode. The verdict compares like with like.
2. **The mode is not coupled to the collapse.** The ~1000 ms mode is present
   from `t = 0`, 546 s before onset, when `rust_wait` is 1 ms. It alternates
   back and forth four times while geometry is perfectly healthy.
3. **The decisive bucket is `1440`.** There the foreground poll runs at its
   **fastest of the entire run** — 210 ms median, `nativeMs` median **4 ms**,
   max gap 580 ms — in the same 60 s as the single worst geometry probe ever
   recorded:

```
1468593 [geometry-timing] {"probeSeq":483,"stale":true,"preCaptureMs":674,"captureMs":182,"analysisMs":173,"nativeElapsedMs":167551,"roundTripMs":305028,...}
```

```
1501563 [foreground-poll] {"action":"settle","nativeMs":3,"epochMoved":false,"epoch":2}
```

A 3 ms main-thread native call and a 167.5 s geometry native call, in the same
minute, in the same process. No global-degradation reading survives that.

**What causes the bimodality is not established here, and no verdict depends on
it.** It is not the diagnostic logger (`src/dev/publicationDiagnostics.ts:189`
applies no throttle) and it is not the clock constant
(`FOREGROUND_POLL_INTERVAL_MS = 250`, `src/foregroundPollScheduler.ts:33`, is
fixed for the whole run). A WebView timer throttle under window occlusion is
the obvious HYPOTHESIS and is left explicitly unverified — badge-layer and
offer-state records span 132-624 s continuously across both modes, so overlay
visibility does not on its own explain it. Flagged for whoever needs the
foreground poll to be a load-bearing measurement later; it is not one here.

---

## 3. Quoted raw lines

### `HEALTHY` — foreground cadence (first two, last two of 129)

```
504495 [foreground-poll] {"action":"settle","nativeMs":11,"epochMoved":false,"epoch":1}
505485 [foreground-poll] {"action":"settle","nativeMs":14,"epochMoved":false,"epoch":1}
622517 [foreground-poll] {"action":"settle","nativeMs":10,"epochMoved":false,"epoch":1}
623502 [foreground-poll] {"action":"settle","nativeMs":9,"epochMoved":false,"epoch":1}
```

### `HEALTHY` — geometry, current and sub-second

```
504287 [geometry-timing] {"probeSeq":391,"stale":false,"preCaptureMs":396,"captureMs":178,"analysisMs":167,"nativeElapsedMs":743,"roundTripMs":768,"timeoutClassification":"none","attemptGeneration":391,"continuousUnhealthyAgeMs":null,"acceptedGeometryAgeMs":0}
505170 [geometry-timing] {"probeSeq":392,"stale":false,"preCaptureMs":351,"captureMs":154,"analysisMs":160,"nativeElapsedMs":677,"roundTripMs":691,"timeoutClassification":"none","attemptGeneration":392,"continuousUnhealthyAgeMs":null,"acceptedGeometryAgeMs":0}
```

### `R3_WINDOW` — foreground cadence (first two, last two of 12)

```
660491 [foreground-poll] {"action":"settle","nativeMs":17,"epochMoved":false,"epoch":1}
661491 [foreground-poll] {"action":"settle","nativeMs":14,"epochMoved":false,"epoch":1}
670534 [foreground-poll] {"action":"settle","nativeMs":16,"epochMoved":false,"epoch":1}
671533 [foreground-poll] {"action":"settle","nativeMs":10,"epochMoved":false,"epoch":1}
```

Twelve settlements in twelve seconds, each servicing a native call in 9-26 ms
apart from two 303/309 ms outliers that are also present in the healthy band.

### `R3_WINDOW` — geometry, both records, both stale

```
661491 [geometry-timing] {"probeSeq":463,"stale":true,"preCaptureMs":318,"captureMs":195,"analysisMs":157,"nativeElapsedMs":10034,"roundTripMs":20896,"timeoutClassification":"none","attemptGeneration":463,"continuousUnhealthyAgeMs":77874,"acceptedGeometryAgeMs":79124}
662213 [geometry-timing] {"probeSeq":464,"stale":true,"preCaptureMs":341,"captureMs":179,"analysisMs":151,"nativeElapsedMs":7622,"roundTripMs":12725,"timeoutClassification":"none","attemptGeneration":464,"continuousUnhealthyAgeMs":78703,"acceptedGeometryAgeMs":79953}
```

Note the arithmetic **inside a single line**: at `661491` the closure did
`318+195+157 = 670` ms of work inside a `10034` ms native call, while a
foreground poll at the very same millisecond returned in 14 ms.

### `R4_WINDOW` — foreground cadence (first two, last two of 19)

```
952509 [foreground-poll] {"action":"settle","nativeMs":11,"epochMoved":false,"epoch":1}
953510 [foreground-poll] {"action":"settle","nativeMs":10,"epochMoved":false,"epoch":1}
969505 [foreground-poll] {"action":"settle","nativeMs":7,"epochMoved":false,"epoch":1}
970593 [foreground-poll] {"action":"settle","nativeMs":15,"epochMoved":false,"epoch":1}
```

### `R4_WINDOW` — geometry absence, proven by its brackets

The window contains **zero** records of any tag other than
`[foreground-poll]`. Absence cannot be quoted, so the bracketing geometry
records are quoted instead — the probes on either side of the 19 s hole:

```
928024 [geometry-timing] {"probeSeq":477,"stale":true,"preCaptureMs":353,"captureMs":175,"analysisMs":155,"nativeElapsedMs":35574,"roundTripMs":68543,"timeoutClassification":"none","attemptGeneration":477,"continuousUnhealthyAgeMs":344521,"acceptedGeometryAgeMs":345771}
996659 [geometry-timing] {"probeSeq":478,"stale":true,"preCaptureMs":702,"captureMs":188,"analysisMs":156,"nativeElapsedMs":47047,"roundTripMs":89160,"timeoutClassification":"none","attemptGeneration":478,"continuousUnhealthyAgeMs":413138,"acceptedGeometryAgeMs":414388}
```

Consecutive probe sequence numbers 68.6 s apart, straddling the whole window.
Nineteen foreground settlements happened inside that gap.

### `DEEP_TAIL` — the divergence at its extreme

```
1377505 [geometry-timing] {"probeSeq":482,"stale":true,"preCaptureMs":298,"captureMs":208,"analysisMs":208,"nativeElapsedMs":165349,"roundTripMs":261977,"timeoutClassification":"none","attemptGeneration":482,"continuousUnhealthyAgeMs":793955,"acceptedGeometryAgeMs":795205}
1468593 [geometry-timing] {"probeSeq":483,"stale":true,"preCaptureMs":674,"captureMs":182,"analysisMs":173,"nativeElapsedMs":167551,"roundTripMs":305028,"timeoutClassification":"none","attemptGeneration":483,"continuousUnhealthyAgeMs":34910.00000000023,"acceptedGeometryAgeMs":null}
```

```
1501563 [foreground-poll] {"action":"settle","nativeMs":3,"epochMoved":false,"epoch":2}
1501874 [foreground-poll] {"action":"settle","nativeMs":3,"epochMoved":false,"epoch":2}
```

167.5 s of native wait for 1029 ms of closure work, in the same seconds as
3 ms foreground settlements.

---

## 4. A signal that looks like cadence and is not

`[game-poll]` records could be mistaken for a second cadence series. They are
not one, and the report says so rather than leaving the trap set.

`[game-poll]` is a **state-change logger**, not a per-tick logger. It emits
85 records: dense 2 s spacing from `1460` to `132155` while the previous
game's `endOfGame` phase was flapping, then **nothing at all for 468 s**
(`132155` -> `600839`) during the healthy steady state, then sparse
`live-data-status-transition` / `preserve` records. Reading its late spacing
(9 s, 15 s, 16 s, 17 s, 21 s, 34 s, 39 s, 53 s, 55 s, 71 s, 157 s, 227 s) as a
cadence collapse would be a category error: those are LCU status transitions,
and the 468 s of silence in the healthiest part of the run proves the tag does
not tick.

What `[game-poll]` *does* contribute is the third clock recorded in
`step-zero.md` C5: its `monotonicMilliseconds` field pins webview uptime at
trace elapsed + 84.0 s, which dates the onset at **10.5 minutes of process
uptime**.

---

## 5. What this verdict decides, and what it does not

**Decides.** Whatever the collapse is, it is not a whole-process stall, not a
webview main-thread stall, and not a JS event-loop stall. A 1 s JS interval
kept firing to the millisecond, its native call kept returning in ~12 ms, and
the JS `performance.now()` clock stayed linear against wall time (five paired
samples, ±52 ms of jitter over 490 s) for the entire 878 s in which geometry
goodput was exactly zero. Anything that would have degraded all three is
eliminated.

**Does not decide — and this is a correction to the caller's framing, carried
from `step-zero.md`.** The caller's prompt reads `SELECTIVE` as implying "not
global executor starvation ... a capture-path-specific serialization stall."
That inference does not follow from this measurement, because the two paths do
not share an executor:

- `probe_augment_surface` is `#[tauri::command] async fn` -> tokio async
  runtime.
- `get_foreground_state` is `#[tauri::command] fn` (sync) -> main thread.

A flat foreground poll is a statement about the **main thread**. It carries no
information about the tokio async runtime, so it cannot separate
"capture-path-specific serialization" from "global tokio async-runtime
starvation that only the capture path is exposed to." Both hypotheses predict
exactly the table above.

The instrument that *would* separate them exists and is shipped
(`async-runtime-heartbeat`, `lib.rs:2398`) but has never been live during a
collapse — the whole premise of this slice. Its healthy noise floor is
`lastDriftMs` median 1 ms, `maxDriftMs` median 2 ms, **max 223 ms** over 633
samples (`step-zero.md` C4). Under starvation it is the drift that moves.

Phase 1 answers, from source, which serialization points could produce a
capture-path-specific stall, and Phase 3's authorization test is applied to
the caller's literal condition (`CADENCE: GLOBAL`) without reinterpretation.

---

## 6. Ledger

| | HEAD | `status --porcelain` count |
| --- | --- | --- |
| Slice baseline | `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71` | 4 |
| End of Phase 0 | (recorded in `ledger.md`) | (recorded in `ledger.md`) |

Pinned hashes re-verified at the start of this phase: 8/8 `OK`.
