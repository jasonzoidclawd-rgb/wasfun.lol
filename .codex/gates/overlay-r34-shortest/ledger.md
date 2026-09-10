# Ledger — slice `overlay-r34-shortest`

Worktree: `/Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card`
Branch: `feat/overlay-tier-card`

Every git invocation in this slice used `/usr/bin/git`. No git write ran.

| Point | `/usr/bin/git rev-parse HEAD` | `/usr/bin/git status --porcelain \| wc -l` |
| --- | --- | --- |
| Baseline (before first writer) | `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71` | 4 |
| End of Phase 0 | `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71` | 4 |
| End of Phase 1 | `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71` | 4 |
| End of Phase 2 | `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71` | 6 |
| End of Phase 3 (no product change authorized) | `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71` | 6 |
| Final | `4eb271b79826877e5fce0cfa7ad4e24b01cb6d71` | 6 |

`HEAD` never moved.

## The 4 to 6 change

`git status --porcelain` collapses untracked directories, so the count is of
entries, not files. Baseline's four:

```
?? .codex/evidence/
?? .codex/gates/
?? docs/proposals/
?? docs/reviews/2026-08-20-v08-recovery-and-harness-audit.md
```

Final's six are those same four plus:

```
?? overlay/scripts/analyze-geometry-bench.mjs
?? overlay/src-tauri/examples/geometry_dispatch_bench.rs
```

Both are Phase 2's authorized new files. This is drift the slice caused, not
drift found in the worktree, so it is not the `R34 SLICE BLOCKED` condition.

Expanded with `--untracked-files=all`, baseline held 188 untracked entries and
the end state holds 220. The 32-path delta is exactly this slice's own
artifacts, and `/usr/bin/comm` confirms **nothing was removed**:

```
/usr/bin/comm -23 <baseline sorted> <final sorted>
```

returns empty. `git status --short --untracked-files=no` also returns empty:
**no tracked file was modified at any point.**

## Evidence integrity

`/usr/bin/shasum -a 256 -c pinned.sha256` re-run at the start of every phase and
again at the end of the slice: **8 of 8 `OK`** every time.
