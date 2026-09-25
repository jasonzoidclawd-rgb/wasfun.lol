# Phase 0 — A/B settlement (re-run against authoritative offer windows)

## Why this file was re-derived

An earlier `phase0-settlement.md` existed in this gate directory (mtime
`Aug  5 13:14:01 2026`). The operator's `offer-windows.txt` was written
**after** it (mtime `Aug  5 13:34:22 2026`) and carries **wider** windows than
the ones that file used:

| Round | earlier file | authoritative `offer-windows.txt` |
| --- | --- | --- |
| R3 | game `08:43-08:54` | game `08:43-08:55` |
| R4 | game `13:35-13:45` | game `13:35-13:54` |

The extraction below is re-run against the authoritative windows. The
classification is unchanged, but it is now established over the full operator
visibility intervals rather than a truncated subset.

## Sources and baseline

- Worktree HEAD at session start: `812ee4fbf8a1a5a5b2dfa7706ca5042833a8be8d`
  (branch `feat/overlay-tier-card`; working tree carries only the untracked
  `.codex/evidence/` and `.codex/gates/` trees).
- Operator windows: `.codex/evidence/round34-live/offer-windows.txt`.
- Timestamped trace: `.codex/evidence/round34-live/trace.timestamped.jsonl`
  (3616 records, `elapsedMs` span `520`-`1502074`).
- Raw-shape cross-check: `.codex/evidence/round34-live/run-b.log` (10204 lines).

## Video/trace alignment — verified, not assumed

`offer-windows.txt` pins `offset_video_minus_game_s=137`. The two advancing
events in the trace are the alignment anchors, and both match the operator's
video timings exactly:

```
139302 [offer-session] {"roundOwner":1,"offerGeneration":4,"geometrySequence":10,"stale":false,"surfaceClassification":"present","offerState":"OFFER_VISIBLE","geometryAction":"publish","validCardCount":3,...,"newOfferDetected":true,...}
384442 [offer-session] {"roundOwner":2,"offerGeneration":30,"geometrySequence":266,"stale":false,"surfaceClassification":"present","offerState":"OFFER_VISIBLE","geometryAction":"publish","validCardCount":3,...,"newOfferDetected":true,...}
```

R1 game `0:02` = 2 s + 137 = video `139` s vs trace `139302` ms. R2 game
`4:07` = 247 s + 137 = video `384` s vs trace `384442` ms. Trace `elapsedMs`
is therefore video time in milliseconds; windows convert by adding 137 s.

Exactly two `newOfferDetected:true` records exist in the whole trace. Exactly
two `[round-content-complete]` records exist (`round:1` at `141090`, `round:2`
at `385957`), both `result:"FAIL_DATA"` — the expected unauthenticated
fallback (pinned fact 9), not a target of this slice.

## Window arithmetic

- R3 game `08:43-08:55` = `523-535` s → trace elapsed **`660000-672000` ms**.
- R4 game `13:35-13:54` = `815-834` s → trace elapsed **`952000-971000` ms**.

Extraction predicate: every JSONL record whose `elapsedMs` falls inside the
inclusive interval and whose `line` begins with one of `[offer-session]`,
`[offer-state]`, `[geometry-timing]`, `[geometry-watchdog]`, `[game-poll]`,
`[geometry-recovery]`, `[geometry-stale-hide]`. (The trace encodes stale
rejections as fields on `[offer-session]`, not as a separate tag; the tag
inventory of the whole trace confirms there is no standalone
`stale-result-rejected` tag.)

## R3 extraction — complete, `660000-672000` ms

18 records fall in the window: 12 `foreground-poll`, 2 `offer-session`,
2 `geometry-timing`, 2 `geometry-watchdog`. All six requested-type records,
verbatim:

