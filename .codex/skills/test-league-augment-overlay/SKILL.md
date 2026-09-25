---
name: test-league-augment-overlay
description: Run evidence-backed, human-controlled live validation of the Mayhem Oracle League augment overlay in this repository. Use for ARAM Mayhem custom-game checks, unauthenticated development-overlay checks, geometry/OCR/tier-badge validation, reroll and hover stability, focus recovery, repeated offer rounds, or synchronized screen-recording and trace review.
---

# Test League Augment Overlay

Validate the local overlay without automating League gameplay. Correlate
repository and process identity, a display recording, the overlay trace, and
human-executed checkpoints.

## Hard boundaries

- Keep all champion movement, abilities, purchases, selections, rerolls, and
  anti-AFK activity human-controlled.
- Never inject into League, read hidden game information, or synthesize input.
- Never use Computer Use or another automation tool to operate League menus,
  champion select, or the game. It can invoke the game incorrectly or select an
  unintended mode. The human owns the entire League interaction.
- Never target whichever window is frontmost.
- Do not edit runtime code, Git state, or PRs during a validation-only run.
- Do not record audio. Warn the user that display recording may include
  notifications or other visible applications.
- Treat every recording and extracted frame as private. Before recording, the
  operator must close, hide, or move every credentials-adjacent or unrelated
  window off the recorded display, enable Do Not Disturb, prepare a blank
  non-sensitive focus-out target, and explicitly acknowledge that check.

## Working directory

Run the **whole** workflow from the repository root. Every path in this skill —
the scripts under `.codex/skills/`, `overlay/`, the trace, preflight, the
recorder, the analyzer, and the extractor — resolves from that root, and
`--repo` must name the root, not the overlay package. Preflight looks for
`$REPO/overlay/package.json`; run from `overlay/` it would look for
`overlay/overlay/package.json`, reject the repository, and stop the workflow
before recording.

```bash
REPO="/Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card"
cd "$REPO"
```

Substitute the checkout you are validating. Only the overlay **launch** is
scoped to `overlay/`, and it is scoped in a way that leaves the workflow
shell's `$PWD` at the root. Confirm the documented sequence before a session:

```bash
bash .codex/skills/test-league-augment-overlay/scripts/verify_workflow_cwd.sh
```

## Prepare

1. Read `CLAUDE.md`, `AGENTS.md`,
   `docs/handoffs/overlay-current-state.md`, and
   `.codex/skills/test-league-augment-overlay/references/validation-protocol.md`.
2. Run `git status --short --branch` and preserve all existing changes.
3. Start the current dev overlay with this **one canonical command** — do not
   substitute any other form. `--prefix overlay` scopes the launch to the
   overlay package without a `cd`, so the workflow shell's `$PWD` never leaves
   the repository root, before or after:

   ```bash
   env -u MAYHEM_TELEMETRY_ENDPOINT -u MAYHEM_DEVICE_TOKEN \
     MAYHEM_OVERLAY_TRACE=1 \
     MAYHEM_OVERLAY_TIER_FIXTURE=1 \
     npm --prefix overlay run tauri -- dev 2>&1 \
     | /usr/bin/tee "/tmp/mayhem-overlay-$(date +%Y%m%d-%H%M%S).log"
   ```

   Every clause is required and none may be dropped or abbreviated:
   `env -u MAYHEM_TELEMETRY_ENDPOINT -u MAYHEM_DEVICE_TOKEN` strips both
   credential variables even if the launching shell has them set, so the
   overlay cannot upload data or authenticate as a member during this run;
   `MAYHEM_OVERLAY_TRACE=1` is what makes the recorder's trace exist at all;
   `MAYHEM_OVERLAY_TIER_FIXTURE=1` is required for local badges to render
   without a member entitlement. Swap the fixture flag out only under a
   separately documented genuine-member-validation protocol — never drop it
   silently. Record the exact timestamped `/tmp/mayhem-overlay-*.log` path
   `tee` prints: it is the trace path every later command needs. Do not print,
   log, or otherwise inspect the value of either stripped credential variable
   while doing so.

