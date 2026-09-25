# Overlay V1 Current State

Status: V1 spec implemented through the Sol A–H repair (uncommitted);
latest controlled run invalid for rendering evaluation because
authorization was never granted; see the 2026-08-03 update below
Inspected working revision: `76a97b630bbdbec9b53d1e757b09bae887544733`

## 2026-08-03 update — two repair passes and two runtime captures

This update supersedes the sections below where they conflict; they remain
as the historical record of the failed 2026-07-31 manual game and the V1
specification written in response.

### Sonnet 5 stabilization pass (2026-07-31, uncommitted)

TS-only; declared the build MVP-stable on source review plus the synthetic
suite, with no successful four-round live game (see
`docs/handoffs/overlay-mvp-residual-risk.md`, "Option A"). Still
authoritative for: the split of confirmed-close vs telemetry-suspend
(`closeConfirmedGame` / `suspendGameRuntimeForUnavailableTelemetry` /
`beginNewGameEpoch` in `App.tsx`), the gameEpoch guard in
`runGeometryProbe`, the fail-closed authorization gate
(`augmentOverlayGate.ts`: member entitlement or explicit
`MAYHEM_OVERLAY_TIER_FIXTURE=1`, never dev build alone — this work also
removed the earlier `TIER_FIXTURE_MEMBER` entitlement-fabrication path),
the badge layer and its `[badge-layer]` diagnostic with production
stripping (`badgeLayerDiagnostic.ts` visibility half, `BadgeChipLayer.tsx`,
`positionedBadgeChips.ts`), and the detached member-verification worker
(`auth/member.ts`). The manual game that same day failed all four rounds,
which is what the sections below document.

### Codex Sol xhigh A–H repair (2026-08-02/03, uncommitted)

Implemented after the V1 spec below was written; the spec's "next
implementation step" is therefore stale. Slices and status:

- A — idempotent confirmed-non-live closure (`liveGamePoll.ts`
  `transitionConfirmedGameOwnership` / `applyGameOwnershipObservation`):
  production-wired; addresses active risk 7 below.
- B — zero-usable-row rejection (`dev/championStats.ts` throws on a
  "complete" dataset with zero rows): production-wired; addresses active
  risk 1 below, the rounds 1–2 root cause of the 2026-07-31 game.
- C — same-visible-offer data refresh (`sameOfferDataRefresh.ts`):
  production-wired.
- D — bounded native OCR recognition (`src-tauri/src/lib.rs` only:
  concurrency cap 6, 1.5 s logical timeout; a logical timeout does not
  cancel native work): production-wired; narrower than "capture ownership"
  — the geometry-probe capture path is untouched.
- E — four-round offer ownership and reroll handling
  (`offerRoundOwnership.ts` reducer, sole writer of round identity):
  production-wired; live-proven (see runtime evidence).
- F — stale-result rejection across round changes (`ocrOwner.ts` gains a
  `round` authority): production-wired.
- G — semantic three-slot completion with DOM acknowledgement
  (`badgeLayerDiagnostic.ts` round-content half, `data-*` acknowledgement
  attributes): dev-only diagnostic; no production rendering change.
- H — deterministic four-round offline replay (`overlayReplay.ts`):
  deliberately unwired; offline tool over the real reducers and renderer.

Sonnet-vs-Sol: no conflicts found. Sol layered onto Sonnet's single reset
point (`beginNewGameEpoch` also resets offer-round ownership) and fully
replaced the old `recordRoundCompleted` / `clearOfferState` round
bookkeeping. Known seams: `badgeLayerProductionStrip.test.ts` does not
audit Sol's `[round-content-complete]` tokens; `TOTAL_ROUNDS` is duplicated
between `offerRoundOwnership.ts` and `roundDelivery.ts`; on the
telemetry-suspend path `completedRoundsRef` is cleared while offer-round
ownership is preserved, so the HUD round label can desync until the next
offer event.

### Runtime evidence

Historical long-lived capture (`overlay-runtime-review-20260803-003417`):
proved the zero-usable-row "complete" dataset and champion-no-data
publications (fixed by B), native identity returns 3–241 s late with
scheduler-unhealthy suppressing badges, 99.8% of game polls repeating
confirmed-non-live clears (addressed by A), and the round counter never
advancing past 1 across 7,146 offer events (addressed by E).

