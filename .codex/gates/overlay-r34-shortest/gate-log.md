# Gate log — slice `overlay-r34-shortest`

Worktree: `/Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card`

The slice modified **zero product source files**. Every gate below therefore
proves one of two things: that the two new files are correct, or that nothing
else moved.

`harness/verify-task.sh` and `scripts/gate.sh` — the two scripts the slice
contract delegates its suite list to — **do not exist in this worktree**:

```
ABSENT  harness/verify-task.sh
ABSENT  scripts/gate.sh
```

Gates were therefore run directly, and each is named with the exact command.

| # | Gate | Command | Result |
| --- | --- | --- | --- |
| 1 | Harness compiles | `cd overlay/src-tauri && cargo build --example geometry_dispatch_bench` | PASS — `Finished dev profile`; 0 warnings attributable to `examples/geometry_dispatch_bench.rs` (grep count 0). The 40 lib warnings are pre-existing `cocoa` deprecations. |
| 2 | Rust suite | `cd overlay/src-tauri && cargo test` | PASS — 139 passed, 0 failed, 1 ignored, across 10 test binaries. Full output: `gate-cargo-test.log`. |
| 3 | Analyzer parses | `node --check overlay/scripts/analyze-geometry-bench.mjs` | PASS |
| 4 | Analyzer behaves | `node overlay/scripts/analyze-geometry-bench.mjs <60s sanity run>` | PASS — produced a well-formed table and `BENCH: NOT_REPRODUCED` on healthy data, i.e. the instrument reads healthy when the system is healthy. |
| 5 | Whitespace / conflict markers | `/usr/bin/git -C <worktree> diff --check` | PASS — clean |
| 6 | Pinned evidence unchanged | `/usr/bin/shasum -a 256 -c pinned.sha256` | PASS — 8 of 8 `OK`, re-verified at the end of the slice as at the start of every phase |
| 7 | Quoted lines are verbatim | scripted exact-match of every `[...]` line quoted in `phase2-bench.md` against `phase2-bench.jsonl` | PASS — 9 of 9 found byte-for-byte; 1 transcription error was found this way and corrected |
| 8 | Worktree integrity | `/usr/bin/git -C <worktree> status --porcelain` vs `baseline-status.txt` | PASS — the only delta is the two authorized new files |
| 9 | Stale-claim audit | scripted re-derivation of every numeric claim in the reports against its source file | PASS after correction — three stale or unit-ambiguous figures were found and fixed: `phase2-bench.jsonl` line count (3463, read mid-run, actual **3590**), process RSS reported in decimal MB from `ps` values that are KiB (now raw **45392 / 77936 / 92944 KiB**), and the jsonl size rounded to `890 KB` (now **889836 bytes**). No verdict or conclusion depended on any of the three. |
| 10 | Full re-gate after those edits | gates 1-8 re-run against the final state | PASS — `cargo test` 139 passed / 0 failed / 1 ignored over 10 binaries; analyzer still returns `BENCH: NOT_REPRODUCED`; 9 of 9 quoted lines verbatim; 8 of 8 pinned hashes OK; both new-file SHA-256 unchanged |

## Gates NOT run, and why

Reported rather than silently skipped, because a silent skip is a false green.

| Gate | Why not run |
| --- | --- |
| `npm test` (vitest), `tsc --noEmit`, `npm run lint`, `npm run build` | **Zero TypeScript files were touched.** The one new `.mjs` is a standalone CLI, imported by no test, no build entry, and no source module. These suites are genuinely uncovered by this slice; nothing in the slice can have affected them. |
| `cd overlay && npx tauri build` plus the release-binary timestamp check | The slice contract requires this "for a Rust change", and the caller specifically warned that `cargo check` does not prove the binary was rebuilt. **No product Rust source was changed.** The only Rust added is an `examples/` target, and `tauri build` does not compile examples into the release binary. The positive proof is stronger than a rebuild would be: `git status --porcelain` shows **no modified tracked file at all**, so the release binary's inputs are byte-identical to `HEAD`. |
| Production-strip check (§9.3) | No instrumentation was shipped into product code. Nothing to strip. |
| `frozen-tests.sha256`, `red.log`, `green.log` | No red test was written. Phase 3 was not authorized (0 of 4 conditions held), and §5 forbids writing a test that cannot reach the true seam. See the Phase 3 evaluation in `phase2-bench.md`. |
