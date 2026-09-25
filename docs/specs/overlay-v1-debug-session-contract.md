# Overlay V1 Debug Session Contract

Status: implementation contract
Audience: owner/developer diagnostics only

## Purpose

One played game must produce enough bounded structured evidence to answer:

- which product stage failed;
- which game, round, offer, and slot owned the failure;
- what the player-facing slot state became;
- whether a late response refreshed the same offer;
- whether stale work was rejected or published; and
- whether the same state sequence can be reproduced offline.

The bundle records product semantics, not unrestricted telemetry or formal
forensic provenance. Screenshots and offer crops are optional, owner-controlled
supplements. Ordinary diagnosis and replay must work without them.

## Bundle layout

The on-disk bundle is a versioned directory:

```text
session/
├── summary.md
├── session.json
├── timeline.jsonl
├── rounds/
│   ├── round-1.json
│   ├── round-2.json
│   ├── round-3.json
│   └── round-4.json
├── replay/
│   └── replay-fixture.json
└── optional-evidence/
    └── bounded-offer-captures/
```

`optional-evidence/` may be absent. `summary.md` is derived from the structured
files and contains no additional sensitive data.

All files carry `schemaVersion`. V1 uses `overlay-debug-session/v1` for session
and round records and `overlay-replay/v1` for replay fixtures. Unknown major
versions fail closed; additive unknown fields in the same major version are
ignored.

## Session schema

`session.json` contains bounded session metadata and results:

```json
{
  "schemaVersion": "overlay-debug-session/v1",
  "gameSessionId": "local-opaque-id",
  "gameEpoch": 12,
  "overlayVersion": "bounded-build-id",
  "startedAt": "2026-07-31T05:00:00.000Z",
  "endedAt": "2026-07-31T05:25:00.000Z",
  "status": "complete",
  "completionReason": "confirmed-game-end",
  "dataSources": [
    {
      "name": "packaged-member-data",
      "version": "bounded-version"
    }
  ],
  "deadlinePolicy": {
    "slotTerminalMs": 8000
  },
  "roundResults": [
    {"round": 1, "result": "PASS"},
    {"round": 2, "result": "PASS"},
    {"round": 3, "result": "PASS"},
    {"round": 4, "result": "PASS"}
  ],
  "gameResult": "PASS",
  "privacy": {
    "rawOcrImagesIncluded": false,
    "optionalCapturesIncluded": false
  }
}
```

Allowed `status` values are `open`, `complete`, and `partial`. `partial` means
the process ended before confirmed game end or finalization failed. A partial
bundle remains replayable through its last complete event.

The build ID is bounded to the application version and source revision known to
the build. It does not inventory dirty worktree bytes.

## Timeline envelope

`timeline.jsonl` is append-only during the game. Each line is one JSON object:

```json
{
  "schemaVersion": "overlay-debug-event/v1",
  "eventId": 184,
  "monotonicMs": 42150,
  "eventType": "data-lookup-succeeded",
  "gameSessionId": "local-opaque-id",
  "gameEpoch": 12,
  "round": 1,
  "offerGeneration": 42,
  "slot": 0,
  "payload": {}
}
```

`eventId` is strictly increasing within a bundle. `monotonicMs` is relative to
session start and drives replay. Wall-clock timestamps are optional outside
`session.json`; ordering never depends on wall-clock time.

Events that do not yet own a round, offer, or slot omit those fields. Payloads
use bounded enums, IDs, counts, durations, and sanitized messages. They do not
contain raw API responses, arbitrary exception dumps, or paths.

## Event taxonomy

The required event types are:

| Event | Required semantic payload |
| --- | --- |
| `game-ownership-established` | `gameEpoch`, bounded ownership reason |
| `champion-identity-requested` | `championGeneration`, source |
| `champion-identity-resolved` | generation, canonical `championId` |
| `champion-identity-failed` | generation, failure category |
| `offer-detected` | observation ID, observed slot count |
| `offer-generation-created` | `round`, `offerGeneration`, transition reason |
| `slot-observed` | slot index, bounded observed identity if available |
| `augment-identity-resolution-started` | slot and slot generation |
| `augment-identity-resolved` | canonical augment ID |
| `augment-identity-failed` | failure category |
| `data-lookup-started` | champion ID, augment ID, source, version, request ID |
| `data-lookup-succeeded` | request ID, bounded result metadata |
| `data-lookup-no-data` | request ID, completeness evidence |
| `data-lookup-failed` | request ID, failure category |
| `slot-render-state-changed` | prior and next public slot states |
| `resolved-content-entered-dom` | semantic state, DOM publication generation |
| `round-content-complete` | three terminal slot summaries, round result |
| `round-ended` | reason, result, next transition if known |
| `game-ended` | confirmed end reason, cleanup result |
| `replay-fixture-finalized` | fixture version, event count, result |

