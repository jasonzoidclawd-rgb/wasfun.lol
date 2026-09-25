# Commit checklist — slice `overlay-r34-shortest`

No git write ran. Every git invocation used `/usr/bin/git` and every one was
read-only. The operator owns the commit.

## Read this first

**The worktree carried 188 untracked entries at baseline, before this slice
started.** `docs/proposals/`, `docs/reviews/2026-08-20-v08-recovery-and-harness-audit.md`,
and large parts of `.codex/evidence/` and `.codex/gates/` belonging to *other*
slices were already there. This slice did not create them and takes no position
on whether they should be committed.

The practical consequence: **do not run `git add .codex`, `git add .`, or
`git add -A`.** Any of those sweeps in ~188 files from other work. Every command
below names its paths individually for that reason.

**No tracked file was modified.** `git status --short --untracked-files=no`
returns nothing, and `/usr/bin/git diff --check` is clean. Everything this slice
produced is a new, untracked file.

**`.codex/` is not git-ignored in this worktree.** This was checked, because the
project's convention suggested otherwise:

```
/usr/bin/git -C /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card check-ignore -v .codex/gates/overlay-r34-shortest/contract.md
```

returns no match. So no `-f` force-add is needed anywhere here, and none is
given.

## Modified files

None.

## New files — the deliverable

Two files, 813 lines, 32 KB. This is what the slice is actually for.

| Path | Lines | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `overlay/src-tauri/examples/geometry_dispatch_bench.rs` | 598 | 24180 | `90e49a403bcf17fd6d1c63094ff4726547820c2e0bba5c24eba360bfb5d4ac79` |
| `overlay/scripts/analyze-geometry-bench.mjs` | 215 | 8053 | `328fa7d549f27c004be8a5edf83791a3acf1af1173af599e1dc7c0e6cb68a196` |

```
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card
/usr/bin/git add overlay/src-tauri/examples/geometry_dispatch_bench.rs overlay/scripts/analyze-geometry-bench.mjs
```

Neither is product source. `cargo` auto-discovers `examples/`, so `Cargo.toml`
needed no edit and got none; `tauri build` does not compile examples into the
release binary, so the shipped overlay is byte-unaffected.

Verify before committing:

```
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card/overlay/src-tauri
cargo build --example geometry_dispatch_bench
cargo test
```

## New files — the gate package

24 files, 1.1 MB. These are the audit trail, not the deliverable. Commit them
only if this repository's convention is to keep gate packages in history.

```
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card
/usr/bin/git add .codex/gates/overlay-r34-shortest/
```

That one is safe as a directory add, because `.codex/gates/overlay-r34-shortest/`
contains nothing but this slice's own files. The 24 it adds are:

```
baseline-head.txt              baseline-porcelain-count.txt   baseline-staged.diff
baseline-status.txt            baseline-tracked.diff          contract.md
gate-cargo-test.log            gate-log.md                    ledger.md
phase0-cadence-buckets.txt     phase0-cadence.md              phase0-quotes.txt
phase0-raw-numbers-2.txt       phase0-raw-numbers.txt         phase1-static.md
phase2-bench-analysis.txt      phase2-bench-rss.txt           phase2-bench.jsonl
phase2-bench.md                phase2-bench.stderr.log        phase2-quotes.txt
pinned-manifest.md             step-zero.md                   COMMIT-CHECKLIST.md
```

Note that `baseline-head.txt` and `baseline-status.txt` were written before the
baseline status snapshot was taken, so they appear in `baseline-status.txt`'s own
listing. They belong to this slice.

## Pinned evidence — decide deliberately

```
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card
/usr/bin/git add .codex/evidence/overlay-r34-shortest/
```

This adds 9 files totalling **4.9 MB**, and they are **copies** of artifacts that
already exist elsewhere on disk. Two of them are byte-identical to each other:
`runB-20260805-trace.timestamped.jsonl` and `round34-live-trace.timestamped.jsonl`
share the SHA-256 `b85a5e3a981163e48a63a0c7b2ac92df9182591de91bf9c9aff38b3c292cbc35`,
so committing both puts the same 1.17 MB in history twice.

They were pinned because the slice contract forbids deriving numbers from `/tmp`
paths that rotate. That reason is about *analysis integrity during the slice*, not
about *permanent storage*. `pinned-manifest.md` records every source path, size
and SHA-256, so the numbers in the phase reports stay re-derivable from the
manifest even if the copies are never committed.

A reasonable middle path, if 4.9 MB of logs in history is unwelcome — it keeps
the run this slice actually produced and drops the copies of pre-existing files:

```
cd /Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card
/usr/bin/git add .codex/evidence/overlay-r34-shortest/pinned.sha256 .codex/evidence/overlay-r34-shortest/offer-windows.txt
```

The single largest artifact in the gate package,
`.codex/gates/overlay-r34-shortest/phase2-bench.jsonl` at 889836 bytes, is the one file
here that exists nowhere else: it is the full 20-minute time series the caller
asked to have attached. Dropping it would make `phase2-bench.md` uncheckable.

## Suggested commit message

```
bench: off-game harness for the geometry dispatch/resume collapse

Adds a 20-minute League-free bench that replicates the capture/geometry
dispatch path at the product's 150ms tick and emits the product's own
record schema, plus the analyzer that scores it.

Replaces "one lucky Mayhem game that reaches Round 3" with a repeatable
command. Diagnostic only: no product source changed, no fix attempted.
First run is flat - rust_wait max 1ms over 1598 dispatches, heartbeat
drift max 6ms - so BENCH: NOT_REPRODUCED. The harness is a replica, not
the product path, because the capture symbols are private to lib.rs.

Gate package: .codex/gates/overlay-r34-shortest/
```

## After committing

Nothing to push, tag, or merge. The caller forbade all three, and no branch
state depends on this slice.