4. Record the exact trace path. Verify the overlay PID and cwd — still from the
   repository root:

   ```bash
   python3 .codex/skills/test-league-augment-overlay/scripts/preflight.py \
     --repo "$REPO" --require-overlay
   ```

   If multiple overlays are listed, choose only the PID whose cwd is inside this
   repository's `overlay/` directory, then rerun preflight with
   `--overlay-pid VERIFIED_PID`. Do not select by recency or frontmost window.

   Preflight requires only what the workflow actually runs: `ffmpeg`, `ffprobe`,
   `git`, `lsof`, `python3`, an executable `/bin/ps`, and at least one verified
   AVFoundation screen device. `jq`, `rg`, and `screencapture` are reported under
   `optionalTools` for operator convenience and never fail preflight; missing
   required tools, process inspection, or capture support still fail closed.

Do not reuse a stale overlay merely because a window is visible. Confirm its
PID, cwd, repository HEAD, and trace path.

Run the skill's unit tests before a live session:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s .codex/skills/test-league-augment-overlay/scripts -p 'test_*.py' -v
```

## Record

Start the observer before the human starts the correct custom game:

```bash
python3 .codex/skills/test-league-augment-overlay/scripts/record_session.py \
  --repo "$REPO" \
  --trace /tmp/the-exact-overlay.log \
  --overlay-pid EXACT_PREFLIGHT_PID \
  --display-index VERIFIED_SCREEN_INDEX_FROM_PREFLIGHT \
  --privacy-acknowledged
