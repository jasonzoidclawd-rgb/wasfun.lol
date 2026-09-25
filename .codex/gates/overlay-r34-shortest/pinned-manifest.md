# Pinned manifest — slice `overlay-r34-shortest`

Pinned into `.codex/evidence/overlay-r34-shortest/` before any analysis.
Re-verify at the start of every phase with:

```
/usr/bin/shasum -a 256 -c /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card/.codex/evidence/overlay-r34-shortest/pinned.sha256
```

| Pinned name | Source path | Source mtime | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `runB-20260805-trace.timestamped.jsonl` | `~/Desktop/wt-snapshots/mayhem-overlay-session-20260805-110950-70jh0a1v/trace.timestamped.jsonl` | Aug  5 11:43:53 2026 | 1169888 | `b85a5e3a981163e48a63a0c7b2ac92df9182591de91bf9c9aff38b3c292cbc35` |
| `round34-live-trace.timestamped.jsonl` | `<W>/.codex/evidence/round34-live/trace.timestamped.jsonl` | Aug  5 13:31:33 2026 | 1169888 | `b85a5e3a981163e48a63a0c7b2ac92df9182591de91bf9c9aff38b3c292cbc35` |
| `diag-20260806-trace.timestamped.jsonl` | `~/Desktop/wt-snapshots/mayhem-overlay-session-20260806-151615-5coj9vpw/trace.timestamped.jsonl` | Aug  6 15:32:09 2026 | 676687 | `a95946b5ac59da6bab85f89328b153ccac0a0d0759986427f87aceb435442952` |
| `diag-20260806-raw.log` | `<W>/.codex/evidence/diag-20260806/raw.log` | Aug  6 15:32:43 2026 | 476277 | `d98d3b5ea65680df0ab0dc65e563c91bfbb7bcb4c8c875b0f4b947da5b671845` |
| `offer-windows.txt` | `<W>/.codex/evidence/round34-live/offer-windows.txt` | Aug  5 13:34:22 2026 | 74 | `a8ad29049ac3118f10f6173ac38d365dbf787b8ffc55d16c3ecff467d989c736` |
| `run-b.log` | `<W>/.codex/evidence/round34-live/run-b.log` | Aug  5 13:31:33 2026 | 1462482 | `85c117b32bb5152ad436a79cac9d5ba8e3076201351366ed2cd2631e79c7a2df` |
| `prior-phase0-settlement.md` | `<W>/.codex/gates/overlay-collapse-fix/phase0-settlement.md` | Aug  5 13:37:29 2026 | 8575 | `d275815e164fcb42f6971bbd3cbb4ad836cbc2ee7e89ef67da92e33d16942fa5` |
| `prior-phase1-root-cause.md` | `<W>/.codex/gates/overlay-collapse-fix/phase1-root-cause.md` | Aug  5 13:50:08 2026 | 15584 | `072eba7490ed2f5612e4b15bc851b78e9687f8da1ce7c0498b4d7afa42c08584` |

`<W>` = `/Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card`

**Byte-identity established, not assumed.** The wt-snapshot trace for run-B and
the copy already under `.codex/evidence/round34-live/` carry the same SHA-256.
They are the same artifact; either name refers to the same bytes.

**Not pinned, deliberately:** `screen.mp4` in both sessions (1.1 GB / 319 MB).
No number in this slice is derived from video; the operator's own
`offer-windows.txt` is the video-derived input and it is pinned.

**No `/tmp` path is an input to this slice.** Every source above is either a
`~/Desktop/wt-snapshots/` session directory or a worktree-local evidence file,
and each is named exactly — no newest-match glob was used to resolve any of
them.

## Sessions surveyed for R3/R4 reach

`~/Desktop/wt-snapshots/` holds two session recordings with traces:

| Session | Trace span | Reached R3/R4? |
| --- | --- | --- |
| `mayhem-overlay-session-20260805-110950-70jh0a1v` | 520 – 1502074 ms | **Yes** — run-B, the collapse recording |
| `mayhem-overlay-session-20260806-151615-5coj9vpw` | 106 – 580657 ms | **No** — ends at 580.7 s, before R3 could open |

The remaining nine `overlay-tier-card-*` and `overlay-sol-gate-*` directories
are worktree checkpoints (`head.txt` / `tracked.diff` / `untracked.tgz`) and
gate packages, not session recordings. They contain no trace.

**Therefore exactly one recorded run in existence reaches R3 or R4**, and it
predates the dispatch/resume instrumentation. That is the whole reason this
slice exists.
