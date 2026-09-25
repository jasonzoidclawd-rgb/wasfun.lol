# Live validation protocol

## Roles

- The human starts the correct game and performs every in-game action.
- Codex verifies process identity, records the display, monitors the trace,
  extracts evidence frames, and reports.
- The human owns all League client and game interaction. Never use Computer Use
  or another automation tool on `LeagueClientUx`, `LeagueOfLegends.app`, or the
  game.

## Preflight

1. Enable Do Not Disturb. Close, hide, or move every unrelated or
   credentials-adjacent window off the recorded display. Prepare a blank,
   non-sensitive window or desktop for the focus-out checkpoint. This is a
   blocking step: pass `--privacy-acknowledged` only after the operator has
   explicitly confirmed it.
2. Confirm the intended repository, branch, HEAD, and dirty state.
3. Confirm the dev overlay PID and cwd.
4. Confirm `MAYHEM_TELEMETRY_ENDPOINT` and `MAYHEM_DEVICE_TOKEN` are absent —
   verified automatically by inspecting the environment of the exact pinned
   overlay process itself (`credential_environment_check`, `preflight.py`),
   never the trace holder or the launching shell. A same-worktree overlay
   launched from a credentialed shell can pass every process-group check and
   still upload data externally, so process-group ownership is never treated
   as a substitute for this. Only the two variable *names* are ever checked —
   values are never read, printed, logged, or persisted anywhere, including in
   this validation's own manifests and error text. This runs during preflight,
   again at recorder startup once the overlay PID is pinned, and once more
   before the final manifest completes; any failure to inspect the process
   (missing tool, exited process, a PID that no longer identifies the pinned
   overlay) fails closed rather than reporting "clean".
5. Confirm the trace is fresh and grows after the current overlay starts.
6. Confirm the selected AVFoundation device index is listed as a screen, not a
   camera. Preflight fails closed on a missing required tool (`ffmpeg`,
   `ffprobe`, `git`, `lsof`, `python3`), unusable `/bin/ps`, or absent screen
   device. `optionalTools` (`jq`, `rg`, `screencapture`) are reported only.
7. Start recording, then verify that FFmpeg remains alive for at least two
   seconds. A permission error, empty stream, or mostly-black recording is a
   stop condition.

## Mode verification

Do not infer the mode from an ARAM icon, map, prior lobby, or gameflow alone.
Before the game starts, require a visible label identifying the
augment-enabled **ARAM: Mayhem** variant. If the label is absent or ambiguous,
the human must correct the mode.

## Checkpoint matrix

| Checkpoint | Human action | Required evidence |
| --- | --- | --- |
| Idle | Stay outside a game | `captureAllowed:false`; no badges |
| Lobby/select | Enter lobby and champion select | Non-live phases; no capture |
| First offer | Open the first augment offer | Three visible cards, geometry accepted, and an affirmative `[badge-layer]` record (`badgeLayerVisible:true`, `renderedBadgeCount>=1`) |
| Hover | Hover each card for about five seconds | Stable generation; no SCANNING flicker |
| Reroll | Reroll exactly once | One generation increment; changed slots invalidated once |
| Select | Select an augment | Offer clears promptly; no stale badges over gameplay |
| Focus out | While an offer whose badges were certified visible is up, switch to the prepared blank target for at least five seconds | A `[focus-transition]` record for that offer generation (primary — emitted synchronously before OCR/geometry sampling stops), or explicit `foreground:false`, or at least two timestamped native not-foreground classifications spanning three seconds; overlay hidden |
| Focus in | Return to the game with the *same* offer still up | Capture resumes without remount; correct surface restored; a fresh affirmative `[badge-layer]` record for the same offer generation |
| Later offers | Repeat hover/reroll/select on later rounds | New generations commit; no stale carry-over |
| Occlusion | Open an ordinary in-game modal if safe | OCCLUDED hides badges; state recovers |
| End | End or leave the custom game | Capture disabled and visible state cleared |

Do not force a checkpoint if it would interfere with normal play or create a
penalty risk. Mark it `not observed`.

## Automatically enforced trace invariants

- Live-game activation is proved only by `[game-poll]` records: either a
  confirmed `gameflowPhase:"inProgress"` sample, or the one development-only
  `action:"live-active"` ownership record the healthy path emits per live span.
  Offer-session, offer-state, render, geometry, identity, and publication
  records never prove a live game on their own.
- A `live-active` record counts only with its complete authority tuple —
  `gameflowConfirmed:true`, `captureAllowed:true`, `liveDataStatus:"ready"`,
  and `gameflowPhase:"inProgress"`. An incomplete one is an analyzer error, not
  weak evidence.
- Game termination (`ended`) still requires a later confirmed non-live phase.
- An unconfirmed `gameflowPhase:"unavailable"` record never changes lifecycle
  state; it preserves the last confirmed live state.
