# Gate log — R3/R4 collector render-loop fix

`harness/verify-task.sh` and `scripts/gate.sh` do not exist on
`feat/overlay-tier-card` (the branch predates the harness). Suites were run
directly. This is recorded, not silently skipped.

| # | Gate | Command | Result |
| --- | --- | --- | --- |
| 1 | Red at the true seam | `npx vitest run src/collector/collectorStatusSubscription.test.tsx` | FAIL 2/2 on assertions: `listen` 6x (expected 1), `get_collector_status` 6x (expected 1). `red.log` |
| 2 | Test freeze | `shasum -a 256 src/collector/collectorStatusSubscription.test.tsx` | `77cca500…c65c05`, `frozen-tests.sha256` |
| 3 | Freeze intact after fix | `shasum -a 256 -c frozen-tests.sha256` | OK |
| 4 | Green at the true seam | same as gate 1 | PASS 2/2 |
| 5 | Full overlay suite | `npx vitest run` | 62 files, 736 tests, 0 failures. `green.log` |
| 6 | Typecheck | `npx tsc --noEmit` | exit 0 |
| 7 | Production build | `npm run build` (`tsc && vite build`) | exit 0, built in 464ms |
| 8 | Rust | not run | No Rust file changed by this fix. The `#[cfg(debug_assertions)]` instrument from the prior slice is untouched and its production-strip check already passed. |
| 9 | Live R3/R4 | two ARAM Mayhem games, one overlay process (PID 43770), recorder session `mayhem-session-20260827-180056` | **PASS.** R1-R4 in both games; `globalQueueDepth` 0 across all 2,253 in-game windows; peak spawn 20-25/sec. See `phase4-live-verification.md`. |
| 10 | Recorder integrity | `record_session.py` finalization | `status: complete`, `repositoryStable: true`, `traceContinuityVerified: true`, `drainCompleted: true`, reopens 0, all boundary failure flags false, video blackFraction 0.0, 41,686/41,686 frames decoded |

## Not covered

- **Visual badge rendering.** Fixture mode was forbidden by the caller, so all
  137 `[badge-layer]` records read `authorizationSource: "none"` /
  `reason: "authorization-denied"`. Rounds are proven from `[identity-start]`
  round attribution inside confirmed live epochs, not from pixels.
  `analyze_trace.py` was not run — its `--require rendered,focus_loss,
  focus_recovery` set is unsatisfiable under those conditions.
- **Focus-out/focus-in checkpoint** — not part of this slice's question and not
  performed.
- Two games is the documented minimum for a timing-coupled failure, not a large
  sample.
- The `void refresh(false)`-before-`if (!poll) return` ordering at
  `CollectorStatus.tsx:75` was left as-is. With a stable `applyStatus` the
  effect runs once per mount, so that call now fires exactly once and reads as
  an intentional initial fetch. It was not part of the approved change.
