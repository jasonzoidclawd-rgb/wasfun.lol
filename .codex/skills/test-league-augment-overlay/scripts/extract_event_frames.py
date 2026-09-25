#!/usr/bin/env python3
"""Extract display frames at timestamped trace events."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

KIND_PRIORITY = (
    # The final badge-layer gate is the strongest visual claim in the analysis,
    # so its frames are selected before anything else.
    "badge_layer",
    "focus_loss",
    "focus_recovery",
    "new_offer",
    "phase",
    "render",
    "trace_reopened",
    "offer_state",
    "timeout",
    "stale",
)
METADATA_FILENAME = "extraction-metadata.json"
EXTRACTION_SCHEMA = "mayhem-overlay-frame-extraction/1"
# Written by record_session.py at finalization and by analyze_trace.py. The
# extractor reads both and re-verifies them; it never authors either, because it
# never observed the artifacts being produced.
ARTIFACT_SCHEMA = "mayhem-overlay-session-artifacts/1"
ANALYSIS_SCHEMA = "mayhem-overlay-trace-analysis/1"

# Every field an evidence directory must carry to be reusable. A directory
# missing any of them is incomplete and is rejected rather than trusted.
REQUIRED_METADATA_KEYS = (
    "schema",
    "recorderArtifactSchema",
    "analysisSchema",
    "manifestPath",
    "manifestSha256",
    "sourceVideoPath",
    "sourceVideoSha256",
    "sourceVideoBytes",
    "sourceVideoMtimeNs",
    "analysisPath",
    "analysisStatus",
    "analysisSha256",
    "sourceTracePath",
    "sourceTraceSha256",
    "sourceTraceBytes",
    "requestedEventKinds",
    "selectedEventKinds",
    "limit",
    "selectedEvents",
    "omittedCount",
    "omittedEventKinds",
    "kindsWithoutEvidence",
    "extractedAt",
    "framesWritten",
    "extractionFailures",
    "frames",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ordered_kinds(kinds: set[str]) -> list[str]:
    return [
        *[kind for kind in KIND_PRIORITY if kind in kinds],
        *sorted(kinds - set(KIND_PRIORITY)),
    ]


def select_checkpoint_events(
    notable_events: list[dict[str, Any]],
    kinds: set[str],
    limit: int,
) -> dict[str, Any]:
    grouped: dict[str, list[tuple[int, dict[str, Any]]]] = {
        kind: [] for kind in kinds
    }
    for index, event in enumerate(notable_events):
        kind = event.get("kind")
        if (
            kind in kinds
            and isinstance(event.get("elapsedMs"), (int, float))
        ):
            grouped[str(kind)].append((index, event))

    present_kinds = [
        kind for kind in ordered_kinds(kinds) if grouped.get(kind)
    ]
    selected_indices: set[int] = set()

    for kind in present_kinds:
        if len(selected_indices) >= limit:
            break
        selected_indices.add(grouped[kind][0][0])

    for kind in present_kinds:
        if len(selected_indices) >= limit:
            break
        selected_indices.add(grouped[kind][-1][0])

    interior = {
        kind: [
            item
            for item in grouped[kind][1:-1]
            if item[0] not in selected_indices
        ]
        for kind in present_kinds
    }
    while len(selected_indices) < limit:
        added = False
        for kind in present_kinds:
            if len(selected_indices) >= limit:
                break
            if interior[kind]:
                selected_indices.add(interior[kind].pop(0)[0])
                added = True
        if not added:
            break

    indexed_events = [
        item
        for kind in present_kinds
        for item in grouped[kind]
        if item[0] in selected_indices
    ]
    indexed_events.sort(key=lambda item: item[0])
    selected = [event for _, event in indexed_events]
    selected_counts = {
        kind: sum(event.get("kind") == kind for event in selected)
        for kind in present_kinds
    }
    omitted_by_kind = {
        kind: len(grouped[kind]) - selected_counts[kind]
        for kind in present_kinds
        if len(grouped[kind]) > selected_counts[kind]
    }
    missing_all_kinds = [
        kind for kind in present_kinds if selected_counts[kind] == 0
    ]
    return {
        "events": selected,
        "selectedKinds": [
            kind for kind in present_kinds if selected_counts[kind] > 0
        ],
        "totalMatched": sum(len(grouped[kind]) for kind in present_kinds),
        "omittedCount": sum(omitted_by_kind.values()),
        "omittedKinds": list(omitted_by_kind),
        "missingAllKinds": missing_all_kinds,
    }


def output_for_status(base: Path, status: str) -> Path:
    return base if status == "pass" else base.with_name(f"{base.name}-{status}")


def output_family(base: Path) -> dict[str, Path]:
    return {
        status: output_for_status(base, status)
        for status in ("pass", "partial", "fail")
    }


def report_selection(selection: dict[str, Any]) -> None:
    omitted_count = int(selection["omittedCount"])
    if omitted_count:
        omitted_kinds = ", ".join(selection["omittedKinds"])
        print(f"events omitted: {omitted_count}")
        print(f"omitted event kinds: {omitted_kinds}")
        print(
            f"WARNING: frame limit omitted {omitted_count} event(s) "
            f"from kinds: {omitted_kinds}",
            file=sys.stderr,
        )
    if selection["missingAllKinds"]:
        missing = ", ".join(selection["missingAllKinds"])
        print(f"requested kinds without evidence: {missing}")
        print(
            "ERROR: frame limit removed all evidence for requested kinds: "
            f"{missing}",
            file=sys.stderr,
        )


def selected_frame_plan(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    plan: list[dict[str, Any]] = []
    for index, event in enumerate(events, start=1):
        seconds = max(0.0, float(event["elapsedMs"]) / 1000.0)
        kind = str(event["kind"]).replace("/", "-")
        plan.append(
            {
                "event": event,
                "seconds": seconds,
                "filename": f"{index:03d}-{kind}-{seconds:.3f}s.png",
            }
        )
    return plan


def video_identity(video: Path) -> dict[str, Any]:
    """Bind the frames to one exact byte-for-byte source recording."""
    stat = video.stat()
    return {
        "sourceVideoPath": str(video),
        "sourceVideoSha256": sha256_file(video),
        "sourceVideoBytes": stat.st_size,
        "sourceVideoMtimeNs": stat.st_mtime_ns,
    }


def verified_chain(
    video: Path,
    trace: Path,
    analysis_path: Path,
    analysis: dict[str, Any],
    manifest_path: Path,
    manifest: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Re-verify the recorder's identity chain before a single PNG is written.

    Identity is established exactly once — by the recorder, at the moment it
    finalized the artifacts — and inherited by the analyzer. This hashes what is
    on disk right now and *compares*. It never promotes a freshly computed hash
    into provenance, because the hash of a swapped-in file is exactly as
    self-consistent as the hash of the real one; only agreement with what the
    recorder stored distinguishes them.

    Returns the verified chain, or None plus the reason it is untrustworthy.
    """
    if manifest.get("status") != "complete" or not manifest.get("videoEnabled"):
        return None, (
            "the recorder manifest does not describe a complete video session"
        )
    artifacts = manifest.get("artifacts")
    if (
        not isinstance(artifacts, dict)
        or artifacts.get("schema") != ARTIFACT_SCHEMA
    ):
        return None, (
            "the recorder manifest establishes no artifact identity (missing or "
            f"unrecognized artifacts block; expected schema {ARTIFACT_SCHEMA!r})"
        )
    recorded_trace = artifacts.get("trace")
    recorded_video = artifacts.get("video")
    if not isinstance(recorded_trace, dict) or not recorded_trace.get("sha256"):
        return None, "the recorder manifest records no trace identity"
    if not isinstance(recorded_video, dict) or not recorded_video.get("sha256"):
        return None, "the recorder manifest records no video identity"

    trace_stat = trace.stat()
    trace_sha256 = sha256_file(trace)
    if (
        recorded_trace.get("sha256") != trace_sha256
        or recorded_trace.get("bytes") != trace_stat.st_size
    ):
        return None, (
            "the trace on disk is not the trace the recorder finalized "
            f"(manifest {recorded_trace.get('sha256')}, disk {trace_sha256})"
        )
    video_fields = video_identity(video)
    if (
        recorded_video.get("sha256") != video_fields["sourceVideoSha256"]
        or recorded_video.get("bytes") != video_fields["sourceVideoBytes"]
    ):
        return None, (
            "the video on disk is not the video the recorder finalized "
            f"(manifest {recorded_video.get('sha256')}, disk "
            f"{video_fields['sourceVideoSha256']})"
        )

    if analysis.get("schema") != ANALYSIS_SCHEMA:
        return None, (
            "the analysis carries no recognized analyzer schema (got "
            f"{analysis.get('schema')!r}, expected {ANALYSIS_SCHEMA!r})"
        )
    analysis_status = analysis.get("status")
    if analysis_status not in {"pass", "partial", "fail"}:
        return None, f"the analysis status is not a verdict: {analysis_status!r}"
    if Path(str(analysis.get("source", ""))).resolve() != trace:
        return None, "the analysis names a different trace than this session's"
    if (
        analysis.get("sourceSha256") != trace_sha256
        or analysis.get("sourceBytes") != trace_stat.st_size
    ):
        return None, (
            "the analysis describes a different trace than the one on disk; it "
            "is stale and must be regenerated"
        )
    manifest_sha256 = sha256_file(manifest_path)
    if not analysis.get("manifestSha256"):
        return None, (
            "the analysis was produced without a recorder manifest, so it "
            "inherits no artifact identity; rerun analyze_trace.py --manifest"
        )
    if analysis.get("manifestSha256") != manifest_sha256:
        return None, (
            "the analysis was produced against a different recorder manifest "
            "than the one supplied; one of them changed after the fact"
        )
    inherited_video = analysis.get("videoIdentity")
    if (
        not isinstance(inherited_video, dict)
        or inherited_video.get("sha256") != video_fields["sourceVideoSha256"]
    ):
        return None, (
            "the analysis does not carry this recording's video identity; the "
            "video does not belong to the analyzed session"
        )

    return {
        "schema": EXTRACTION_SCHEMA,
        "recorderArtifactSchema": ARTIFACT_SCHEMA,
        "analysisSchema": ANALYSIS_SCHEMA,
        "manifestPath": str(manifest_path),
        "manifestSha256": manifest_sha256,
        **video_fields,
        "analysisPath": str(analysis_path),
        "analysisStatus": str(analysis_status),
        "analysisSha256": sha256_file(analysis_path),
        "sourceTracePath": str(trace),
        "sourceTraceSha256": trace_sha256,
        "sourceTraceBytes": trace_stat.st_size,
    }, None


