# Overlay V1 Implementation Plan

Status: ready for implementation review; no implementation has begun
Inspected working revision: `76a97b630bbdbec9b53d1e757b09bae887544733`

## Objective and stopping condition

Deliver the smallest change that makes the existing overlay work for four
augment rounds and turns the next real game into a deterministic offline replay
fixture. Preserve the native capture, geometry, OCR, entitlement, and existing
stale-result guards unless a focused failing test demonstrates that a local
change is necessary.

Implementation stops when the definition of complete in
`docs/specs/overlay-v1-product-contract.md` and the exact release gate in
`docs/testing/overlay-v1-acceptance-plan.md` both pass. It does not continue
into trace certification, general capture-platform redesign, or another
open-ended theoretical review.

## Evidence inspected

The plan is based on the current working tree, its focused tests, the handoffs
in `docs/handoffs/`, and the latest manual-game trace
`mayhem-mvp-fixture-20260731-135636.log`. The manual observations supplied for
this specification are authoritative:

- the process stayed alive;
- fixture authorization was active;
- temporary Live Client Data failure was preserved;
- rounds 1 and 2 showed three surfaces with no champion data;
- rounds 3 and 4 showed nothing;
- diagnostics sometimes reported `badgeLayerVisible:true` and
  `renderedBadgeCount:3`.

Trace replay adds stage-level detail:

- current champion ID was `56`;
- three offered augments were canonically resolved in the early offer;
- the champion dataset reported `completeness:"complete"` and
  `loadedCount:0`;
- slot selection reported `champion-no-data`;
- later native geometry calls took tens of seconds, accepted geometry aged
  beyond the final health deadline, and the badge gate became
  scheduler-unhealthy;
- OCR logical timeouts did not cancel native work; and
- confirmed non-live polls repeatedly invoked game cleanup, advancing epochs
  after the game had already ended.

The current upstream champion-56 fixture response was also inspected. It
advertised augment rows but every row had a null `win_rate`, so the current
string-only parser accepted none. That source can change; the durable defect is
that zero usable rows are still classified as a complete dataset.

## Current architecture map

The working implementation is a large coordinator in `overlay/src/App.tsx`
with pure helpers and Tauri native commands around it.