```

Take the display index from the preflight command's `capture devices` output;
never assume index `0`.

Run it in a persistent PTY and stop it with `Ctrl-C` after the planned
checkpoints. Press `Ctrl-C` once; shutdown ignores further interrupts while
FFmpeg finalizes. The recorder:

- verifies the selected AVFoundation device is a screen, then captures it
  without audio so the transparent overlay is included;
- pins one overlay PID/cwd/process group and rejects a stale or unrelated trace;
- follows trace replacement/truncation and adds video-aligned timestamps;
- on stop, stamps the capture boundary *before* any encoder wait, freezes the
  trace's byte boundary, drains every record through exactly that boundary, and
  only then waits for FFmpeg to finalize — so container finalization is never
  charged to trace silence and the final records are never lost;
- treats the frozen boundary as an identity, not a byte count: device, inode,
  size, **and** a SHA-256 checkpoint over the last 4 KiB. A missing trace, a
  failed `stat`, an unreadable trace, or any missing field is not an empty
  completed drain — it invalidates the recording (`boundaryMissing`). Inode
  replacement (`boundaryRotated`), a shrinking file (`boundaryTruncated`), and a
  same-inode copy-truncate that re-grew past the reader (`boundaryDiscontinuous`,
  caught by the checkpoint alone) each fail closed, and the drain never reopens
  or continues across the boundary. `drainCompleted` is true only after one
  verified continuous source has been consumed exactly through the boundary;
- reads only bounded binary chunks once the boundary exists, capped at
  `boundary_size - position`, and keeps only complete newline-terminated records
  wholly inside it. An unbounded text `readline()` would let bytes appended
  *after* capture stop complete a torn record and enter the evidence; instead a
  record left incomplete at the boundary (`partialFinalLine`, including a split
  UTF-8 sequence) or an undecodable record (`undecodableRecord`) fails the
  session. Post-boundary bytes — a late `endOfGame` above all — stay unread, so
  the final hash, record count, and lifecycle coverage describe exactly the
  capture interval. Any of these outcomes sets `manifest.status:
  recording-failed`;
- saves process/repository provenance in `manifest.json`;
- after finalization, records artifact identity in `manifest.artifacts`
  (schema, resolved video/trace paths, SHA-256, byte sizes, final record count,
  `captureStopElapsedMs`, `finalizationCompletedElapsedMs`). This block is the
  root of trust for everything downstream;
- checks free space and writability against the nearest existing ancestor of a
  nested `--output`, then creates every missing level owner-only, so a rejected
  session leaves no partial evidence directory behind;
- stores artifacts with owner-only permissions, rejects empty or mostly-black
  video, and stops after one hour by default;
- never sends input to League.

If recording fails with a permission error, stop. Ask the user to enable the
host application under **System Settings → Privacy & Security → Screen
Recording & System Audio**, then restart that application if macOS requests it.
Do not continue with a black or unverified recording.

## Run human checkpoints

The human must visibly confirm **ARAM: Mayhem**, not standard ARAM, before
starting. Do not click or type in League. Ask the human to perform the
checkpoints in
`.codex/skills/test-league-augment-overlay/references/validation-protocol.md`;
observe and timestamp outcomes without clicking the game.

Keep the game foregrounded except during the deliberate focus-out/focus-in
checkpoint. Report phase changes and anomalies as they occur. Do not claim a
visual result from trace data alone.

During focus-out, keep the prepared blank target visible for at least five
seconds while an augment offer is visible, then return to the *same* offer:
the analyzer correlates loss and recovery by offer generation, so an offer
that rerolls or resolves while focus is out ends the checkpoint rather than
completing it. Confirm the loss from the runtime's own trace, not the wall
clock: the moment focus is lost the runtime emits a `[focus-transition]`
record synchronously and immediately stops OCR/geometry sampling, so a fully
compliant alt-tab commonly leaves no other evidence behind. The checkpoint is
satisfied by **any one** of, in the order a compliant run actually produces
them:

1. **`[focus-transition]` for the currently visible positive offer
   generation** — the primary, authoritative signal. It is emitted before OCR
   and geometry sampling stop, so do not keep waiting for either once it has
   appeared for the right generation.
2. An explicit `foreground:false` offer-session record, where still
   available.
3. At least two timestamped native not-foreground classifications spanning
   three seconds, where still available.

The documented alt-tab sequence is: valid visible badge generation N →
`[focus-transition]` loss for generation N → badge authority cleared → the
user remains away from the game for at least five seconds → foreground
restored → final visible badge generation N. None of the following qualifies
as focus-loss evidence: a malformed, zero, boolean, or otherwise-typed
generation; a `[focus-transition]` for a different generation or a different
game epoch; generic occlusion; an authorization denial; a preview; missing
positions; a scheduler failure; or a geometry failure unrelated to focus.

## Analyze

After stopping the recorder, still from the repository root. `SESSION_DIR` is
the absolute session path the recorder printed, not a path relative to it:

```bash
python3 .codex/skills/test-league-augment-overlay/scripts/analyze_trace.py \
  SESSION_DIR/trace.timestamped.jsonl \
  --require in_progress,rendered,new_offer,focus_loss,focus_recovery,ended \
  --manifest SESSION_DIR/manifest.json \
  --output SESSION_DIR/analysis.json

python3 .codex/skills/test-league-augment-overlay/scripts/extract_event_frames.py \
  --video SESSION_DIR/screen.mp4 \
  --analysis SESSION_DIR/analysis.json \
  --manifest SESSION_DIR/manifest.json \
  --output SESSION_DIR/frames
