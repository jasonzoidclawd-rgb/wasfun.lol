# Live run — spawn-origin confirmation

Literal commands, real values. Nothing here contains a placeholder, and no
command carries an inline `#` comment (`INTERACTIVE_COMMENTS` is disabled in
this zsh, so a trailing comment makes the shell treat later words as
filenames).

## Before anything: freeze the worktree

`preflight.py`'s `repository_fingerprint` binds every UNTRACKED file's path and
exact content, and `.codex/gates/` is untracked. Writing any file under the
repository while the recorder runs fails the run with
`failureReason: repository-drift`. This has already destroyed one recording.

Every artifact this slice needs is already written. Do not add, edit, or delete
anything under the worktree between the preflight and the recorder's exit.

## 1. Launch the DEV overlay

The instrument is `#[cfg(debug_assertions)]`; a release build emits nothing.
No fixture, telemetry, auth, or API override — the standing prohibition holds.

```bash
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card
TRACE="/private/tmp/mayhem-overlay-$(date +%Y%m%d-%H%M%S).log"
echo "$TRACE"
nohup env -u MAYHEM_TELEMETRY_ENDPOINT -u MAYHEM_DEVICE_TOKEN MAYHEM_OVERLAY_TRACE=1 npm --prefix overlay run tauri -- dev > "$TRACE" 2>&1 &
disown
```

Record the printed `$TRACE`. Every later command needs it.

## 2. Instrument sanity — all four must pass before gameplay

```bash
/usr/bin/grep -m1 "spawn-origin-install" "$TRACE"
/usr/bin/grep -c "^\[spawn-origin\]" "$TRACE"
/usr/bin/grep "^\[runtime-occupancy\]" "$TRACE" | /usr/bin/tail -1
/usr/bin/pgrep -f "target/debug/mayhem-oracle-overlay"
```

Required:

- `"installed":true` and `"workers":10`. **Absent means the run measured
  Tauri's DEFAULT runtime and must be discarded.**
- `[spawn-origin]` count rising at ~1/s.
- `pollsInWindow` is NOT -1 (that would mean `tokio_unstable` never reached
  the build).
- Exactly one overlay PID. Never reuse a historical one.

Verified baseline on 2026-08-27: `spawnsPerSec` 0-8, `distinctSites` 3,
`sitesOverflowed` false, `meanPollUs` 32-1578. The FIRST occupancy sample after
launch reads `meanPollUs` ~55,000 with `maxWorkerMeanPollUs` ~520,000 — that is
startup initialisation, not a stall; read the baseline from a settled window.

## 3. Preflight, then the recorder

```bash
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card
REPO="$PWD"
python3 .codex/skills/test-league-augment-overlay/scripts/preflight.py --repo "$REPO" --require-overlay
```

Bind the recorder to the overlay PID that preflight reports and the `$TRACE`
from step 1. Launch it through the shim so it can be stopped:

```bash
nohup python3 .codex/gates/overlay-r34-spawn-origin/sigint-shim.py .codex/skills/test-league-augment-overlay/scripts/record_session.py --repo "$REPO" --trace "$TRACE" --overlay-pid PID_FROM_PREFLIGHT --output /private/tmp/mayhem-r34-spawnorigin-session --max-duration 3600 --privacy-acknowledged > /private/tmp/recorder-launch.log 2>&1 &
disown
```

`PID_FROM_PREFLIGHT` is the single value the preceding command prints as the
overlay PID; substitute it before pasting. It is the one value in this document
that cannot be known at write time.

## 4. Play

Human-controlled gameplay only. Play until R3 and R4 have both been offered, or
until the collapse is clearly underway (`globalQueueDepth` climbing past a few
thousand). The 2026-08-27 collapse began ~2 minutes after the last R2 record.

## 5. Stop — order matters

Recorder FIRST, confirm it exited, THEN the overlay. Killing the overlay first
silences the trace and fails the session with
`Trace silence exceeded 30 seconds during the session.`

```bash
/usr/bin/pgrep -f "record_session.py --repo"
/bin/kill -INT RECORDER_PID
until ! /bin/ps -p RECORDER_PID > /dev/null 2>&1; do /bin/sleep 2; done
echo "recorder exited"
/usr/bin/pkill -f "target/debug/mayhem-oracle-overlay"
```

`RECORDER_PID` is what the first line prints.

## 6. Read it

```bash
/usr/bin/grep "^\[spawn-origin\]" "$TRACE" | /usr/bin/tail -40
```

Take the answer to `decision-matrix.md`. Check the four sanity rows there
before reading any number.
