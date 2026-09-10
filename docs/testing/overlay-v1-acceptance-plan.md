# Overlay V1 Acceptance Plan

Status: release-gate definition
Applies to: one four-round League game and its offline replay

## Testing principle

V1 tests the product-semantic pipeline:

```text
game
→ champion
→ offer
→ three augment identities
→ three champion/augment lookups
→ three explicit render states
→ DOM publication
→ round cleanup
→ game cleanup
```

Geometry presence, OCR execution, and container count remain useful stage
signals. None of them alone proves that a player received useful current
content.

Use fake clocks, injected adapters, and structured semantic events for all
automated timing tests. No automated acceptance test may require League, LCU,
network access, a live membership service, or raw OCR images.

## Unit tests

### Session and ownership reducer

Test the pure V1 state coordinator for:

- game ownership creation and monotonic game epoch;
- one idempotent confirmed game-end transition;
- exactly four ordered round ordinals;
- reroll generations within one round;
- exactly three ordered slots per accepted offer;
- all seven public slot states;
- deterministic state precedence;
- terminal deadline behavior;
- current late-result promotion;
- stale champion, offer, slot, source-version, and game-result rejection;
- previous-round clear before next-round publication;
- deterministic round-result precedence; and
- game `PASS` only from four passing rounds plus successful cleanup.

Every stale-result test must assert both that the result is recorded as
rejected and that the public state is unchanged.

### Champion and augment data validity

Add focused tests around `parseChampionAugmentDataset` and
`selectChampionSlotStat`:

- valid complete dataset plus matching row → `resolved`;
- valid complete dataset plus genuinely missing row → `no-data`;
- advertised non-empty dataset plus zero usable rows → `error`,
  `data-source-invalid`;
- wrong champion → `error`, not `no-data`;
- wrong or missing source version → `error`;
- malformed tier or win-rate values do not establish completeness;
- transient fetch failure is retryable and is not cached as permanent absence;
- a newer valid response can replace a current `no-data` or `error`; and
- an older response cannot replace a newer source version.

The champion-56 null-win-rate shape from the latest game must be a permanent
regression fixture, reduced to the smallest synthetic payload.

### Offer and round lifecycle

Test:

- no offer → stable three-slot offer creates round 1;
- offer close → later stable offer creates the next round without keyboard
  input;
- visible offer replacement classified as reroll keeps the round and increments
  offer generation;
- ambiguous transition records a bounded failure instead of silently choosing;
- a two-card observation cannot complete a round;
- selection by mouse, keyboard, or no explicit input cannot create duplicate
  round ordinals; and
- non-live polls after cleanup do not advance epochs or finalize twice.

### Debug contract

Validate:

- every event conforms to its bounded schema;
- event IDs and logical times are monotonic;
- a round contains exactly three final slot records;
- `round-content-complete` requires three terminal DOM acknowledgements;
- `renderedBadgeCount:3` without semantic acknowledgements does not complete;
- complete bundles contain four round files;
- interrupted sessions remain valid `partial` bundles;
- replay projection is deterministic byte-for-byte for the same event sequence;
- raw API bodies, account/summoner fields, tokens, headers, arbitrary paths,
  unrestricted OCR text, and default images are rejected; and
- repeated finalization is a no-op.

### Native bundle writer

If the Rust writer is added, test:

- writes are restricted to the application-owned debug-session root;
- a caller cannot provide an absolute or parent-traversal path;
- final JSON and Markdown files replace temporary files atomically;
- an interrupted finalization preserves the append-only timeline;
- optional evidence is absent by default; and
- bounded retention never removes an open session.

## Integration tests

Mount the real card renderer with the semantic coordinator and injected
adapters. Avoid source-text assertions for behavior that can be executed.

### Happy four-round pipeline

The harness must:

1. establish one game;
2. resolve one champion;
3. publish four distinct offers;
4. resolve three canonical augments per offer;
5. return champion-specific data for all 12 slots;
6. acknowledge three current DOM cards per round;
7. clear the preceding offer before each next offer;
8. emit four `round-content-complete` events;
9. confirm game end; and
10. leave no cards, current champion, offer, lookup, or open session.

Assert the complete sequence of semantic ownership attributes in the DOM, not
only text or node count.

### Fixture and production adapter parity

Run the same adapter contract tests against:

- the member-authorized packaged production adapter;
- the development fixture adapter; and
- the in-memory replay adapter.

They may return different content, but they must agree on status meanings,
version ownership, valid absence, malformed-source behavior, and stale-result
rules. Production-build tests must continue proving that development fixture
code and authorization are stripped.

### Geometry publication boundary

Inject geometry outcomes without native capture:

- three fresh current rectangles publish the semantic cards;
- fewer than three do not complete;
- stale accepted geometry cannot publish into a later generation;
- a prior `renderedBadgeCount:3` does not survive loss of current authority;
- a delayed native result cannot overwrite a newer accepted frame; and
- logical timeout plus eventual native completion leaves bounded outstanding
  work and permits later rounds to recover.

The final case is the red characterization for the latest rounds 3–4 failure.
Only after it reproduces should capture scheduling change.

## Deterministic replay tests

The canonical `overlay-replay/v1` suite contains:

1. `four-round-success`: 12 successful lookups, four clears, one game cleanup.
2. `delayed-same-offer-refresh`: loading/fallback first, then current resolved
   content under the same offer generation.
3. `verified-missing-data`: valid complete source with one absent row; visible
   `no-data` and a passing round.
4. `invalid-empty-dataset`: advertised rows parse to zero usable rows; visible
   error and `FAIL_DATA`, never verified `no-data`.
5. `lookup-error`: bounded error response and deterministic failure.
6. `augment-identity-failure`: one unresolved canonical identity and
   `FAIL_IDENTITY`.
7. `temporary-state-timeout`: a request never responds; visible terminal
   fallback and `FAIL_TIMEOUT`.
8. `stale-late-response`: a prior offer result arrives during a later offer;
   no DOM change and stale rejection recorded.
9. `round-transition-clear`: every old card disappears before new ownership is
   published.
10. `game-end-cleanup`: confirmed end clears once; repeated non-live events are
    no-ops.
11. `partial-session`: process exit after round 2 produces a useful partial
    bundle and deterministic partial replay.
12. `geometry-recovery`: delayed native observations do not prevent rounds 3
    and 4 from receiving current positions.

For every fixture, assert:

- state sequence by logical time;
- current ownership keys;
- visible bounded text/state;
- DOM publication acknowledgements;
- round result;
- event taxonomy;
- bundle projection; and
- final cleanup.

The replay output must be identical without League, LCU, OCR, network, a live
membership service, or external fixture files.

## Same-offer delayed-data refresh test

This is a release-blocking integration test:

1. Establish a game, champion ID `123`, round 1, offer generation `42`, and
   three canonical augments.
2. Return data immediately for slots 0 and 1.
3. Keep slot 2 pending long enough for `loading-data` to enter the DOM.
4. Optionally pass the terminal deadline and show an explicit `error`; record
   the timeout.
5. Deliver a valid current slot-2 result with the same champion, offer, slot,
   source, and version ownership.
6. Assert that slot 2 becomes `resolved` without changing round or offer
   generation.
7. Assert exactly one new DOM publication acknowledgement for slot 2.
8. Assert the other two cards never regress or change ownership.

Repeat with a delayed response from offer generation `41`; it must be rejected
and must not alter generation `42`.

## Game-end cleanup test

This is a release-blocking integration test:

1. Drive four complete rounds in one session.
2. Send a temporary Live Client Data failure while gameflow remains confirmed
   live; assert all current game state is preserved.
3. Send one confirmed non-live gameflow event.
4. Assert cards, champion identity, round, offer, slot lookups, cached
   publication authority, and active session state are cleared.
5. Assert one `game-ended`, one replay finalization, four final round files, and
   one final session status.
6. Send at least ten more confirmed non-live poll events.
7. Assert no additional epoch advance, cleanup, bundle write, or game-end
   event.
8. Start a new confirmed live game and assert it cannot access any prior
   session content.

## Negative test matrix

| Condition | Expected visible state | Round result | Required diagnostic |
| --- | --- | --- | --- |
| No stable offer | No cards; bounded offer wait outside a current round | not final | `offer-detected` with count |
| Only two slots observed | No completed three-card publication | `FAIL_IDENTITY` at round bound | `slot-count-not-three` |
| Champion unresolved | Three bounded `resolving-champion` cards, then error | `FAIL_IDENTITY` or `FAIL_TIMEOUT` | champion requested/failed |
| One augment unmatched | That card resolves to explicit error | `FAIL_IDENTITY` | augment resolution failed |
| Valid source has no row | `no-data` with augment identity | may `PASS` | lookup no-data plus completeness |
| Source advertises rows but parses zero | source-error fallback | `FAIL_DATA` | `data-source-invalid` |
| Lookup network/source error | data-error fallback | `FAIL_DATA` | lookup failed |
| Lookup never returns | loading, then timeout fallback | `FAIL_TIMEOUT` | state change plus timeout |
| Current result arrives late | Same card refreshes in place | based on final content | new lookup/publication event |
| Old offer result arrives late | No visible change | `PASS` if nothing stale published | stale result rejected |
| Old champion result arrives late | No visible change | `PASS` if nothing stale published | stale result rejected |
| Old frame arrives in later round | No old cards published | `FAIL_STALE_STATE` if published | stale frame rejected/published |
| DOM has three empty containers | Explicit failure, never completion | `FAIL_RENDER` | missing semantic publication |
| Gate hides current terminal content | No cards | `FAIL_RENDER` | `render-suppressed` |
| Temporary live-data read fails | Preserve current state | unchanged | bounded preserve reason |
| Confirmed game ends | No cards or game state | game based on four rounds | one game-ended and cleanup |
| Process exits mid-game | No claim of complete bundle | partial | `bundle-incomplete` |