Recommended bounded support events are `stale-result-rejected`,
`offer-cleared`, `source-version-changed`, `bundle-write-failed`, and
`replay-divergence`. Native timing or focus details may be recorded only as
bounded support fields attached to a product-stage event.

`resolved-content-entered-dom` is emitted once per slot publication generation
after the rendered element exposes matching semantic ownership and state. It is
not emitted for a bare positioned container.

`round-content-complete` is emitted once per offer generation only when:

- exactly three slots exist;
- all three ownership keys match the current game/round/offer;
- every slot is `resolved`, verified `no-data`, or explicit `error`;
- all three matching states entered the DOM; and
- the round result was calculated.

An offer with an `error` slot can be content-complete for debugging while its
machine result remains a failure.

## Per-slot schema

Each round contains exactly three slot records with this minimum shape:

```json
{
  "gameSessionId": "local-opaque-id",
  "gameEpoch": 12,
  "round": 1,
  "offerGeneration": 42,
  "slot": 0,
  "slotGeneration": 7,
  "championGeneration": 3,
  "championId": 123,
  "championResolutionStatus": "resolved",
  "observedAugmentIdentity": "bounded-title-or-id",
  "canonicalAugmentId": "augment-id",
  "augmentResolutionStatus": "resolved",
  "dataSource": "fixture-or-production-source",
  "dataVersion": "bounded-version",
  "lookupRequestId": 17,
  "lookupStatus": "success",
  "renderState": "resolved",
  "renderStatus": "resolved-content-rendered",
  "startedAtMs": 42150,
  "terminalAtMs": 42420,
  "failureCategory": null
}
```

Resolution status is `pending`, `resolved`, or `failed`. Lookup status is
`not-started`, `loading`, `success`, `no-data`, or `error`. Render status is
`not-published`, `temporary-content-rendered`,
`resolved-content-rendered`, `fallback-content-rendered`, or
`publication-failed`.

`observedAugmentIdentity` is capped and normalized. It may be a recognized
catalog title or ID; it must not contain an unrestricted OCR transcript.

## Per-round schema

`rounds/round-N.json` contains:

```json
{
  "schemaVersion": "overlay-debug-session/v1",
  "gameSessionId": "local-opaque-id",
  "gameEpoch": 12,
  "round": 1,
  "offerGenerationHistory": [42, 43],
  "acceptedOfferGeneration": 43,
  "startedAtMs": 40000,
  "endedAtMs": 50000,
  "transitionReason": "next-distinct-offer",
  "championId": 123,
  "slots": [],
  "contentCompleteEventId": 212,
  "result": "PASS",
  "failureCategories": []
}
```

`offerGenerationHistory` preserves rerolls within a round. Slot records in the
final round file describe the accepted current generation; prior generation
events remain in `timeline.jsonl` and the replay fixture.

A round file is finalized on a classified next-round transition or confirmed
game end. It is never rewritten as another round.

## Failure categories

Failure categories are bounded, stable strings:

| Stage | Categories |
| --- | --- |
| Game | `game-ownership-failed`, `game-cleanup-failed` |
| Champion | `champion-unavailable`, `champion-mismatch`, `champion-timeout` |
| Offer | `offer-not-detected`, `slot-count-not-three`, `offer-transition-ambiguous` |
| Augment | `augment-unmatched`, `augment-ambiguous`, `augment-timeout` |
| Data | `data-source-unavailable`, `data-source-invalid`, `data-version-mismatch`, `data-row-missing`, `data-lookup-error`, `data-timeout` |
| Render | `render-suppressed`, `dom-publication-missing`, `positioning-failed` |
| Ownership | `stale-result-rejected`, `stale-result-published` |
| Bundle/replay | `bundle-write-failed`, `bundle-incomplete`, `replay-divergence` |