Latest controlled live run (`overlay-v1-prelive-20260803-102930`, champion
96): authorization stayed `false` with `authorizationSource:"none"` for the
entire run — neither member entitlement nor the fixture flag was active, so
every badge-gate decision read `authorization-denied` and the run could not
evaluate final rendering. Round 1 and round 2 ownership were detected and a
same-round reroll correctly did not advance the round (E live-proven).
Round 1 resolved no usable augment identities (empty canonical IDs — a
different signature from the historical champion-no-data). Round 2 native
identity calls ran 3.4–3.8x over the 2 s logical deadline. The
geometry-probe native path then wedged: one outstanding native call grew
from 1.9 s to 340 s, `continuousUnhealthyAgeMs` reached about 17 minutes
with no recovery, while `nativeOutstanding` stayed at 1 — concurrency is
bounded, single-call duration is not (D covers OCR recognition, not this
path). Foreground polling was healthy throughout. No round 3/4 offer, no
`round-content-complete`, and no game-end cleanup appear before the log
ends mid-degradation; whether the match reached rounds 3–4 is
undetermined.

Synthetic vs live proof: A–H all have passing focused suites (197/197
re-verified 2026-08-03). Only E has live proof. G and H cannot produce live
proof by design. Neither pass has a successful four-round live game.

### Selected next slice and ladder

Next slice: authorization preflight visibility — before a game starts, the
overlay must display whether badge authorization is ready and, if not,
which stage is failing (bootstrap pending or failed, verification pending
or retrying, denied, no credential, fixture ready, member ready). The
latest controlled run was invalid because this state was invisible.
Display only; the authorization gate itself is unchanged.

Ladder after that: geometry-probe native capture recovery (bound or restart
the wedged single call — the clearest runtime defect); then
stage-specific terminal failure reasons for missed rounds 3–4; then the
`completedRoundsRef` desync on the telemetry-suspend path.

## Current implementation status

The current overlay has substantial capture, identity, stale-work, and
authorization machinery, but it does not satisfy the V1 product contract.
Latest product result:

```text
Round 1: FAIL_DATA
Round 2: FAIL_DATA
Round 3: no product output; likely FAIL_RENDER/FAIL_TIMEOUT
Round 4: no product output; likely FAIL_RENDER/FAIL_TIMEOUT
Game: FAIL
```

The exact round 3–4 machine category cannot be assigned retrospectively because
the current diagnostics do not maintain trustworthy four-round semantic
ownership. The manual outcome is authoritative: no cards appeared.

No application code or tests were changed while producing this V1
specification.

## What currently works

- The overlay process builds, launches, and remained alive through the latest
  game.
- LCU and Live Client Data are polled through bounded native commands.
- A temporary Live Client Data failure is preserved when gameflow still
  confirms a live game.
- Current player champion name is returned by native player-data parsing and
  mapped to a packaged canonical champion ID.
- Native surface probing can detect augment card rectangles.
- Triggered OCR can resolve observed slot titles to canonical augment IDs.
- Foreground, game epoch, offer generation, and slot generation guards reject
  several classes of stale asynchronous work.
- Fixture authorization was active in the latest game.
- Development fixture loading is stripped from production builds by Vite
  aliases.
- Production member mode has a separate packaged-data/scoring path.
- The card renderer has explicit labels for scanning, loading, no data, data
  error, unmatched identity, OCR error, and resolved tiers.
- A current fixture response can in principle re-resolve stored slot identities
  and update the same offer.
- Confirmed non-live gameflow clears visible game state.
- Existing trace/replay utilities expose native delays, stale results,
  scheduler health, and publication-gate reasons.

These mechanisms are inputs to V1, not evidence that V1 already works.

## Latest game failure

### Rounds 1–2: containers without useful champion content

The early pipeline reached geometry and augment identity:

- current champion ID was `56`;
- the early offer had canonical augment identities;
- diagnostics reported a complete champion dataset with zero loaded rows; and
- each selection reported `champion-no-data`.

The development fixture response advertised champion augment rows, but the
observed rows had null win rates. `parseRow` in
`overlay/src/dev/championStats.ts` accepts only string win rates, so every row
was discarded. `parseChampionAugmentDataset` nevertheless marked the dataset
complete. `selectChampionSlotStat` then treated each current canonical augment
as genuine no-data.

