# Overlay V1 Product Contract

Status: implementation contract
Scope: the League augment overlay for one complete four-round game

## Product outcome

Overlay V1 helps the current player make an augment choice in each of the four
augment-pick rounds. A successful round is not merely three positioned
containers. It is three correctly owned cards whose augment identities and
champion-specific content are either resolved or represented by an explicit,
bounded fallback.

The V1 priority order is:

1. a working four-round overlay;
2. an actionable one-game debug bundle;
3. deterministic offline replay;
4. a simple, stable implementation;
5. theoretical validation completeness.

## User-visible behavior

For every augment offer, the player sees exactly three cards aligned with the
three current offer slots. Each card shows:

- the canonical augment identity, once resolved;
- champion-specific content when the selected data source has it;
- a short loading indication while current identities or data are pending; or
- a clear fallback when valid data is genuinely absent or the current lookup
  fails.

The cards may update in place. If champion identity, augment identity, or
champion-specific data arrives after the cards first appear, the same offer
refreshes automatically. The player does not need to dismiss the offer, change
focus, reroll, or enter another game to trigger that update.

The overlay never presents content owned by a different game, round, offer
generation, slot, champion, augment, or data version. The previous round is
removed before the next round is published. Confirmed game end removes all
game-specific cards and state.

The following do not count as useful visible output:

- an empty card;
- a card that remains indefinitely in a temporary state;
- a generic `NO CHAMP DATA` label caused by an invalid or empty data load;
- a positioned DOM node with no current semantic slot state; or
- a card inherited from an earlier offer.

## Four-round contract

A game session owns four ordered offer rounds. `round` is the ordinal of an
accepted, distinct offer within the current game (`1` through `4`), not an
inference from champion level and not dependent on the player pressing a
keyboard selection key.

For each round, the implementation must:

1. detect one stable current offer;
2. identify exactly three ordered slots;
3. create one `offerGeneration`;
4. resolve a canonical augment ID for every slot;
5. resolve the current player's canonical champion ID;
6. look up champion-specific data for every champion/augment pair;
7. publish three current semantic card states;
8. refresh those states when a late current result arrives;
9. produce `round-content-complete` when all three cards are terminal and
   present in the DOM;
10. end and clear the offer before publishing the next round.

A reroll or another distinct three-slot offer during the same pick round gets a
new `offerGeneration` but does not increment `round`. A round increments only
after the current offer has ended and a later stable offer is accepted. The
implementation must record why it classified a transition as a reroll, round
transition, or game cleanup.

Game end is authoritative only when the existing gameflow source confirms a
non-live state. Temporary Live Client Data or LCU read failures preserve the
current game. Confirmed game cleanup is idempotent: repeated non-live polls do
not repeatedly advance the game epoch, refinalize the bundle, or emit duplicate
game-end transitions.

## Four offer rounds, up to five final augments

Four offer rounds do not imply a maximum of four final owned augments.

- A standard game has exactly four augment offer rounds and exactly four
  offer-round owners; no fifth offer round is ever created.
- Normally one selected offer card per round.
- One originating round may produce multiple final augment results:
  Transmute: Gold may transform into Transmute: Prismatic, which may make
  Transmute: Chaos possible, and Transmute: Chaos can produce two randomized
  augments from one originating offer round.
- Final ownership representations must support at least five entries.
- Transformation lineage remains attached to the originating round.
- Round progression must never be derived from final augment inventory
  length.
- Rerolls and transformations are separate concepts: a reroll replaces the
  current offer within the same round; a transformation changes what a
  selected augment ultimately becomes.

Current-code status (audited 2026-08-03 at `76a97b6` plus worktree): the
final owned inventory (`pickedAugments` in `overlay/src/App.tsx`) is
unbounded; no production, replay, or serialization path caps final augments
at four or derives `round` from inventory length; transformation lineage is
not yet represented anywhere. Do not add a cardinality assertion that would
reject a fifth final augment.

## Slot state model

Every current slot has exactly one public state:

| State | Meaning | Temporary |
| --- | --- | --- |
| `waiting-for-offer` | No accepted three-slot offer owns the slot yet. | Yes |
| `resolving-augment` | A slot was observed but its canonical augment ID is not known. | Yes |
| `resolving-champion` | The augment is known but the current champion ID is not known. | Yes |
| `loading-data` | Both identities are known and a current data lookup is pending. | Yes |
| `resolved` | Current champion-specific content is ready. | No |
| `no-data` | A valid, complete current source explicitly has no row for this pair. | No |
| `error` | Identity, source validation, lookup, or publication failed within its bound. | No |

The deterministic precedence is:

1. no accepted offer: `waiting-for-offer`;
2. missing canonical augment: `resolving-augment`;
3. missing canonical champion: `resolving-champion`;
4. outstanding current lookup: `loading-data`;
5. current successful row: `resolved`;
6. valid complete source with an explicit missing pair: `no-data`;
7. bounded failure: `error`.

`no-data` is not a synonym for “the loader returned no usable rows.” A source
that is malformed, has zero usable rows when rows were advertised, has the
wrong champion/version, or cannot prove completeness produces `error` with a
data-source failure category.