`data-row-missing` may accompany verified `no-data` and does not itself fail a
round. The other data categories map to `FAIL_DATA` or `FAIL_TIMEOUT` as
specified by the product contract.

Human-readable error text is optional, sanitized, and capped at 160
characters. The bounded category is authoritative.

## Replay fixture schema

`replay/replay-fixture.json` is a normalized, deterministic projection of the
timeline rather than a recording of native calls:

```json
{
  "schemaVersion": "overlay-replay/v1",
  "sourceSessionId": "local-opaque-id",
  "initialState": {
    "gameEpoch": 12,
    "dataSources": [
      {"name": "packaged-member-data", "version": "bounded-version"}
    ]
  },
  "actions": [
    {
      "atMs": 0,
      "type": "game-ownership-established",
      "payload": {}
    },
    {
      "atMs": 120,
      "type": "champion-identity-resolved",
      "payload": {"championGeneration": 3, "championId": 123}
    },
    {
      "atMs": 300,
      "type": "offer-generation-created",
      "payload": {"round": 1, "offerGeneration": 42}
    },
    {
      "atMs": 450,
      "type": "data-lookup-response",
      "payload": {
        "round": 1,
        "offerGeneration": 42,
        "slot": 0,
        "outcome": "success",
        "responseDelayMs": 250,
        "content": {"tier": "S"}
      }
    }
  ],
  "expectedPublications": [],
  "expectedRoundResults": [
    {"round": 1, "result": "PASS"}
  ],
  "expectedGameResult": "PASS"
}
```

The action vocabulary must represent:

- champion resolution success and failure;
- four rounds and three ordered slots per offer;
- offer generation ordering and rerolls;
- augment resolution success and failure;
- data success, verified missing data, invalid data, and errors;
- delayed responses and same-offer refresh;
- round clear and transition;
- stale late responses;
- confirmed game end and cleanup.

Replay uses a logical clock and injected in-memory adapters. It makes no League,
LCU, OCR, network, filesystem-data, or live membership call. The same semantic
reducer and card renderer used by the live app consume the replay actions.

`expectedPublications` records state and bounded display values, not pixel
snapshots. Optional visual screenshot tests may supplement it but are not the
deterministic contract.

## Privacy and retention limits

The default bundle must not include:

- account, summoner, or Riot account names;
- tokens, cookies, credentials, headers, or entitlement payloads;
- raw API responses;
- raw OCR images or unrestricted OCR text;
- unrestricted filesystem paths;
- unrelated screen content;
- full process lists, environment variables, or arbitrary logs.

Allowed identities are local opaque session IDs, game epochs, canonical
champion IDs, canonical augment IDs, bounded recognized titles, slot numbers,
versions, statuses, durations, and failure categories.

Optional evidence capture is off by default and requires an owner action for
that session. It is limited to offer-card crops, never a full screen, and is
listed in `session.json`. Structured replay must remain sufficient when those
files are removed.

Bundles live in the application's owner-only data directory. V1 should retain a
small bounded number of completed sessions and expose an explicit export
action. Final retention count and export UI are product-owner choices; neither
may expand bundle contents.

## Bundle completion rules

1. Create an open bundle after game ownership is established, before the first
   offer.
2. Append timeline events in increasing `eventId` order.
3. Persist enough state after every terminal slot transition to survive a
   process exit with a useful partial bundle.
4. Finalize each round once; synthesize a failed partial round if confirmed
   game end occurs mid-round.
5. On confirmed game end, calculate four round results and the game result,
   write the replay fixture, derive `summary.md`, and mark the session complete.
6. Write final structured files through temporary files and atomic replacement
   within the owner-only session directory.
7. Emit `replay-fixture-finalized` before the final session status is written.
8. Repeated non-live polls are no-ops for an already finalized session.
9. If finalization fails, mark the bundle `partial` when possible and record
   `bundle-write-failed`; never discard the earlier timeline.
10. A complete bundle contains exactly four round files. A partial bundle may
    contain fewer and must say why.

Bundle completeness proves that the structured product story is replayable. It
does not certify capture bytes, player perception, or repository provenance.