def metadata_identity(
    chain: dict[str, Any],
    kinds: set[str],
    limit: int,
    selection: dict[str, Any],
    frame_plan: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        **chain,
        "requestedEventKinds": ordered_kinds(kinds),
        "selectedEventKinds": selection["selectedKinds"],
        "limit": limit,
        "selectedEvents": [
            {
                "kind": item["event"]["kind"],
                "elapsedMs": item["event"]["elapsedMs"],
                "filename": item["filename"],
            }
            for item in frame_plan
        ],
        "omittedCount": selection["omittedCount"],
        "omittedEventKinds": selection["omittedKinds"],
        "kindsWithoutEvidence": selection["missingAllKinds"],
    }


def matching_existing_output(
    output: Path,
    identity: dict[str, Any],
) -> tuple[bool, str]:
    """Only an exact match — same video, analysis, trace, plan, and PNG bytes —
    may be reused. Every other state is rejected; nothing is ever deleted."""
    metadata_path = output / METADATA_FILENAME
    if not metadata_path.is_file():
        return False, f"missing {metadata_path}"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False, f"invalid {metadata_path}"
    if not isinstance(metadata, dict):
        return False, f"invalid {metadata_path}"
    absent = [key for key in REQUIRED_METADATA_KEYS if key not in metadata]
    if absent:
        return False, "incomplete metadata; missing " + ", ".join(sorted(absent))
    for key, value in identity.items():
        if metadata.get(key) != value:
            return False, f"metadata field {key!r} does not match"
    if metadata.get("extractionFailures") != 0:
        return False, "prior extraction recorded frame failures"
    expected_entries = {
        METADATA_FILENAME,
        *[item["filename"] for item in identity["selectedEvents"]],
    }
    actual_entries = {entry.name for entry in output.iterdir()}
    if actual_entries != expected_entries:
        return False, "output files do not match metadata"

    recorded_frames = metadata.get("frames")
    if not isinstance(recorded_frames, list):
        return False, "metadata field 'frames' is not a list"
    by_filename = {
        str(entry.get("filename")): entry
        for entry in recorded_frames
        if isinstance(entry, dict)
    }
    if len(by_filename) != len(recorded_frames):
        return False, "metadata field 'frames' has malformed or duplicate entries"
    for item in identity["selectedEvents"]:
        filename = item["filename"]
        frame = output / filename
        if not frame.is_file() or frame.stat().st_size == 0:
            return False, f"frame is missing or empty: {frame}"
        recorded = by_filename.get(filename)
        if recorded is None:
            return False, f"metadata has no recorded hash for frame: {filename}"
        if recorded.get("elapsedMs") != item["elapsedMs"]:
            return False, f"frame target timestamp does not match: {filename}"
        if recorded.get("sha256") != sha256_file(frame):
            return False, f"extracted frame changed on disk: {filename}"
    if set(by_filename) != {item["filename"] for item in identity["selectedEvents"]}:
        return False, "metadata field 'frames' does not match the selected events"
    return True, ""


