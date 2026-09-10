#!/usr/bin/env python3
"""Summarize tagged overlay trace JSON and enforce high-confidence invariants."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

TAGGED_JSON = re.compile(r"\[(?P<tag>[A-Za-z0-9_-]+)\]\s+(?P<body>\{.*\})\s*$")
ANALYSIS_SCHEMA = "mayhem-overlay-trace-analysis/1"
# Written by record_session.py. The analyzer reads this block; it never writes
# one, because it did not observe the artifacts being finalized.
ARTIFACT_SCHEMA = "mayhem-overlay-session-artifacts/1"
FOCUS_DWELL_MIN_MS = 3000
FOCUS_NATIVE_MIN_EVENTS = 2
# The single reason string a final badge-layer decision uses when the gate was
# fully open AND chips were actually painted. Anything else is a rejection.
VISIBLE_BADGE_REASON = "badge-layer-visible"
# Which authority opened the gate. "none" is not an authority; the record must
# name the one that was. Never an account identifier — just the kind.
BADGE_LAYER_AUTHORITIES = frozenset({"member", "fixture"})
# The only offer surface a visible badge layer can belong to.
VISIBLE_OFFER_STATE = "OFFER_VISIBLE"
# Surfaces that mean the offer itself is gone, not merely undrawn: an in-game
# modal covers it, or it resolved. Either way the badges a focus test would be
# about no longer exist.
OFFER_GONE_STATES = frozenset({"OCCLUDED", "NO_OFFER"})
KNOWN_REQUIREMENTS = {
    "in_progress",
    "rendered",
    "new_offer",
    "focus_loss",
    "focus_recovery",
    "occlusion",
    "ended",
}
EVENT_LIMITS = {
    "phase": 30,
    "offer_state": 80,
    "new_offer": 40,
    "badge_layer": 40,
    "render": 30,
    "focus_loss": 30,
    "focus_recovery": 30,
    "timeout": 80,
    "stale": 50,
    "trace_reopened": 20,
}
# Notable-event kinds that certify the live overlay rather than describe the
# session. These are scoped to one live-game epoch: their per-epoch budget is
# independent, so pre-game or fixture noise can neither certify a live game nor
# starve the real one out of the frame-extraction plan.
OFFER_EVENT_KINDS = frozenset(
    {
        "badge_layer",
        "render",
        "new_offer",
        "offer_state",
        "focus_loss",
        "focus_recovery",
    }
)
# Coverage checkpoints that only offer/geometry evidence can satisfy. Every one
# of them lives inside a live-game epoch.
EPOCH_COVERAGE = ("rendered", "new_offer", "focus_loss", "focus_recovery", "occlusion")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def recorder_provenance(
    manifest_path: Path, trace: Path, trace_sha256: str, trace_bytes: int
) -> tuple[dict[str, Any], list[str]]:
    """Inherit artifact identity from the recorder — never re-establish it.

    The recorder is the only component that saw the artifacts at the instant
    they were finalized, so its manifest is the root of trust. This verifies the
    trace being analyzed is still byte-for-byte the one the recorder hashed and
    copies the video identity through untouched. A mismatch is an error to
    report, never a stale hash to quietly overwrite with a fresh one.
    """
    errors: list[str] = []
    provenance: dict[str, Any] = {
        "manifestPath": str(manifest_path),
        "manifestSha256": None,
        "videoIdentity": None,
    }
    if not manifest_path.is_file():
        errors.append(f"Recorder manifest does not exist: {manifest_path}")
        return provenance, errors
    provenance["manifestSha256"] = sha256_file(manifest_path)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        errors.append(f"Recorder manifest is not readable JSON: {error}")
        return provenance, errors
    if not isinstance(manifest, dict):
        errors.append("Recorder manifest is not a JSON object.")
        return provenance, errors
    if manifest.get("status") != "complete":
        errors.append(
            "Recorder manifest status is "
            f"{manifest.get('status')!r}; only a completed session may root "
            "artifact identity."
        )
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        errors.append(
            "Recorder manifest has no artifacts block; it cannot establish "
            "artifact identity."
        )
        return provenance, errors
    if artifacts.get("schema") != ARTIFACT_SCHEMA:
        errors.append(
            "Unrecognized recorder artifact schema: "
            f"{artifacts.get('schema')!r} (expected {ARTIFACT_SCHEMA!r})."
        )
        return provenance, errors
    recorded_trace = artifacts.get("trace")
    if not isinstance(recorded_trace, dict) or not recorded_trace.get("sha256"):
        errors.append("Recorder manifest records no trace identity.")
    else:
        if recorded_trace.get("sha256") != trace_sha256:
            errors.append(
                "Trace does not match the recorder manifest: recorder hashed "
                f"{recorded_trace.get('sha256')}, this trace is {trace_sha256}."
            )
        if recorded_trace.get("bytes") != trace_bytes:
            errors.append(
                "Trace size does not match the recorder manifest: recorder "
                f"stored {recorded_trace.get('bytes')} bytes, this trace is "
                f"{trace_bytes} bytes."
            )
    video = artifacts.get("video")
    if manifest.get("videoEnabled") and not isinstance(video, dict):
        errors.append(
            "Recorder manifest enabled video but records no video identity."
        )
    provenance["videoIdentity"] = video if isinstance(video, dict) else None
    # `trace` is resolved and may legitimately differ from the recorder's path
    # if the session directory moved; the hash above is what identity means.
    if recorded_trace and recorded_trace.get("path") not in (None, str(trace)):
        provenance["recordedTracePath"] = recorded_trace.get("path")
    return provenance, errors


def new_epoch_scope(index: int) -> dict[str, Any]:
    """All state a single live game may accumulate.

    Index 0 is the sink for records observed outside any live game — pre-game,
    fixture, preview, replay, and post-end noise. It is never evaluated, so that
    traffic can never certify a live overlay; it is still inspected for
    invariant violations, because a malformed record is a defect wherever it
    appears.
    """
    return {
        "index": index,
        "ended": False,
        "coverage": {name: False for name in EPOCH_COVERAGE},
        "maxGeneration": None,
        "newGenerations": set(),
        "renderedKeys": set(),
        "visibleBadgeKeys": set(),
        "visibleBadgeGenerations": set(),
        # The offer generation whose badges a FINAL badge-layer decision
        # certifies as visible RIGHT NOW. Focus evidence means nothing without
        # one: you cannot lose sight of badges that are not on screen. Anything
        # that takes the badge layer down clears it again.
        "visibleBadgeGeneration": None,
        # The last offer surface state observed in this epoch.
        "offerState": None,
        # The one open focus loss, bound to the generation whose badges were
        # visible when focus was lost:
        # {"generation": int, "startedMs": float | None, "source": str}.
        "focusLoss": None,
        "focusLossDurationsMs": [],
        "nativeFocusStartedMs": None,
        "nativeFocusEventCount": 0,
        # The visible generation captured when the native not-foreground streak
        # BEGAN. Native records carry no offer identity, so the streak's
        # authority is fixed at its first sample and can never be back-filled
        # from a later re-render.
        "nativeFocusGeneration": None,
    }


def strict_generation(value: Any) -> bool:
    """A usable offer identity: a real, non-negative integer.

    `True` is an `int` in Python; a boolean is never an offer generation.
    Strings, floats, `None`, and missing values are malformed and are never
    coerced — a generation we cannot read is a defect, not a weaker number.
    """
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def positive_generation(value: Any) -> bool:
    """A generation that names a REAL offer.

    Generation zero is the pre-offer `NO_OFFER` source state. It is legitimate
    as the *before* side of an advancement, but it never identifies an offer
    whose badges were on screen, so it can certify neither visible badges nor
    the offer identity that focus evidence is bound to.
    """
    return strict_generation(value) and value > 0


def badge_layer_visibility(payload: dict[str, Any]) -> tuple[bool, bool, int | None]:
    """Read one final badge-layer record as (qualified, malformed, generation).

    Only an affirmative record carrying its COMPLETE final-gate authority may
    certify that badges were visible. A record that claims visibility while
    missing, contradicting, or malforming any part of that authority is a
    defect, not weaker evidence: it is reported and credits nothing. A record
    that does not claim visibility is ordinary context and is inert.
    """
    claims = (
        payload.get("badgeLayerVisible") is True
        or payload.get("reason") == VISIBLE_BADGE_REASON
    )
    if not claims:
        return False, False, None
    generation = payload.get("offerGeneration")
    badge_count = payload.get("renderedBadgeCount")
    complete = (
        payload.get("badgeLayerVisible") is True
        and payload.get("reason") == VISIBLE_BADGE_REASON
        and payload.get("authorized") is True
        and payload.get("authorizationSource") in BADGE_LAYER_AUTHORITIES
        and payload.get("previewMode") is False
        and payload.get("visibleFrame") is True
        and payload.get("offerSurface") is True
        and payload.get("schedulerHealthy") is True
        # Generation zero is the NO_OFFER source state; badges cannot be
        # visible for an offer that does not exist yet.
        and positive_generation(generation)
        and strict_generation(badge_count)
        and badge_count >= 1
    )
    if not complete:
        return False, True, None
    return True, False, generation


def evaluated_epoch(epochs: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The one epoch whose evidence is allowed to answer the requirements.

    Policy: the most recent live epoch. If it ended, that is the latest
    completed game; if it is still open at end of trace, that is the active
    game. Requirements are never combined across epochs, so game one's coverage
    can never satisfy game two.
    """
    return epochs[-1] if epochs else None