## Four-round manual checklist

Before launching League:

- [ ] Record the release build ID and confirm the running overlay uses it.
- [ ] Confirm member or explicitly authorized development-fixture mode.
- [ ] Confirm structured debug capture is enabled and optional images are off
      unless the owner intentionally enables them.
- [ ] Confirm no previous session is open.

For each round 1 through 4:

- [ ] One current offer is detected.
- [ ] Exactly three ordered slots are recorded.
- [ ] Three cards are correctly aligned with the current offer.
- [ ] The current champion ID is resolved.
- [ ] All three canonical augment IDs are correct.
- [ ] Every card leaves its temporary state within the deadline.
- [ ] Every card shows champion-specific content or verified `no-data`.
- [ ] No card contains another slot, offer, round, champion, or game result.
- [ ] A delayed current response, if observed, refreshes in place.
- [ ] One `round-content-complete` event contains three matching DOM
      publications.
- [ ] The round result is `PASS`.
- [ ] The cards clear before the next round is published.

After round 4:

- [ ] Confirmed game end removes all cards.
- [ ] The session finalizes once.
- [ ] `session.json` reports four rounds and game `PASS`.
- [ ] Four round files and one replay fixture exist.
- [ ] The bundle contains none of the forbidden privacy fields.
- [ ] Offline replay produces the same semantic card-state sequence and four
      `PASS` round results.

Any unchecked round item fails the manual game. Do not play another game until
the captured bundle has been replayed and the failing stage is identified
offline.

## Exact release gate

Release only when all gates pass in order:

### Gate 1 — Focused behavior

- all new coordinator, data-validity, bundle, replay, publication, delayed
  refresh, geometry recovery, and cleanup tests pass;
- the reduced champion-56 invalid-data regression passes; and
- the current rounds 3–4 hidden-layer reproduction is red before the fix and
  green after it.

### Gate 2 — Deterministic replay

- all canonical fixtures above pass;
- `four-round-success` produces exactly 12 current slot publications and four
  `round-content-complete` events;
- a fixture generated twice from the same events is identical; and
- replay runs with all live adapters disabled.

### Gate 3 — Repository verification

Run the repository floor:

```bash
npm test
npx eslint src scripts
npm run build
(cd overlay && npm run build)
```

If Rust changes, also run the release build required by `CLAUDE.md` and report
the resulting binary timestamp. Report every skipped or blocked gate.

### Gate 4 — Production boundaries

- the production overlay build contains no development fixture authorization
  or live ARAMGG loader;
- member entitlement behavior is unchanged;
- no member/internal data is added to a public static surface;
- debug output is owner-only and privacy tests pass; and
- optional images remain off by default.

### Gate 5 — One real game and its replay

- one release build completes rounds 1–4 with four `PASS` results;
- confirmed game cleanup succeeds;
- the required bundle finalizes;
- that exact bundle replays offline;
- replay semantic publications and results match the recorded live sequence;
  and
- the game result is `PASS`.

This one passing game is the V1 product release gate. Experimental trace,
focus, inode, repository-drift, and video-certification tools may provide
supporting evidence but cannot block release unless they expose a direct
product-contract violation.

## What logs can and cannot prove

Structured semantic logs can prove that the application:

- established a bounded game/round/offer owner;
- resolved a champion or augment ID;
- validated a source and classified a lookup response;
- transitioned each slot through explicit states;
- rejected a stale result;
- received a DOM acknowledgement carrying matching semantic ownership;
- calculated a round result;
- finalized a replay fixture; and
- invoked idempotent cleanup.

Logs cannot by themselves prove:

- that a person saw or understood the cards;
- that cards were visually aligned on the player's exact display;
- that an upstream statistical claim is substantively correct beyond the
  recorded source/version and validation rules;
- that a bare DOM node painted on screen;
- that a recorded frame matches source bytes;
- that all operating-system focus or capture races were impossible; or
- that `renderedBadgeCount:3` contained useful champion-specific content.

Manual alignment and visibility remain part of Gate 5. Product-semantic logs
and offline replay make failures actionable; they are not formal forensic
certification.