```

`--require` takes one comma-separated list; repeating the flag keeps only the
last value. `--manifest` is what makes the analysis citable evidence: it
verifies the trace still matches the bytes the recorder hashed, inherits the
video identity from `manifest.artifacts`, and records the analyzer schema, the
resolved source path, its SHA-256 and byte size, and the manifest SHA-256 into
`analysis.json`. Any mismatch is an error and the analysis fails — the analyzer
never replaces the recorder's identity with a freshly computed one. The
extractor then re-verifies the whole chain (manifest → analysis → trace →
video) before writing a single PNG and fails closed with exit status 2 when
provenance is missing, incomplete, stale, or mismatched. An analysis produced
without `--manifest` carries no inherited identity and cannot drive extraction.

Coverage is scoped to **one live-game epoch**. A confirmed `[game-poll]`
activation opens an epoch; a confirmed non-live phase closes it; unconfirmed
records neither open, advance, nor close one, and a transient unconfirmed
`unavailable` preserves the epoch across the outage. Requirements are answered
by the latest live epoch — the most recent completed game, or the still-open
one if the trace ends mid-game — and are **never** combined across games. Offer,
render, and focus evidence observed outside that epoch (fixture, preview,
replay, pre-game, or post-end noise) is dropped from `notableEvents` with a
warning and can never certify a live overlay. `analysis.json` reports
`evaluatedGameEpoch` and per-epoch coverage under `gameEpochs`; multiple games
in one recording yield independent per-epoch results.

Live-game coverage comes only from `[game-poll]` records. A healthy session's
poll returns early on success, so the runtime emits one development-only
`action: "live-active"` record per live-ownership span — the authoritative proof
that a real game activated. The analyzer trusts it only with its complete
authority tuple (`gameflowConfirmed: true`, `captureAllowed: true`,
`liveDataStatus: "ready"`, `gameflowPhase: "inProgress"`) and errors on any
incomplete one. `ended` still requires a later confirmed non-live phase. Offer,
render, geometry, and publication traffic never prove a live game: they are
downstream of the overlay's own belief and reproducible from fixtures, replays,
lobby, or pre-game noise. `analysis.json` reports the attribution under
`liveActivation`.

`rendered` is certified only by `[badge-layer]`, the development-only diagnostic
the overlay emits at its **final** badge-layer decision — the same gate object
that decides `showBadgeLayer`, so the two cannot diverge. It carries bounded
booleans, two closed enums, and three counters only: `badgeLayerVisible`,
`reason` (`badge-layer-visible` / `authorization-denied` / `preview-mode` /
`visible-frame-rejected` / `offer-surface-rejected` / `scheduler-unhealthy` /
`no-visible-badges`), `authorizationSource` (`none` / `member` / `fixture`),
`previewMode`, `visibleFrame`, `offerSurface`, `schedulerHealthy`,
`offerGeneration`, `renderedBadgeCount`, `previewBadgeCount` — no augment names,
OCR text, geometry, paths, tokens, or account identifiers, and nothing of it
survives into a production bundle. Coverage requires
`badgeLayerVisible: true` **and** `reason: badge-layer-visible` **and**
`authorizationSource` in `{member, fixture}` **and** `renderedBadgeCount >= 1`
**and** an `offerGeneration` that is a non-boolean integer strictly greater than
zero — generation zero is the pre-offer `NO_OFFER` state and `bool` subclasses
`int`, so neither may certify an offer — inside the evaluated live epoch.
The same rule governs new-offer advancement: `offerGenerationBefore` and
`offerGenerationAfter` must both be real non-boolean integers, strictly
increasing, with a positive value after, so a malformed `false → true` pair
never reads as `0 → 1` and never satisfies `new_offer`.
`[offer-session].render`, `offer-state.renderDecision`, geometry, and
publication records are still reported as context, but an intermediate
`render:true` no longer proves a badge was on screen; a plain development launch
with no fixture flag and no membership never qualifies. `analysis.json` reports
`badgeLayer.visibleRecords`, `badgeLayer.malformedRecords`, and a
`badgeLayer.rejectionReasons` histogram.

Visible-offer authority describes a badge layer that is on screen **right now**,
never one that was on screen earlier. It ends the moment final visibility does:
an `OCCLUDED` or `NO_OFFER` surface, any `[badge-layer]` rejection (authorization
denied, preview mode, rejected visible frame or offer surface, unhealthy
scheduler, zero painted badges), a malformed diagnostic, a confirmed game end,
or a new epoch. Without it, a modal that hid the badges before the operator
alt-tabbed would still let a later re-render of the same generation satisfy both
focus checkpoints.

Focus checkpoints are bound to that live authority. `focus_loss` requires an open
live epoch, an offer whose badges are *currently* certified visible, and one of:
a `[focus-transition]` record for that generation (the primary signal — emitted
synchronously the moment focus is lost, before OCR/geometry sampling stops),
explicit foreground loss, or a qualified native-loss run, attributed to that
generation; repeated loss samples keep the earliest timestamp and emit one
logical event, and
no badge visibility is credited while focus is lost. Native records carry no
offer identity, so a native run's authority is fixed at its **first** sample: a
run that begins while the badges are hidden can never be converted into a loss by
a later re-render, and an affirmative `[badge-layer]` record — which requires a
renderable visible frame, and therefore foreground — retires any run in flight.
`focus_recovery` requires the same epoch, the **same** offer generation, at least
3000 ms of qualified loss, foreground recovery, and a fresh affirmative
`[badge-layer]` record afterwards. A new offer generation is a new offer, not a
recovery. Pending focus state is cleared on a new epoch and on a confirmed game
end, so combat, `NO_OFFER`, preview, unauthorized hidden badges, pre-game, and
post-end traffic can satisfy neither checkpoint. `analysis.json` reports the
certified generations under `focusEvidence.visibleBadgeGenerations` and per
epoch under `gameEpochs[].visibleBadgeGenerations`.

Treat `status: partial` as incomplete coverage, not success. Inspect extracted
frames for every claimed visual result. A clean trace cannot prove that badges
were readable, correctly positioned, or attached to the intended cards.
For a partial or failed analysis, the extractor writes owner-only diagnostic
frames to `frames-partial` or `frames-fail`, labels them non-passing, and exits
nonzero. They can support diagnosis but never a pass claim.
Treat `frames`, `frames-partial`, and `frames-fail` as one evidence family.
Extraction fails if a non-empty sibling exists; an empty sibling is retained
and ignored with a warning. Never delete it automatically. Each output contains
`extraction-metadata.json`, which binds the frames to the verified chain: the
extraction/recorder/analyzer schemas, the manifest (resolved path, SHA-256), the
exact source recording (resolved path, SHA-256, byte size, nanosecond mtime),
the analysis and trace (resolved paths, SHA-256, byte size, status), the
requested and selected event kinds, and every extracted PNG (filename, target
timestamp, byte size, SHA-256) plus the extraction timestamp. Only an exact
match across all of that
is reusable, and it is an idempotent no-op that re-asserts owner-only
permissions. A replaced or touched video, a replaced trace, an analysis from a
different trace, a manifest edited after the analysis, a tampered PNG, or
incomplete metadata fails closed with exit status 2 and never deletes the
conflicting evidence — clean it explicitly or choose a new output path.
Sessions recorded before `manifest.artifacts` existed carry no artifact
identity and are rejected by design; reanalysis of such a session is still
valid evidence for its trace, but do not retrofit identity into its original
manifest.
For an unauthenticated development-bypass run, verify the visible member
warning and unobstructed local overlay manually; the current runtime trace has
no structured member-auth event, so do not claim automated auth-state coverage.
Before attaching, copying, or otherwise disclosing any frame, inspect the
entire frame for notifications, credentials, terminal content, user/host
identifiers, paths, tokens, keys, and unrelated applications. Keep unsafe
frames inside the owner-only session directory and cite no frame from them.

## Report

Report:

- repository path, branch, HEAD, and dirty-state count;
- overlay PID/cwd, League client PID, game PID, and trace path;
- manifest status, recording/session paths, recording permission status, and
  the recorded privacy acknowledgement;
- video validation resolution, container and decoded frame counts, duration,
  and black fraction;
- every FFmpeg capture warning and its final-validation disposition;
- trace holder PIDs, reopen count, maximum/terminal trace silence, trace-tail
  start offset, and timeline origin;
- each requested checkpoint as pass, fail, or not observed;
- trace invariant violations, timeout classifications, stale-result counts,
  and capture-busy counts;
- rendered-record count plus missing/invalid foreground-authority count and
  ratio;
- affirmative `[badge-layer]` count, malformed-diagnostic count, the
  rejection-reason histogram, and the offer generations that reached the badge
  layer;
- focus-loss duration, whether it met the three-second analyzer minimum, and the
  offer generation loss and recovery were attributed to;
- only privacy-reviewed frame filenames supporting visual claims;
- any remaining manual, Windows, release, or production-auth gate;
- confirmation that no gameplay input, push, or merge occurred.

Keep diagnosis separate from implementation. If the run finds a bug, finish
the evidence report before proposing or applying a fix.
