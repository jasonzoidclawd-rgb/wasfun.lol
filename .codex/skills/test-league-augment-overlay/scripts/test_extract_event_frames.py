#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import extract_event_frames


class ExtractEventFramesTest(unittest.TestCase):
    def encode_video(self, destination: Path, color: str = "red") -> None:
        destination.unlink(missing_ok=True)
        subprocess.run(
            [
                shutil.which("ffmpeg") or "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"color={color}:size=64x64:rate=5:duration=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                str(destination),
            ],
            check=True,
        )

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.directory))
        self.video = self.directory / "screen.mp4"
        self.encode_video(self.video)
        self.trace = self.directory / "trace.timestamped.jsonl"
        self.trace.write_text("", encoding="utf-8")
        self.analysis = self.directory / "analysis.json"
        self.manifest = self.directory / "manifest.json"
        self.write_manifest()
        self.script = Path(__file__).with_name("extract_event_frames.py")

    def write_manifest(self) -> None:
        """A recorder manifest that actually identifies these artifacts.

        The recorder hashes the video and trace once, at finalization; every
        downstream check compares against these numbers.
        """
        self.manifest.write_text(
            json.dumps(
                {
                    "status": "complete",
                    "videoEnabled": True,
                    "artifacts": {
                        "schema": extract_event_frames.ARTIFACT_SCHEMA,
                        "video": self.identity(self.video),
                        "trace": self.identity(self.trace),
                        "traceRecordCount": 0,
                        "captureStopElapsedMs": 1_000,
                        "finalizationCompletedElapsedMs": 1_200,
                    },
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    def identity(self, path: Path) -> dict[str, object]:
        return {
            "path": str(path.resolve()),
            "sha256": extract_event_frames.sha256_file(path),
            "bytes": path.stat().st_size,
        }

    def analysis_document(
        self,
        status: str,
        events: list[dict[str, object]],
        source: Path | None = None,
    ) -> dict[str, object]:
        """An analysis that inherited its artifact identity from the manifest."""
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        return {
            "schema": extract_event_frames.ANALYSIS_SCHEMA,
            "status": status,
            "source": str((source or self.trace).resolve()),
            "sourceSha256": extract_event_frames.sha256_file(self.trace),
            "sourceBytes": self.trace.stat().st_size,
            "manifestPath": str(self.manifest.resolve()),
            "manifestSha256": extract_event_frames.sha256_file(self.manifest),
            "videoIdentity": manifest.get("artifacts", {}).get("video"),
            "notableEvents": events,
        }

    def run_extract(
        self,
        elapsed_ms: int,
        status: str = "pass",
        *,
        events: list[dict[str, object]] | None = None,
        kinds: str | None = None,
        limit: int | None = None,
        output: Path | None = None,
        video: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        selected_events = events or [
            {"kind": "phase", "elapsedMs": elapsed_ms, "payload": {}}
        ]
        self.analysis.write_text(
            json.dumps(self.analysis_document(status, selected_events)),
            encoding="utf-8",
        )
        command = [
            "/usr/bin/python3",
            str(self.script),
            "--video",
            str(video or self.video),
            "--analysis",
            str(self.analysis),
            "--manifest",
            str(self.manifest),
            "--output",
            str(output or self.directory / "frames"),
        ]
        if kinds is not None:
            command.extend(["--kinds", kinds])
        if limit is not None:
            command.extend(["--limit", str(limit)])
        return subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

    def run_raw(
        self, output: Path | None = None, video: Path | None = None
    ) -> subprocess.CompletedProcess[str]:
        """Run the extractor against the analysis exactly as it sits on disk."""
        return subprocess.run(
            [
                "/usr/bin/python3",
                str(self.script),
                "--video",
                str(video or self.video),
                "--analysis",
                str(self.analysis),
                "--manifest",
                str(self.manifest),
                "--output",
                str(output or self.directory / "frames"),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

    def test_out_of_range_seek_cannot_claim_a_written_frame(self) -> None:
        completed = self.run_extract(999_000)
        self.assertEqual(completed.returncode, 1)
        self.assertIn("frames written: 0", completed.stdout)
        self.assertEqual(list((self.directory / "frames").glob("*.png")), [])

    def test_written_frames_and_directory_are_owner_only(self) -> None:
        completed = self.run_extract(100)
        self.assertEqual(completed.returncode, 0)
        frames = list((self.directory / "frames").glob("*.png"))
        self.assertEqual(len(frames), 1)
        self.assertEqual((self.directory / "frames").stat().st_mode & 0o777, 0o700)
        self.assertEqual(frames[0].stat().st_mode & 0o777, 0o600)
        metadata = self.directory / "frames" / "extraction-metadata.json"
        self.assertEqual(metadata.stat().st_mode & 0o777, 0o600)
        contents = json.loads(metadata.read_text(encoding="utf-8"))
        self.assertEqual(contents["analysisPath"], str(self.analysis.resolve()))
        self.assertEqual(contents["analysisStatus"], "pass")
        self.assertEqual(contents["sourceTracePath"], str(self.trace.resolve()))
        self.assertEqual(contents["selectedEventKinds"], ["phase"])
        self.assertEqual(len(contents["analysisSha256"]), 64)
        self.assertEqual(len(contents["sourceTraceSha256"]), 64)
        self.assertTrue(contents["extractedAt"].endswith("Z"))

    def test_partial_analysis_writes_labeled_diagnostic_frames(self) -> None:
        completed = self.run_extract(100, status="partial")
        self.assertEqual(completed.returncode, 1)
        self.assertIn("diagnostic frames", completed.stdout)
        frames = list((self.directory / "frames-partial").glob("*.png"))
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].stat().st_mode & 0o777, 0o600)

    def test_matching_metadata_rerun_is_safe_noop(self) -> None:
        first = self.run_extract(100)
        metadata = self.directory / "frames" / "extraction-metadata.json"
        original_metadata = metadata.read_bytes()
        second = self.run_extract(100)
        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 0)
        self.assertIn("no extraction performed", second.stdout)
        self.assertEqual(metadata.read_bytes(), original_metadata)

    def test_source_mismatch_is_rejected(self) -> None:
        self.analysis.write_text(
            json.dumps(
                self.analysis_document(
                    "pass",
                    [{"kind": "phase", "elapsedMs": 100, "payload": {}}],
                    source=self.directory / "another-trace.jsonl",
                )
            ),
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                "/usr/bin/python3",
                str(self.script),
                "--video",
                str(self.video),
                "--analysis",
                str(self.analysis),
                "--manifest",
                str(self.manifest),
                "--output",
                str(self.directory / "mismatch-frames"),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)

    def test_ffmpeg_timeout_is_a_failed_extraction(self) -> None:
        self.analysis.write_text(
            json.dumps(
                self.analysis_document(
                    "pass",
                    [{"kind": "phase", "elapsedMs": 100, "payload": {}}],
                )
            ),
            encoding="utf-8",
        )
        output = self.directory / "timeout-frames"
        argv = [
            "extract_event_frames.py",
            "--video",
            str(self.video),
            "--analysis",
            str(self.analysis),
            "--manifest",
            str(self.manifest),
            "--output",
            str(output),
        ]
        with (
            patch.object(sys, "argv", argv),
            patch(
                "extract_event_frames.subprocess.run",
                side_effect=subprocess.TimeoutExpired("ffmpeg", 30),
            ),
        ):
            self.assertEqual(extract_event_frames.main(), 1)
        self.assertEqual(list(output.glob("*.png")), [])

    def test_late_focus_recovery_survives_early_noise(self) -> None:
        events = [
            {"kind": "timeout", "elapsedMs": index, "payload": {}}
            for index in range(40)
        ]
        events.extend(
            {"kind": "render", "elapsedMs": 100 + index, "payload": {}}
            for index in range(40)
        )
        events.append(
            {"kind": "focus_recovery", "elapsedMs": 500, "payload": {}}
        )

        selection = extract_event_frames.select_checkpoint_events(
            events,
            {"timeout", "render", "focus_recovery"},
            10,
        )

        self.assertEqual(len(selection["events"]), 10)
        self.assertIn(
            "focus_recovery",
            [event["kind"] for event in selection["events"]],
        )
        self.assertGreater(selection["omittedCount"], 0)

    def test_first_and_last_new_offer_frames_are_retained(self) -> None:
        events = [
            {
                "kind": "new_offer",
                "elapsedMs": 100 + index,
                "payload": {"sequence": index},
            }
            for index in range(60)
        ]

        selection = extract_event_frames.select_checkpoint_events(
            events,
            {"new_offer"},
            5,
        )
        selected_sequences = [
            event["payload"]["sequence"] for event in selection["events"]
        ]

        self.assertEqual(selected_sequences[0], 0)
        self.assertEqual(selected_sequences[-1], 59)

    def test_each_requested_present_kind_receives_evidence(self) -> None:
        kinds = {
            "focus_loss",
            "focus_recovery",
            "new_offer",
            "phase",
            "render",
        }
        events = [
            {"kind": kind, "elapsedMs": index * 100, "payload": {}}
            for index, kind in enumerate(reversed(sorted(kinds)))
        ]

        selection = extract_event_frames.select_checkpoint_events(
            events,
            kinds,
            len(kinds),
        )

        self.assertEqual(set(selection["selectedKinds"]), kinds)
        self.assertEqual(selection["missingAllKinds"], [])

    def test_omission_is_reported_without_dropping_requested_kind(self) -> None:
        events = [
            {"kind": "timeout", "elapsedMs": 100, "payload": {"index": index}}
            for index in range(55)
        ]
        events.append(
            {"kind": "focus_recovery", "elapsedMs": 100, "payload": {}}
        )

        completed = self.run_extract(
            100,
            events=events,
            kinds="timeout,focus_recovery",
            limit=5,
        )

        self.assertEqual(completed.returncode, 0)
        self.assertIn("events omitted: 51", completed.stdout)
        self.assertIn("omitted event kinds: timeout", completed.stdout)
        metadata = json.loads(
            (
                self.directory / "frames" / "extraction-metadata.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(metadata["omittedCount"], 51)
        self.assertEqual(metadata["omittedEventKinds"], ["timeout"])
        self.assertIn("focus_recovery", metadata["selectedEventKinds"])

    def test_limit_removing_all_evidence_for_requested_kind_is_nonzero(self) -> None:
        events = [
            {"kind": "phase", "elapsedMs": 100, "payload": {}},
            {"kind": "new_offer", "elapsedMs": 100, "payload": {}},
            {"kind": "focus_recovery", "elapsedMs": 100, "payload": {}},
        ]

        completed = self.run_extract(
            100,
            events=events,
            kinds="phase,new_offer,focus_recovery",
            limit=2,
        )

        self.assertEqual(completed.returncode, 1)
        self.assertIn("requested kinds without evidence: phase", completed.stdout)

    def test_frame_naming_is_deterministic(self) -> None:
        events = [
            {"kind": "timeout", "elapsedMs": 900, "payload": {}},
            {"kind": "focus_recovery", "elapsedMs": 800, "payload": {}},
            {"kind": "new_offer", "elapsedMs": 700, "payload": {}},
        ]
        first = extract_event_frames.select_checkpoint_events(
            events,
            {"timeout", "focus_recovery", "new_offer"},
            3,
        )
        second = extract_event_frames.select_checkpoint_events(
            events,
            {"timeout", "focus_recovery", "new_offer"},
            3,
        )

        self.assertEqual(
            [
                item["filename"]
                for item in extract_event_frames.selected_frame_plan(
                    first["events"]
                )
            ],
            [
                item["filename"]
                for item in extract_event_frames.selected_frame_plan(
                    second["events"]
                )
            ],
        )

    def test_existing_pass_evidence_blocks_fail_output(self) -> None:
        frames = self.directory / "frames"
        frames.mkdir()
        (frames / "old.png").write_bytes(b"old")

        completed = self.run_extract(100, status="fail")

        self.assertEqual(completed.returncode, 2)
        self.assertIn(str(frames), completed.stdout)
        self.assertFalse((self.directory / "frames-fail").exists())

    def test_existing_fail_evidence_blocks_pass_output(self) -> None:
        frames_fail = self.directory / "frames-fail"
        frames_fail.mkdir()
        (frames_fail / "old.png").write_bytes(b"old")

        completed = self.run_extract(100, status="pass")

        self.assertEqual(completed.returncode, 2)
        self.assertIn(str(frames_fail), completed.stdout)
        self.assertFalse((self.directory / "frames").exists())

    def test_empty_conflicting_sibling_is_ignored_with_warning(self) -> None:
        (self.directory / "frames-fail").mkdir()

        completed = self.run_extract(100, status="pass")

        self.assertEqual(completed.returncode, 0)
        self.assertIn("ignoring empty sibling", completed.stdout)
        self.assertTrue((self.directory / "frames").is_dir())

    def test_status_change_cannot_leave_pass_and_fail_evidence_valid(self) -> None:
        first = self.run_extract(100, status="pass")
        second = self.run_extract(100, status="fail")

        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 2)
        self.assertTrue((self.directory / "frames").is_dir())
        self.assertFalse((self.directory / "frames-fail").exists())

    def test_changed_analysis_hash_fails_closed(self) -> None:
        first = self.run_extract(100)
        analysis = json.loads(self.analysis.read_text(encoding="utf-8"))
        analysis["warnings"] = ["changed"]
        self.analysis.write_text(json.dumps(analysis), encoding="utf-8")

        completed = subprocess.run(
            [
                "/usr/bin/python3",
                str(self.script),
                "--video",
                str(self.video),
                "--analysis",
                str(self.analysis),
                "--manifest",
                str(self.manifest),
                "--output",
                str(self.directory / "frames"),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

        self.assertEqual(first.returncode, 0)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("analysisSha256", completed.stdout)

    def test_changed_trace_hash_fails_closed(self) -> None:
        first = self.run_extract(100)
        self.trace.write_text("changed\n", encoding="utf-8")
        second = self.run_extract(100)

        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 2)
        # Caught at the provenance gate now, before any extraction: the
        # recorder's stored trace hash no longer describes the file on disk.
        self.assertIn("not the trace the recorder finalized", second.stdout)

    def read_metadata(self, output: str = "frames") -> dict[str, object]:
        return json.loads(
            (self.directory / output / "extraction-metadata.json").read_text(
                encoding="utf-8"
            )
        )

    def test_metadata_binds_frames_to_the_source_video(self) -> None:
        completed = self.run_extract(100)
        metadata = self.read_metadata()
        stat = self.video.stat()

        self.assertEqual(completed.returncode, 0)
        for key in extract_event_frames.REQUIRED_METADATA_KEYS:
            self.assertIn(key, metadata)
        self.assertEqual(metadata["sourceVideoPath"], str(self.video.resolve()))
        self.assertEqual(
            metadata["sourceVideoSha256"],
            extract_event_frames.sha256_file(self.video),
        )
        self.assertEqual(metadata["sourceVideoBytes"], stat.st_size)
        self.assertEqual(metadata["sourceVideoMtimeNs"], stat.st_mtime_ns)
        self.assertEqual(len(metadata["sourceVideoSha256"]), 64)

        frames = metadata["frames"]
        self.assertEqual(len(frames), 1)
        self.assertEqual(metadata["framesWritten"], [frames[0]["filename"]])
        self.assertEqual(
            [item["filename"] for item in metadata["selectedEvents"]],
            [frames[0]["filename"]],
        )
        written = self.directory / "frames" / str(frames[0]["filename"])
        self.assertEqual(frames[0]["elapsedMs"], 100)
        self.assertEqual(frames[0]["targetSeconds"], 0.1)
        self.assertEqual(frames[0]["bytes"], written.stat().st_size)
        self.assertEqual(
            frames[0]["sha256"], extract_event_frames.sha256_file(written)
        )

    def test_replaced_video_fails_closed(self) -> None:
        first = self.run_extract(100)
        self.encode_video(self.video, color="blue")
        second = self.run_extract(100)

        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 2)
        self.assertIn("not the video the recorder finalized", second.stdout)
        self.assertTrue((self.directory / "frames").is_dir())

    def test_touched_video_identity_fails_closed(self) -> None:
        first = self.run_extract(100)
        metadata = self.read_metadata()
        os.utime(
            self.video,
            ns=(
                int(metadata["sourceVideoMtimeNs"]) + 1_000_000,
                int(metadata["sourceVideoMtimeNs"]) + 1_000_000,
            ),
        )
        second = self.run_extract(100)

        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 2)
        self.assertIn("sourceVideoMtimeNs", second.stdout)

    def test_tampered_frame_fails_closed(self) -> None:
        first = self.run_extract(100)
        frame = next((self.directory / "frames").glob("*.png"))
        with frame.open("ab") as handle:
            handle.write(b"tampered")
        second = self.run_extract(100)

        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 2)
        self.assertIn("changed on disk", second.stdout)
        self.assertTrue(frame.is_file())

    def test_incomplete_metadata_fails_closed(self) -> None:
        for dropped in ("frames", "sourceVideoSha256", "extractedAt"):
            with self.subTest(dropped=dropped):
                shutil.rmtree(self.directory / "frames", ignore_errors=True)
                first = self.run_extract(100)
                metadata_path = (
                    self.directory / "frames" / "extraction-metadata.json"
                )
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                metadata.pop(dropped)
                metadata_path.write_text(
                    json.dumps(metadata), encoding="utf-8"
                )
                second = self.run_extract(100)

                self.assertEqual(first.returncode, 0)
                self.assertEqual(second.returncode, 2)
                self.assertIn("incomplete metadata", second.stdout)
                self.assertIn(dropped, second.stdout)

    def test_frame_hash_record_must_cover_every_selected_event(self) -> None:
        first = self.run_extract(100)
        metadata_path = self.directory / "frames" / "extraction-metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["frames"] = []
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
        second = self.run_extract(100)

        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 2)
        self.assertIn("no recorded hash", second.stdout)

    def test_exact_match_rerun_reasserts_owner_only_permissions(self) -> None:
        first = self.run_extract(100)
        frames = self.directory / "frames"
        metadata_path = frames / "extraction-metadata.json"
        frame = next(frames.glob("*.png"))
        original = {
            "metadata": metadata_path.read_bytes(),
            "frame": frame.read_bytes(),
        }
        frames.chmod(0o755)
        frame.chmod(0o644)
        metadata_path.chmod(0o644)

        second = self.run_extract(100)

        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 0)
        self.assertIn("no extraction performed", second.stdout)
        self.assertEqual(frames.stat().st_mode & 0o777, 0o700)
        self.assertEqual(frame.stat().st_mode & 0o777, 0o600)
        self.assertEqual(metadata_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(metadata_path.read_bytes(), original["metadata"])
        self.assertEqual(frame.read_bytes(), original["frame"])

    # --- provenance chain: recorder -> analyzer -> extractor ---------------

    def test_exact_chain_is_verified_and_recorded(self) -> None:
        completed = self.run_extract(100)
        metadata = self.read_metadata()
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))

        self.assertEqual(completed.returncode, 0)
        self.assertEqual(metadata["schema"], extract_event_frames.EXTRACTION_SCHEMA)
        self.assertEqual(
            metadata["recorderArtifactSchema"],
            extract_event_frames.ARTIFACT_SCHEMA,
        )
        self.assertEqual(
            metadata["analysisSchema"], extract_event_frames.ANALYSIS_SCHEMA
        )
        self.assertEqual(metadata["manifestPath"], str(self.manifest.resolve()))
        self.assertEqual(
            metadata["manifestSha256"],
            extract_event_frames.sha256_file(self.manifest),
        )
        # The identities written into evidence are the recorder's, not hashes
        # the extractor invented for itself.
        self.assertEqual(
            metadata["sourceVideoSha256"], manifest["artifacts"]["video"]["sha256"]
        )
        self.assertEqual(
            metadata["sourceTraceSha256"], manifest["artifacts"]["trace"]["sha256"]
        )
        self.assertEqual(
            metadata["sourceTraceBytes"], manifest["artifacts"]["trace"]["bytes"]
        )

    def test_analysis_from_another_trace_fails_closed(self) -> None:
        other_trace = self.directory / "other-trace.jsonl"
        other_trace.write_text("[game-poll] {}\n", encoding="utf-8")
        analysis = self.analysis_document(
            "pass", [{"kind": "phase", "elapsedMs": 100, "payload": {}}]
        )
        # Analysis of trace A, presented alongside session trace B.
        analysis["sourceSha256"] = extract_event_frames.sha256_file(other_trace)
        analysis["sourceBytes"] = other_trace.stat().st_size
        self.analysis.write_text(json.dumps(analysis), encoding="utf-8")

        completed = self.run_raw()

        self.assertEqual(completed.returncode, 2)
        self.assertIn("stale and must be regenerated", completed.stdout)
        self.assertFalse((self.directory / "frames").exists())

    def test_modified_manifest_fails_closed(self) -> None:
        first = self.run_extract(100)
        # Edit the root of trust itself: claim a different video identity. A
        # fresh analysis inherits the forged identity, so only comparing the
        # manifest against the bytes on disk can catch this.
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        manifest["artifacts"]["video"]["sha256"] = "0" * 64
        self.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        second = self.run_extract(100, output=self.directory / "after-manifest")

        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 2)
        self.assertIn("not the video the recorder finalized", second.stdout)
        self.assertFalse((self.directory / "after-manifest").exists())

    def test_recording_failed_repository_drift_manifest_fails_closed(self) -> None:
        # record_session.py holds a repository-drift session at
        # "recording-failed" precisely so this generic completeness gate —
        # not any drift-specific extractor logic — refuses it.
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        manifest["status"] = "recording-failed"
        manifest["failureReason"] = "repository-drift"
        manifest["repositoryFingerprintSchema"] = 1
        manifest["repositoryFingerprintStart"] = "a" * 64
        manifest["repositoryFingerprintFinal"] = "b" * 64
        manifest["repositoryStable"] = False
        self.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        result = self.run_extract(100, output=self.directory / "drift-rejected")

        self.assertEqual(result.returncode, 2)
        self.assertIn(
            "does not describe a complete video session", result.stdout
        )
        self.assertFalse((self.directory / "drift-rejected").exists())

    def test_recording_failed_checkpoint_unreadable_manifest_fails_closed(self) -> None:
        # record_session.py holds a checkpoint-unreadable session at
        # "recording-failed" precisely so this generic completeness gate —
        # not any checkpoint-specific extractor logic — refuses it.
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        manifest["status"] = "recording-failed"
        manifest["failureReason"] = "trace-checkpoint-unreadable"
        manifest["traceContinuityVerified"] = False
        self.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        result = self.run_extract(100, output=self.directory / "checkpoint-rejected")

        self.assertEqual(result.returncode, 2)
        self.assertIn(
            "does not describe a complete video session", result.stdout
        )
        self.assertFalse((self.directory / "checkpoint-rejected").exists())

    def test_analysis_generated_before_a_manifest_change_fails_closed(self) -> None:
        # The analysis is written against the manifest as it stands now...
        self.analysis.write_text(
            json.dumps(
                self.analysis_document(
                    "pass", [{"kind": "phase", "elapsedMs": 100, "payload": {}}]
                )
            ),
            encoding="utf-8",
        )
        # ...and the manifest changes afterwards.
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        manifest["provenance"] = {"rewritten": True}
        self.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        completed = self.run_raw()

        self.assertEqual(completed.returncode, 2)
        self.assertIn("one of them changed after the fact", completed.stdout)
        self.assertFalse((self.directory / "frames").exists())

    def test_missing_recorder_provenance_fails_closed(self) -> None:
        for missing in ("artifacts", "video", "analysisManifestIdentity"):
            with self.subTest(missing=missing):
                self.write_manifest()
                analysis = self.analysis_document(
                    "pass", [{"kind": "phase", "elapsedMs": 100, "payload": {}}]
                )
                manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
                if missing == "artifacts":
                    manifest.pop("artifacts")
                elif missing == "video":
                    manifest["artifacts"].pop("video")
                if missing != "analysisManifestIdentity":
                    self.manifest.write_text(
                        json.dumps(manifest, indent=2), encoding="utf-8"
                    )
                    analysis["manifestSha256"] = (
                        extract_event_frames.sha256_file(self.manifest)
                    )
                else:
                    # A legacy analysis produced without --manifest.
                    analysis["manifestSha256"] = None
                    analysis["videoIdentity"] = None
                self.analysis.write_text(json.dumps(analysis), encoding="utf-8")

                completed = self.run_raw()

                self.assertEqual(completed.returncode, 2)
                self.assertIn("provenance is not verifiable", completed.stdout)
                self.assertFalse((self.directory / "frames").exists())

    def test_original_video_and_trace_are_never_modified(self) -> None:
        before = {
            "video": extract_event_frames.sha256_file(self.video),
            "trace": extract_event_frames.sha256_file(self.trace),
            "manifest": extract_event_frames.sha256_file(self.manifest),
        }

        completed = self.run_extract(100)

        self.assertEqual(completed.returncode, 0)
        self.assertEqual(extract_event_frames.sha256_file(self.video), before["video"])
        self.assertEqual(extract_event_frames.sha256_file(self.trace), before["trace"])
        self.assertEqual(
            extract_event_frames.sha256_file(self.manifest), before["manifest"]
        )

    def test_unresolved_video_path_resolves_deterministically(self) -> None:
        (self.directory / "sub").mkdir()
        alias = self.directory / "sub" / ".." / "screen.mp4"

        first = self.run_extract(100, video=alias)
        metadata = self.read_metadata()
        second = self.run_extract(100)

        self.assertEqual(first.returncode, 0)
        self.assertEqual(metadata["sourceVideoPath"], str(self.video.resolve()))
        self.assertEqual(second.returncode, 0)
        self.assertIn("no extraction performed", second.stdout)


if __name__ == "__main__":
    unittest.main()