Temporary states have recorded start times and configured deadlines. The V1
default terminal deadline is eight seconds after a stable offer is accepted;
the implementation may complete sooner. A missed deadline moves the affected
slot to an explicit `error` fallback and records `timeout`. It must not remain
blank or loading.

A terminal state is terminal for one lookup attempt, not forever. A newer
current result may reopen `no-data` or `error` as `loading-data` and then
replace it with `resolved`, provided all ownership keys still match.

## Ownership model

Every slot result and rendered card is keyed by:

```text
gameSessionId
+ gameEpoch
+ round
+ offerGeneration
+ slot
+ championGeneration
+ championId
+ canonicalAugmentId
+ dataSource
+ dataVersion
```

Before applying an asynchronous result, the implementation compares all
applicable keys to current ownership. A mismatch is recorded and discarded.
Late work may populate a bounded cache, but it cannot publish UI state.

The existing foreground, geometry, OCR, and slot-generation checks remain
useful input guards. They do not replace semantic ownership at the
champion/augment data and render-publication boundary.

## Product invariants

1. One live game has one stable `gameSessionId` and monotonically increasing
   `gameEpoch`.
2. One accepted offer generation has exactly three ordered slots.
3. A slot cannot enter `loading-data` until champion and augment identities are
   canonical.
4. `resolved` always includes current champion ID, canonical augment ID,
   source, version, and bounded display content.
5. `no-data` requires a valid, complete source response for the same ownership
   key.
6. No temporary state survives its deadline without an explicit terminal
   fallback.
7. A current late result refreshes the same offer without requiring a new
   offer generation.
8. A stale late result cannot alter the current offer.
9. DOM publication contains exactly three cards for a complete round.
10. `round-content-complete` requires all three current slots to be `resolved`
    or an allowed terminal fallback and requires the matching content to have
    entered the DOM.
11. `renderedBadgeCount` and container presence alone never establish product
    success.
12. Round cleanup precedes publication of the next round.
13. Confirmed game cleanup clears champion, offer, lookup, render, and
    session-owned state exactly once.
14. Replay and live execution reduce the same semantic events through the same
    state transition logic.

## Round and game results

Every round emits exactly one machine-readable result:

```text
PASS
FAIL_DATA
FAIL_IDENTITY
FAIL_RENDER
FAIL_TIMEOUT
FAIL_STALE_STATE
```

Evaluation uses this precedence:

1. `FAIL_STALE_STATE`: any stale content was published, or cleanup ownership
   was violated.
2. `FAIL_TIMEOUT`: any slot remained temporary past its deadline.
3. `FAIL_RENDER`: semantic terminal states were current but exactly three
   matching cards did not enter the DOM.
4. `FAIL_IDENTITY`: the champion, offer slot count, or any canonical augment
   identity failed to resolve within its bound.
5. `FAIL_DATA`: identity succeeded, but the source was invalid, the lookup
   failed, or an unverified absence was presented as `no-data`.
6. `PASS`: exactly three cards entered the DOM; every card was `resolved` or a
   verified `no-data` fallback; all ownership and cleanup checks passed.

An `error` card is a required safe visible fallback, but it still makes the
round fail under the most specific category. A verified `no-data` card is an
acceptable product result and can pass.

The game result is `PASS` only when rounds 1, 2, 3, and 4 are all `PASS` and
confirmed game cleanup succeeds. Missing, duplicated, or extra rounds fail the
game.

## Acceptance criteria

A manual round passes only when all of the following are observed and captured
in the session bundle:

- one current offer and exactly three ordered slots;
- three correctly positioned current cards;
- the current champion resolved;
- all three canonical augment identities resolved;
- every slot left its temporary state within the deadline;
- each slot rendered champion-specific content or verified `no-data`;
- a late current response refreshed the same offer when that case occurred;
- no content came from another slot, offer, round, champion, or game;
- the prior offer was cleared before a later round appeared; and
- one `round-content-complete` event matched the three DOM publications.

The full manual game additionally requires four passing rounds and one
idempotent confirmed-game cleanup.

## Explicit non-goals

V1 does not require:

- cryptographic certification of a dirty worktree or every captured byte;
- formal inode provenance across every trace rotation race;
- exhaustive proof of all foreground transitions;
- continuous repository-drift monitoring;
- cross-game forensic evidence certification;
- perfect diagnostic attribution for malformed trace input;
- automatic proof that recorded video frames match source bytes;
- raw OCR images or full-screen captures by default;
- a new public data surface, weakened entitlement, or changed trial semantics;
- a rewrite of the native capture, geometry, or OCR stack.

Existing validation tooling may continue as a separate engineering aid. It is
not part of the V1 product release gate unless it directly proves one of the
observable criteria above.

## Definition of V1 complete

V1 is complete when one release build:

1. passes the unit, integration, and deterministic four-round replay gates in
   `docs/testing/overlay-v1-acceptance-plan.md`;
2. completes one real game with four `PASS` round results;
3. finalizes the bounded owner-only session bundle;
4. replays that bundle offline without League, LCU, OCR, network, or live
   membership services;
5. renders the same recorded semantic card-state sequence during replay; and
6. clears all live and replay game-specific state at confirmed game end.

No formal trace-certification milestone is required after these conditions are
met. Remaining theoretical races become separately prioritized follow-up work.