def parse_record(line: str) -> tuple[str | None, dict[str, Any], dict[str, Any]]:
    metadata: dict[str, Any] = {}
    candidate = line.strip()
    try:
        outer = json.loads(candidate)
    except json.JSONDecodeError:
        outer = None
    if isinstance(outer, dict) and outer.get("event") == "trace-reopened":
        return (
            "observer-event",
            {"event": "trace-reopened"},
            {
                "observedAt": outer.get("observedAt"),
                "elapsedMs": outer.get("elapsedMs"),
            },
        )
    if isinstance(outer, dict) and isinstance(outer.get("line"), str):
        candidate = outer["line"]
        metadata = {
            "observedAt": outer.get("observedAt"),
            "elapsedMs": outer.get("elapsedMs"),
        }
    match = TAGGED_JSON.search(candidate)
    if not match:
        return None, {}, metadata
    try:
        payload = json.loads(match.group("body"))
    except json.JSONDecodeError:
        return None, {}, metadata
    return match.group("tag"), payload, metadata


def payload_contains(payload: Any, target: str) -> bool:
    if isinstance(payload, str):
        return payload == target
    if isinstance(payload, dict):
        return any(payload_contains(value, target) for value in payload.values())
    if isinstance(payload, list):
        return any(payload_contains(value, target) for value in payload)
    return False


