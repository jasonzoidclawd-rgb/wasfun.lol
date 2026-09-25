# Decision matrix — `[spawn-origin]` / poll accounting

One row per outcome the next live run can produce, written BEFORE the run so a
reading cannot be chosen after the fact. Rows 4, 7 and 8 refute the current
reading; they are here because a matrix without them is a confirmation device.

## Instrument sanity — check these before reading any number

| Check | Required | If it fails |
| --- | --- | --- |
| `[spawn-origin-install]` present, `"installed":true` | yes | The run used Tauri's DEFAULT runtime. `[spawn-origin]` totals are structurally zero. **Discard the run.** |
| `workers` in that line equals `[runtime-occupancy]`'s `workers` | yes | Replacement runtime has different geometry; not the same subject. Discard. |
| `pollsInWindow` != -1 | yes | `tokio_unstable` did not reach the build. Poll rows below are unreadable. |
| `spawnsPerSec` sane pre-gameplay (tens, not zero) | yes | Hook is installed but not firing; investigate before gameplay. |

## What the reading would mean

| # | Reading | Conclusion |
| --- | --- | --- |
| 1 | `top[0].file` is one of this crate's own `src/*.rs` lines, delta tracking the collapse | **Named — application spawn site.** Only four exist (`lib.rs:625/663/910/2516`); a runaway there is a local, fixable defect. |
| 2 | `top[0]` is a dependency path (`hyper*/src/…`, `reqwest*/…`, `tokio*/…`) | **Named — library-internal spawn.** Prime suspect becomes the per-request `Client::builder()` sites (`lcu.rs:202`, `lib.rs:166/203/1654`, `collector.rs:261`, `upload_queue.rs:89`), each of which builds a fresh pool with its own background tasks. |
| 3 | `top[0]` is a Tauri IPC/command path | **Named — renderer storm.** The webview is issuing commands far faster than the markers imply, which the throttled `[geometry-timing]` (1/s) and coalescing `[foreground-poll]` would both hide. Moves the investigation to `App.tsx`. |
| 4 | `spawnsPerSec` stays low (< 50) while `aliveTasks` climbs into the tens of thousands | **REFUTES the arrival-outruns-service reading.** Growth would then be tasks that stop *completing*, i.e. the LEAK arm the observed ~950/s drain appeared to rule out. Re-open the leak arm; the drain may have been a different population. |
| 5 | `sitesOverflowed: true` with a flat top-5 (no site dominating) | Origins are diffuse — a fan-out pattern rather than one runaway caller. Raise `MAX_SITES`/`TOP_K` and re-run before theorising. |
| 6 | `maxWorkerMeanPollUs` >> 1,000 at onset | **Blocking-in-async confirmed.** Occupancy is long polls, and `minWorkerBusyPct: 0` was the lazy busy-duration accounting artifact predicted in the field's own note. |
| 7 | `maxWorkerMeanPollUs` stays small (< ~100) while `pollsInWindow` explodes | **REFUTES the long-poll inference.** Workers are healthy and fast; arrival volume is the entire story. `minWorkerBusyPct: 0` then needs a different explanation (steal-loop searching, which tokio excludes from busy time). |
| 8 | Collapse does not reproduce at all across several games | **Not evidence of a fix and must not be reported as one.** This build carries `tokio_unstable`, a replacement runtime, and a per-spawn hook; it is not the binary that collapsed. Timing-coupled failures need the §16 second confirmation run. |

## What this slice does NOT do

It does not fix anything. It adds counters. A green run is not a repaired
overlay, and a quiet trace is not a healthy one.