```jsonl
661491 [offer-session] {"roundOwner":null,"offerGeneration":56,"geometrySequence":463,"stale":true,"surfaceClassification":"absent","offerState":"OCCLUDED","geometryAction":null,"validCardCount":0,"blueControlConfidence":0.4,"fingerprintChangeCount":0,"confirmedRerollCount":0,"baselineSettling":false,"newOfferDetected":false,"gameEpoch":0,"foregroundEpoch":1,"timeSinceLastAcceptedOfferMs":276899,"fingerprintHashes":["hd8fcec1d","h0f3ae8bc","hd5c45628"],"failureCategory":"stale-result-rejected","rejectionStage":"geometry-currentness","rejectionReason":"superseded-geometry-sequence"}
661491 [geometry-timing] {"probeSeq":463,"stale":true,"preCaptureMs":318,"captureMs":195,"analysisMs":157,"nativeElapsedMs":10034,"roundTripMs":20896,"timeoutClassification":"none","attemptGeneration":463,"continuousUnhealthyAgeMs":77874,"acceptedGeometryAgeMs":79124}
662213 [offer-session] {"roundOwner":null,"offerGeneration":56,"geometrySequence":464,"stale":true,"surfaceClassification":"absent","offerState":"OCCLUDED","geometryAction":null,"validCardCount":0,"blueControlConfidence":0.39361697,"fingerprintChangeCount":0,"confirmedRerollCount":0,"baselineSettling":false,"newOfferDetected":false,"gameEpoch":0,"foregroundEpoch":1,"timeSinceLastAcceptedOfferMs":277728,"fingerprintHashes":["h9f04162e","h8f6087f1","hf555b11c"],"failureCategory":"stale-result-rejected","rejectionStage":"geometry-currentness","rejectionReason":"superseded-geometry-sequence"}
662213 [geometry-timing] {"probeSeq":464,"stale":true,"preCaptureMs":341,"captureMs":179,"analysisMs":151,"nativeElapsedMs":7622,"roundTripMs":12725,"timeoutClassification":"none","attemptGeneration":464,"continuousUnhealthyAgeMs":78703,"acceptedGeometryAgeMs":79953}
663594 [geometry-watchdog] {"probeSeq":465,"attemptGeneration":465,"scheduledAt":747466,"inFlightSince":745466,"inFlightMs":2000,"schedulerRestartCount":18,"hiddenReason":"probe-timeout","continuousUnhealthyAgeMs":79977,"acceptedGeometryAgeMs":81227,"nativeOutstanding":1,"action":"abandon"}
667621 [geometry-watchdog] {"probeSeq":466,"attemptGeneration":466,"scheduledAt":751467,"inFlightSince":749467,"inFlightMs":2000,"schedulerRestartCount":19,"hiddenReason":"probe-timeout","continuousUnhealthyAgeMs":83978,"acceptedGeometryAgeMs":85228,"nativeOutstanding":2,"action":"abandon"}
```

Widening the window from the earlier `660000-671000` to the authoritative
`660000-672000` added no further requested-type record.

## R4 extraction — complete, `952000-971000` ms

19 records fall in the window; **all 19 are `foreground-poll`**. Zero
`offer-session`, `offer-state`, `geometry-timing`, `geometry-watchdog`,
`game-poll`, `geometry-recovery`, or `geometry-stale-hide` records exist
anywhere inside the interval.

Widening the window from the earlier `952000-962000` to the authoritative
`952000-971000` added nine more `foreground-poll` settlements and no
requested-type record. The process is demonstrably alive and servicing small
native calls throughout R4 while the geometry path emits nothing at all.

## Corroborating boundary: when currentness died

The trace contains 449 `stale:false` `[offer-session]` records. The **first**
is at `133629` and the **last is at `624275`** (`geometrySequence:459`).

- The last current look precedes the R3 window opening (`660000`) by
  **35.7 s**, and precedes the R4 window opening (`952000`) by **327.7 s**.
- No `stale:false` observation exists anywhere in the remaining ~878 s of
  trace after `624275`.
- Emission cadence visibly decays before that: `stale:false` records arrive
  ~1 s apart through `549698`, then stretch to `551893, 555098, 557448,
  559368, 561191, 563317, 567433, 569176, 572312, 574242, 575738, 578280,
  580373, 582279, 588938, 592530, 624275`.

This independently rules out the alternative that a current look happened and
was misread: no current look of any kind existed in either window.

## Settlement

**Classification A — no current geometry observation existed while either real
offer was visible.**

Test of the B condition — "a `stale:false` observation with `validCardCount:0`
inside an offer window" — over the authoritative windows:

- R3: both returned observations are `stale:true`, both rejected at
  `rejectionStage:"geometry-currentness"` with
  `rejectionReason:"superseded-geometry-sequence"`, and their accepted
  geometry is already `79124` ms and `79953` ms old. The only other
  requested-type events are two watchdog `action:"abandon"` records with
  accepted geometry `81227` ms and `85228` ms old.
- R4: no requested-type record exists in the window at all.
- Therefore **B is false in both windows.** The surface classifier never
  received a current frame of a visible R3 or R4 offer; it cannot have
  misread one.

No pivot to the Rust surface classification path (`surface_probe.rs`) is
warranted. Proceed to Phase 1 against the geometry **acquisition** seam.

Note carried into Phase 1: the collapse of *currentness* completes around
`~550-624` s, i.e. **~166-240 s after R2** (`384442`), not immediately at R2.
Fresh `absent` classifications between R2 and `624275` are correct behavior —
no offer was visible in that span. Phase 1 must therefore date the onset from
the latency series, not from R2.