def analyze(
    path: Path, required: set[str], manifest: Path | None = None
) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    timeouts: Counter[str] = Counter()
    phases: list[str] = []
    offer_states: list[str] = []
    errors: list[str] = []
    warnings: list[str] = []
    # Identity of the trace actually read, computed before parsing so the
    # analysis can only ever describe these exact bytes.
    source_sha256 = sha256_file(path) if path.is_file() else None
    source_bytes = path.stat().st_size if path.is_file() else None
    provenance: dict[str, Any] = {
        "manifestPath": None,
        "manifestSha256": None,
        "videoIdentity": None,
    }
    if manifest is not None:
        provenance, provenance_errors = recorder_provenance(
            manifest, path, source_sha256 or "", source_bytes or 0
        )
        errors.extend(provenance_errors)
    notable: list[dict[str, Any]] = []
    event_counts: Counter[tuple[str, int | None]] = Counter()
    event_drops: Counter[str] = Counter()
    # Completed and active live games, in order. Only a confirmed `[game-poll]`
    # authority may append to this list, so no fixture, preview, replay, or
    # pre-game record can manufacture an epoch to hide evidence in.
    epochs: list[dict[str, Any]] = []
    epoch_count = 0
    scope = new_epoch_scope(0)
    in_progress = False
    # Which authority proved a live game ran. Only `[game-poll]` records feed
    # this: offer/render/geometry activity is downstream of the overlay's own
    # belief and can be produced by fixtures, replays, or pre-game noise.
    live_activation = {
        "confirmedGamePollRecords": 0,
        "healthyOwnershipRecords": 0,
        "rejectedOwnershipRecords": 0,
    }
    # The final badge-layer gate — the only authority on visible badges.
    badge_layer = {
        "visibleRecords": 0,
        "malformedRecords": 0,
        "rejectionReasons": Counter(),
    }

    def add_unique(target: list[str], message: str) -> None:
        if message not in target:
            target.append(message)

    def event(
        kind: str,
        tag: str,
        payload: dict[str, Any],
        meta: dict[str, Any],
    ) -> None:
        # Offer-derived evidence gets an independent budget per epoch; session
        # diagnostics keep one shared budget.
        epoch = scope["index"]
        bucket = (kind, epoch if kind in OFFER_EVENT_KINDS else None)
        limit = EVENT_LIMITS[kind]
        if event_counts[bucket] >= limit:
            event_drops[kind] += 1
            return
        event_counts[bucket] += 1
        notable.append(
            {
                "kind": kind,
                "tag": tag,
                "gameEpoch": epoch,
                "observedAt": meta.get("observedAt"),
                "elapsedMs": meta.get("elapsedMs"),
                "payload": payload,
            }
        )

    def reset_native_focus_streak(epoch: dict[str, Any]) -> None:
        """Forget the in-flight not-foreground streak, authority included."""
        epoch["nativeFocusStartedMs"] = None
        epoch["nativeFocusEventCount"] = 0
        epoch["nativeFocusGeneration"] = None

    def invalidate_visible_badges(epoch: dict[str, Any], offer_gone: bool) -> None:
        """End visible-offer authority: nothing is on screen as of right now.

        Visible-offer authority describes a badge layer that is CURRENTLY
        visible, never one that was visible earlier. Occlusion, the offer
        resolving, and any final gate that stopped certifying all end it
        immediately, so a later focus sample cannot borrow a generation whose
        badges were already hidden before focus moved.

        `offer_gone` additionally retires a not-foreground streak already in
        flight. A streak that began while the badges were up survives the badge
        layer going dark — that is the expected consequence of losing focus, and
        the badge-layer record reporting it arrives in no fixed order relative
        to the native probe — but it can never outlive the offer itself.
        """
        epoch["visibleBadgeGeneration"] = None
        if offer_gone:
            epoch["nativeFocusGeneration"] = None

    def open_focus_loss(
        epoch: dict[str, Any],
        generation: int,
        started_ms: float | None,
        source: str,
        tag: str,
        payload: dict[str, Any],
        meta: dict[str, Any],
    ) -> None:
        """Record one logical loss of a specific visible offer.

        Repeated samples of the same loss keep the EARLIEST timestamp and emit
        no second event, so a chatty poll cannot shorten a dwell or inflate the
        event budget.
        """
        loss = epoch["focusLoss"]
        if loss is None:
            epoch["focusLoss"] = {
                "generation": generation,
                "startedMs": started_ms,
                "source": source,
            }
            epoch["coverage"]["focus_loss"] = True
            event("focus_loss", tag, payload, meta)
            return
        if started_ms is not None and (
            loss["startedMs"] is None or started_ms < loss["startedMs"]
        ):
            loss["startedMs"] = started_ms

    def resolve_focus_loss(
        epoch: dict[str, Any],
        generation: int,
        tag: str,
        payload: dict[str, Any],
        meta: dict[str, Any],
    ) -> None:
        """Close an open loss with affirmative badge visibility.

        The final badge-layer gate consults the foreground itself, so an
        affirmative record IS the proof that focus returned AND that badges came
        back with it. Recovery is credited only for the EXACT generation that
        was lost: a new offer replaces the old one, it does not recover it.
        """
        loss = epoch["focusLoss"]
        if loss is None:
            return
        epoch["focusLoss"] = None
        reset_native_focus_streak(epoch)
        if loss["generation"] != generation:
            add_unique(
                warnings,
                "Focus returned on offer generation "
                f"{generation} after generation {loss['generation']} lost it; a "
                "new offer never recovers the previous one.",
            )
            return
        elapsed = meta.get("elapsedMs")
        started = loss["startedMs"]
        duration = (
            float(elapsed) - started
            if isinstance(elapsed, (int, float)) and started is not None
            else None
        )
        if duration is not None and duration >= 0:
            epoch["focusLossDurationsMs"].append(duration)
        if duration is not None and duration >= FOCUS_DWELL_MIN_MS:
            epoch["coverage"]["focus_recovery"] = True
            event("focus_recovery", tag, payload, meta)
        else:
            add_unique(
                warnings,
                "Focus returned without a timestamped "
                f"{FOCUS_DWELL_MIN_MS} ms dwell.",
            )

    if not required:
        errors.append("At least one required coverage checkpoint must be supplied.")
    unknown = required - KNOWN_REQUIREMENTS
    if unknown:
        errors.append("Unknown coverage requirements: " + ", ".join(sorted(unknown)))

    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            tag, payload, meta = parse_record(line)
            if not tag:
                continue
            counts[tag] += 1

            if tag == "observer-event" and payload.get("event") == "trace-reopened":
                event("trace_reopened", tag, payload, meta)
                continue

            if tag == "game-poll":
                phase = str(payload.get("gameflowPhase", "unknown"))
                # ONLY an affirmative boolean True confirms a gameflow sample.
                # Missing, null, False, strings ("true"/"false"), and numbers
                # (0/1) are all UNCONFIRMED and may never activate a game, end
                # one, advance a game epoch, or satisfy lifecycle coverage. A
                # record that simply omits the field is a malformed or drifted
                # record, not an authority.
                confirmed = payload.get("gameflowConfirmed") is True
                # A healthy live session's poll returns early on success, so the
                # runtime emits ONE `live-active` record per live-ownership span
                # as the authoritative proof that a real game was activated. It
                # is only trusted with its complete authority tuple: real Live
                # Client Data, capture allowed, and a fresh confirmed inProgress
                # gameflow sample in the same poll. Anything else is a forged,
                # replayed, or drifted record — reject it outright rather than
                # let it reach the generic phase handling below.
                if payload.get("action") == "live-active":
                    if (
                        confirmed
                        and payload.get("captureAllowed") is True
                        and payload.get("liveDataStatus") == "ready"
                        and phase == "inProgress"
                    ):
                        live_activation["healthyOwnershipRecords"] += 1
                        if in_progress:
                            # The overlay emits this record at most once per
                            # live-ownership span (its announcement latch
                            # resets only when ownership releases or a new
                            # game is detected — see shouldAnnounceLiveActivation
                            # and advanceGameEpoch). A second healthy record
                            # while still `in_progress` is therefore always a
                            # fresh game, even when no confirmed non-live phase
                            # separated them in this trace. Close the open
                            # epoch here so the generic phase-transition
                            # handling below opens a new one instead of
                            # silently extending the old one.
                            scope["ended"] = True
                            scope["focusLoss"] = None
                            invalidate_visible_badges(scope, offer_gone=True)
                            reset_native_focus_streak(scope)
                            in_progress = False
                    else:
                        live_activation["rejectedOwnershipRecords"] += 1
                        add_unique(
                            errors,
                            "A 'live-active' record lacked complete live-ownership "
                            "authority (confirmed inProgress gameflow, capture "
                            "allowed, and ready live data).",
                        )
                        continue
                if not phases or phases[-1] != phase:
                    phases.append(phase)
                    event("phase", tag, payload, meta)
                now_in_progress = phase == "inProgress"
                if now_in_progress and confirmed:
                    live_activation["confirmedGamePollRecords"] += 1
                # Unconfirmed records are inert: they neither activate a game,
                # end one, advance the epoch, nor clear the prior confirmed
                # state (the existing `unavailable` grace behaviour). A
                # transient unconfirmed `unavailable` therefore preserves the
                # epoch that is already open.
                if confirmed:
                    if now_in_progress and not in_progress:
                        # Both authoritative activation paths land here: a
                        # confirmed inProgress poll and the strict healthy-live
                        # `live-active` diagnostic, which is itself a confirmed
                        # inProgress poll that survived its authority tuple. A
                        # brand-new scope means the epoch starts clean — no
                        # generation, focus, render, or offer state is carried
                        # in from before activation.
                        epoch_count += 1
                        scope = new_epoch_scope(epoch_count)
                        epochs.append(scope)
                    if in_progress and not now_in_progress:
                        # A confirmed non-live phase closes the active epoch;
                        # everything after it is post-end noise until the next
                        # confirmed activation. Any focus loss still open at the
                        # end can never be recovered — the game it belonged to
                        # is over — so it is dropped rather than left pending
                        # for post-end traffic to close.
                        scope["ended"] = True
                        scope["focusLoss"] = None
                        invalidate_visible_badges(scope, offer_gone=True)
                        reset_native_focus_streak(scope)
                        scope = new_epoch_scope(0)
                    in_progress = now_in_progress
                if (
                    confirmed
                    and not now_in_progress
                    and payload.get("captureAllowed") is True
                ):
                    add_unique(
                        errors,
                        f"Confirmed non-live phase {phase!r} allowed capture.",
                    )
                elif (
                    not confirmed
                    and phase == "unavailable"
                    and payload.get("captureAllowed") is True
                    and payload.get("action") == "clear"
                ):
                    add_unique(
                        warnings,
                        "Unconfirmed unavailable gameflow reported action 'clear' "
                        "while capture remained allowed; inspect grace-window "
                        "diagnostics.",
                    )

            if tag == "focus-transition":
                # P2 fix (focus-loss-before-clear ordering): a deterministic,
                # runtime-emitted transition — recorded BEFORE stopOcr() runs
                # — naming the exact offer generation whose badges were
                # visible the instant foreground was lost. This is the
                # AUTHORITATIVE trigger for opening focus loss: during the
                # documented alt-tab flow, OCR stops immediately (no later
                # offer-session foreground:false record) and the scheduler
                # halts (native geometry may never accumulate a qualifying
                # not-foreground streak), so this may be the ONLY evidence.
                # Only the exact "foreground-loss" transition value may
                # establish a loss — no other reason, generic or otherwise,
                # is accepted here.
                transition = payload.get("transition")
                generation = payload.get("offerGeneration")
                if transition != "foreground-loss":
                    add_unique(
                        errors,
                        "Unrecognized focus-transition value: "
                        f"{transition!r} (only 'foreground-loss' is defined).",
                    )
                else:
                    visible = scope["visibleBadgeGeneration"]
                    elapsed = meta.get("elapsedMs")
                    started_ms = (
                        float(elapsed) if isinstance(elapsed, (int, float)) else None
                    )
                    if visible is None:
                        add_unique(
                            warnings,
                            "A foreground-loss transition was observed with no "
                            "offer whose badges had been certified visible; it "
                            "cannot satisfy focus coverage.",
                        )
                    elif not positive_generation(generation):
                        add_unique(
                            errors,
                            "A foreground-loss transition carried a malformed or "
                            f"non-positive offer generation {generation!r}.",
                        )
                    elif generation != visible:
                        add_unique(
                            warnings,
                            "A foreground-loss transition named offer generation "
                            f"{generation} while generation {visible} held the "
                            "visible badges.",
                        )
                    else:
                        # Record the loss, THEN clear visible authority — this
                        # deterministic record is authoritative on its own and
                        # must not wait for whatever badge-layer rejection (if
                        # any) follows it.
                        open_focus_loss(
                            scope, visible, started_ms, "foreground-transition",
                            tag, payload, meta,
                        )
                        invalidate_visible_badges(scope, offer_gone=False)

            if tag == "badge-layer":
                # The FINAL gate. `[offer-session].render` decided only that the
                # offer surface wanted to draw; this record is taken where
                # authorization, preview mode, the visible frame, the offer
                # surface, and scheduler health have all been applied, so it is
                # the ONLY record that may certify visible badges.
                qualified, malformed, visible_generation = badge_layer_visibility(
                    payload
                )
                if malformed:
                    badge_layer["malformedRecords"] += 1
                    # A gate decision we cannot read is not a visible badge
                    # layer; it ends the current authority rather than leaving
                    # the last affirmative one standing.
                    invalidate_visible_badges(scope, offer_gone=False)
                    add_unique(
                        errors,
                        "A badge-layer record claimed visible badges without its "
                        "complete final-gate authority (authorized member or "
                        "fixture source, no preview mode, visible frame, offer "
                        "surface, healthy scheduler, a strictly positive "
                        "integer offer generation, and at least one painted "
                        "badge).",
                    )
                elif qualified:
                    badge_layer["visibleRecords"] += 1
                    # Resolve any open loss FIRST: the recovery must be matched
                    # against the generation that was visible when focus went
                    # away, before this record becomes the new visible one.
                    resolve_focus_loss(scope, visible_generation, tag, payload, meta)
                    # An affirmative final gate requires a renderable visible
                    # frame, which the overlay only reports while the game
                    # window is foreground — so this record affirmatively proves
                    # focus is present, exactly like a fresh geometry result.
                    # Any not-foreground streak still in flight is over, and the
                    # authority below is the fresh one a later streak may use.
                    reset_native_focus_streak(scope)
                    scope["coverage"]["rendered"] = True
                    scope["visibleBadgeGeneration"] = visible_generation
                    scope["visibleBadgeGenerations"].add(visible_generation)
                    visible_key = (visible_generation, payload.get("renderedBadgeCount"))
                    if visible_key not in scope["visibleBadgeKeys"]:
                        scope["visibleBadgeKeys"].add(visible_key)
                        event("badge_layer", tag, payload, meta)
                else:
                    reason = str(payload.get("reason", "unknown"))
                    badge_layer["rejectionReasons"][reason] += 1
                    # Authorization denied, preview mode, a rejected visible
                    # frame or offer surface, an unhealthy scheduler, and zero
                    # painted badges all mean the badge layer is NOT on screen
                    # now. Whatever it certified a moment ago is over.
                    invalidate_visible_badges(scope, offer_gone=False)

            if tag == "offer-state":
                state = str(payload.get("nextState", "unknown"))
                scope["offerState"] = state
                if state in OFFER_GONE_STATES:
                    invalidate_visible_badges(scope, offer_gone=True)
                if not offer_states or offer_states[-1] != state:
                    offer_states.append(state)
                    event("offer_state", tag, payload, meta)
                if state == "OCCLUDED":
                    scope["coverage"]["occlusion"] = True
                    if payload.get("renderDecision") is True:
                        add_unique(errors, "An occluded offer requested rendering.")

            if tag == "offer-session":
                state = str(payload.get("offerState", "unknown"))
                render = payload.get("render") is True
                foreground = payload.get("foreground")
                generation = payload.get("offerGenerationAfter")
                scope["offerState"] = state
                if state in OFFER_GONE_STATES:
                    invalidate_visible_badges(scope, offer_gone=True)

                if generation is not None and not strict_generation(generation):
                    # A generation we cannot read never becomes the epoch's
                    # high-water mark, so a malformed value can neither mask a
                    # real regression nor manufacture one.
                    add_unique(
                        errors,
                        "An offer-session record carried a malformed offer "
                        f"generation {generation!r}.",
                    )
                elif strict_generation(generation):
                    if (
                        scope["maxGeneration"] is not None
                        and generation < scope["maxGeneration"]
                    ):
                        add_unique(
                            errors,
                            f"Offer generation regressed from {scope['maxGeneration']} "
                            f"to {generation} within game epoch {scope['index']}.",
                        )
                    scope["maxGeneration"] = (
                        generation
                        if scope["maxGeneration"] is None
                        else max(scope["maxGeneration"], generation)
                    )

                if render:
                    # Context only. This is the offer surface's intermediate
                    # decision, taken before authorization, preview mode, the
                    # visible frame, and scheduler health are consulted, so it
                    # can NEVER certify `rendered` — only `[badge-layer]` can.
                    # Its invariants still hold and are still enforced.
                    counts["rendered-records"] += 1
                    if foreground is False:
                        add_unique(errors, "A frame rendered while the game was not foreground.")
                    elif foreground is not True:
                        counts["rendered-without-foreground-authority"] += 1
                        add_unique(
                            errors,
                            "A rendered offer-session had missing or invalid "
                            "foreground authority.",
                        )
                    if payload.get("zeroRenderReason") not in (None, "rendered"):
                        add_unique(
                            errors,
                            "A rendered frame also reported a zero-render reason.",
                        )
                    render_key = (generation, state)
                    if render_key not in scope["renderedKeys"]:
                        scope["renderedKeys"].add(render_key)
                        event("render", tag, payload, meta)
                if foreground is True:
                    reset_native_focus_streak(scope)
                if state == "OCCLUDED" and render:
                    add_unique(errors, "An OCCLUDED offer rendered.")
                if foreground is False:
                    # Losing focus only matters if there were visible badges to
                    # lose. It must name the SAME still-visible offer, and the
                    # surface must still be the visible one — combat, NO_OFFER,
                    # occlusion, and a superseded generation all describe an
                    # offer that was already gone before focus moved.
                    visible = scope["visibleBadgeGeneration"]
                    elapsed = meta.get("elapsedMs")
                    started_ms = (
                        float(elapsed) if isinstance(elapsed, (int, float)) else None
                    )
                    if visible is None:
                        add_unique(
                            warnings,
                            "Foreground loss was observed with no offer whose "
                            "badges had been certified visible; it cannot satisfy "
                            "focus coverage.",
                        )
                    elif state != "OFFER_VISIBLE" or not positive_generation(generation):
                        add_unique(
                            warnings,
                            "Foreground loss was observed on offer state "
                            f"{state!r}; only a still-visible offer with a valid "
                            "generation can lose visible badges.",
                        )
                    elif generation != visible:
                        add_unique(
                            warnings,
                            f"Foreground loss named offer generation {generation} "
                            f"while generation {visible} held the visible badges.",
                        )
                    else:
                        open_focus_loss(
                            scope, visible, started_ms, "explicit", tag, payload, meta
                        )
                if payload.get("newOfferDetected") is True:
                    before = payload.get("offerGenerationBefore")
                    after = payload.get("offerGenerationAfter")
                    # `bool` subclasses `int`, so a bare isinstance check reads
                    # `false -> true` as `0 -> 1` and would certify a new offer
                    # from a record that carries no generation at all. Zero is
                    # legal only as the pre-offer source state, so `before` may
                    # be zero and `after` never may.
                    if (
                        not strict_generation(before)
                        or not positive_generation(after)
                        or after <= before
                    ):
                        # Fail closed: a pair we cannot read certifies nothing
                        # and never becomes an offer identity.
                        add_unique(errors, "A new offer did not advance its generation.")
                    elif after in scope["newGenerations"]:
                        scope["coverage"]["new_offer"] = True
                        add_unique(
                            errors,
                            f"Offer generation {after} was announced new more than once "
                            f"in game epoch {scope['index']}.",
                        )
                    else:
                        scope["coverage"]["new_offer"] = True
                        scope["newGenerations"].add(after)
                    if not payload.get("invalidatedSlots"):
                        add_unique(errors, "A new offer did not report invalidated slots.")
                    event("new_offer", tag, payload, meta)

            if tag == "geometry-timing":
                stale = payload.get("stale") is True
                if stale:
                    counts["stale-results"] += 1
                classification = str(payload.get("timeoutClassification", "none"))
                if classification != "none":
                    timeouts[classification] += 1
                    if classification == "actual-game-window-not-foreground":
                        elapsed = meta.get("elapsedMs")
                        if isinstance(elapsed, (int, float)):
                            if scope["nativeFocusStartedMs"] is None:
                                scope["nativeFocusStartedMs"] = float(elapsed)
                                scope["nativeFocusEventCount"] = 1
                                # A streak may only BEGIN while the badge layer
                                # is certified visible on a currently visible
                                # offer. Authority is captured here and never
                                # re-read, so samples collected while the offer
                                # was occluded, resolved, or unauthorized can
                                # never be converted into a loss by a later
                                # re-render of the same generation.
                                scope["nativeFocusGeneration"] = (
                                    scope["visibleBadgeGeneration"]
                                    if scope["offerState"]
                                    in (None, VISIBLE_OFFER_STATE)
                                    else None
                                )
                            else:
                                scope["nativeFocusEventCount"] += 1
                            native_started = scope["nativeFocusStartedMs"]
                            native_dwell = float(elapsed) - native_started
                            if (
                                scope["nativeFocusEventCount"] >= FOCUS_NATIVE_MIN_EVENTS
                                and native_dwell >= FOCUS_DWELL_MIN_MS
                            ):
                                # Native evidence has no offer identity of its
                                # own, so it uses the generation that was
                                # visible when the streak began — and without
                                # one it proves nothing about visible badges.
                                visible = scope["nativeFocusGeneration"]
                                if visible is None:
                                    add_unique(
                                        warnings,
                                        "Native not-foreground evidence arrived "
                                        "with no offer whose badges were "
                                        "certified visible at the time; it "
                                        "cannot satisfy focus coverage.",
                                    )
                                else:
                                    open_focus_loss(
                                        scope,
                                        visible,
                                        native_started,
                                        "native",
                                        tag,
                                        payload,
                                        meta,
                                    )
                        else:
                            add_unique(
                                warnings,
                                "Native not-foreground evidence lacked video-aligned "
                                "timestamps and cannot satisfy focus coverage.",
                            )
                    event("timeout", tag, payload, meta)
                elif stale:
                    event("stale", tag, payload, meta)
                else:
                    # Only a fresh, unclassified geometry result affirmatively
                    # proves that the native probe recovered. Timeout, busy, and
                    # stale records are inconclusive and must not erase an
                    # in-progress not-foreground streak.
                    reset_native_focus_streak(scope)

            if tag == "capture-busy" or payload.get("timeoutClassification") == "capture-busy":
                counts["capture-busy-events"] += 1
            if payload_contains(payload, "SCANNING"):
                counts["SCANNING-events"] += 1

    if counts["observer-event"]:
        warnings.append(
            f"Trace source reopened {counts['observer-event']} time(s); inspect "
            "the manifest reopen count and coverage around each marker."
        )
    if counts["capture-busy-events"]:
        warnings.append(
            f"Observed {counts['capture-busy-events']} capture-busy events; "
            "inspect their timing for retry fan-out."
        )
    if event_drops:
        warnings.append(
            "Notable-event output was capped: "
            + ", ".join(f"{kind}={count}" for kind, count in sorted(event_drops.items()))
        )
    if not counts:
        errors.append("No tagged overlay trace records were parsed.")

    # One epoch answers the requirements — never a union across games, and never
    # evidence observed outside a live game.
    evaluated = evaluated_epoch(epochs)
    coverage = {key: False for key in KNOWN_REQUIREMENTS}
    if evaluated is not None:
        coverage.update(evaluated["coverage"])
        coverage["in_progress"] = True
        coverage["ended"] = evaluated["ended"]
    evaluated_index = evaluated["index"] if evaluated is not None else None
    if epochs and any(
        item["kind"] in OFFER_EVENT_KINDS and item["gameEpoch"] != evaluated_index
        for item in notable
    ):
        warnings.append(
            "Offer evidence outside the evaluated live-game epoch was ignored; "
            "it cannot certify the live overlay."
        )
    notable = [
        item
        for item in notable
        if item["kind"] not in OFFER_EVENT_KINDS
        or item["gameEpoch"] == evaluated_index
    ]
    focus_loss_durations_ms = (
        evaluated["focusLossDurationsMs"] if evaluated is not None else []
    )

    missing = sorted(
        name for name in required & KNOWN_REQUIREMENTS if not coverage.get(name, False)
    )
    if missing:
        warnings.append("Required coverage not observed: " + ", ".join(missing))

    status = "fail" if errors else ("partial" if missing else "pass")
    rendered_records = counts["rendered-records"]
    missing_foreground = counts["rendered-without-foreground-authority"]
    return {
        "schema": ANALYSIS_SCHEMA,
        "status": status,
        "source": str(path),
        "sourceSha256": source_sha256,
        "sourceBytes": source_bytes,
        "manifestPath": provenance["manifestPath"],
        "manifestSha256": provenance["manifestSha256"],
        "videoIdentity": provenance["videoIdentity"],
        "requiredCoverage": sorted(required),
        "coverage": coverage,
        "counts": dict(sorted(counts.items())),
        "phaseTransitions": phases,
        "offerStateTransitions": offer_states,
        "timeoutClassifications": dict(sorted(timeouts.items())),
        "foregroundAuthority": {
            "renderedRecords": rendered_records,
            "missingOrInvalidRecords": missing_foreground,
            "missingOrInvalidRatio": (
                round(missing_foreground / rendered_records, 6)
                if rendered_records
                else 0.0
            ),
        },
        "liveActivation": live_activation,
        "badgeLayer": {
            "visibleRecords": badge_layer["visibleRecords"],
            "malformedRecords": badge_layer["malformedRecords"],
            "rejectionReasons": dict(sorted(badge_layer["rejectionReasons"].items())),
        },
        "evaluatedGameEpoch": evaluated_index,
        "gameEpochs": [
            {
                "index": epoch["index"],
                "ended": epoch["ended"],
                "coverage": dict(epoch["coverage"]),
                "newOfferGenerations": sorted(epoch["newGenerations"]),
                "visibleBadgeGenerations": sorted(epoch["visibleBadgeGenerations"]),
            }
            for epoch in epochs
        ],
        "focusEvidence": {
            "minimumDwellMs": FOCUS_DWELL_MIN_MS,
            "minimumNativeNotForegroundEvents": FOCUS_NATIVE_MIN_EVENTS,
            "observedLossDurationsMs": [
                round(duration, 3) for duration in focus_loss_durations_ms
            ],
            "visibleBadgeGenerations": (
                sorted(evaluated["visibleBadgeGenerations"])
                if evaluated is not None
                else []
            ),
        },
        "newOfferGenerations": [
            {"gameEpoch": epoch["index"], "generation": generation}
            for epoch in epochs
            for generation in sorted(epoch["newGenerations"])
        ],
        "eventDrops": dict(sorted(event_drops.items())),
        "errors": errors,
        "warnings": warnings,
        "notableEvents": notable,
    }


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("trace", type=Path)
    parser.add_argument("--require", required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--manifest",
        type=Path,
        help=(
            "Recorder manifest that establishes artifact identity. Supplying it "
            "verifies this trace against what the recorder finalized and "
            "inherits the video identity into the analysis."
        ),
    )
    args = parser.parse_args()
    required = {part.strip() for part in args.require.split(",") if part.strip()}
    result = analyze(
        args.trace.resolve(),
        required,
        args.manifest.resolve() if args.manifest else None,
    )
    rendered = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
        args.output.chmod(0o600)
    print(f"status: {result['status']}")
    print("phases: " + " -> ".join(result["phaseTransitions"]))
    print("offer states: " + " -> ".join(result["offerStateTransitions"]))
    print(f"new generations: {result['newOfferGenerations']}")
    for message in result["errors"]:
        print(f"ERROR: {message}")
    for message in result["warnings"]:
        print(f"WARNING: {message}")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
