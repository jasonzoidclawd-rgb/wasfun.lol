# Windows parity pending Claude hover/R4 behavior port

> **Ported 2026-09-25.** The canonical fix (`06dce3f`, slot generation as the
> sole identity authority) reached the Windows line by merging
> `feat/overlay-tier-card` in `d7ac5fc` (PR #65). Only platform-boundary
> conflicts in `lib.rs` were resolved; the hover/R4 tests run unchanged and
> pass on Windows CI. Real-hardware validation is still outstanding.

Date: 2026-07-27

## Source boundary

This Windows branch was created from committed macOS overlay HEAD
`49dd04b97155a13e82d84e5af0a5db9156e9a4f1`. It did not copy or inspect
Claude's uncommitted files.

At branch creation, the read-only canonical worktree reported these untracked
Claude-owned paths:

- `docs/handoffs/codex-overlay-current-state.md`
- `docs/prompts/`
- `overlay/src/geometrySingleFlight.test.ts`
- `overlay/src/hoverIdentityStability.test.ts`

No tracked canonical file was modified at that instant. The user separately
identified Claude's in-flight behavior scope as:

- hover-induced `RESOLVED -> SCANNING` churn;
- visual-fingerprint comparisons that bypass reroll hysteresis;
- Level-15/R4 geometry restart/abandon recovery;
- the new hover-identity and geometry-recovery RED tests.

## Port rule

Do not implement a Windows-specific version of that behavior. The following
remain shared TypeScript ownership/state-machine surfaces:

- `overlay/src/App.tsx`
- `overlay/src/foregroundPollScheduler.ts`
- `overlay/src/surfaceProbeScheduler.ts`
- `overlay/src/surfaceGeometry.ts`
- `overlay/src/ocrOwner.ts`
- `overlay/src/rerollInvalidation.ts`
- active-game, offer, publication, and lifecycle helpers under `overlay/src/`

After Claude commits the canonical fix, port the exact committed patch (or
rebase/cherry-pick its commit) and resolve only platform-boundary conflicts.
The resulting tests must run unchanged on Windows mocks; do not fork thresholds,
fingerprints, hover policy, reroll confirmation, offer generation, OCR
ownership, or presentation behavior by OS.

## Expected verification after port

Run the focused hover/R4 tests named by Claude, full overlay Vitest, the shared
lifecycle/reroll/OCR-owner suites, native Rust tests, Windows-target compilation
on a Windows runner, and controlled real-Windows validation. Until then this
branch is Windows platform parity preparation, not behavior-complete or release
ready.