- A confirmed non-live gameflow phase never has `captureAllowed:true`.
- Visible badges are proved only by the final `[badge-layer]` diagnostic:
  `badgeLayerVisible:true`, `reason:"badge-layer-visible"`,
  `authorizationSource` in `{member, fixture}`, `renderedBadgeCount>=1`, and an
  `offerGeneration` that is a non-boolean integer strictly greater than zero
  (generation zero is the pre-offer `NO_OFFER` state), inside the evaluated
  live epoch. An
  intermediate `[offer-session].render:true` is context, never certification,
  and an incomplete or malformed diagnostic is counted and discarded.
- `render:true` never occurs while `foreground:false`.
- An occluded offer never renders.
- Every `newOfferDetected:true` advances the offer generation. Both
  `offerGenerationBefore` and `offerGenerationAfter` must be real non-boolean
  integers — `bool` subclasses `int` in Python, so `false → true` would
  otherwise read as `0 → 1` — and the value after must be strictly greater and
  strictly positive. Zero is legal only as the pre-offer source state. A pair
  that is malformed, equal, or decreasing is an analyzer error: it certifies no
  new offer and never enters `newOfferGenerations`.
- A generation is not announced as new more than once.
- A new offer invalidates at least one slot exactly once.
- Late or stale results never restore an older generation.
- Visible-offer authority is CURRENT, not historical. It ends on `OCCLUDED`,
  `NO_OFFER`, any `[badge-layer]` rejection (authorization denied, preview mode,
  rejected visible frame or offer surface, unhealthy scheduler, zero painted
  badges), a malformed diagnostic, a confirmed game end, or a new epoch. Once it
  ends, later focus samples cannot borrow the generation it named.
- Focus-loss coverage requires a badge generation certified visible *at that
  moment* in the open epoch, plus any one of: a `[focus-transition]` record
  for that same generation (the primary signal — emitted synchronously before
  OCR/geometry sampling stops, so a compliant alt-tab commonly produces no
  other evidence at all), an explicit `foreground:false` offer-session record,
  or at least two timestamped native not-foreground classifications spanning
  three seconds — all attributed to that same generation. A single timeout is
  diagnostic evidence only. Native not-foreground evidence alone, with no
  currently visible badge, never qualifies, and neither does a
  `[focus-transition]` for a different generation or a different game epoch.
- A native not-foreground run takes its authority from its FIRST sample and
  never re-reads it, so a run started while the badges were hidden cannot be
  retroactively validated by a later render of the same generation.
- Repeated loss samples for one generation keep the earliest timestamp and emit
  one logical loss event; no badge visibility is certified while focus is lost.
- Focus recovery requires the same epoch, the same offer generation, a recorded
  dwell of at least three seconds, foreground recovery, and a fresh affirmative
  `[badge-layer]` record afterwards. A new offer generation is a new offer, not
  a recovery. A new epoch or a confirmed game end clears pending focus state.
- Missing foreground data is unknown; it never counts as focus loss. Rendering
  without boolean foreground authority is an analyzer failure.
- Missing required coverage returns a nonzero exit status.
- Trace reopen/truncation markers are surfaced in the analysis and report.
- The recorder's frozen capture boundary must be complete (device, inode, size,
  content checkpoint) and provably continuous. Missing, rotated, truncated,
  discontinuous, or unverifiable boundaries set `manifest.status:
  recording-failed`; reads never cross the boundary, and a record left
  incomplete at it fails the session rather than being completed by bytes
  written afterwards.
- Before that boundary is frozen, the trace source is opened exactly once —
  pinned by device and inode on first open — and the session fails closed
  immediately (`sourceReplaced`/`sourceReplacedReason`, never a reopen) on any
  later identity change, size regression, content mismatch, disappearance, or
  holder-process-group change. Records observed before a replacement and any
  bytes read from the replacement are never combined into one session's
  evidence.

## Evidence reviewed manually

- Capture timeouts or busy results do not form an increasing retry fan-out.
- Focus recovery occurs without restarting or remounting the overlay.
- Hover does not create visible SCANNING flicker.
- The unauthenticated member warning may remain, but it does not prevent local
  dev geometry, OCR, SCANNING, badges, calibration, or trace output.

## Visual checks

Use extracted frames, not memory, to verify:

- three badges correspond to the three cards;
- badge positions stay outside card/reroll control regions;
- labels are readable and not clipped;
- hover does not cause flicker or generation churn;
- a selected/dismissed offer leaves no combat overlay;
- no overlay leaks onto another application during focus loss.

Before a frame is copied, attached, or cited outside its owner-only session
directory, inspect the entire image for credentials, terminal content,
notifications, user/host identifiers, paths, tokens, keys, and unrelated
applications. Do not disclose a frame that contains any such content.

## Stop conditions

Stop and report rather than improvising when:

- the repository, overlay PID/cwd, game PID, or display cannot be verified;
- screen recording permission is denied or the capture is black;
- the intended Mayhem mode is not visibly confirmed;
- the trace path is stale or belongs to another overlay process;
- reliable observation would require targeting the frontmost window;
- continuing would require gameplay automation or hidden-information access.
