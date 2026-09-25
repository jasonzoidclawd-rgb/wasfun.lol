# Overlay MVP — residual risk (2026-07-31)

Scope: `feat/overlay-tier-card` as of this handoff. Written at the point the
overlay build was declared MVP-stable (see completion report in the
conversation this originated from — not duplicated here).

## Selected architecture

**Option A** — product-only stable build. The overlay runtime, member
authorization, and badge-gate code are the release surface. The custom
validation recorder/analyzer/extractor under
`.codex/skills/test-league-augment-overlay/` is **not** part of the release
gate: it is preserved, untracked, and may still be useful for a future
dedicated validation effort, but its pass/fail state does not block this
build and its certification claims (cross-game continuity, focus-loss proof)
are not authoritative for this release.

## Product risks (none currently blocking)

- `runGeometryProbe`'s stale-check now includes an explicit `gameEpoch`
  guard (added this round), matching `runIdentityProbe`. Before this change
  the guarantee "stale geometry cannot publish after a confirmed epoch
  change" held only because `geometrySeqRef` is bumped synchronously,
  in the same tick, by every code path that also bumps `gameEpochRef`
  (`closeConfirmedGame`, and the inline boundary-detection branch in the
  poll loop) — true today, but an implicit ordering contract rather than a
  checked invariant. The fix makes it self-evident and removes dependence on
  that ordering surviving future refactors.

## Validation-tooling risks (deferred, not release-blocking)

These are known gaps in the `.codex` recorder/analyzer's own internal
correctness. None have a reachable path to the actual overlay product
(confirmed by reading the relevant code this round — `analyze_trace.py`'s
`game-poll`/`focus-transition` handling operates only on already-recorded
trace log lines; it cannot affect runtime behavior).

1. Analyzer accepts `[focus-transition]` without matching it against the
   runtime epoch it was recorded under — a forged or replayed line with a
   stale `gameEpoch` could be accepted as evidence for the wrong game.
2. Recorder can tail a trace inode different from the one preflight
   inspected (residual from the Round 3 checkpoint-continuity work — the
   fail-closed path added there narrows but does not eliminate every
   filesystem race).
3. Analyzer may split one game into two epochs when its first
   `live-active` record follows a provisional `in-progress` scope rather
   than a clean confirmed boundary.
4. `test_preflight_record.TraceDrainTest.test_a_shrinking_trace_at_the_boundary_is_reported_as_truncation`
   is flaky under full-suite execution (passes 3/3 in isolation, failed once
   in a full 317-test run on 2026-07-31). Not caused by any change made this
   round — no Python file was touched. Left as-is; do not chase without a
   reliable repro.

None of these are treated as blocking. If the recorder/analyzer is picked
back up for a future validation effort, start there.

## What was explicitly NOT done (by design, not oversight)

- No cryptographic dirty-worktree certification, continuous repo-drift
  monitoring, or crypto-attribution work.
- No further hardening of `record_session.py`/`analyze_trace.py` beyond
  what Round 3 already fixed — the 4 remaining Codex findings against them
  are validation-only and deferred per the classification above.
- No live recording, League launch, or Codex `/review` invocation this
  round (per explicit instruction).

## Recommended next review scope

A future review of this branch should be scoped to **product runtime code
only** (`overlay/src/App.tsx`, `overlay/src/auth/member.ts`,
`overlay/src/liveGamePoll.ts`, `overlay/src/augmentOverlayGate.ts`,
`overlay/src/badgeLayerDiagnostic.ts`) — explicitly excluding
`.codex/skills/test-league-augment-overlay/**`, so it cannot reopen the
deferred validation-tooling architecture.
