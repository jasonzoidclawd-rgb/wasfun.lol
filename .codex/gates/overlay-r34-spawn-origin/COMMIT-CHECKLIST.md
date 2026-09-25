# Commit checklist — R3/R4 collector render-loop fix

Branch `feat/overlay-tier-card`, parent
`c014a390db5e1aab7ff4f7a8116f4e185ab390ee`.

## Pre-existing uncommitted work — READ FIRST

Four tracked files were **already dirty at baseline** with operator/prior-slice
work and are **deliberately excluded** from this commit:

```
overlay/src-tauri/src/lib.rs
overlay/src-tauri/src/surface_probe.rs
overlay/src/App.tsx
overlay/src/surfaceGeometry.ts
```

`lib.rs` additionally carries this slice's `#[cfg(debug_assertions)]`
spawn-origin wiring. None of it is committed here. The uncommitted
instrumentation (`spawn_origin.rs`, `runtime_occupancy.rs`, their tests, and
`overlay/src-tauri/.cargo/config.toml`) is what produced the verification
evidence, so **it must not be deleted** — it is simply not part of this
product commit.

`overlay/src/collector/CollectorStatus.tsx` was **clean at baseline**
(see `baseline-status.txt`), so every changed line in it is this slice's.

## Modified (1)

```
 M overlay/src/collector/CollectorStatus.tsx     | 8 +++++++-
```

The whole change: hoist the inline `() => {}` default for `onStatus` to a
module-level `IGNORE_STATUS` constant.

## New (18)

Product:
```
?? overlay/src/collector/collectorStatusSubscription.test.tsx
?? overlay/src/react-test-renderer.d.ts
```

`react-test-renderer.d.ts` exists because the devDependency ships no types and
no `@types/react-test-renderer` is installed; a 12-line local declaration was
chosen over adding a dependency and churning the lockfile.

Gate package:
```
?? .codex/gates/overlay-r34-spawn-origin/baseline-head.txt
?? .codex/gates/overlay-r34-spawn-origin/baseline-status.txt
?? .codex/gates/overlay-r34-spawn-origin/contract.md
?? .codex/gates/overlay-r34-spawn-origin/decision-matrix.md
?? .codex/gates/overlay-r34-spawn-origin/final.diff
?? .codex/gates/overlay-r34-spawn-origin/frozen-tests.sha256
?? .codex/gates/overlay-r34-spawn-origin/gate-log.md
?? .codex/gates/overlay-r34-spawn-origin/green.log
?? .codex/gates/overlay-r34-spawn-origin/phase1-root-cause.md
?? .codex/gates/overlay-r34-spawn-origin/phase1-root-cause-run4.md
?? .codex/gates/overlay-r34-spawn-origin/phase4-live-verification.md
?? .codex/gates/overlay-r34-spawn-origin/red.log
?? .codex/gates/overlay-r34-spawn-origin/run-instructions.md
?? .codex/gates/overlay-r34-spawn-origin/run-instructions-fix.md
?? .codex/gates/overlay-r34-spawn-origin/sigint-shim.py
```

Evidence:
```
?? .codex/evidence/overlay-r34-spawn-origin/pinned-manifest.md
?? .codex/evidence/overlay-r34-spawn-origin/pinned.sha256
?? .codex/evidence/overlay-r34-spawn-origin/run4-overlay-20260827-163149.log
?? .codex/evidence/overlay-r34-spawn-origin-live/pinned-manifest.md
?? .codex/evidence/overlay-r34-spawn-origin-live/pinned.sha256
?? .codex/evidence/overlay-r34-spawn-origin-live/live-manifest.json
?? .codex/evidence/overlay-r34-spawn-origin-live/live-trace.timestamped.jsonl
```

## Deliberately NOT committed

- `.codex/evidence/overlay-r34-spawn-origin/overlay-raw-20260827-000353.log`
  — 40,446,005 bytes, superseded run-3 diagnostic trace. Reasoning and its
  SHA-256 are recorded in that directory's `pinned-manifest.md`. It stays on
  disk, untracked.
- `screen.mp4` (2,588,629,341 bytes) from the live session. A full-hour capture
  of the operator's display; private, oversized, and no frame was cited. It
  remains owner-only in `/private/tmp/mayhem-session-20260827-180056`.
- The four baseline-dirty files listed at the top.

No `.gitignore` rule is involved in any of these — every path above is plain
untracked, so `git status --short --untracked-files=all` shows the full set and
no force-add is required.

## Gates re-run immediately before commit

| Gate | Command | Result |
| --- | --- | --- |
| Frozen test intact | `shasum -a 256 -c frozen-tests.sha256` | OK |
| Typecheck | `npx tsc --noEmit` | exit 0 |
| Full overlay suite | `npx vitest run` | 62 files, 736 tests, 0 failures |
| Production build | `npm run build` | exit 0 |
| Live | two ARAM Mayhem games, one process | R1-R4 both games, queue 0 throughout |

`harness/verify-task.sh` and `scripts/gate.sh` do not exist on this branch; see
`gate-log.md`.

## Compliance

No game automation, no hidden-information access, no client injection. No agent
launched or operated League. No push, tag, or merge — commit only, on a feature
branch.