| Product stage | Current implementation path | Important symbols |
| --- | --- | --- |
| Game identity | `App.tsx` polls LCU gameflow and Live Client Data, carries a transient null gameflow result forward, hashes a live game, and advances an epoch. Native player data comes from `overlay/src-tauri/src/lib.rs`. | `poll`, `resolveGameflowCaptureAllowed`, `beginNewGameEpoch`, `closeConfirmedGame`, `get_live_player_data`, `parse_live_player_data` |
| Champion identity | Rust joins active-player identity to the player list and returns champion name; `App.tsx` maps that name through the packaged champion catalog. | `parse_live_player_data`, `championSlugByName`, `resolveKnownChampionSlug`, `currentChampionId` |
| Offer detection | Rust captures a bounded frame and probes augment-card geometry. React accepts observations into an offer surface and a separate visible-frame authority. | `probe_augment_surface`, `capture_surface_frame`, `run_bounded_capture`, `offerSurfaceState`, `deriveSurfaceGeometry`, `visibleFrame` |
| Offer generation | A transition from no offer to visible, a classified replacement, or an explicit clear increments a generation. Round delivery is tracked separately. | `offerSurfaceState`, `resolveOfferSurfaceTransition`, `resolveRoundDelivery`, `recordRoundCompleted` |
| Slot identity | Accepted card rectangles create slot generations. Triggered OCR returns observed titles, which are reconciled against the current slot owner and canonical augment catalog. | `runIdentityProbe`, `reconcileOcrResult`, `ocrOwner`, `rerollInvalidation`, identity store refs |
| Fixture mode | Development authorization enables the ARAMGG fixture adapter. It loads per-champion external tables and maps canonical augment IDs to stats. Production aliases replace these modules with inert stubs. | `tierFixtureOn`, `useAramggTierFixture`, `ChampionDatasetCache`, `resolveSlotTitle`, `overlay/vite.config.ts`, `overlay/src/dev/production/*` |
| Production data | After member authorization, `App.tsx` uses packaged augment, champion, combo, pool-rule, and ability data to build an overlay lookup and scoring result. | `memberCoachEnabled`, `buildOverlayAugmentLookup`, `nameLookup`, `decisionResult`, `pool` |
| Champion/augment lookup | Fixture parsing accepts only rows with string `tier` and string `win_rate`; a complete parsed dataset with no selected row becomes `champion-no-data`. The production scorer is a separate path. | `parseRow`, `parseChampionAugmentDataset`, `selectChampionSlotStat`, `buildOverlayAugmentLookup` |
| Badge content | `App.tsx` derives `slotChips`; `BadgeChipLayer.tsx` renders tier or fallback labels; `positionBadgeChips.ts` maps them to current rectangles. | `slotChips`, `BadgeChipLayer`, `positionBadgeChips` |
| Publication gate | Authorization, a visible frame, an offer surface, and geometry scheduler health control whether the whole layer is visible. Container count is reported separately from semantic content. | `computeAugmentOverlayGate`, `deriveBadgeLayerDiagnostic` |
| Same-offer update | An effect re-resolves stored identities when the fixture resolver, champion request, or patch changes and republishes current geometry if ownership still matches. | fixture re-resolution effect in `App.tsx`, `reconcileOcrResult` |
| Round cleanup | Strong selection evidence or a visible-to-visible replacement closes an offer. Keyboard selection is only recorded in member coach mode, so a normal mouse selection in fixture mode is not sufficient on its own. | `recordRoundCompleted`, `resolveRoundDelivery`, `clearOfferState` |
| Game cleanup | Confirmed non-live gameflow clears render/game state and advances the epoch. The current poll path can call this repeatedly on every non-live poll. | `clearGameRenderState`, `closeConfirmedGame`, `beginNewGameEpoch` |

Two independent authorities currently meet at publication:

1. geometry decides whether there are current positioned card surfaces; and
2. OCR/data resolution decides what those cards contain.

That separation is useful and should remain. The missing layer is a single
semantic owner that turns their results into three explicit slot states and
records the same transitions for live and replay execution.

## Current failure analysis

### Why rounds 1–2 could show three empty-information containers

The early-round path succeeded through geometry and canonical augment identity:

1. `probe_augment_surface` returned current rectangles.
2. `App.tsx` created an offer generation and slot generations.
3. `runIdentityProbe` resolved canonical augment IDs.
4. `useAramggTierFixture` loaded the champion-56 source.
5. `parseRow` in `overlay/src/dev/championStats.ts` discarded every row because
   the advertised win rates were null rather than strings.
6. `parseChampionAugmentDataset` still returned `completeness:"complete"` with
   zero usable rows.
7. `selectChampionSlotStat` classified each known augment as
   `champion-no-data`.
8. `slotChips` converted that to `no-data`, and `BadgeChipLayer` rendered
   `NO CHAMP DATA`.
9. `deriveBadgeLayerDiagnostic` counted the three positioned elements without
   examining their semantic content.

This explains how `badgeLayerVisible:true` and `renderedBadgeCount:3` coexisted
with product failure. The durable bug is at the data-validity boundary, not the
container renderer: an invalid zero-usable-row dataset was allowed to assert
complete absence.

The existing same-offer effect could only re-run the same invalid complete
dataset. It had no new source version or valid row that could promote the
slots, so the cards remained permanently `no-data`.

### Why rounds 3–4 could show no containers

The absence path is separate from champion data:

1. `augmentOverlayGate.ts` hides the entire badge layer if the current visible
   frame or offer surface is absent or the geometry scheduler is unhealthy.
2. The geometry scheduler permits one logical native surface probe at a time.
   A JavaScript timeout abandons the wait but does not cancel the blocking
   native capture.
3. The latest trace shows native geometry durations growing into tens of
   seconds and accepted geometry aging beyond the final freshness bound.
