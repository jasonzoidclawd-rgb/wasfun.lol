# Live run — R3/R4 collector render-loop fix

Literal commands, real values. No placeholders. No inline `#` comment appears
in any command (`INTERACTIVE_COMMENTS` is disabled in this zsh, so a trailing
comment makes the shell treat later words as filenames).

## 0. Do not write to the worktree during the run

`preflight.py`'s `repository_fingerprint` binds every UNTRACKED file's path and
exact content, and `.codex/gates/` is untracked. Writing any file under the
repository while the recorder runs fails the run with
`failureReason: repository-drift`. Every artifact this slice needs is already
written. Do not add, edit, or delete anything under the worktree between the
preflight and the recorder's exit.

## 1. Kill the collapsed overlay from the previous run

PID 39097 is still alive, still in the injection-queue collapse, and still
burning CPU. It must not be confused with the new process.

```bash
kill 39097
/usr/bin/pgrep -f "target/debug/mayhem-oracle-overlay"
```

The second command must print nothing before continuing.

## 2. Launch the DEV overlay

The spawn-origin and runtime-occupancy instruments are
`#[cfg(debug_assertions)]`; a release build emits nothing. Keeping them on is
deliberate — they are how the fix gets measured. No fixture, telemetry, auth,
or API override: the standing prohibition holds.

```bash
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card
TRACE="/private/tmp/mayhem-overlay-$(date +%Y%m%d-%H%M%S).log"
echo "$TRACE"
nohup env -u MAYHEM_TELEMETRY_ENDPOINT -u MAYHEM_DEVICE_TOKEN MAYHEM_OVERLAY_TRACE=1 npm --prefix overlay run tauri -- dev > "$TRACE" 2>&1 &
disown
```

Record the printed `$TRACE`. Every later command needs it.

## 3. Instrument sanity — all four must pass before gameplay

```bash
/usr/bin/grep -m1 "spawn-origin-install" "$TRACE"
/usr/bin/grep -c "^\[spawn-origin\]" "$TRACE"
/usr/bin/grep "^\[runtime-occupancy\]" "$TRACE" | /usr/bin/tail -1
/usr/bin/pgrep -f "target/debug/mayhem-oracle-overlay"
```

Required:

- `"installed":true` and `"workers":10`. Absent means the run measured Tauri's
  DEFAULT runtime and must be discarded.
- `[spawn-origin]` count rising at ~1/s.
- `pollsInWindow` is NOT -1 (that would mean `tokio_unstable` never reached
  the build).
- Exactly one overlay PID, and it is NOT 39097.

## 4. Play one full ARAM Mayhem game

Human-controlled gameplay only. Nothing is injected into League, and no agent
launches or operates the client. Play through all four augment offer rounds.

Note the wall-clock time at each augment round as it happens. Per-interval
attribution is not derivable afterwards without it.

## 5. Decision matrix

Read after the game. `Q` is the max `globalQueueDepth` seen during the game,
`S` is the peak per-second count at `src/async_runtime.rs:200`.

| # | R3/R4 render? | Q | S | Meaning |
| --- | --- | --- | --- | --- |
| 1 | yes | < 100 | tens | **Fix confirmed** at both mechanism and product level. Still needs a second game (§16). |
| 2 | yes | spikes > 10,000 | thousands | Rendering recovered but a second storm source remains. The hook fix is not the whole story — re-run the spawn census. |
| 3 | **no** | < 100 | tens | **REFUTATION ROW.** The render loop was real but was not what broke R3/R4. The runtime is healthy and the rounds still fail, so the cause is in the geometry/data path. Do not keep attributing R3/R4 to the runtime. |
| 4 | no | spikes | thousands | The fix did not take. Check that vite dev picked up `CollectorStatus.tsx`, and that step 1 actually killed 39097. |

Row 3 is the row that would refute the current hypothesis. It is the one to
read first.

## 6. Sampling, if it collapses again

Sample while the process is ALIVE. The run-3 repro was lost by waiting.

```bash
/usr/bin/pgrep -f "target/debug/mayhem-oracle-overlay"
```

Substitute the printed PID into the next command in place of 39097.

```bash
/usr/bin/sample 39097 10 -f /private/tmp/mayhem-sample-fix.txt
```

## What this run cannot establish

A single passing game is not evidence against a history of failing ones. The
failure is timing-coupled, so a second confirming game is required before this
is called fixed.