`App.tsx` converted those results to no-data chips and
`BadgeChipLayer.tsx` rendered the fallback in three positioned containers.
Because the dataset stayed “complete” at zero usable rows, the same-offer
refresh path had no valid later value to publish.

Current failure hypothesis: the primary rounds 1–2 defect is invalid source
completeness at the champion-data boundary, compounded by diagnostics that
count containers rather than current semantic content.

### Rounds 3–4: no containers

Later in the same trace:

- native geometry requests took tens of seconds;
- logical timeouts did not cancel the blocking native work;
- accepted geometry aged beyond the final freshness deadline; and
- the publication gate reported unhealthy geometry and hid the badge layer.

`computeAugmentOverlayGate` requires a current visible frame, offer surface,
and healthy geometry scheduler. When any is absent, the whole layer is
suppressed regardless of data state. This is the precise current path by which
rounds 3–4 can show nothing.

Current failure hypothesis: outstanding native capture work starved fresh
later-round geometry, which made publication authority stale and suppressed the
layer. This must be reproduced with an injected delayed native adapter before
changing the scheduler.

Two lifecycle weaknesses make the failure harder to classify:

- normal mouse selection in fixture-only mode does not reliably advance the
  current round counter, so later offer generations remained labeled round 1;
  and
- repeated confirmed non-live polls call game cleanup repeatedly, advancing
  epochs after the session has already ended.

Neither weakness explains the rounds 1–2 no-data cards. Both block a
deterministic four-round session bundle.

## Known misleading diagnostics

The following are supporting signals, not V1 success:

- `badgeLayerVisible:true`;
- `renderedBadgeCount:3`;
- three positioned badge DOM nodes;
- an accepted geometry frame;
- a successful OCR invocation;
- a canonical augment match without champion data;
- a dataset labeled `complete` without usable-row validation;
- a synthetic four-offer lifecycle test; and
- an R1-only capture replay.

`renderedBadgeCount` currently proves only that positioned elements existed.
It does not prove:

- current champion identity;
- three current canonical augment identities;
- successful champion/augment lookup;
- a valid no-data decision;
- useful bounded fallback text;
- matching semantic ownership in the DOM;
- round completion; or
- player-visible paint.

The replacement release signal is `round-content-complete`, defined in
`docs/specs/overlay-v1-debug-session-contract.md`. It requires three terminal
current slot states and three matching DOM publication acknowledgements.

## Current architecture ownership

| Stage | Current owner |
| --- | --- |
| Native player/game data | `overlay/src-tauri/src/lib.rs` |
| Game, champion, geometry, OCR, and render orchestration | `overlay/src/App.tsx` |
| Gameflow carry-forward | `overlay/src/liveGamePoll.ts` |
| Surface and offer generation | `overlay/src/surfaceGeometry.ts`, `overlay/src/offerSurfaceState.ts` |
| OCR ownership and reroll invalidation | `overlay/src/ocrOwner.ts`, `overlay/src/rerollInvalidation.ts` |
| Development champion data | `overlay/src/dev/championDataset.ts`, `overlay/src/dev/championStats.ts`, `overlay/src/dev/useAramggTierFixture.ts` |
| Production packaged lookup/scoring | `buildOverlayAugmentLookup` and related state in `overlay/src/App.tsx` |
| Visible cards | `overlay/src/BadgeChipLayer.tsx`, `overlay/src/positionBadgeChips.ts` |
| Publication gate and diagnostic | `overlay/src/augmentOverlayGate.ts`, `overlay/src/badgeLayerDiagnostic.ts` |

There is no single current owner for the seven public slot states, four round
results, bundle projection, and replay. That is the central V1 architecture
gap.

## Changed-file map

Note (2026-08-03): this map predates the Sol A–H repair; see the update
section above for the files added since.

### Written by this specification task

| File | Purpose |
| --- | --- |
| `docs/specs/overlay-v1-product-contract.md` | User-visible behavior, state model, invariants, acceptance, completion |
| `docs/specs/overlay-v1-debug-session-contract.md` | Event and bundle schemas, privacy, replay, completion |
| `docs/plans/overlay-v1-implementation-plan.md` | Current path, failures, phases, dependencies, file map, stopping rule |
| `docs/testing/overlay-v1-acceptance-plan.md` | Automated, replay, manual, negative, and release gates |
| `docs/handoffs/overlay-v1-current-state.md` | Current V1-only handoff |