4. The final gate therefore suppressed publication, so neither resolved cards
   nor fallbacks could appear.

This is the stage where later-round “nothing appeared” can occur. It is not a
level-15 data branch. It is a loss of current geometry publication authority.
The live trace is sufficient to prioritize this path, but the implementation
phase must first reproduce the unhealthy-to-hidden transition with a bounded
fake native adapter before changing scheduling.

Round accounting is an additional defect. `recordRoundCompleted` does not
observe a normal mouse selection in fixture-only mode, and the trace continued
to label later offer generations as round 1. This does not by itself explain
the missing containers, but it prevents a trustworthy four-round bundle and
must be replaced by offer-lifecycle ordinals for V1.

Repeated `closeConfirmedGame` calls after game end are likewise not the cause
of the in-game blank rounds, but they violate idempotent cleanup and deterministic
bundle finalization.

## Central architecture decision

Add one small pure `OverlaySessionCoordinator` that owns the V1 semantic state:

```text
live adapters ─┐
               ├─> semantic events ─> OverlaySessionCoordinator
replay adapter ┘                            │
                                            ├─> RoundViewModel -> existing cards
                                            └─> debug timeline -> session bundle
```

The coordinator is a reducer plus bounded effects. It owns game, round, offer,
slot, champion, data, and publication keys; it does not capture pixels, perform
OCR, call LCU, fetch data, or write files. The existing live modules become
adapters that emit typed semantic events. The replay driver emits the same
events on a logical clock. `App.tsx` renders only the coordinator's current
three-slot `RoundViewModel`.

This is not a rewrite:

- keep `probe_augment_surface`, geometry classification, OCR recognition,
  foreground protection, member authorization, packaged scoring, and existing
  caches;
- wrap the current production and fixture lookups behind one small result
  interface;
- move ownership and public slot-state calculation out of scattered React
  effects;
- add a narrow owner-only writer for structured bundle files; and
- change geometry scheduling only after the later-round reproduction test is
  red.

The production, development-fixture, and replay adapters must return the same
result shape:

```ts
type AugmentDataResult =
  | { status: "resolved"; source: string; version: string; content: CardContent }
  | { status: "no-data"; source: string; version: string; completeness: "complete" }
  | { status: "error"; source: string; version?: string; category: FailureCategory };
```

No adapter may return `no-data` from a malformed, mismatched, or zero-usable-row
source.

## Exact V1 data pipeline

### 1. Game identity

The current LCU gameflow carry-forward remains the source of live-vs-transient
failure. On the first confirmed live state with usable Live Client Data, create
one local opaque `gameSessionId` and game epoch. Emit
`game-ownership-established` before accepting an offer.

Confirmed non-live state finalizes once. Track an explicit closed state so
later non-live polls are no-ops. A subsequent confirmed live game creates a new
session and epoch.

### 2. Champion identity

Keep `get_live_player_data` and `parse_live_player_data` as the native source.
Normalize the returned champion through the packaged catalog in one adapter,
then emit requested/resolved/failed events with a `championGeneration`.

A champion change invalidates current data requests, not the offer geometry.
Current slots move to `resolving-champion` or `loading-data` and refresh in
place under the same offer generation.

### 3. Offer detection

Keep the current geometry observations and accepted rectangles. The semantic
coordinator accepts an offer only when exactly three ordered current slots are
available. Observations with zero, one, or two slots remain detection evidence
and never produce `round-content-complete`.

If later-round capture health is lost, the coordinator retains the last
semantic state only within its current freshness bound, then publishes a
bounded `error` fallback if three owned positions remain safe. If positions are
not safe, it records `render-suppressed` and the round fails visibly and in the
bundle; it must not claim success from old geometry.

### 4. Augment identity

Create one slot generation for each of the three accepted positions. Feed
current OCR results through the existing canonical resolver. Emit resolution
events per slot. Reject all results whose game, offer, slot, or foreground
ownership differs.

A distinct observed offer creates a new offer generation and clears prior
identities before any new card content is published.

### 5. Data lookup

