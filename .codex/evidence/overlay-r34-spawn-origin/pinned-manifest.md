# Pinned evidence — overlay-r34-spawn-origin

## overlay-raw-20260827-000353.log

| | |
| --- | --- |
| Source | `/private/tmp/mayhem-overlay-20260827-000353.log` |
| Source mtime | Aug 27 15:32:02 2026 |
| Bytes | 40,446,005 |
| SHA-256 | `298b19f579fb0a56c0412d14781c73d48655828ca0cbfa95ee3b888e2d6fd01f` |

The run-3 DEV trace: ~15 h of overlay life covering the healthy period, the
2026-08-27 collapse onset, and the partial drain. Pinned AFTER the owning
process (PID 6788) had already exited, because every number in
`phase1-root-cause.md` derives from it and `/tmp` is not durable storage.

Caveat, recorded rather than smoothed over: the analysis in
`phase1-root-cause.md` was computed against a 39,766,557-byte PREFIX of this
file, read while the process was still writing. The pinned copy is a superset;
re-deriving any figure against the pinned file is correct and may extend the
tail past the last sample quoted.

Times quoted as `t=HH:MM:SS` are TRACE-RELATIVE, derived from the 1 Hz
`[runtime-occupancy]` sample index. Sample windows run 1000-1100 ms, so the
index lags wall clock by roughly 0.7 % over the full trace.

Verify with:

```bash
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card/.codex/evidence/overlay-r34-spawn-origin
/usr/bin/shasum -a 256 -c pinned.sha256
```

## run-4 trace (pinned 2026-08-27)
- source: /private/tmp/mayhem-overlay-20260827-163149.log
- snapshot taken while PID 39097 was still writing (file continues to grow)
- stat at copy: Aug 27 17:09:27 2026, 2949864 bytes
- pinned: run4-overlay-20260827-163149.log
- sha256: b70eff0a11a15549c367e9299ad1ed587f533b3435e6fa2aa2842ec0e5618ef4

## Tracking decision (2026-08-27)

`overlay-raw-20260827-000353.log` is **retained on disk but deliberately NOT
committed.** At 40,446,005 bytes it is four times every other artifact here
combined, and this repository is used through several git worktrees, each of
which would materialise its own copy. It is the run-3 diagnostic-phase trace
and is superseded for every live conclusion by `run4-overlay-20260827-163149.log`
(root cause) and `../overlay-r34-spawn-origin-live/live-trace.timestamped.jsonl`
(verification), both of which ARE committed.

Its SHA-256 above remains the reference. If it is ever needed again and the
local copy is gone, it is not recoverable — `/tmp` has rotated and PID 6788 is
long dead. That is an accepted loss, not an oversight: nothing in the committed
contract depends on it.