def enforce_owner_only(output: Path, filenames: list[str]) -> None:
    """Evidence and its metadata stay owner-only, including on a reuse pass."""
    output.chmod(0o700)
    for name in (METADATA_FILENAME, *filenames):
        entry = output / name
        if entry.is_file():
            entry.chmod(0o600)


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--analysis", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--kinds",
        default=(
            "badge_layer,phase,render,new_offer,offer_state,timeout,stale,"
            "focus_loss,focus_recovery,trace_reopened"
        ),
        help="Comma-separated notable event kinds",
    )
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()

    if args.limit <= 0:
        print("ERROR: --limit must be greater than zero.", file=sys.stderr)
        return 2
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("ERROR: ffmpeg is required.", file=sys.stderr)
        return 2
    video = args.video.resolve()
    analysis_path = args.analysis.resolve()
    manifest_path = args.manifest.resolve()
    if not video.is_file() or not analysis_path.is_file() or not manifest_path.is_file():
        print("ERROR: video, analysis, or manifest file does not exist.", file=sys.stderr)
        return 2

    if len({video.parent, analysis_path.parent, manifest_path.parent}) != 1:
        print(
            "ERROR: video, analysis, and manifest must belong to one session directory.",
            file=sys.stderr,
        )
        return 2
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        print(f"ERROR: manifest or analysis is not readable JSON: {error}", file=sys.stderr)
        return 2
    if not isinstance(manifest, dict) or not isinstance(analysis, dict):
        print(
            "ERROR: manifest and analysis must both be JSON objects.",
            file=sys.stderr,
        )
        return 2
    expected_trace = (video.parent / "trace.timestamped.jsonl").resolve()
    if not expected_trace.is_file():
        print(f"ERROR: session trace does not exist: {expected_trace}", file=sys.stderr)
        return 2
    chain, provenance_error = verified_chain(
        video, expected_trace, analysis_path, analysis, manifest_path, manifest
    )
    if chain is None:
        print(
            f"ERROR: provenance is not verifiable — {provenance_error}. No "
            "frames were extracted.",
            file=sys.stderr,
        )
        return 2
    analysis_status = chain["analysisStatus"]
    kinds = {item.strip() for item in args.kinds.split(",") if item.strip()}
    if not kinds:
        print("ERROR: at least one event kind must be requested.", file=sys.stderr)
        return 2
    selection = select_checkpoint_events(
        analysis.get("notableEvents", []),
        kinds,
        args.limit,
    )
    events = selection["events"]
    if not events:
        print(
            "ERROR: no timestamped notable events matched the requested kinds.",
            file=sys.stderr,
        )
        return 1
    base_output = args.output.resolve()
    output = output_for_status(base_output, str(analysis_status))
    family = output_family(base_output)
    for sibling_status, sibling in family.items():
        if sibling == output or not sibling.exists():
            continue
        if not sibling.is_dir() or any(sibling.iterdir()):
            print(
                "ERROR: conflicting sibling evidence directory exists: "
                f"{sibling}. Clean it explicitly or choose a new output path.",
                file=sys.stderr,
            )
            return 2
        print(
            f"WARNING: ignoring empty sibling evidence directory: {sibling}",
            file=sys.stderr,
        )

    frame_plan = selected_frame_plan(events)
    identity = metadata_identity(chain, kinds, args.limit, selection, frame_plan)
    if output.exists():
        if not output.is_dir():
            print(f"ERROR: output is not a directory: {output}", file=sys.stderr)
            return 2
        if any(output.iterdir()):
            matches, mismatch = matching_existing_output(output, identity)
            if not matches:
                print(
                    "ERROR: existing evidence does not match the current "
                    f"analysis and trace: {output} ({mismatch}). Clean it "
                    "explicitly or choose a new output path.",
                    file=sys.stderr,
                )
                return 2
            enforce_owner_only(
                output,
                [item["filename"] for item in identity["selectedEvents"]],
            )
            print(f"existing evidence matches; no extraction performed: {output}")
            print(f"events selected: {len(events)}")
            print(f"frames written: {len(events)}")
            print(f"analysis status: {analysis_status}")
            print(f"output: {output}")
            report_selection(selection)
            if analysis_status != "pass":
                print(
                    "WARNING: diagnostic frames came from a non-passing analysis.",
                    file=sys.stderr,
                )
            return (
                1
                if analysis_status != "pass" or selection["missingAllKinds"]
                else 0
            )
    output.mkdir(parents=True, mode=0o700, exist_ok=True)
    output.chmod(0o700)
    failures = 0
    written_frames: list[str] = []
    frame_records: list[dict[str, Any]] = []
    for item in frame_plan:
        seconds = item["seconds"]
        fast_seek = max(0.0, seconds - 2.0)
        accurate_seek = seconds - fast_seek
        destination = output / item["filename"]
        try:
            completed = subprocess.run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{fast_seek:.3f}",
                    "-i",
                    str(video),
                    "-ss",
                    f"{accurate_seek:.3f}",
                    "-frames:v",
                    "1",
                    "-y",
                    str(destination),
                ],
                check=False,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            failures += 1
            destination.unlink(missing_ok=True)
            continue
        if completed.returncode or not destination.is_file() or destination.stat().st_size == 0:
            failures += 1
            destination.unlink(missing_ok=True)
        else:
            destination.chmod(0o600)
            written_frames.append(destination.name)
            frame_records.append(
                {
                    "filename": destination.name,
                    "kind": item["event"]["kind"],
                    "elapsedMs": item["event"]["elapsedMs"],
                    "targetSeconds": round(item["seconds"], 3),
                    "bytes": destination.stat().st_size,
                    "sha256": sha256_file(destination),
                }
            )
    metadata = {
        **identity,
        "extractedAt": (
            dt.datetime.now(dt.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        ),
        "framesWritten": written_frames,
        "extractionFailures": failures,
        "frames": frame_records,
    }
    metadata_path = output / METADATA_FILENAME
    metadata_path.write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    metadata_path.chmod(0o600)
    print(f"events selected: {len(events)}")
    print(f"frames written: {len(events) - failures}")
    print(f"analysis status: {analysis_status}")
    print(f"output: {output}")
    report_selection(selection)
    if analysis_status != "pass":
        print(
            "WARNING: diagnostic frames came from a non-passing analysis.",
            file=sys.stderr,
        )
    return (
        1
        if failures
        or analysis_status != "pass"
        or selection["missingAllKinds"]
        else 0
    )


if __name__ == "__main__":
    raise SystemExit(main())