Wrap the current packaged member scorer and development fixture loader behind
`AugmentDataResult`. Production continues to use server/member-authorized
packaged data; the development ARAMGG adapter remains development-only unless
the product owner explicitly approves a source and entitlement change.

Validate source version, champion ownership, declared completeness, advertised
row count, usable row count, and row shape before selection. Zero usable rows
from an advertised non-empty response is `data-source-invalid`.

Cache valid source responses by champion ID, data source, and version. Never
cache an unversioned error as permanent no-data. A late valid response for the
current key emits a new lookup result and refreshes the same offer.

### 6. Render-state publication

The coordinator derives the seven public slot states. `App.tsx` passes exactly
three current view models to `BadgeChipLayer`. The card component displays
bounded loading and fallback content but does not infer data state.

After React commits, a narrow publication callback verifies the DOM ownership
attributes and semantic state, then emits `resolved-content-entered-dom`.
`renderedBadgeCount` remains a layout diagnostic only.

### 7. Session capture

Every reducer input and relevant publication acknowledgement becomes a bounded
debug event. A Tauri command writes events under an owner-only application data
directory. The React side never sends arbitrary paths or raw responses to the
writer.

The bundle begins before the first offer, persists terminal transitions during
the game, and finalizes once after confirmed game end. A crash leaves a useful
partial bundle.

### 8. Replay

At finalization, normalize the recorded semantic events and lookup outcomes
into `overlay-replay/v1`. A pure replay driver advances a fake clock and feeds
the same coordinator. Injected adapters replace LCU, OCR, data, membership, and
filesystem calls.

The replay mounts the real card component and records the same semantic DOM
publications. It does not attempt to reproduce native pixels.

## Implementation phases

### Phase 0 — Lock source policy and write red characterizations

Decisions:

- confirm the authoritative V1 production champion-specific data source;
- confirm that development ARAMGG data remains non-production unless
  separately approved; and
- set the eight-second terminal deadline or choose another single V1 value.

Tests first:

- advertised rows plus zero usable parsed rows must be source-invalid;
- three `no-data` chips must not satisfy round success without completeness;
- unhealthy current geometry must make a semantic round fail even when a prior
  container count was three;
- repeated confirmed non-live polls must produce one game-end transition.

Observable exit: all four tests fail for the expected current reason, with no
application behavior changed.

### Phase 1 — Add the pure semantic coordinator

Implement the ownership keys, seven slot states, transitions, deterministic
round result, and `round-content-complete`. Add a logical-clock test harness.

Observable exit: pure tests drive four rounds with three slots, late current
responses, stale responses, rerolls, round clears, and game cleanup without
React or Tauri.

### Phase 2 — Capture a useful bundle before the next live game

Add bounded event serialization, per-round projections, replay-fixture
generation, and the owner-only native writer. Wire existing live stage results
to semantic events without yet changing their algorithms.

Observable exit: a fully synthetic session creates the required directory
layout, passes privacy assertions, survives simulated interrupted finalization,
and replays from its structured files.

### Phase 3 — Unify data result semantics and same-offer refresh

Add the small data-source interface. Wrap the current production and fixture
paths. Validate zero-usable-row and version mismatches. Route all late current
responses back through the coordinator; remove only superseded state inference
created by this change.

Observable exit: a mounted same-offer test first renders loading or explicit
error, then renders current champion-specific data without changing
`offerGeneration`. A stale champion/source response cannot update the card.

### Phase 4 — Wire round ownership and semantic rendering

Make accepted distinct-offer lifecycle, not keyboard selection, the source of
round ordinals. Render the coordinator's three view models. Add DOM publication
acknowledgements and idempotent game cleanup. Preserve keyboard/mouse evidence
only as supporting transition signals.

Observable exit: the mounted integration harness produces rounds 1–4 exactly
once, clears each prior offer, emits four completion results, and has no cards
after game end.

### Phase 5 — Repair only the reproduced later-round geometry failure

Use an injected capture adapter to reproduce a native call outliving its
logical timeout and causing the current gate to hide later offers. Apply the
smallest bounded scheduling or recovery change that restores fresh three-slot
geometry without retry amplification. Keep capture permits owned until native
work truly settles.