### Pre-existing active implementation changes, not touched by this task

At inspection time the worktree already contained tracked modifications in:

- `overlay/src/App.tsx`;
- `overlay/src/auth/member.ts`;
- `overlay/src/dev/production/tierFixture.ts`;
- `overlay/src/dev/publicationDiagnostics.ts`;
- `overlay/src/dev/tierFixture.ts`;
- `overlay/src/liveGamePoll.ts` and its focused tests;
- `overlay/src/publicationIntegration.test.ts`; and
- `src/lib/__tests__/overlay-tier-fixture.test.ts`.

It also contained untracked active overlay implementation/test files including:

- `overlay/src/BadgeChipLayer.tsx`;
- `overlay/src/augmentOverlayGate.ts` and its test;
- `overlay/src/badgeLayerDiagnostic.ts` and its tests;
- `overlay/src/positionedBadgeChips.ts` and its test; and
- `overlay/src/auth/member.test.ts`.

Those files are part of the current implementation slice and must be preserved
and reviewed before any implementation edit. Their untracked status is a
delivery risk; this documentation task did not stage or alter them.

## Active V1 risks

1. **Invalid absence:** zero usable fixture rows can be classified as complete
   and permanently presented as no-data.
2. **Split data semantics:** development fixture and production member scoring
   use different lookup paths and status meanings.
3. **No semantic owner:** asynchronous identity, data, geometry, and React
   effects derive overlapping state without one current ownership reducer.
4. **Later-round capture starvation:** native work can outlive logical waits,
   leaving current geometry unhealthy and the layer hidden.
5. **Two-card geometry tolerance:** surface presence may accept two strong
   cards, while V1 completion requires exactly three slots.
6. **Round ambiguity:** keyboard evidence and visible replacements do not
   reliably classify normal four-round mouse-driven play.
7. **Non-idempotent cleanup:** repeated non-live polling can repeat close,
   epoch, and future bundle-finalization actions.
8. **Falsely reassuring tests:** several current integration tests inspect
   source wiring or synthetic container behavior without running
   champion/data/DOM semantics.
9. **No debug bundle:** the current trace is rich but does not create the
   bounded round/slot/replay artifacts required for one-game diagnosis.
10. **Production-source decision:** development ARAMGG content is stripped from
    production; the authoritative member-authorized V1 content source must be
    confirmed before adapter work.

## Deferred validation tooling

Keep the current trace analyzer, focus/geometry timing markers, watchdog
reports, frame identity checks, and manual validation skill as engineering
tools. The following are explicitly outside the V1 product release gate unless
they expose a direct product-contract failure:

- cryptographic dirty-worktree certification;
- exhaustive inode and trace-rotation provenance;
- continuous worktree drift detection;
- exhaustive focus-transition proof;
- cross-game evidence certification;
- perfect malformed-trace attribution; and
- automatic video/source-byte matching.

Do not delete or weaken useful checks. Do not spend additional V1 phases
certifying them after four-round product, bundle, replay, and cleanup acceptance
pass.

## Next implementation step

Note (2026-08-03): stale — the Sol A–H pass has since implemented work
overlapping Phases 0–4 plus the OCR-recognition part of Phase 5. See the
2026-08-03 update above for the selected next slice.

Start Phase 0 from `docs/plans/overlay-v1-implementation-plan.md`:

1. confirm the authoritative member-authorized production data source and the
   default eight-second temporary-state deadline;
2. add the four focused red characterizations for invalid zero-row
   completeness, false container success, unhealthy geometry suppression, and
   repeated game cleanup; then
3. implement the pure semantic coordinator before modifying live algorithms.

The bundle/event projection follows immediately after the coordinator so the
next real game is useful even if a later product stage still fails.

Do not launch another manual game until the bundle writer and offline replay
path pass synthetically.

## Open decisions for review

- Confirm packaged member data/scoring as the V1 production source, with
  ARAMGG remaining development-only.
- Confirm an eight-second terminal slot deadline with same-offer background
  recovery.
- Confirm retention of the five most recent owner-only bundles with optional
  captures disabled by default.

None of these decisions authorizes a public/member ladder, entitlement, trial,
locale, or consent change.
