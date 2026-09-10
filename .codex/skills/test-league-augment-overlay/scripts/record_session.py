#!/usr/bin/env python3
"""Record a display and timestamp a trace pinned to one overlay process group."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from preflight import collect, file_holder_access, process_rows, repository_fingerprint


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


TRACE_DRAIN_TIMEOUT_SECONDS = 5.0
ARTIFACT_SCHEMA = "mayhem-overlay-session-artifacts/1"
# Full repository fingerprinting spawns several git subprocesses over the
# whole worktree; every 5 seconds is frequent enough to catch drift promptly
# without dominating the recording loop's own work.
REPO_DRIFT_CHECK_INTERVAL_SECONDS = 5.0
# Bytes hashed immediately before a position to prove the source is still the
# same stream at that offset. A same-inode copy-truncate that re-grows past the
# frozen boundary is invisible to (device, inode, size) alone; only content can
# tell those two files apart.
CONTENT_CHECKPOINT_BYTES = 4096
# One bounded read per drain iteration; positions stay exact because every read
# is binary and capped at the remaining distance to the frozen boundary.
DRAIN_READ_CHUNK_BYTES = 65536


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def initial_trace_stats(trace_tail_start_elapsed_ms: int) -> dict[str, Any]:
    return {
        "lines": 0,
        "reopens": 0,
        "lastLineElapsedMs": trace_tail_start_elapsed_ms,
        "maxSilenceMs": 0,
        # Drain outcome, always present so a missing key can never read as
        # "nothing went wrong".
        "drainCompleted": False,
        "drainTimedOut": False,
        "partialFinalLine": False,
        "undecodableRecord": False,
        "boundaryMissing": False,
        "boundaryRotated": False,
        "boundaryTruncated": False,
        "boundaryDiscontinuous": False,
        # Active-recording (pre-boundary) source identity failures. Unlike the
        # boundary* flags above, these end the session immediately instead of
        # only invalidating the final drain: once the pinned source is gone,
        # nothing read afterwards can be trusted as the same evidence stream.
        "sourceReplaced": False,
        "sourceReplacedReason": None,
    }


def content_checkpoint(
    path: Path, position: int, window: int = CONTENT_CHECKPOINT_BYTES
) -> str | None:
    """Digest of the bytes immediately preceding `position`, or None.

    None means "cannot be verified" — a missing file, a short read, or an
    unreadable trace. It is never treated as a match.
    """
    if position < 0:
        return None
    start = max(0, position - window)
    try:
        with path.open("rb") as handle:
            handle.seek(start)
            data = handle.read(position - start)
    except OSError:
        return None
    if len(data) != position - start:
        return None
    return hashlib.sha256(data).hexdigest()


def foreign_writable_holder(path: Path, trusted_writer_pids: frozenset[int]) -> bool:
    """Whether a process outside `trusted_writer_pids` currently holds `path`
    open for writing.

    A foreign process can append bytes to the *same* inode the pinned overlay
    is writing without changing device, inode, size, or any already-read
    content — file-identity checks alone cannot see that. Only write (`w`) or
    read/write (`u`) descriptors matter: a foreign reader cannot inject
    fabricated records, so it is tolerated regardless of which process or
    process group it belongs to — this is what lets the recorder's own
    read-only descriptor, and any other innocuous reader, pass. Sharing the
    pinned overlay's process group is never sufficient on its own for a
    *writer*; only exact membership in `trusted_writer_pids` (pinned once, at
    recorder startup) counts.

    Indeterminate access (missing `lsof`) is treated the same as a confirmed
    foreign writer: this can never report "safe" without a positive,
    complete inspection.
    """
    holders = file_holder_access(path)
    if holders is None:
        return True
    return any(
        holder["access"] in ("w", "u")
        and int(holder["pid"]) not in trusted_writer_pids
        for holder in holders
    )


def revalidate_trusted_writer(
    stats: dict[str, Any], source: Path, trusted_writer_pids: frozenset[int]
) -> None:
    """Re-check the trusted writer set at one revalidation checkpoint.

    A foreign writer sets `sourceReplaced`/`sourceReplacedReason` exactly
    once. Once set — by this check or by any other source-identity failure —
    later calls are no-ops: evidence from before and after a violation is
    never combined into one verdict, and a later reason never overwrites an
    earlier one.
    """
    if stats.get("sourceReplaced"):
        return
    if foreign_writable_holder(source, trusted_writer_pids):
        stats["sourceReplaced"] = True
        stats["sourceReplacedReason"] = "foreign-writable-holder"


def check_repo_fingerprint(
    repo: Path,
    state: dict[str, Any],
    lock: threading.Lock,
    exclude_paths: tuple[Path, ...] = (),
) -> None:
    """Recompute the repository content fingerprint and fold it into `state`.

    `state` starts as `{"start": <sha256>, "final": <sha256>, "stable": True}`.
    Once `state["stable"]` is False it never flips back to True, even if a
    later inspection matches the pinned start value again: periodic
    validation having observed drift is itself the failure, regardless of
    whether the repository is later restored to its starting content. A
    fingerprint that cannot be recomputed at all (git failure, unreadable
    file, unresolved concurrent mutation) is treated the same as a mismatch —
    a repository we cannot currently re-read is never assumed unchanged.
    """
    with lock:
        if not state["stable"]:
            return
        current = repository_fingerprint(repo, exclude_paths=exclude_paths)
        if current is None:
            state["stable"] = False
            state["final"] = None
            return
        state["final"] = current["sha256"]
        if current["sha256"] != state["start"]:
            state["stable"] = False


def repository_drift_monitor(
    repo: Path,
    state: dict[str, Any],
    lock: threading.Lock,
    stop: threading.Event,
    exclude_paths: tuple[Path, ...] = (),
    interval: float = REPO_DRIFT_CHECK_INTERVAL_SECONDS,
) -> None:
    """Background loop: periodically confirm the fingerprint hasn't moved.

    Sets `stop` the moment drift is found, so the main recording loop unwinds
    promptly instead of running to the max duration or an operator Ctrl-C
    with a repository that no longer matches what was pinned at startup.
    Also exits (without flagging drift) once something else sets `stop`, so
    it never outlives the session it is watching.
    """
    while not stop.wait(interval):
        check_repo_fingerprint(repo, state, lock, exclude_paths)
        if not state["stable"]:
            stop.set()
            return


def trace_boundary(source: Path) -> dict[str, Any]:
    """Freeze the observable end of the trace at capture stop.

    Everything already written at this byte length is evidence; anything the
    overlay appends afterwards belongs to a session we were no longer
    recording, so it is deliberately excluded.

    Identity is (device, inode, size) PLUS a content checkpoint. Without the
    checkpoint a copy-truncate that reuses the inode and re-grows past the same
    byte length is indistinguishable from an untouched file, and the drain would
    happily read a different stream's bytes as this session's evidence.
    """
    try:
        stat = source.stat()
    except OSError:
        return {
            "device": None,
            "inode": None,
            "size": None,
            "checkpoint": None,
            "checkpointBytes": None,
        }
    checkpoint = content_checkpoint(source, stat.st_size)
    return {
        "device": stat.st_dev,
        "inode": stat.st_ino,
        "size": stat.st_size,
        "checkpoint": checkpoint,
        "checkpointBytes": (
            min(stat.st_size, CONTENT_CHECKPOINT_BYTES)
            if checkpoint is not None
            else None
        ),
    }


def boundary_is_complete(boundary: dict[str, Any]) -> bool:
    """A boundary that can be verified. Anything less invalidates the session.

    An unknown boundary is never an empty completed drain: it means we do not
    know what the trace looked like when capture stopped.
    """
    if not isinstance(boundary, dict):
        return False
    size = boundary.get("size")
    return (
        isinstance(boundary.get("device"), int)
        and isinstance(boundary.get("inode"), int)
        and isinstance(size, int)
        and not isinstance(size, bool)
        and size >= 0
        and isinstance(boundary.get("checkpoint"), str)
        and bool(boundary.get("checkpoint"))
    )


def begin_shutdown(
    timeline_origin: float,
    source: Path,
    stop: threading.Event,
    boundary: dict[str, Any],
) -> int:
    """Stamp the capture boundary and freeze the trace boundary, in that order,
    BEFORE any encoder shutdown wait.

    FFmpeg finalization can take tens of seconds. Counting that as trace silence
    fails healthy sessions, so `captureStopElapsedMs` is the moment capture
    stopped being observed — never the moment the muxer finished writing.
    """
    capture_stop_elapsed_ms = round((time.monotonic() - timeline_origin) * 1000)
    boundary.update(trace_boundary(source))
    stop.set()
    return capture_stop_elapsed_ms


def observe_trace_line(stats: dict[str, Any], elapsed_ms: int) -> None:
    previous_line_ms = stats.get("lastLineElapsedMs")
    if isinstance(previous_line_ms, int):
        stats["maxSilenceMs"] = max(
            int(stats.get("maxSilenceMs", 0)),
            max(0, elapsed_ms - previous_line_ms),
        )
    stats["lastLineElapsedMs"] = elapsed_ms


def finalize_trace_silence(
    stats: dict[str, Any],
    capture_stop_elapsed_ms: int,
    threshold_seconds: float,
) -> str | None:
    last_line_ms = stats.get("lastLineElapsedMs")
    terminal_silence_ms = (
        max(0, capture_stop_elapsed_ms - last_line_ms)
        if isinstance(last_line_ms, int)
        else capture_stop_elapsed_ms
    )
    stats["terminalSilenceMs"] = terminal_silence_ms
    stats["maxSilenceMs"] = max(
        int(stats.get("maxSilenceMs", 0)),
        terminal_silence_ms,
    )
    if stats["maxSilenceMs"] > threshold_seconds * 1000:
        return (
            "Trace silence exceeded "
            f"{threshold_seconds:g} seconds during the session."
        )
    return None


def drain_validation_error(stats: dict[str, Any]) -> str | None:
    """A drain that did not complete cleanly invalidates the trace."""
    if stats.get("sourceReplaced"):
        reason = stats.get("sourceReplacedReason") or "unknown"
        return (
            "The trace source was replaced during active recording "
            f"(reason: {reason}); records from before and after a source "
            "replacement are never combined into one session."
        )
    if stats.get("partialFinalLine"):
        return (
            "The trace ended mid-record at the capture boundary; the final "
            "record is incomplete."
        )
    if stats.get("undecodableRecord"):
        return (
            "A trace record was not valid UTF-8; the trace is not a faithful "
            "record of the session."
        )
    if stats.get("boundaryMissing"):
        return (
            "The capture boundary was never established (missing trace, failed "
            "stat, or an unreadable trace); the recording cannot be verified."
        )
    if stats.get("boundaryRotated"):
        return (
            "The trace file rotated at the capture boundary; the recorded byte "
            "boundary no longer describes it."
        )
    if stats.get("boundaryTruncated"):
        return (
            "The trace shrank at the capture boundary; bytes this session "
            "already observed were removed."
        )
    if stats.get("boundaryDiscontinuous"):
        return (
            "The trace content at or before the capture boundary changed under "
            "the reader; it is no longer one continuous source."
        )
    if stats.get("drainTimedOut") or not stats.get("drainCompleted"):
        return (
            f"The trace did not drain through the capture boundary within "
            f"{TRACE_DRAIN_TIMEOUT_SECONDS:g} seconds."
        )
    return None


def trace_continuity_verified(stats: dict[str, Any]) -> bool:
    """Whether the trace stream was proven gap-free end to end.

    False for any unverified source replacement or unproven boundary —
    including one left unproven because a continuity checkpoint could not be
    read — independent of which specific check caught it.
    """
    return not (
        stats.get("sourceReplaced")
        or stats.get("boundaryMissing")
        or stats.get("boundaryRotated")
        or stats.get("boundaryTruncated")
        or stats.get("boundaryDiscontinuous")
    )


def file_identity(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path),
        "sha256": sha256_file(path),
        "bytes": stat.st_size,
    }


def finalized_artifacts(
    video: Path | None,
    timestamped_trace: Path,
    capture_stop_elapsed_ms: int,
    finalization_completed_elapsed_ms: int,
) -> dict[str, Any]:
    """The recorder's root of trust.

    Hashes are taken only after FFmpeg finalized the container and the trace
    drained through its boundary, so this block identifies the finished
    artifacts exactly. Everything downstream — analyzer, extractor — verifies
    against this and never re-establishes identity on its own.
    """
    record_count = sum(
        1
        for line in timestamped_trace.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines()
        if line.strip()
    )
    return {
        "schema": ARTIFACT_SCHEMA,
        "video": (
            file_identity(video) if video is not None and video.is_file() else None
        ),
        "trace": file_identity(timestamped_trace),
        "traceRecordCount": record_count,
        "captureStopElapsedMs": capture_stop_elapsed_ms,
        "finalizationCompletedElapsedMs": finalization_completed_elapsed_ms,
    }


def tail_trace(
    source: Path,
    destination: Path,
    timeline_origin: float,
    stop: threading.Event,
    stats: dict[str, Any],
    boundary: dict[str, Any] | None = None,
    drain_timeout: float = TRACE_DRAIN_TIMEOUT_SECONDS,
    trusted_writer_pids: frozenset[int] | None = None,
    holder_check_interval: float = 1.0,
) -> None:
    """Follow the overlay trace, then drain it through the capture boundary.

    `stop` means "capture stop requested", NOT "stop reading". A record appended
    during the last polling wait — the final `endOfGame` above all — is still
    evidence, so the tailer keeps reading until it has consumed every byte that
    existed at the boundary, the source proves discontinuous, or the bounded
    drain timeout expires.

    Reads are binary throughout, so byte positions are exact, and once the
    boundary is frozen every read is capped at `boundary_size - position`. A
    text `readline()` would be unbounded: a record still being written at
    capture stop could be completed by bytes appended afterwards and silently
    read as this session's evidence. Instead only complete newline-terminated
    records wholly inside the boundary are kept, and an incomplete record or
    incomplete UTF-8 sequence at the boundary fails the session closed.

    Before the boundary is frozen, the source is opened exactly once — the
    very first time it is seen — and pinned by (device, inode). Any later
    identity change, size regression, content mismatch, disappearance, or
    (when `trusted_writer_pids` is given) a foreign writable holder ends the
    session immediately instead of reopening and combining a new source's
    content into the same evidence stream. `trusted_writer_pids=None`
    disables the holder re-check (used by tests that only exercise the drain
    phase).
    """
    boundary = {} if boundary is None else boundary
    reader = None
    identity: tuple[int, int] | None = None
    # Reader offset in bytes. `pending` holds bytes read but not yet terminated
    # by a newline, so complete records end at `position - len(pending)`.
    position = 0
    pending = bytearray()
    previous_size: int | None = None
    checkpoint: str | None = None
    drain_deadline: float | None = None
    draining = False
    last_holder_check: float | None = None

    def write_record(line: bytes, writer: Any) -> bool:
        """Emit one complete record; False means the bytes are not valid UTF-8."""
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError:
            return False
        elapsed_ms = round((time.monotonic() - timeline_origin) * 1000)
        observe_trace_line(stats, elapsed_ms)
        writer.write(
            json.dumps(
                {
                    "observedAt": utc_now(),
                    "elapsedMs": elapsed_ms,
                    "line": text.rstrip("\r"),
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        writer.flush()
        stats["lines"] += 1
        return True

    with destination.open("w", encoding="utf-8") as writer:
        try:
            while True:
                # The boundary is published before `stop` is set, so honouring
                # it as soon as it appears keeps post-boundary bytes unread even
                # if this thread notices the stop a moment later.
                boundary_size = boundary.get("size")
                if not draining and (
                    stop.is_set() or isinstance(boundary_size, int)
                ):
                    draining = True
                    drain_deadline = time.monotonic() + drain_timeout
                    if not boundary_is_complete(boundary):
                        # An unknown boundary is never an empty completed drain.
                        stats["boundaryMissing"] = True
                        break

                if draining:
                    boundary_size = int(boundary["size"])
                    if position > boundary_size:
                        stats["boundaryTruncated"] = True
                        break
                    if position == boundary_size:
                        if pending:
                            # No "later" exists at the boundary: half a record
                            # (or half a character) is never evidence.
                            stats["partialFinalLine"] = True
                        elif content_checkpoint(source, boundary_size) != boundary[
                            "checkpoint"
                        ]:
                            stats["boundaryDiscontinuous"] = True
                        else:
                            stats["drainCompleted"] = True
                        break
                    if drain_deadline is not None and time.monotonic() >= drain_deadline:
                        stats["drainTimedOut"] = True
                        break

                try:
                    current = source.stat()
                except OSError:
                    if draining:
                        # The source is gone before the frozen boundary was
                        # consumed; never reopen or guess across the boundary.
                        stats["boundaryRotated"] = True
                        break
                    if reader is not None:
                        # The pinned source vanished mid-recording. A later
                        # reappearance at the same path is a new file, not a
                        # continuation, so this fails closed rather than
                        # waiting to reopen it.
                        stats["sourceReplaced"] = True
                        stats["sourceReplacedReason"] = "source-disappeared"
                        break
                    stop.wait(0.1)
                    continue
                current_identity = (current.st_dev, current.st_ino)

                if draining:
                    if reader is None or identity != current_identity:
                        # A replaced inode — or no established view at all —
                        # cannot be continued through the boundary.
                        stats["boundaryRotated"] = True
                        break
                    if current.st_size < position or (
                        previous_size is not None and current.st_size < previous_size
                    ):
                        stats["boundaryTruncated"] = True
                        break
                    if (
                        checkpoint is None
                        or content_checkpoint(source, position) != checkpoint
                    ):
                        # Same inode, same or larger size, different bytes — or a
                        # checkpoint that can no longer be read at all — is never
                        # treated as a continuation past the reader position.
                        stats["boundaryDiscontinuous"] = True
                        break
                else:
                    if reader is None:
                        # The one legitimate open: pin identity and seek to the
                        # current end, so only records from here on are ours.
                        reader = source.open("rb")
                        identity = current_identity
                        pending.clear()
                        reader.seek(0, 2)
                        position = reader.tell()
                        checkpoint = content_checkpoint(source, position)
                        if checkpoint is None:
                            # No trusted baseline at the starting position: there
                            # is nothing later reads can be verified against, so
                            # this fails closed rather than proceeding uncheckable.
                            stats["sourceReplaced"] = True
                            stats["sourceReplacedReason"] = "trace-checkpoint-unreadable"
                            break
                        previous_size = current.st_size
                        last_holder_check = time.monotonic()
                        continue
                    size_decreased = (
                        previous_size is not None and current.st_size < previous_size
                    )
                    if identity != current_identity:
                        stats["sourceReplaced"] = True
                        stats["sourceReplacedReason"] = "identity-changed"
                        break
                    if size_decreased or current.st_size < position:
                        stats["sourceReplaced"] = True
                        stats["sourceReplacedReason"] = "size-decreased"
                        break
                    # A prior check already guarantees current.st_size >= position
                    # here (size_decreased and undersize are ruled out above), so
                    # this checkpoint is always attempted, never skipped.
                    current_checkpoint = content_checkpoint(source, position)
                    if current_checkpoint is None or checkpoint is None:
                        stats["sourceReplaced"] = True
                        stats["sourceReplacedReason"] = "trace-checkpoint-unreadable"
                        break
                    if current_checkpoint != checkpoint:
                        stats["sourceReplaced"] = True
                        stats["sourceReplacedReason"] = "content-mismatch"
                        break
                    if trusted_writer_pids is not None and (
                        last_holder_check is None
                        or time.monotonic() - last_holder_check >= holder_check_interval
                    ):
                        last_holder_check = time.monotonic()
                        revalidate_trusted_writer(stats, source, trusted_writer_pids)
                        if stats.get("sourceReplaced"):
                            break

                previous_size = current.st_size
                wanted = (
                    min(boundary_size - position, DRAIN_READ_CHUNK_BYTES)
                    if draining
                    else DRAIN_READ_CHUNK_BYTES
                )
                chunk = reader.read(wanted) if wanted > 0 else b""
                if not chunk:
                    if draining:
                        time.sleep(0.02)
                    else:
                        stop.wait(0.1)
                    continue
                position += len(chunk)
                pending.extend(chunk)
                checkpoint = content_checkpoint(source, position)
                if checkpoint is None:
                    # No trusted baseline for what was just read: never treat this
                    # chunk, or any later one, as verified continuous evidence.
                    if draining:
                        stats["boundaryDiscontinuous"] = True
                    else:
                        stats["sourceReplaced"] = True
                        stats["sourceReplacedReason"] = "trace-checkpoint-unreadable"
                    break
                undecodable = False
                while True:
                    newline = pending.find(b"\n")
                    if newline < 0:
                        break
                    line = bytes(pending[:newline])
                    del pending[: newline + 1]
                    if not write_record(line, writer):
                        undecodable = True
                        break
                if undecodable:
                    # A record we cannot decode is not evidence, and silently
                    # substituting replacement characters would hash and ship it
                    # as though it were.
                    stats["undecodableRecord"] = True
                    break
        finally:
            if reader is not None:
                reader.close()


def progress_reader(
    stream: Any,
    origin: dict[str, float | None],
    ready: threading.Event,
) -> None:
    out_time_seconds: float | None = None
    for raw_line in stream:
        line = raw_line.strip()
        if line.startswith("out_time_us="):
            try:
                out_time_seconds = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            if out_time_seconds >= 0:
                origin["monotonic"] = time.monotonic() - out_time_seconds
                ready.set()


def encoder_names(ffmpeg: str) -> set[str]:
    completed = subprocess.run(
        [ffmpeg, "-hide_banner", "-encoders"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    names: set[str] = set()
    for line in completed.stdout.splitlines():
        match = re.match(
            r"^\s*V[\.A-Z]{5}\s+(?P<name>[A-Za-z0-9][A-Za-z0-9_.-]*)\s",
            line,
        )
        if match:
            names.add(match.group("name"))
    return names


def validate_video(ffmpeg: str, ffprobe: str, video: Path) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    probe = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,width,height,nb_frames,avg_frame_rate:"
            "format=duration,size",
            "-of",
            "json",
            str(video),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if probe.returncode:
        return {
            "probeError": (probe.stderr or probe.stdout).strip()
        }, ["Video is not readable by ffprobe."]
    try:
        metadata = json.loads(probe.stdout)
    except json.JSONDecodeError:
        return {
            "probeError": (probe.stderr or probe.stdout).strip()
        }, ["FFprobe did not return valid video metadata."]
    streams = metadata.get("streams") or []
    stream = streams[0] if streams else {}
    try:
        raw_frame_count = stream.get("nb_frames")
        frame_count = (
            int(raw_frame_count)
            if raw_frame_count not in (None, "", "N/A", 0, "0")
            else None
        )
        width = int(stream.get("width", 0))
        height = int(stream.get("height", 0))
        duration = float((metadata.get("format") or {}).get("duration", 0))
    except (TypeError, ValueError):
        frame_count = None
        width = height = 0
        duration = 0.0
    if width <= 0 or height <= 0 or duration <= 0:
        errors.append("Video has no usable frame stream.")

    black_timeout = max(30.0, min(600.0, duration * 0.25))
    try:
        black = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-nostats",
                "-i",
                str(video),
                "-vf",
                "blackdetect=d=1:pix_th=0.10",
                "-an",
                "-progress",
                "pipe:1",
                "-f",
                "null",
                "-",
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=black_timeout,
        )
    except subprocess.TimeoutExpired:
        metadata["validation"] = {
            "frameCount": frame_count,
            "decodedFrameCount": 0,
            "width": width,
            "height": height,
            "durationSeconds": duration,
            "blackFraction": None,
        }
        errors.append(
            f"Video decode validation exceeded {black_timeout:.1f} seconds."
        )
        return metadata, errors
    decoded_frame_values = [
        int(value)
        for value in re.findall(r"^frame=(\d+)$", black.stdout, re.MULTILINE)
    ]
    decoded_frame_count = max(decoded_frame_values, default=0)
    if black.returncode or decoded_frame_count < 2:
        errors.append("Video could not be fully decoded for validation.")
    elif frame_count is not None and decoded_frame_count != frame_count:
        errors.append(
            "Decoded frame count does not match the container frame count "
            f"({decoded_frame_count} != {frame_count})."
        )
    black_durations = [
        float(value)
        for value in re.findall(r"black_duration:([0-9.]+)", black.stdout)
    ]
    black_fraction = min(1.0, sum(black_durations) / duration) if duration > 0 else 1.0
    metadata["validation"] = {
        "frameCount": frame_count,
        "decodedFrameCount": decoded_frame_count,
        "width": width,
        "height": height,
        "durationSeconds": duration,
        "blackFraction": round(black_fraction, 6),
    }
    if black_fraction >= 0.80:
        errors.append("At least 80% of the recording is black.")
    return metadata, errors


def required_free_bytes(max_duration: int, minimum_gib: float) -> int:
    # Budget 8 Mb/s plus 20% container/encoder headroom and one GiB reserve.
    estimated_video = max_duration * 8_000_000 / 8 * 1.20
    reserve = 1024**3
    return max(int(minimum_gib * 1024**3), int(estimated_video + reserve))


def nearest_existing_ancestor(path: Path) -> Path:
    """The directory that already exists on the filesystem which will hold
    `path` once its parents are created."""
    for candidate in (path, *path.parents):
        if candidate.exists():
            return candidate
    return Path(path.anchor or ".")


def check_output_capacity(output: Path, minimum_free_bytes: int) -> str | None:
    """Verify capacity and writability against the nearest existing ancestor.

    A nested `--output` whose immediate parent does not exist yet is normal, so
    measuring the parent directly raises FileNotFoundError before `mkdir` ever
    runs. Checking before creating anything also means a rejected session leaves
    no partially initialized evidence directory behind.
    """
    ancestor = nearest_existing_ancestor(output.parent)
    if not ancestor.is_dir():
        return f"output parent is not a directory: {ancestor}"
    if not os.access(ancestor, os.W_OK | os.X_OK):
        return f"output parent is not writable: {ancestor}"
    try:
        free_bytes = shutil.disk_usage(ancestor).free
    except OSError as error:
        return f"could not measure free space at {ancestor}: {error}"
    if free_bytes < minimum_free_bytes:
        return (
            f"less than {minimum_free_bytes / 1024**3:.1f} GiB free "
            "for the requested maximum duration."
        )
    return None


def make_owner_only_dir(output: Path) -> None:
    """Create every missing level owner-only, not just the leaf."""
    missing: list[Path] = []
    probe = output
    while not probe.exists():
        missing.append(probe)
        if probe.parent == probe:
            break
        probe = probe.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
        directory.chmod(0o700)


def capture_log_warnings(log_text: str) -> list[str]:
    warnings: list[str] = []
    if re.search(r"configuration of video device failed", log_text, re.I):
        warnings.append(
            "FFmpeg reported a video-device configuration fallback; final "
            "screen identity, dimensions, frames, and black fraction were verified."
        )
    return warnings


def capture_log_errors(log_text: str) -> list[str]:
    errors: list[str] = []
    if re.search(
        r"(?:not authorized to (?:capture|use)|authorization status is denied|"
        r"screen capture permission denied|permission denied[^\n]*(?:screen|capture))",
        log_text,
        re.I,
    ):
        errors.append("Screen Recording permission was denied.")
    return errors


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--overlay-pid", type=int, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--display-index", type=int, required=True)
    parser.add_argument("--fps", type=int, default=15)
    parser.add_argument("--max-duration", type=int, default=3600)
    parser.add_argument("--trace-max-age", type=float, default=15.0)
    parser.add_argument("--trace-silence-max", type=float, default=30.0)
    parser.add_argument("--min-free-gb", type=float, default=3.0)
    parser.add_argument("--privacy-acknowledged", action="store_true")
    parser.add_argument("--no-video", action="store_true")
    args = parser.parse_args()

    repo = args.repo.resolve()
    trace = args.trace.resolve()
    if not args.privacy_acknowledged:
        print(
            "ERROR: privacy preflight was not acknowledged. Hide sensitive and "
            "unrelated windows, enable Do Not Disturb, prepare a blank focus-out "
            "target, then pass --privacy-acknowledged.",
            file=sys.stderr,
        )
        return 2
    if not trace.is_file():
        print(f"ERROR: trace does not exist: {trace}", file=sys.stderr)
        return 2

    provenance = collect(
        repo,
        require_overlay=True,
        require_game=False,
        overlay_pid=args.overlay_pid,
    )
    if not provenance["ok"]:
        for error in provenance["errors"]:
            print(f"ERROR: {error}", file=sys.stderr)
        return 2
    display_indices = {
        int(device["index"]) for device in provenance["captureDevices"]
    }
    if not args.no_video and args.display_index not in display_indices:
        print(
            f"ERROR: device {args.display_index} is not a verified screen capture "
            f"device; available screen indices: {sorted(display_indices)}",
            file=sys.stderr,
        )
        return 2

    rows = process_rows()
    by_pid = {int(row["pid"]): row for row in rows}
    overlay = provenance["processes"]["overlay"][0]
    overlay_pgid = int(overlay["pgid"])
    holder_access = file_holder_access(trace)
    if holder_access is None:
        print(
            "ERROR: could not inspect the trace file's holders (lsof unavailable).",
            file=sys.stderr,
        )
        return 2
    writer_pids = {
        int(holder["pid"]) for holder in holder_access if holder["access"] in ("w", "u")
    }
    # The trusted writer set is pinned here, once, by exact pid — not by
    # process group. After this point, sharing the overlay's pgid is never
    # sufficient for a writer to be trusted; only membership in this exact
    # set is.
    trusted_writer_pids = frozenset(
        pid
        for pid in writer_pids
        if pid in by_pid and int(by_pid[pid]["pgid"]) == overlay_pgid
    )
    if not trusted_writer_pids:
        print(
            "ERROR: the trace has no writable holder in the pinned overlay "
            f"process group {overlay_pgid}.",
            file=sys.stderr,
        )
        return 2
    if writer_pids - trusted_writer_pids:
        print(
            "ERROR: the trace is held open for writing by a process outside "
            "the trusted writer set.",
            file=sys.stderr,
        )
        return 2
    trace_age = time.time() - trace.stat().st_mtime
    if trace_age > args.trace_max_age:
        print(
            f"ERROR: trace is stale ({trace_age:.1f}s old; max "
            f"{args.trace_max_age:.1f}s).",
            file=sys.stderr,
        )
        return 2

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    minimum_free_bytes = required_free_bytes(args.max_duration, args.min_free_gb)
    if args.output:
        output = args.output.resolve()
        if output.exists():
            print(f"ERROR: output already exists: {output}", file=sys.stderr)
            return 2
        capacity_error = check_output_capacity(output, minimum_free_bytes)
        if capacity_error:
            print(f"ERROR: {capacity_error}", file=sys.stderr)
            return 2
        make_owner_only_dir(output)
    else:
        if shutil.disk_usage("/tmp").free < minimum_free_bytes:
            print(
                f"ERROR: less than {minimum_free_bytes / 1024**3:.1f} GiB free "
                "for the requested maximum duration.",
                file=sys.stderr,
            )
            return 2
        output = Path(tempfile.mkdtemp(prefix=f"mayhem-overlay-session-{stamp}-"))

    # Pinned before anything is recorded: the starting source identity that
    # the eventual video/trace must be attributable to in full. `output` is
    # excluded in case it was placed inside the repository — this session's
    # own evidence directory must never feed back into the fingerprint it is
    # pinned against.
    repo_fingerprint_start = repository_fingerprint(repo, exclude_paths=(output,))
    if repo_fingerprint_start is None:
        print(
            "ERROR: could not compute a repository content fingerprint (git "
            "failure, unreadable file, or concurrent mutation).",
            file=sys.stderr,
        )
        return 2
    repo_fingerprint_state: dict[str, Any] = {
        "start": repo_fingerprint_start["sha256"],
        "final": repo_fingerprint_start["sha256"],
        "stable": True,
    }
    repo_fingerprint_lock = threading.Lock()

    started_epoch = time.time()
    session_started_monotonic = time.monotonic()
    manifest: dict[str, Any] = {
        "status": "recording",
        "startedAt": utc_now(),
        "startedEpoch": started_epoch,
        "repositoryFingerprintSchema": repo_fingerprint_start["schema"],
        "repositoryFingerprintStart": repo_fingerprint_start["sha256"],
        "tracePath": str(trace),
        "traceIdentity": {
            "device": trace.stat().st_dev,
            "inode": trace.stat().st_ino,
            "trustedWriterPids": sorted(trusted_writer_pids),
            "overlayPid": args.overlay_pid,
            "overlayPgid": overlay_pgid,
            "ageSeconds": round(trace_age, 3),
        },
        "displayIndex": args.display_index,
        "fps": args.fps,
        "maxDurationSeconds": args.max_duration,
        "requiredFreeBytes": minimum_free_bytes,
        "privacyAcknowledged": args.privacy_acknowledged,
        "videoEnabled": not args.no_video,
        "provenance": provenance,
    }
    manifest_path = output / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    ffmpeg_process: subprocess.Popen[str] | None = None
    ffmpeg_log_handle = None
    progress_thread: threading.Thread | None = None
    timeline_origin = session_started_monotonic
    video = output / "screen.mp4"
    if not args.no_video:
        ffmpeg = str(provenance["tools"]["ffmpeg"])
        available_encoders = encoder_names(ffmpeg)
        candidates = [
            encoder
            for encoder in ("h264_videotoolbox", "libx264")
            if encoder in available_encoders
        ]
        if not candidates:
            manifest["status"] = "recording-failed"
            manifest["videoValidationError"] = "No supported H.264 encoder."
            manifest_path.write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            print("ERROR: no supported H.264 encoder.", file=sys.stderr)
            return 3
        ffmpeg_log_handle = (output / "ffmpeg.log").open("w", encoding="utf-8")
        origin_holder: dict[str, float | None] = {"monotonic": None}
        ready = threading.Event()
        for encoder in candidates:
            command = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "warning",
                "-y",
                "-f",
                "avfoundation",
                "-framerate",
                str(args.fps),
                "-pixel_format",
                "nv12",
                "-i",
                f"{args.display_index}:none",
                "-an",
                "-c:v",
                encoder,
            ]
            if encoder == "h264_videotoolbox":
                command.extend(["-b:v", "6M"])
            else:
                command.extend(["-preset", "veryfast", "-crf", "24"])
            command.extend(
                [
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    "-stats_period",
                    "0.1",
                    "-progress",
                    "pipe:1",
                    str(video),
                ]
            )
            ffmpeg_log_handle.write(f"encoder-attempt: {encoder}\n")
            ffmpeg_log_handle.flush()
            ffmpeg_process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=ffmpeg_log_handle,
                text=True,
                start_new_session=True,
            )
            assert ffmpeg_process.stdout is not None
            progress_thread = threading.Thread(
                target=progress_reader,
                args=(ffmpeg_process.stdout, origin_holder, ready),
                daemon=True,
            )
            progress_thread.start()
            if ready.wait(timeout=5) and ffmpeg_process.poll() is None:
                manifest["videoEncoder"] = encoder
                timeline_origin = float(origin_holder["monotonic"])
                break
            if ffmpeg_process.poll() is None:
                ffmpeg_process.terminate()
                ffmpeg_process.wait(timeout=5)
            if progress_thread:
                progress_thread.join(timeout=1)
            ready.clear()
            origin_holder["monotonic"] = None
            ffmpeg_process = None
            if video.exists():
                video.unlink()
        if ffmpeg_process is None:
            ffmpeg_log_handle.close()
            manifest["status"] = "recording-failed"
            manifest["stoppedAt"] = utc_now()
            manifest_path.write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            log_text = (output / "ffmpeg.log").read_text(encoding="utf-8")
            print(log_text, file=sys.stderr)
            if re.search(r"not authorized|permission denied|screen recording", log_text, re.I):
                print(
                    "ERROR: enable the host application under System Settings > "
                    "Privacy & Security > Screen Recording & System Audio, restart "
                    "it if requested, and retry.",
                    file=sys.stderr,
                )
            else:
                print(
                    f"ERROR: screen recording did not start; inspect "
                    f"{output / 'ffmpeg.log'}.",
                    file=sys.stderr,
                )
            return 3

    manifest["timelineOriginEpoch"] = time.time() - (
        time.monotonic() - timeline_origin
    )
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    stop = threading.Event()
    trace_boundary_holder: dict[str, Any] = {}
    timestamped_trace = output / "trace.timestamped.jsonl"
    trace_tail_start_elapsed_ms = round(
        (time.monotonic() - timeline_origin) * 1000
    )
    trace_stats = initial_trace_stats(trace_tail_start_elapsed_ms)
    trace_thread = threading.Thread(
        target=tail_trace,
        args=(
            trace,
            timestamped_trace,
            timeline_origin,
            stop,
            trace_stats,
            trace_boundary_holder,
        ),
        kwargs={"trusted_writer_pids": trusted_writer_pids},
        daemon=True,
    )
    manifest["traceTailStartElapsedMs"] = trace_tail_start_elapsed_ms
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    trace_thread.start()
    repo_drift_thread = threading.Thread(
        target=repository_drift_monitor,
        args=(repo, repo_fingerprint_state, repo_fingerprint_lock, stop),
        kwargs={"exclude_paths": (output,)},
        daemon=True,
    )
    repo_drift_thread.start()

    print(f"session: {output}")
    print("recording; press Ctrl-C once to stop")
    try:
        while time.monotonic() - session_started_monotonic < args.max_duration:
            if ffmpeg_process and ffmpeg_process.poll() is not None:
                raise RuntimeError("FFmpeg exited before the session was stopped.")
            if not repo_fingerprint_state["stable"]:
                raise RuntimeError("Repository content changed during recording.")
            time.sleep(0.5)
        print("maximum duration reached; stopping")
    except KeyboardInterrupt:
        pass
    except RuntimeError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        manifest["status"] = "recording-failed"
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        # Revalidate immediately, before anything else: a repository edit
        # landing at the exact moment of capture stop must still be caught,
        # not only by the periodic monitor's last sample before this point.
        check_repo_fingerprint(
            repo, repo_fingerprint_state, repo_fingerprint_lock, exclude_paths=(output,)
        )
        # 1-2. Stamp the observable capture boundary and freeze the trace byte
        # boundary FIRST. Everything below may block for tens of seconds and
        # none of it may leak into the trace-silence measurement.
        capture_stop_elapsed_ms = begin_shutdown(
            timeline_origin, trace, stop, trace_boundary_holder
        )
        manifest["captureStopElapsedMs"] = capture_stop_elapsed_ms
        manifest["traceBoundary"] = dict(trace_boundary_holder)
        # `begin_shutdown` already set `stop`; the monitor thread wakes from
        # its wait almost immediately, so this join is not a meaningful delay.
        repo_drift_thread.join(timeout=2)
        # A foreign writer that appears right at capture stop may arrive
        # after the tail thread's own last periodic check but before it
        # drains; catch it here rather than waiting for the pre-manifest
        # checkpoint below.
        revalidate_trusted_writer(trace_stats, trace, trusted_writer_pids)
        # 3. Ask FFmpeg to stop, but do not wait on it yet.
        if ffmpeg_process and ffmpeg_process.poll() is None:
            try:
                assert ffmpeg_process.stdin is not None
                ffmpeg_process.stdin.write("q\n")
                ffmpeg_process.stdin.flush()
            except (BrokenPipeError, OSError):
                ffmpeg_process.send_signal(signal.SIGINT)
        # 4. Drain the trace through the frozen boundary while the encoder
        # flushes in parallel.
        trace_thread.join(timeout=TRACE_DRAIN_TIMEOUT_SECONDS + 2)
        if trace_thread.is_alive():
            trace_stats["drainTimedOut"] = True
        # 5. Only now wait for container finalization.
        if ffmpeg_process and ffmpeg_process.poll() is None:
            try:
                ffmpeg_process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                ffmpeg_process.send_signal(signal.SIGINT)
                try:
                    ffmpeg_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    ffmpeg_process.terminate()
                    ffmpeg_process.wait(timeout=5)
        if progress_thread:
            progress_thread.join(timeout=2)
        if ffmpeg_log_handle:
            ffmpeg_log_handle.close()

        if not args.no_video:
            print("finalizing recording; validation may take several minutes")
            video_metadata, video_errors = validate_video(
                str(provenance["tools"]["ffmpeg"]),
                str(provenance["tools"]["ffprobe"]),
                video,
            )
            log_text = (output / "ffmpeg.log").read_text(
                encoding="utf-8", errors="replace"
            )
            log_errors = capture_log_errors(log_text)
            log_warnings = capture_log_warnings(log_text)
            manifest["video"] = video_metadata
            if log_warnings:
                manifest["captureWarnings"] = log_warnings
            if video_errors or log_errors:
                manifest["status"] = "recording-failed"
                manifest["videoValidationErrors"] = video_errors + log_errors
        # Final revalidation before the manifest is written as complete: a
        # foreign writer that appeared during finalization must still fail
        # closed even though capture already stopped.
        revalidate_trusted_writer(trace_stats, trace, trusted_writer_pids)
        drain_error = drain_validation_error(trace_stats)
        if trace_stats["lines"] == 0:
            manifest["status"] = "recording-failed"
            manifest["traceValidationError"] = (
                "No new trace records were observed during the session."
            )
        elif drain_error:
            # A truncated or ambiguous drain means the trace is not a faithful
            # record of the capture interval; never bless it as evidence.
            manifest["status"] = "recording-failed"
            manifest["traceValidationError"] = drain_error
        else:
            trace_error = finalize_trace_silence(
                trace_stats,
                capture_stop_elapsed_ms,
                args.trace_silence_max,
            )
            if trace_error:
                manifest["status"] = "recording-failed"
                manifest["traceValidationError"] = trace_error
        manifest["traceContinuityVerified"] = trace_continuity_verified(trace_stats)
        if trace_stats.get("sourceReplacedReason") == "trace-checkpoint-unreadable":
            manifest["failureReason"] = "trace-checkpoint-unreadable"
        manifest["traceStats"] = trace_stats
        # Statistics, record count, and hashes are computed only now — after the
        # drain finished — so the identity below describes the finished file.
        manifest["finalizationCompletedElapsedMs"] = round(
            (time.monotonic() - timeline_origin) * 1000
        )
        if trace_stats.get("sourceReplacedReason") == "foreign-writable-holder":
            # A foreign writer may have influenced the bytes on disk; do not
            # publish hashes or counts that would read as a trustworthy,
            # complete artifact record.
            manifest["artifacts"] = {
                "schema": ARTIFACT_SCHEMA,
                "withheld": "foreign-writable-holder-detected",
            }
        else:
            manifest["artifacts"] = finalized_artifacts(
                video if not args.no_video else None,
                timestamped_trace,
                capture_stop_elapsed_ms,
                manifest["finalizationCompletedElapsedMs"],
            )
        final = collect(
            repo,
            require_overlay=True,
            require_game=False,
            overlay_pid=args.overlay_pid,
        )
        manifest["finalProcesses"] = final["processes"]
        if not final["ok"]:
            manifest["status"] = "recording-failed"
            manifest["finalProcessErrors"] = final["errors"]

        # Last check, after the trace has fully drained and immediately
        # before the manifest can be published as complete: the repository
        # must still match what was pinned at startup, end to end.
        check_repo_fingerprint(
            repo, repo_fingerprint_state, repo_fingerprint_lock, exclude_paths=(output,)
        )
        manifest["repositoryFingerprintFinal"] = repo_fingerprint_state["final"]
        manifest["repositoryStable"] = repo_fingerprint_state["stable"]
        if not repo_fingerprint_state["stable"]:
            manifest["status"] = "recording-failed"
            manifest["failureReason"] = "repository-drift"

        if manifest["status"] == "recording":
            manifest["status"] = "complete"
        manifest["stoppedAt"] = utc_now()
        manifest["durationSeconds"] = round(time.time() - started_epoch, 3)
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    print(f"saved: {output}")
    if manifest["status"] != "complete":
        print(f"ERROR: session status is {manifest['status']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