Possible implementation choices must be evaluated from the red test, in this
order:

1. prevent an abandoned logical wait from monopolizing future accepted probes;
2. allow one bounded replacement generation while retaining native permit
   ownership;
3. restart or isolate the native capture worker only if the first two cannot
   make progress.

Observable exit: four synthetic offer windows remain publishable under delayed
native returns, outstanding work stays bounded, and no old frame enters a later
round.

### Phase 6 — Canonical replay and one-game release gate

Run the canonical success, delayed-data, missing-data, error, stale-result, and
cleanup fixtures. Run repository verification. Build the release overlay. Play
one owner-controlled four-round game and finalize its bundle. Replay that exact
bundle offline and compare semantic publications and round results.

Observable exit: all four live rounds and the offline replay pass the exact
release gate. Stop V1 work.

## File-level change map

These are planned implementation changes, not changes made by this document
task.

| File | Planned minimal responsibility |
| --- | --- |
| `overlay/src/overlaySession.ts` (new) | Pure state, ownership keys, reducer, result calculation, public view model |
| `overlay/src/overlaySession.test.ts` (new) | State, stale ownership, four-round, timeout, cleanup unit tests |
| `overlay/src/augmentDataSource.ts` (new) | Common result type and thin production/fixture adapter boundary |
| `overlay/src/debugSession.ts` (new) | Bounded event/round/session schemas and replay projection |
| `overlay/src/debugSession.test.ts` (new) | Schema, privacy, completeness, partial-session tests |
| `overlay/src/replaySession.ts` (new) | Logical-clock adapter that drives the real coordinator |
| `overlay/src/replaySession.test.tsx` (new) | Deterministic mounted four-round replay and DOM publications |
| `overlay/src/App.tsx` | Convert existing live outcomes to events; render coordinator view; idempotent game lifecycle |
| `overlay/src/BadgeChipLayer.tsx` | Render explicit semantic states and expose bounded ownership attributes |
| `overlay/src/badgeLayerDiagnostic.ts` | Add semantic terminal/publication counts; retain container count as non-proof |
| `overlay/src/augmentOverlayGate.ts` | Consume current semantic publication readiness without conflating it with geometry |
| `overlay/src/liveGamePoll.ts` | Make confirmed game-end transition idempotent if the pure lifecycle belongs here |
| `overlay/src/dev/championStats.ts` | Reject advertised sources with zero usable rows; distinguish invalid from true absence |
| `overlay/src/dev/championDataset.ts` | Propagate validated completeness, version, and usable-row metadata |
| `overlay/src/dev/useAramggTierFixture.ts` | Adapt fixture results to the common data-result contract |
| `overlay/src/dev/production/useAramggTierFixture.ts` | Preserve inert production behavior with the same type surface |
| `overlay/src-tauri/src/debug_session.rs` (new) | Owner-only bounded bundle writer; no caller-supplied arbitrary paths |
| `overlay/src-tauri/src/lib.rs` | Register the writer command; capture changes only if Phase 5's red test requires them |

Existing focused tests should be extended where they already own a pure
contract. Source-string tests should not be expanded as substitutes for runtime
tests.

## Tests that are currently insufficient

| Existing test area | What it proves | Why it is falsely reassuring for V1 |
| --- | --- | --- |
| `badgeLayerDiagnostic.test.ts` | A visible layer can report a supplied container count. | It does not inspect slot state or content ownership; three fallbacks pass. |
| `positionedBadgeChips.test.ts` | Positioned inputs produce DOM nodes. | It does not require three useful current semantic results. |
| `publicationIntegration.test.ts` | Expected source wiring strings exist. | It does not execute the asynchronous live/data/render pipeline. |
| `laterRoundLifecycle.test.ts` | A synthetic offer harness can iterate offers. | It bypasses champion loading, OCR, data validity, native delay, and real DOM publication. |
| `offerGeneration.test.ts` | Pure surface generations change. | It does not establish four round ordinals or cleanup. |
| `liveGamePollIntegration.test.ts` | Poll helpers and source wiring cover selected cases. | It does not mount `App.tsx` through four offers and bundle finalization. |
| `r1Replay.test.ts` and Rust `r1_replay.rs` | One captured R1 geometry/OCR case can be replayed. | They do not cover champion data content, rounds 2–4, late data, or game cleanup. |
| champion fixture/parser tests | Synthetic valid rows select expected tiers. | They do not reject an advertised dataset whose rows all parse to unusable. |
| fixture state tests | Pure fixture status mappings work. | They do not prove a mounted same-offer refresh reaches the DOM. |

Keep these tests for their narrow contracts. Add the missing semantic runtime
tests instead of deleting broad existing coverage.

## Dependency ordering

```text
source-policy decision
        ↓
red characterizations
        ↓
pure coordinator ───────> mounted semantic renderer
        │                          ↑
        ├─> debug events/bundle ───┤
        │                          │
        └─> replay driver ─────────┘
                                   ↑
data adapters + refresh ───────────┤
                                   ↑
offer/round lifecycle ─────────────┤
                                   ↑
bounded geometry repair, if needed
```

The pure coordinator precedes both bundle and UI wiring so live and replay
cannot develop separate state machines. Bundle capture precedes the next manual
game so even a remaining failure is actionable offline. Geometry repair follows
a reproduction to avoid destabilizing the working native path speculatively.

## Migration strategy

1. Add the coordinator behind a development-only comparison flag in tests,
   feeding it the same current events while legacy rendering remains
   authoritative.
2. Compare legacy chip output to semantic view models for canonical replay
   fixtures; differences must be classified, not silently normalized.
3. Switch `BadgeChipLayer` input to the semantic view model when mounted tests
   pass.
4. Remove only the duplicated React state/effects made unreachable by that
   switch. Keep geometry/OCR helpers and existing validation logs.
5. Make structured session events the product diagnostic source. Retain the
   legacy trace analyzer as optional experimental tooling.
6. Build fixture and production configurations to prove development modules
   remain stripped and entitlement is unchanged.

There is no public-data migration in V1. Any proposal to ship a new
champion-specific dataset, change its disclosure layer, use a live third-party
source in production, or alter entitlement must return to the product owner
before implementation.

## Do not expand scope

During these phases, do not:

- replace the native capture stack without a focused failing test;
- merge production and development authorization;
- expose member data through public static assets or APIs;
- add locales, change locale ownership, or hardcode a new locale list;
- redesign overlay scoring;
- add full-screen or default raw-image recording;
- build a general telemetry platform;
- pursue perfect focus/inode/repository provenance;
- rewrite all `App.tsx` behavior at once;
- make video or formal trace certification a release dependency; or
- continue review rounds after the finite release gate passes.

Useful validation tooling remains documented and runnable, but its deferred
defects are tracked separately from product completion.

## Open specification decisions

Implementation Phase 0 requires three bounded owner decisions:

1. Which existing member-authorized, versioned source is authoritative for
   champion/augment V1 content? Default: the packaged production scorer/data
   already used by the member overlay; keep ARAMGG strictly as a development
   fixture.
2. Is eight seconds the acceptable maximum temporary slot state after a stable
   offer? Default: yes, followed by visible `error` and a background retry
   that may refresh the same offer.
3. How many completed owner-only bundles are retained? Default: the five most
   recent, with explicit export and optional captures off.

None of these decisions justifies changing the public/member data ladder,
entitlement, or consent behavior without separate approval.

## Finite stopping rule

After Phase 6, stop when:

- canonical offline fixtures pass;
- repository tests, lint, web build, overlay build, and any required Rust
  release build pass;
- one real game records exactly four round files and four `PASS` results;
- its offline replay produces the same semantic publication sequence;
- game-end cleanup leaves no cards or open session; and
- no high-severity product-contract failure remains.

Record non-blocking capture/provenance concerns in the handoff and end V1. Do
not schedule another real game merely to discover an unrecorded stage failure;
the bundle and replay must drive the next fix.
