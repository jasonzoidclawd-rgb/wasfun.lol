#!/usr/bin/env python3

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import preflight
import record_session
from record_session import (
    begin_shutdown,
    boundary_is_complete,
    capture_log_errors,
    capture_log_warnings,
    check_output_capacity,
    check_repo_fingerprint,
    content_checkpoint,
    drain_validation_error,
    encoder_names,
    finalize_trace_silence,
    finalized_artifacts,
    foreign_writable_holder,
    initial_trace_stats,
    make_owner_only_dir,
    observe_trace_line,
    progress_reader,
    repository_drift_monitor,
    required_free_bytes,
    revalidate_trusted_writer,
    sha256_file,
    tail_trace,
    trace_boundary,
    trace_continuity_verified,
    validate_video,
)


class PreflightTest(unittest.TestCase):
    def repo(self) -> Path:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        (directory / "overlay").mkdir()
        (directory / "overlay" / "package.json").write_text("{}")
        return directory

    def collect_with_tools(
        self,
        absent: set[str],
        *,
        process_listing: bool = True,
    ) -> dict[str, object]:
        with (
            patch.object(preflight, "process_rows", return_value=[]),
            patch.object(
                preflight.shutil,
                "which",
                side_effect=lambda name: None if name in absent else f"/usr/bin/{name}",
            ),
            patch.object(
                preflight,
                "capture_devices",
                return_value=[{"index": 0, "label": "Capture screen 0"}],
            ),
            patch.object(preflight, "git_value", return_value=""),
            patch.object(preflight, "dirty_status_entries", return_value=[]),
            patch.object(preflight.platform, "system", return_value="Darwin"),
            patch.object(
                preflight,
                "process_listing_available",
                return_value=process_listing,
            ),
        ):
            return preflight.collect(
                self.repo(),
                require_overlay=False,
                require_game=False,
            )

    def test_unused_operator_tools_never_fail_preflight(self) -> None:
        # jq, rg, and screencapture are not invoked anywhere in this skill, so
        # their absence is reported but must not block a recording session.
        result = self.collect_with_tools({"jq", "rg", "screencapture"})

        self.assertTrue(result["ok"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(
            sorted(result["missingOptionalTools"]),
            ["jq", "rg", "screencapture"],
        )
        self.assertEqual(result["missingRequiredTools"], [])
        self.assertEqual(
            sorted(result["requiredTools"]),
            sorted(preflight.REQUIRED_TOOLS),
        )
        self.assertNotIn("jq", result["requiredTools"])
        self.assertNotIn("rg", result["requiredTools"])
        self.assertNotIn("screencapture", result["requiredTools"])

    def test_missing_real_dependency_fails_closed(self) -> None:
        for tool in preflight.REQUIRED_TOOLS:
            with self.subTest(tool=tool):
                result = self.collect_with_tools({tool})
                self.assertFalse(result["ok"])
                self.assertEqual(result["missingRequiredTools"], [tool])
                self.assertIn(
                    f"Missing required tools: {tool}",
                    result["errors"],
                )

    def test_missing_process_inspection_fails_closed(self) -> None:
        result = self.collect_with_tools(set(), process_listing=False)

        self.assertFalse(result["ok"])
        self.assertFalse(result["processInspection"]["available"])
        self.assertTrue(
            any("Process inspection" in error for error in result["errors"])
        )

    def test_missing_capture_support_fails_closed(self) -> None:
        with (
            patch.object(preflight, "process_rows", return_value=[]),
            patch.object(
                preflight.shutil,
                "which",
                side_effect=lambda name: f"/usr/bin/{name}",
            ),
            patch.object(preflight, "capture_devices", return_value=[]),
            patch.object(preflight, "git_value", return_value=""),
            patch.object(preflight, "dirty_status_entries", return_value=[]),
            patch.object(preflight.platform, "system", return_value="Darwin"),
        ):
            result = preflight.collect(
                self.repo(),
                require_overlay=False,
                require_game=False,
            )

        self.assertFalse(result["ok"])
        self.assertTrue(
            any("screen capture device" in error for error in result["errors"])
        )

    def test_capture_parser_keeps_only_screen_indices(self) -> None:
        listing = """
[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] [1] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Microphone
"""
        self.assertEqual(
            preflight.parse_capture_devices(listing),
            [{"index": 1, "label": "Capture screen 0"}],
        )

    def test_required_overlay_with_unknown_cwd_fails_closed(self) -> None:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        (directory / "overlay").mkdir()
        (directory / "overlay" / "package.json").write_text("{}")
        rows = [
            {
                "pid": 123,
                "ppid": 1,
                "pgid": 123,
                "comm": "target/debug/mayhem-oracle-overlay",
            }
        ]
        with (
            patch.object(preflight, "process_rows", return_value=rows),
            patch.object(preflight, "process_cwd", return_value=None),
            patch.object(
                preflight.shutil,
                "which",
                side_effect=lambda name: f"/usr/bin/{name}",
            ),
            patch.object(
                preflight,
                "capture_devices",
                return_value=[{"index": 0, "label": "Capture screen 0"}],
            ),
            patch.object(preflight, "git_value", return_value=""),
            patch.object(preflight.platform, "system", return_value="Darwin"),
            patch.object(
                preflight,
                "credential_environment_check",
                return_value={
                    "credentialEnvironmentVerified": True,
                    "forbiddenCredentialNamesPresent": False,
                },
            ),
        ):
            result = preflight.collect(
                directory,
                require_overlay=True,
                require_game=False,
                overlay_pid=123,
            )
        self.assertFalse(result["ok"])
        self.assertTrue(any("cwd" in error for error in result["errors"]))
        # `directory` is a plain tempdir, not a git repository: dirty-status
        # provenance must fail closed rather than silently report "clean".
        self.assertEqual(result["repository"]["dirtyPaths"], [])
        self.assertTrue(
            any("git status" in error for error in result["errors"])
        )

    def _collect_with_credential_result(
        self, credential_result: dict[str, object]
    ) -> dict[str, object]:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        (directory / "overlay").mkdir()
        (directory / "overlay" / "package.json").write_text("{}")
        expected_cwd = str((directory / "overlay").resolve())
        rows = [
            {"pid": 4242, "ppid": 1, "pgid": 4242, "comm": "mayhem-oracle-overlay"}
        ]
        with (
            patch.object(preflight, "process_rows", return_value=rows),
            patch.object(preflight, "process_cwd", return_value=expected_cwd),
            patch.object(
                preflight.shutil,
                "which",
                side_effect=lambda name: f"/usr/bin/{name}",
            ),
            patch.object(
                preflight,
                "capture_devices",
                return_value=[{"index": 0, "label": "Capture screen 0"}],
            ),
            patch.object(preflight, "git_value", return_value=""),
            patch.object(preflight, "dirty_status_entries", return_value=[]),
            patch.object(preflight.platform, "system", return_value="Darwin"),
            patch.object(
                preflight,
                "credential_environment_check",
                return_value=credential_result,
            ),
        ):
            return preflight.collect(
                directory,
                require_overlay=True,
                require_game=False,
                overlay_pid=4242,
            )

    def test_collect_fails_closed_on_a_forbidden_credential_variable(self) -> None:
        result = self._collect_with_credential_result(
            {
                "credentialEnvironmentVerified": True,
                "forbiddenCredentialNamesPresent": True,
            }
        )
        self.assertFalse(result["ok"])
        self.assertTrue(
            any("credential" in error.lower() for error in result["errors"])
        )
        self.assertEqual(
            result["credentialEnvironment"],
            {
                "credentialEnvironmentVerified": True,
                "forbiddenCredentialNamesPresent": True,
            },
        )

    def test_collect_fails_closed_when_credential_environment_unverifiable(
        self,
    ) -> None:
        result = self._collect_with_credential_result(
            {
                "credentialEnvironmentVerified": False,
                "forbiddenCredentialNamesPresent": True,
            }
        )
        self.assertFalse(result["ok"])
        self.assertTrue(
            any("credential" in error.lower() for error in result["errors"])
        )

    def test_collect_passes_with_a_clean_credential_environment(self) -> None:
        result = self._collect_with_credential_result(
            {
                "credentialEnvironmentVerified": True,
                "forbiddenCredentialNamesPresent": False,
            }
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["errors"], [])


class CredentialEnvironmentTest(unittest.TestCase):
    """The exact pinned overlay process's environment must be verified clear
    of MAYHEM_TELEMETRY_ENDPOINT / MAYHEM_DEVICE_TOKEN — never its value."""

    def overlay_row(
        self, pid: int = 4242, pgid: int = 4242, comm: str = "mayhem-oracle-overlay"
    ) -> dict[str, object]:
        return {"pid": pid, "ppid": 1, "pgid": pgid, "comm": comm}

    def ps_result(self, returncode: int, stdout: str) -> subprocess.CompletedProcess:
        return subprocess.CompletedProcess(
            args=["ps"], returncode=returncode, stdout=stdout, stderr=""
        )

    def test_clean_overlay_environment_passes(self) -> None:
        with (
            patch.object(preflight, "process_rows", return_value=[self.overlay_row()]),
            patch.object(
                preflight.subprocess,
                "run",
                return_value=self.ps_result(
                    0,
                    "  PID TTY           TIME CMD\n"
                    "4242 ttys005    0:00.00 overlay PATH=/usr/bin HOME=/Users/x\n",
                ),
            ),
        ):
            result = preflight.credential_environment_check(4242)
        self.assertEqual(
            result,
            {
                "credentialEnvironmentVerified": True,
                "forbiddenCredentialNamesPresent": False,
            },
        )

    def test_telemetry_variable_present_fails(self) -> None:
        with (
            patch.object(preflight, "process_rows", return_value=[self.overlay_row()]),
            patch.object(
                preflight.subprocess,
                "run",
                return_value=self.ps_result(
                    0,
                    "  PID TTY           TIME CMD\n"
                    "4242 ttys005    0:00.00 overlay PATH=/usr/bin "
                    "MAYHEM_TELEMETRY_ENDPOINT=https://example.invalid/collect\n",
                ),
            ),
        ):
            result = preflight.credential_environment_check(4242)
        self.assertTrue(result["credentialEnvironmentVerified"])
        self.assertTrue(result["forbiddenCredentialNamesPresent"])

    def test_device_token_variable_present_fails(self) -> None:
        with (
            patch.object(preflight, "process_rows", return_value=[self.overlay_row()]),
            patch.object(
                preflight.subprocess,
                "run",
                return_value=self.ps_result(
                    0,
                    "  PID TTY           TIME CMD\n"
                    "4242 ttys005    0:00.00 overlay PATH=/usr/bin "
                    "MAYHEM_DEVICE_TOKEN=placeholder-device-token\n",
                ),
            ),
        ):
            result = preflight.credential_environment_check(4242)
        self.assertTrue(result["credentialEnvironmentVerified"])
        self.assertTrue(result["forbiddenCredentialNamesPresent"])

    def test_both_forbidden_variables_present_fails(self) -> None:
        with (
            patch.object(preflight, "process_rows", return_value=[self.overlay_row()]),
            patch.object(
                preflight.subprocess,
                "run",
                return_value=self.ps_result(
                    0,
                    "  PID TTY           TIME CMD\n"
                    "4242 ttys005    0:00.00 overlay "
                    "MAYHEM_TELEMETRY_ENDPOINT=https://example.invalid/collect "
                    "MAYHEM_DEVICE_TOKEN=placeholder-device-token\n",
                ),
            ),
        ):
            result = preflight.credential_environment_check(4242)
        self.assertTrue(result["credentialEnvironmentVerified"])
        self.assertTrue(result["forbiddenCredentialNamesPresent"])

    def test_empty_string_variable_still_counts_as_present(self) -> None:
        with (
            patch.object(preflight, "process_rows", return_value=[self.overlay_row()]),
            patch.object(
                preflight.subprocess,
                "run",
                return_value=self.ps_result(
                    0,
                    "  PID TTY           TIME CMD\n"
                    "4242 ttys005    0:00.00 overlay PATH=/usr/bin "
                    "MAYHEM_DEVICE_TOKEN=\n",
                ),
            ),
        ):
            result = preflight.credential_environment_check(4242)
        self.assertTrue(result["credentialEnvironmentVerified"])
        self.assertTrue(result["forbiddenCredentialNamesPresent"])

    def test_environment_inspection_failure_fails_closed(self) -> None:
        with (
            patch.object(preflight, "process_rows", return_value=[self.overlay_row()]),
            patch.object(
                preflight.subprocess, "run", return_value=self.ps_result(1, "")
            ),
        ):
            result = preflight.credential_environment_check(4242)
        self.assertEqual(
            result,
            {
                "credentialEnvironmentVerified": False,
                "forbiddenCredentialNamesPresent": True,
            },
        )

    def test_empty_ps_output_fails_closed(self) -> None:
        with (
            patch.object(preflight, "process_rows", return_value=[self.overlay_row()]),
            patch.object(
                preflight.subprocess,
                "run",
                return_value=self.ps_result(0, "  PID TTY           TIME CMD\n"),
            ),
        ):
            result = preflight.credential_environment_check(4242)
        self.assertFalse(result["credentialEnvironmentVerified"])
        self.assertTrue(result["forbiddenCredentialNamesPresent"])

    def test_missing_process_listing_fails_closed(self) -> None:
        with patch.object(preflight, "process_listing_available", return_value=False):
            result = preflight.credential_environment_check(4242)
        self.assertEqual(
            result,
            {
                "credentialEnvironmentVerified": False,
                "forbiddenCredentialNamesPresent": True,
            },
        )

    def test_comm_name_mismatch_fails_closed(self) -> None:
        # No process row matches pid 4242 at all — process listing succeeded,
        # but the pinned overlay pid itself was never found.
        with patch.object(preflight, "process_rows", return_value=[]):
            result = preflight.credential_environment_check(4242)
        self.assertFalse(result["credentialEnvironmentVerified"])
        self.assertTrue(result["forbiddenCredentialNamesPresent"])

    def test_inspecting_the_trace_holder_but_not_the_overlay_pid_cannot_pass(
        self,
    ) -> None:
        # Only a different pid (e.g. the trace holder) is known to
        # process_rows; the pinned overlay pid (4242) is absent. Verifying
        # the holder's process group is never a substitute for inspecting
        # the pinned overlay process itself.
        holder_row = self.overlay_row(pid=9999, pgid=4242)
        with (
            patch.object(preflight, "process_rows", return_value=[holder_row]),
            patch.object(
                preflight.subprocess,
                "run",
                return_value=self.ps_result(
                    0, "  PID TTY           TIME CMD\n9999 ttys005 0:00.00 overlay\n"
                ),
            ),
        ):
            result = preflight.credential_environment_check(4242)
        self.assertFalse(result["credentialEnvironmentVerified"])
        self.assertTrue(result["forbiddenCredentialNamesPresent"])

    def test_pid_replacement_between_checkpoints_fails_closed(self) -> None:
        with (
            patch.object(preflight, "process_rows", return_value=[self.overlay_row()]),
            patch.object(
                preflight.subprocess,
                "run",
                return_value=self.ps_result(
                    0,
                    "  PID TTY           TIME CMD\n"
                    "4242 ttys005    0:00.00 overlay PATH=/usr/bin\n",
                ),
            ),
        ):
            first = preflight.credential_environment_check(4242)
        self.assertTrue(first["credentialEnvironmentVerified"])
        self.assertFalse(first["forbiddenCredentialNamesPresent"])

        # The same pid is now an unrelated process (the original overlay
        # exited and the pid was reused) — this must never reuse the earlier
        # "clean" verdict.
        with patch.object(
            preflight,
            "process_rows",
            return_value=[self.overlay_row(comm="/usr/bin/unrelated-process")],
        ):
            second = preflight.credential_environment_check(4242)
        self.assertFalse(second["credentialEnvironmentVerified"])
        self.assertTrue(second["forbiddenCredentialNamesPresent"])

    def test_placeholder_credential_value_never_appears_in_the_result(self) -> None:
        # A real synthetic subprocess carrying a harmless placeholder value,
        # inspected through the real (unmocked) production code path. The
        # placeholder must never surface anywhere in the returned structure,
        # regardless of whether this host lets `ps` see the child's
        # environment at all — an uninspectable environment must fail closed,
        # never echo back what it could not read.
        placeholder = "sekrit-placeholder-value-must-never-leak-9f3c"
        env = dict(os.environ)
        env["MAYHEM_TELEMETRY_ENDPOINT"] = placeholder
        process = subprocess.Popen(["/bin/sleep", "5"], env=env)
        self.addCleanup(lambda: (process.terminate(), process.wait(timeout=5)))
        with patch.object(
            preflight,
            "process_rows",
            return_value=[self.overlay_row(pid=process.pid, pgid=process.pid)],
        ):
            result = preflight.credential_environment_check(process.pid)

        self.assertIsInstance(result["credentialEnvironmentVerified"], bool)
        self.assertIsInstance(result["forbiddenCredentialNamesPresent"], bool)
        self.assertNotIn(placeholder, json.dumps(result))
        # Fail-closed is an acceptable outcome here (this host may not expose
        # a freshly spawned child's environment to `ps` at all); reporting
        # the child's *own* credential as absent while never having actually
        # inspected it is not.
        if not result["credentialEnvironmentVerified"]:
            self.assertTrue(result["forbiddenCredentialNamesPresent"])


class DirtyStatusEntriesTest(unittest.TestCase):
    """`git status --short` collapses an entire untracked directory into one
    line (`?? .codex/`), undercounting the actual dirty paths recorded as
    provenance. `dirty_status_entries` must expand every one of them."""

    def make_repo(self) -> Path:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        subprocess.run(["git", "init", "-q"], cwd=directory, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=directory,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"], cwd=directory, check=True
        )
        return directory

    def test_nested_untracked_directory_expands_to_every_file(self) -> None:
        repo = self.make_repo()
        (repo / "newdir").mkdir()
        (repo / "newdir" / "a.txt").write_text("a")
        (repo / "newdir" / "b.txt").write_text("b")
        (repo / "newdir" / "c.txt").write_text("c")

        entries = preflight.dirty_status_entries(repo)

        self.assertIsNotNone(entries)
        paths = [entry["path"] for entry in entries]
        self.assertEqual(len(paths), 3)
        self.assertEqual(set(paths), {"newdir/a.txt", "newdir/b.txt", "newdir/c.txt"})

    def test_old_collapsed_directory_behavior_no_longer_occurs(self) -> None:
        repo = self.make_repo()
        (repo / "newdir").mkdir()
        (repo / "newdir" / "a.txt").write_text("a")
        (repo / "newdir" / "b.txt").write_text("b")
        (repo / "newdir" / "c.txt").write_text("c")

        # The behavior Finding 4 fixed: plain `--short` collapses the whole
        # untracked directory into a single line, undercounting by 2.
        collapsed = subprocess.run(
            ["git", "status", "--short"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        self.assertEqual(collapsed, ["?? newdir/"])

        entries = preflight.dirty_status_entries(repo)
        self.assertEqual(len(entries), 3)

    def test_tracked_modification_is_counted(self) -> None:
        repo = self.make_repo()
        tracked = repo / "tracked.txt"
        tracked.write_text("original\n")
        subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
        tracked.write_text("modified\n")

        entries = preflight.dirty_status_entries(repo)

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["path"], "tracked.txt")
        self.assertEqual(entries[0]["status"][1], "M")

    def test_staged_and_unstaged_states_are_represented(self) -> None:
        repo = self.make_repo()
        a = repo / "a.txt"
        b = repo / "b.txt"
        a.write_text("a\n")
        b.write_text("b\n")
        subprocess.run(["git", "add", "a.txt", "b.txt"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
        a.write_text("a-staged\n")
        subprocess.run(["git", "add", "a.txt"], cwd=repo, check=True)
        b.write_text("b-unstaged\n")

        entries = preflight.dirty_status_entries(repo)

        by_path = {entry["path"]: entry["status"] for entry in entries}
        self.assertEqual(by_path["a.txt"][0], "M")
        self.assertEqual(by_path["b.txt"][1], "M")

    def test_filenames_with_spaces_are_preserved(self) -> None:
        repo = self.make_repo()
        (repo / "file with spaces.txt").write_text("x")

        entries = preflight.dirty_status_entries(repo)

        self.assertEqual([entry["path"] for entry in entries], ["file with spaces.txt"])

    def test_unicode_filenames_are_preserved(self) -> None:
        repo = self.make_repo()
        (repo / "文件-日本語-🎮.txt").write_text("x")

        entries = preflight.dirty_status_entries(repo)

        self.assertEqual(
            [entry["path"] for entry in entries], ["文件-日本語-🎮.txt"]
        )

    def test_rename_entries_are_handled_deterministically(self) -> None:
        repo = self.make_repo()
        original = repo / "original.txt"
        original.write_text("identical content across the rename\n")
        subprocess.run(["git", "add", "original.txt"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
        subprocess.run(["git", "mv", "original.txt", "renamed.txt"], cwd=repo, check=True)

        entries = preflight.dirty_status_entries(repo)

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["path"], "renamed.txt")
        self.assertEqual(entries[0]["status"][0], "R")
        self.assertEqual(entries[0]["renamedFrom"], "original.txt")

    def test_dirty_count_equals_path_list_length_via_collect(self) -> None:
        repo = self.make_repo()
        (repo / "overlay").mkdir()
        (repo / "overlay" / "package.json").write_text("{}")
        (repo / "newdir").mkdir()
        (repo / "newdir" / "a.txt").write_text("a")
        (repo / "newdir" / "b.txt").write_text("b")
        with (
            patch.object(preflight, "process_rows", return_value=[]),
            patch.object(
                preflight.shutil,
                "which",
                side_effect=lambda name: f"/usr/bin/{name}",
            ),
            patch.object(
                preflight,
                "capture_devices",
                return_value=[{"index": 0, "label": "Capture screen 0"}],
            ),
            patch.object(preflight.platform, "system", return_value="Darwin"),
        ):
            result = preflight.collect(repo, require_overlay=False, require_game=False)

        self.assertEqual(
            result["repository"]["dirtyCount"],
            len(result["repository"]["dirtyPaths"]),
        )
        self.assertGreaterEqual(result["repository"]["dirtyCount"], 3)

    def test_repeated_runs_produce_stable_ordering(self) -> None:
        repo = self.make_repo()
        (repo / "zeta.txt").write_text("z")
        (repo / "alpha.txt").write_text("a")
        (repo / "middle_dir").mkdir()
        (repo / "middle_dir" / "m.txt").write_text("m")

        first = preflight.dirty_status_entries(repo)
        second = preflight.dirty_status_entries(repo)

        first_paths = [entry["path"] for entry in first]
        self.assertEqual(first_paths, [entry["path"] for entry in second])
        self.assertEqual(first_paths, sorted(first_paths))

    def test_non_git_directory_fails_closed(self) -> None:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        self.assertIsNone(preflight.dirty_status_entries(directory))


class VideoValidationTest(unittest.TestCase):
    def make_video(self, color: str) -> Path:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        output = directory / f"{color}.mp4"
        subprocess.run(
            [
                shutil.which("ffmpeg") or "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"color={color}:size=64x64:rate=5:duration=2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(output),
            ],
            check=True,
        )
        return output

    def test_nonblack_video_is_accepted(self) -> None:
        metadata, errors = validate_video(
            shutil.which("ffmpeg") or "ffmpeg",
            shutil.which("ffprobe") or "ffprobe",
            self.make_video("red"),
        )
        self.assertEqual(errors, [])
        self.assertGreater(metadata["validation"]["frameCount"], 1)

    def test_black_video_is_rejected(self) -> None:
        _, errors = validate_video(
            shutil.which("ffmpeg") or "ffmpeg",
            shutil.which("ffprobe") or "ffprobe",
            self.make_video("black"),
        )
        self.assertTrue(any("black" in error for error in errors))

    def test_truncated_video_is_rejected(self) -> None:
        source = self.make_video("red")
        corrupt = source.with_name("corrupt.mp4")
        data = source.read_bytes()
        corrupt.write_bytes(data[: int(len(data) * 0.60)])
        _, errors = validate_video(
            shutil.which("ffmpeg") or "ffmpeg",
            shutil.which("ffprobe") or "ffprobe",
            corrupt,
        )
        self.assertTrue(errors)

    def test_decode_timeout_is_reported(self) -> None:
        source = self.make_video("red")
        real_run = subprocess.run

        def run_or_timeout(args: list[str], **kwargs: object) -> object:
            if "-progress" in args:
                raise subprocess.TimeoutExpired(args, 30)
            return real_run(args, **kwargs)

        with patch("record_session.subprocess.run", side_effect=run_or_timeout):
            metadata, errors = validate_video(
                shutil.which("ffmpeg") or "ffmpeg",
                shutil.which("ffprobe") or "ffprobe",
                source,
            )
        self.assertTrue(any("exceeded" in error for error in errors))
        self.assertIsNone(metadata["validation"]["blackFraction"])


class RecorderSafetyTest(unittest.TestCase):
    def make_directory(self) -> Path:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        return directory

    def test_trace_silence_includes_initial_and_terminal_intervals(self) -> None:
        stats = initial_trace_stats(1_000)
        observe_trace_line(stats, 4_500)
        observe_trace_line(stats, 5_000)
        error = finalize_trace_silence(stats, 7_200, 3.0)

        self.assertEqual(stats["lastLineElapsedMs"], 5_000)
        self.assertEqual(stats["terminalSilenceMs"], 2_200)
        self.assertEqual(stats["maxSilenceMs"], 3_500)
        self.assertEqual(
            error,
            "Trace silence exceeded 3 seconds during the session.",
        )

    def test_video_validation_duration_does_not_extend_trace_silence(self) -> None:
        stats = initial_trace_stats(0)
        stats["lastLineElapsedMs"] = 1_900_666
        stats["maxSilenceMs"] = 5_631
        capture_stop_elapsed_ms = 1_901_800
        finalization_completed_elapsed_ms = 1_947_682

        error = finalize_trace_silence(
            stats,
            capture_stop_elapsed_ms,
            30.0,
        )

        self.assertEqual(stats["terminalSilenceMs"], 1_134)
        self.assertEqual(stats["maxSilenceMs"], 5_631)
        self.assertIsNone(error)
        self.assertEqual(
            finalization_completed_elapsed_ms - capture_stop_elapsed_ms,
            45_882,
        )

    def test_real_capture_time_trace_gap_above_threshold_fails(self) -> None:
        stats = initial_trace_stats(0)
        stats["lastLineElapsedMs"] = 1_900_666
        stats["maxSilenceMs"] = 30_001

        error = finalize_trace_silence(stats, 1_901_800, 30.0)

        self.assertEqual(stats["terminalSilenceMs"], 1_134)
        self.assertEqual(stats["maxSilenceMs"], 30_001)
        self.assertEqual(
            error,
            "Trace silence exceeded 30 seconds during the session.",
        )

    def test_progress_origin_changes_only_on_timestamp_lines(self) -> None:
        origin: dict[str, float | None] = {"monotonic": None}
        ready = threading.Event()
        with patch("record_session.time.monotonic", side_effect=[100.0]):
            progress_reader(
                io.StringIO("out_time_us=1000000\nprogress=continue\nspeed=1x\n"),
                origin,
                ready,
            )
        self.assertEqual(origin["monotonic"], 99.0)
        self.assertTrue(ready.is_set())

    def test_device_configuration_fallback_is_surfaced_as_warning(self) -> None:
        log = "Configuration of video device failed, falling back to default."
        self.assertEqual(capture_log_errors(log), [])
        self.assertTrue(
            capture_log_warnings(log)
        )

    def test_permission_detection_requires_a_denial(self) -> None:
        self.assertEqual(
            capture_log_errors("Screen Recording device selected successfully."),
            [],
        )
        self.assertTrue(
            capture_log_errors("AVFoundation: screen capture permission denied")
        )

    def test_encoder_parser_returns_real_allowlisted_encoders(self) -> None:
        names = encoder_names(shutil.which("ffmpeg") or "ffmpeg")
        self.assertNotIn("=", names)
        self.assertTrue({"h264_videotoolbox", "libx264"} & names)

    def test_file_holder_access_reports_real_access_modes(self) -> None:
        # Exercises the real `lsof -Fpfa` invocation and field parsing this
        # process's own read and write descriptors on the same file are
        # unambiguous ground truth for what the parser should report.
        directory = self.make_directory()
        target = directory / "probe.txt"
        target.write_text("seed\n", encoding="utf-8")
        with (
            target.open("a", encoding="utf-8") as writer,
            target.open("r", encoding="utf-8") as reader,
        ):
            writer.write("more\n")
            writer.flush()
            reader.read(1)
            holders = preflight.file_holder_access(target)
        self.assertIsNotNone(holders)
        assert holders is not None
        pid = os.getpid()
        accesses = {holder["access"] for holder in holders if holder["pid"] == pid}
        self.assertIn("w", accesses)
        self.assertIn("r", accesses)

    def test_recorder_refuses_to_start_without_real_prerequisites(self) -> None:
        directory = self.make_directory()
        trace = directory / "overlay.log"
        trace.write_text("[game-poll] {}\n", encoding="utf-8")
        argv = [
            "record_session.py",
            "--repo",
            str(directory),
            "--trace",
            str(trace),
            "--overlay-pid",
            "4242",
            "--display-index",
            "1",
            "--privacy-acknowledged",
        ]
        blocked = {
            "ok": False,
            "errors": ["Missing required tools: ffprobe"],
            "tools": {},
            "captureDevices": [],
            "processes": {"overlay": [], "leagueClientUx": [], "leagueGame": []},
        }
        with (
            patch.object(sys, "argv", argv),
            patch.object(record_session, "collect", return_value=blocked),
        ):
            self.assertEqual(record_session.main(), 2)
        self.assertEqual(list(directory.glob("*.mp4")), [])

    def test_recorder_refuses_an_unverified_capture_device(self) -> None:
        directory = self.make_directory()
        trace = directory / "overlay.log"
        trace.write_text("[game-poll] {}\n", encoding="utf-8")
        argv = [
            "record_session.py",
            "--repo",
            str(directory),
            "--trace",
            str(trace),
            "--overlay-pid",
            "4242",
            "--display-index",
            "9",
            "--privacy-acknowledged",
        ]
        healthy = {
            "ok": True,
            "errors": [],
            "tools": {"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"},
            "captureDevices": [{"index": 1, "label": "Capture screen 0"}],
            "processes": {"overlay": [], "leagueClientUx": [], "leagueGame": []},
        }
        with (
            patch.object(sys, "argv", argv),
            patch.object(record_session, "collect", return_value=healthy),
        ):
            self.assertEqual(record_session.main(), 2)
        self.assertEqual(list(directory.glob("*.mp4")), [])

    def test_recorder_rejects_a_writer_outside_the_overlay_process_group(
        self,
    ) -> None:
        directory = self.make_directory()
        trace = directory / "overlay.log"
        trace.write_text("[game-poll] {}\n", encoding="utf-8")
        argv = [
            "record_session.py",
            "--repo",
            str(directory),
            "--trace",
            str(trace),
            "--overlay-pid",
            "4242",
            "--display-index",
            "1",
            "--privacy-acknowledged",
        ]
        healthy = {
            "ok": True,
            "errors": [],
            "tools": {"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"},
            "captureDevices": [{"index": 1, "label": "Capture screen 0"}],
            "processes": {
                "overlay": [{"pid": 4242, "pgid": 4242}],
                "leagueClientUx": [],
                "leagueGame": [],
            },
        }
        stderr = io.StringIO()
        with (
            patch.object(sys, "argv", argv),
            patch.object(record_session, "collect", return_value=healthy),
            patch.object(
                record_session,
                "process_rows",
                return_value=[
                    {"pid": 99999, "ppid": 1, "pgid": 424242, "comm": "/usr/bin/curl"}
                ],
            ),
            patch.object(
                record_session,
                "file_holder_access",
                return_value=[{"pid": 99999, "access": "w"}],
            ),
            patch.object(sys, "stderr", stderr),
        ):
            self.assertEqual(record_session.main(), 2)
        self.assertIn("no writable holder", stderr.getvalue())

    def test_recorder_rejects_a_foreign_writer_alongside_the_trusted_one(
        self,
    ) -> None:
        directory = self.make_directory()
        trace = directory / "overlay.log"
        trace.write_text("[game-poll] {}\n", encoding="utf-8")
        argv = [
            "record_session.py",
            "--repo",
            str(directory),
            "--trace",
            str(trace),
            "--overlay-pid",
            "4242",
            "--display-index",
            "1",
            "--privacy-acknowledged",
        ]
        healthy = {
            "ok": True,
            "errors": [],
            "tools": {"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"},
            "captureDevices": [{"index": 1, "label": "Capture screen 0"}],
            "processes": {
                "overlay": [{"pid": 4242, "pgid": 4242}],
                "leagueClientUx": [],
                "leagueGame": [],
            },
        }
        stderr = io.StringIO()
        with (
            patch.object(sys, "argv", argv),
            patch.object(record_session, "collect", return_value=healthy),
            patch.object(
                record_session,
                "process_rows",
                return_value=[
                    {"pid": 4242, "ppid": 1, "pgid": 4242, "comm": "mayhem-oracle-overlay"},
                    {"pid": 7000, "ppid": 1, "pgid": 7000, "comm": "/usr/bin/curl"},
                ],
            ),
            patch.object(
                record_session,
                "file_holder_access",
                return_value=[
                    {"pid": 4242, "access": "w"},
                    {"pid": 7000, "access": "w"},
                ],
            ),
            patch.object(sys, "stderr", stderr),
        ):
            self.assertEqual(record_session.main(), 2)
        self.assertIn("outside the trusted writer set", stderr.getvalue())

    def test_disk_budget_scales_with_duration(self) -> None:
        short = required_free_bytes(60, 0.1)
        long = required_free_bytes(3600, 0.1)
        self.assertGreater(long, short)
        self.assertGreater(long, 3 * 1024**3)


class HolderInspectionTest(unittest.TestCase):
    """`file_holder_access` must return exactly one of three outcomes: a
    list with holders, a confirmed-empty list, or `None` for anything it
    cannot fully vouch for. Only the one documented `lsof` "no match" exit
    (nonzero, nothing on either stream) may become the confirmed-empty list;
    every other nonzero exit, a failed or hung invocation, and output this
    strict `-Fpfa` parser cannot fully read must all become `None` —
    indeterminate, never a trusted empty holder set."""

    def with_lsof_path(self):
        return patch.object(preflight.shutil, "which", return_value="/usr/sbin/lsof")

    def fake_lsof(self, *, returncode: int, stdout: str = "", stderr: str = ""):
        return patch.object(
            preflight.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(
                args=["lsof"], returncode=returncode, stdout=stdout, stderr=stderr
            ),
        )

    def test_successful_inspection_with_holders(self) -> None:
        with self.with_lsof_path(), self.fake_lsof(
            returncode=0, stdout="p123\nfcwd\naw\nf4\nar\n"
        ):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertEqual(
            holders,
            [{"pid": 123, "access": "w"}, {"pid": 123, "access": "r"}],
        )

    def test_successful_inspection_with_no_holders(self) -> None:
        # The ONE documented "no match" outcome: a nonzero exit with nothing
        # at all on stdout or stderr.
        with self.with_lsof_path(), self.fake_lsof(returncode=1, stdout="", stderr=""):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertEqual(holders, [])

    def test_permission_denied_is_indeterminate(self) -> None:
        with self.with_lsof_path(), self.fake_lsof(
            returncode=1,
            stdout="",
            stderr="lsof: WARNING: can't stat() file system: Operation not permitted\n",
        ):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertIsNone(holders)

    def test_executable_failure_is_indeterminate(self) -> None:
        with (
            self.with_lsof_path(),
            patch.object(
                preflight.subprocess,
                "run",
                side_effect=OSError("lsof is not executable"),
            ),
        ):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertIsNone(holders)

    def test_timeout_is_indeterminate(self) -> None:
        with (
            self.with_lsof_path(),
            patch.object(
                preflight.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(cmd="lsof", timeout=5.0),
            ),
        ):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertIsNone(holders)

    def test_malformed_pid_output_is_indeterminate(self) -> None:
        with self.with_lsof_path(), self.fake_lsof(
            returncode=0, stdout="pNOTAPID\nfcwd\naw\n"
        ):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertIsNone(holders)

    def test_access_field_without_a_preceding_pid_is_indeterminate(self) -> None:
        # An "a" record with no "p" record ever having opened it is an
        # incomplete/reordered record this parser cannot vouch for.
        with self.with_lsof_path(), self.fake_lsof(returncode=0, stdout="aw\n"):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertIsNone(holders)

    def test_transient_nonzero_with_unrelated_output_is_indeterminate(self) -> None:
        with self.with_lsof_path(), self.fake_lsof(
            returncode=2, stdout="", stderr="lsof: internal error, retry\n"
        ):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertIsNone(holders)

    def test_missing_lsof_executable_is_indeterminate(self) -> None:
        with patch.object(preflight.shutil, "which", return_value=None):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertIsNone(holders)

    def test_old_nonzero_to_empty_behavior_is_no_longer_accepted(self) -> None:
        # Regression guard for the exact defect fixed here: the previous
        # implementation treated ANY nonzero exit with empty STDOUT as "no
        # holders", even when stderr carried a real error. That conflation
        # must no longer occur.
        with self.with_lsof_path(), self.fake_lsof(
            returncode=1, stdout="", stderr="lsof: permission denied\n"
        ):
            holders = preflight.file_holder_access(Path("/probe"))
        self.assertIsNone(holders)
        self.assertNotEqual(holders, [])

    def test_no_raw_stderr_enters_the_returned_structure(self) -> None:
        marker = "SECRET-DIAGNOSTIC-TEXT-not-a-real-credential"
        with self.with_lsof_path(), self.fake_lsof(
            returncode=1, stdout="", stderr=f"lsof: {marker} permission denied\n"
        ):
            holders = preflight.file_holder_access(Path("/probe"))
        # `None` carries no payload at all, so the raw stderr text has
        # nowhere to leak into.
        self.assertIsNone(holders)


class TraceReplacementTest(unittest.TestCase):
    """Before the capture boundary is frozen, the tailer pins the source on
    first open. Any later identity change, size regression, content
    mismatch, disappearance, or (with `trusted_writer_pids` set) a foreign
    writable holder must end the session immediately instead of reopening and
    combining a different source's bytes into the same evidence stream."""

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.directory))
        self.source = self.directory / "overlay.log"
        self.destination = self.directory / "trace.timestamped.jsonl"
        self.source.write_text("", encoding="utf-8")
        self.stop = threading.Event()
        self.stats = initial_trace_stats(0)

    def start(self, **kwargs: object) -> threading.Thread:
        thread = threading.Thread(
            target=tail_trace,
            args=(
                self.source,
                self.destination,
                time.monotonic(),
                self.stop,
                self.stats,
            ),
            kwargs=kwargs,
        )
        thread.start()
        self.addCleanup(lambda: (self.stop.set(), thread.join(timeout=5)))
        return thread

    def append(self, text: str) -> None:
        with self.source.open("a", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()

    def recorded_lines(self) -> list[str]:
        return [
            json.loads(line).get("line", "")
            for line in self.destination.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def wait_for_replacement(
        self, thread: threading.Thread, timeout: float = 2.0
    ) -> None:
        deadline = time.monotonic() + timeout
        while not self.stats["sourceReplaced"] and time.monotonic() < deadline:
            time.sleep(0.02)
        thread.join(timeout=2)

    def test_manifest_stats_default_shape_includes_replacement_fields(self) -> None:
        stats = initial_trace_stats(0)
        self.assertIn("sourceReplaced", stats)
        self.assertIn("sourceReplacedReason", stats)
        self.assertFalse(stats["sourceReplaced"])
        self.assertIsNone(stats["sourceReplacedReason"])

    def test_rename_and_replace_fails_closed(self) -> None:
        thread = self.start()
        time.sleep(0.15)
        self.append("before-replacement\n")
        time.sleep(0.15)
        self.source.rename(self.directory / "overlay.log.1")
        self.source.write_text("after-replacement-record\n", encoding="utf-8")
        self.wait_for_replacement(thread)

        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["sourceReplaced"])
        self.assertEqual(self.stats["sourceReplacedReason"], "identity-changed")
        self.assertIn("before-replacement", self.recorded_lines())
        self.assertNotIn("after-replacement-record", self.recorded_lines())
        self.assertIn("replaced", str(drain_validation_error(self.stats)))

    def test_inode_replacement_fails_closed(self) -> None:
        thread = self.start()
        time.sleep(0.15)
        self.append("original-content\n")
        time.sleep(0.15)
        self.source.unlink()
        self.source.write_text("new-inode-content\n", encoding="utf-8")
        self.wait_for_replacement(thread)

        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["sourceReplaced"])
        self.assertIn(
            self.stats["sourceReplacedReason"],
            ("identity-changed", "source-disappeared"),
        )
        self.assertNotIn("new-inode-content", self.recorded_lines())

    def test_same_inode_copytruncate_fails_closed(self) -> None:
        thread = self.start()
        time.sleep(0.15)
        self.append("original-record-one\n")
        time.sleep(0.15)  # consumed; the reader now sits past this record
        original_inode = self.source.stat().st_ino
        with self.source.open("r+b") as handle:
            handle.seek(0)
            handle.truncate(0)
            # Re-grows past the reader position immediately, so (device,
            # inode, size) alone still looks untouched.
            handle.write(b"replacement-one\nreplacement-two\n")
            handle.flush()
        self.wait_for_replacement(thread)

        self.assertEqual(self.source.stat().st_ino, original_inode)
        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["sourceReplaced"])
        # truncate() and write() are two separate syscalls, so the tailer can
        # observe either the momentary 0-byte gap ("size-decreased") or the
        # regrown-but-different content ("content-mismatch") depending on
        # exactly when it polls — both are correct fail-closed outcomes.
        self.assertIn(
            self.stats["sourceReplacedReason"],
            ("content-mismatch", "size-decreased"),
        )
        self.assertNotIn("replacement-one", self.recorded_lines())
        self.assertIn("original-record-one", self.recorded_lines())

    def test_trace_disappearance_and_recreation_fails_closed(self) -> None:
        thread = self.start()
        time.sleep(0.15)
        self.append("seen-before-disappearance\n")
        time.sleep(0.15)
        self.source.unlink()
        self.wait_for_replacement(thread)
        # Recreate the path only after the failure is already recorded — a
        # later reappearance must never be picked back up as a continuation.
        self.source.write_text("recreated-after-disappearance\n", encoding="utf-8")

        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["sourceReplaced"])
        self.assertEqual(self.stats["sourceReplacedReason"], "source-disappeared")
        self.assertNotIn("recreated-after-disappearance", self.recorded_lines())

    def test_only_pinned_writer_succeeds(self) -> None:
        with patch.object(
            record_session,
            "file_holder_access",
            return_value=[{"pid": 4242, "access": "w"}],
        ):
            thread = self.start(
                trusted_writer_pids=frozenset({4242}), holder_check_interval=0.05
            )
            time.sleep(0.15)  # the tailer is now idle inside its polling wait
            self.append('[game-poll] {"gameflowPhase": "inProgress"}\n')
            deadline = time.monotonic() + 1
            while self.stats["lines"] < 1 and time.monotonic() < deadline:
                time.sleep(0.02)
            time.sleep(0.2)  # let at least one holder re-check elapse
            self.stop.set()
            thread.join(timeout=2)

        self.assertFalse(self.stats["sourceReplaced"])
        self.assertIsNone(self.stats["sourceReplacedReason"])
        self.assertIn(
            '[game-poll] {"gameflowPhase": "inProgress"}', self.recorded_lines()
        )

    def test_recorders_own_read_only_descriptor_is_tolerated(self) -> None:
        # The recorder's own tailing open is read-only, so it must never be
        # mistaken for a foreign writer even though it is not in the trusted
        # writer set.
        with patch.object(
            record_session,
            "file_holder_access",
            return_value=[
                {"pid": 4242, "access": "w"},
                {"pid": 5150, "access": "r"},
            ],
        ):
            self.assertFalse(foreign_writable_holder(self.source, frozenset({4242})))

    def test_unrelated_read_only_holder_follows_safe_policy(self) -> None:
        # A wholly unrelated process (e.g. something previewing the trace)
        # holding it open read-only is safe by the same policy: only write
        # access is ever a threat.
        with patch.object(
            record_session,
            "file_holder_access",
            return_value=[
                {"pid": 4242, "access": "w"},
                {"pid": 8800, "access": "r"},
            ],
        ):
            self.assertFalse(foreign_writable_holder(self.source, frozenset({4242})))

    def test_foreign_writer_outside_trusted_set_fails_even_if_pgid_would_match(
        self,
    ) -> None:
        # foreign_writable_holder never consults process group at all: once
        # the trusted set is pinned, sharing a process group with the pinned
        # writer is never a substitute for exact pid membership.
        with patch.object(
            record_session,
            "file_holder_access",
            return_value=[{"pid": 6000, "access": "w"}],
        ):
            self.assertTrue(foreign_writable_holder(self.source, frozenset({4242})))

    def test_trusted_and_foreign_writers_simultaneously_fail(self) -> None:
        with patch.object(
            record_session,
            "file_holder_access",
            return_value=[
                {"pid": 4242, "access": "w"},
                {"pid": 6000, "access": "u"},
            ],
        ):
            self.assertTrue(foreign_writable_holder(self.source, frozenset({4242})))

    def test_foreign_writable_holder_is_fail_closed_when_indeterminate(self) -> None:
        with patch.object(record_session, "file_holder_access", return_value=None):
            self.assertTrue(foreign_writable_holder(self.source, frozenset({4242})))

    def test_writer_appearing_midway_through_capture_fails(self) -> None:
        calls = {"n": 0}

        def holder_access(_path: Path) -> list[dict[str, object]]:
            calls["n"] += 1
            holders: list[dict[str, object]] = [{"pid": 4242, "access": "w"}]
            if calls["n"] > 2:
                holders.append({"pid": 9000, "access": "w"})
            return holders

        with patch.object(
            record_session, "file_holder_access", side_effect=holder_access
        ):
            thread = self.start(
                trusted_writer_pids=frozenset({4242}), holder_check_interval=0.05
            )
            self.append("only-record\n")
            self.wait_for_replacement(thread)

        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["sourceReplaced"])
        self.assertEqual(self.stats["sourceReplacedReason"], "foreign-writable-holder")

    def test_writer_appearing_immediately_before_capture_stop_fails(self) -> None:
        # Mirrors the exact call `main()` makes right after `begin_shutdown()`
        # freezes the boundary: a foreign writer that appeared too late for
        # the periodic in-loop check to have caught it must still fail here.
        stats = initial_trace_stats(0)
        with patch.object(
            record_session,
            "file_holder_access",
            return_value=[
                {"pid": 4242, "access": "w"},
                {"pid": 7777, "access": "w"},
            ],
        ):
            revalidate_trusted_writer(stats, self.source, frozenset({4242}))

        self.assertTrue(stats["sourceReplaced"])
        self.assertEqual(stats["sourceReplacedReason"], "foreign-writable-holder")

    def test_periodic_revalidation_fails_closed_on_indeterminate_inspection(
        self,
    ) -> None:
        # An indeterminate inspection mid-recording (an `lsof` timeout,
        # permission failure, or malformed output) must end the session the
        # same way a confirmed foreign writer would — never be read as "no
        # writers" just because the trusted pid was never actually seen.
        calls = {"n": 0}

        def holder_access(_path: Path) -> list[dict[str, object]] | None:
            calls["n"] += 1
            if calls["n"] > 2:
                return None
            return [{"pid": 4242, "access": "w"}]

        with patch.object(
            record_session, "file_holder_access", side_effect=holder_access
        ):
            thread = self.start(
                trusted_writer_pids=frozenset({4242}), holder_check_interval=0.05
            )
            self.append("only-record\n")
            self.wait_for_replacement(thread)

        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["sourceReplaced"])
        self.assertEqual(self.stats["sourceReplacedReason"], "foreign-writable-holder")

    def test_capture_stop_validation_fails_closed_on_indeterminate_inspection(
        self,
    ) -> None:
        # Same call site as test_writer_appearing_immediately_before_capture_
        # stop_fails, but the inspection itself is indeterminate rather than
        # showing a real foreign writer.
        stats = initial_trace_stats(0)
        with patch.object(record_session, "file_holder_access", return_value=None):
            revalidate_trusted_writer(stats, self.source, frozenset({4242}))

        self.assertTrue(stats["sourceReplaced"])
        self.assertEqual(stats["sourceReplacedReason"], "foreign-writable-holder")

    def test_indeterminate_inspection_drives_the_manifest_to_recording_failed(
        self,
    ) -> None:
        # `main()` sets manifest["status"] = "recording-failed" precisely
        # when `drain_validation_error` returns non-None; an indeterminate
        # holder inspection must reach that same outcome, not a silent pass.
        stats = initial_trace_stats(0)
        with patch.object(record_session, "file_holder_access", return_value=None):
            revalidate_trusted_writer(stats, self.source, frozenset({4242}))

        error = drain_validation_error(stats)
        self.assertIsNotNone(error)
        self.assertIn("foreign-writable-holder", str(error))

    def test_evidence_across_violation_is_never_combined(self) -> None:
        # The foreign writer only "appears" once the before-record is
        # already durably recorded, so this is deterministic regardless of
        # exactly when the periodic check happens to fire.
        def holder_access(_path: Path) -> list[dict[str, object]]:
            holders: list[dict[str, object]] = [{"pid": 4242, "access": "w"}]
            if self.stats["lines"] >= 1:
                holders.append({"pid": 9000, "access": "w"})
            return holders

        with patch.object(
            record_session, "file_holder_access", side_effect=holder_access
        ):
            thread = self.start(
                trusted_writer_pids=frozenset({4242}), holder_check_interval=0.05
            )
            time.sleep(0.15)  # idle inside the polling wait; checks stay clean
            self.append('[game-poll] {"before": true}\n')
            deadline = time.monotonic() + 1
            while self.stats["lines"] < 1 and time.monotonic() < deadline:
                time.sleep(0.02)
            self.wait_for_replacement(thread)
            # Bytes appended after the violation was recorded must never
            # enter evidence, and re-running the checkpoint (as `main()` does
            # before the final manifest) must not clear or overwrite the
            # reason already recorded.
            self.append('[game-poll] {"after": true}\n')
            revalidate_trusted_writer(self.stats, self.source, frozenset({4242}))

        self.assertTrue(self.stats["sourceReplaced"])
        self.assertEqual(self.stats["sourceReplacedReason"], "foreign-writable-holder")
        lines = self.recorded_lines()
        self.assertTrue(any('"before": true' in line for line in lines))
        self.assertFalse(any('"after": true' in line for line in lines))

    def test_drain_validation_error_reports_foreign_writable_holder(self) -> None:
        stats = initial_trace_stats(0)
        stats["sourceReplaced"] = True
        stats["sourceReplacedReason"] = "foreign-writable-holder"

        error = drain_validation_error(stats)

        self.assertIsNotNone(error)
        self.assertIn("foreign-writable-holder", str(error))

    def test_records_before_and_after_replacement_never_combine_into_passing_coverage(
        self,
    ) -> None:
        thread = self.start()
        time.sleep(0.15)
        self.append('[game-poll] {"gameflowPhase": "inProgress"}\n')
        time.sleep(0.15)
        self.source.rename(self.directory / "overlay.log.1")
        self.source.write_text(
            '[game-poll] {"gameflowPhase": "inProgress"}\n', encoding="utf-8"
        )
        self.wait_for_replacement(thread)

        self.assertTrue(self.stats["sourceReplaced"])
        self.assertIsNotNone(drain_validation_error(self.stats))
        # Exactly one generation of records made it into evidence — the
        # replacement's own copy of the same-looking line is never appended.
        self.assertEqual(
            self.recorded_lines().count(
                '[game-poll] {"gameflowPhase": "inProgress"}'
            ),
            1,
        )


class TraceDrainTest(unittest.TestCase):
    """Capture stop requests a stop; the drain decides when reading ends."""

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.directory))
        self.source = self.directory / "overlay.log"
        self.destination = self.directory / "trace.timestamped.jsonl"
        self.source.write_text("", encoding="utf-8")
        self.stop = threading.Event()
        self.boundary: dict[str, object] = {}
        self.stats = initial_trace_stats(0)

    def start(self, drain_timeout: float = 2.0) -> threading.Thread:
        thread = threading.Thread(
            target=tail_trace,
            args=(
                self.source,
                self.destination,
                time.monotonic(),
                self.stop,
                self.stats,
                self.boundary,
                drain_timeout,
            ),
        )
        thread.start()
        self.addCleanup(lambda: (self.stop.set(), thread.join(timeout=5)))
        return thread

    def append(self, text: str) -> None:
        with self.source.open("a", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()

    def recorded_lines(self) -> list[str]:
        return [
            json.loads(line).get("line", "")
            for line in self.destination.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_line_appended_during_the_last_polling_wait_is_retained(self) -> None:
        thread = self.start()
        time.sleep(0.25)  # the tailer is now idle inside its polling wait
        self.append("[game-poll] {\"gameflowPhase\": \"inProgress\"}\n")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["drainCompleted"])
        self.assertIn(
            "[game-poll] {\"gameflowPhase\": \"inProgress\"}",
            self.recorded_lines(),
        )

    def test_final_end_of_game_record_is_retained(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("[game-poll] {\"gameflowPhase\": \"endOfGame\"}\n")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        self.assertTrue(
            any("endOfGame" in line for line in self.recorded_lines())
        )
        self.assertIsNone(drain_validation_error(self.stats))

    def test_records_beyond_the_boundary_are_excluded(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("inside-boundary\n")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        self.append("beyond-boundary\n")
        thread.join(timeout=5)

        lines = self.recorded_lines()
        self.assertIn("inside-boundary", lines)
        self.assertNotIn("beyond-boundary", lines)

    def test_partial_final_record_fails_closed(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("complete-record\n")
        self.append("torn-record-without-newline")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        self.assertTrue(self.stats["partialFinalLine"])
        self.assertEqual(self.recorded_lines(), ["complete-record"])
        self.assertIn("mid-record", str(drain_validation_error(self.stats)))

    def test_drain_is_bounded_when_the_boundary_is_never_reached(self) -> None:
        thread = self.start(drain_timeout=0.3)
        time.sleep(0.25)
        self.append("only-record\n")
        # A boundary claiming bytes that will never arrive must not hang.
        self.boundary.update(trace_boundary(self.source))
        self.boundary["size"] = int(self.boundary["size"]) + 4096
        started = time.monotonic()
        self.stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertLess(time.monotonic() - started, 3.0)
        self.assertTrue(self.stats["drainTimedOut"])
        self.assertIn("drain", str(drain_validation_error(self.stats)))

    def test_rotation_at_the_boundary_is_reported_not_guessed(self) -> None:
        self.append("rotated-away\n")
        self.boundary.update(trace_boundary(self.source))
        self.boundary["inode"] = int(self.boundary["inode"]) + 1
        thread = self.start(drain_timeout=1.0)
        self.stop.set()
        thread.join(timeout=5)

        self.assertTrue(self.stats["boundaryRotated"])
        self.assertIn("rotated", str(drain_validation_error(self.stats)))

    def test_finalized_hash_covers_every_record_through_the_boundary(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("first\n")
        self.append("second\n")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        artifacts = finalized_artifacts(None, self.destination, 1_000, 26_000)
        self.assertEqual(artifacts["schema"], "mayhem-overlay-session-artifacts/1")
        self.assertIsNone(artifacts["video"])
        self.assertEqual(artifacts["traceRecordCount"], 2)
        self.assertEqual(len(self.recorded_lines()), 2)
        self.assertEqual(
            artifacts["trace"]["sha256"], sha256_file(self.destination)
        )
        self.assertEqual(
            artifacts["trace"]["bytes"], self.destination.stat().st_size
        )

    # ---- the boundary must exist and describe one continuous source ---------

    def test_a_continuous_trace_drains_with_every_boundary_flag_clear(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("[game-poll] {\"gameflowPhase\": \"inProgress\"}\n")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        self.assertTrue(self.stats["drainCompleted"])
        for flag in (
            "drainTimedOut",
            "partialFinalLine",
            "undecodableRecord",
            "boundaryMissing",
            "boundaryRotated",
            "boundaryTruncated",
            "boundaryDiscontinuous",
        ):
            self.assertFalse(self.stats[flag], flag)
        self.assertIsNone(drain_validation_error(self.stats))

    def test_a_trace_missing_at_shutdown_fails_the_session(self) -> None:
        thread = self.start(drain_timeout=1.0)
        time.sleep(0.25)
        self.append("observed-record\n")
        time.sleep(0.2)
        self.source.unlink()
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        self.assertIsNone(self.boundary["size"])
        self.assertTrue(self.stats["boundaryMissing"])
        self.assertFalse(self.stats["drainCompleted"])
        self.assertIn(
            "never established", str(drain_validation_error(self.stats))
        )

    def test_an_unknown_boundary_is_never_an_empty_completed_drain(self) -> None:
        thread = self.start(drain_timeout=1.0)
        time.sleep(0.25)
        self.append("observed-record\n")
        time.sleep(0.2)
        # stat() failed at shutdown: nothing about the boundary is known.
        self.boundary.update(
            {
                "device": None,
                "inode": None,
                "size": None,
                "checkpoint": None,
                "checkpointBytes": None,
            }
        )
        self.stop.set()
        thread.join(timeout=5)

        self.assertTrue(self.stats["boundaryMissing"])
        self.assertFalse(self.stats["drainCompleted"])

    def test_a_boundary_without_a_size_fails_instead_of_draining(self) -> None:
        thread = self.start(drain_timeout=1.0)
        time.sleep(0.25)
        self.append("observed-record\n")
        time.sleep(0.2)
        self.boundary.update(trace_boundary(self.source))
        self.boundary["size"] = None
        self.stop.set()
        thread.join(timeout=5)

        self.assertTrue(self.stats["boundaryMissing"])
        self.assertFalse(self.stats["drainCompleted"])

    def test_a_boundary_without_a_checkpoint_fails_instead_of_draining(self) -> None:
        thread = self.start(drain_timeout=1.0)
        time.sleep(0.25)
        self.append("observed-record\n")
        time.sleep(0.2)
        self.boundary.update(trace_boundary(self.source))
        self.boundary["checkpoint"] = None
        self.stop.set()
        thread.join(timeout=5)

        self.assertTrue(self.stats["boundaryMissing"])
        self.assertFalse(self.stats["drainCompleted"])

    def test_same_inode_copy_truncate_fails_even_after_rapid_regrowth(self) -> None:
        thread = self.start(drain_timeout=1.5)
        time.sleep(0.25)
        self.append("original-record-one\n")  # 20 bytes
        time.sleep(0.2)  # consumed; the reader now sits at byte 20
        self.boundary.update(trace_boundary(self.source))
        # The boundary expects a second record the rotation will destroy.
        self.boundary["size"] = int(self.boundary["size"]) + 20
        original_inode = self.source.stat().st_ino
        self.stop.set()
        time.sleep(0.1)  # the bounded drain is now waiting for those bytes
        with self.source.open("r+b") as handle:
            handle.seek(0)
            handle.truncate(0)
            # copytruncate re-grows past the reader position immediately, so
            # (device, inode, size) alone still looks untouched.
            handle.write(b"replacement-one\nreplacement-two\n")
            handle.flush()
        thread.join(timeout=5)

        self.assertEqual(self.source.stat().st_ino, original_inode)
        self.assertGreater(self.source.stat().st_size, 20)
        self.assertTrue(self.stats["boundaryDiscontinuous"])
        self.assertFalse(self.stats["drainCompleted"])
        self.assertIn("continuous", str(drain_validation_error(self.stats)))
        self.assertNotIn("replacement-one", self.recorded_lines())

    def test_a_shrinking_trace_at_the_boundary_is_reported_as_truncation(self) -> None:
        thread = self.start(drain_timeout=1.5)
        time.sleep(0.25)
        self.append("original-record-one\n")  # 20 bytes
        time.sleep(0.2)
        self.boundary.update(trace_boundary(self.source))
        self.boundary["size"] = int(self.boundary["size"]) + 20
        self.stop.set()
        time.sleep(0.1)
        with self.source.open("r+b") as handle:
            handle.truncate(4)  # now shorter than the reader's own position
        thread.join(timeout=5)

        self.assertTrue(self.stats["boundaryTruncated"])
        self.assertFalse(self.stats["drainCompleted"])
        self.assertIn("shrank", str(drain_validation_error(self.stats)))

    def test_the_drain_never_reopens_across_the_boundary(self) -> None:
        thread = self.start(drain_timeout=1.5)
        time.sleep(0.25)
        self.append("before-rotation\n")
        time.sleep(0.2)
        self.boundary.update(trace_boundary(self.source))
        self.boundary["size"] = int(self.boundary["size"]) + 64
        self.stop.set()
        time.sleep(0.1)
        reopens_before = self.stats["reopens"]
        # logrotate: the followed file moves aside and a new inode replaces it.
        self.source.rename(self.directory / "overlay.log.1")
        self.source.write_text("after-rotation-record\n", encoding="utf-8")
        thread.join(timeout=5)

        self.assertEqual(self.stats["reopens"], reopens_before)
        self.assertTrue(self.stats["boundaryRotated"])
        self.assertFalse(self.stats["drainCompleted"])
        self.assertNotIn("after-rotation-record", self.recorded_lines())

    # ---- reads are capped at the frozen byte boundary -----------------------

    def test_a_record_ending_exactly_at_the_boundary_is_retained(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("[game-poll] {\"gameflowPhase\": \"endOfGame\"}\n")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        self.assertEqual(self.boundary["size"], self.source.stat().st_size)
        self.assertTrue(self.stats["drainCompleted"])
        self.assertEqual(
            self.recorded_lines(),
            ["[game-poll] {\"gameflowPhase\": \"endOfGame\"}"],
        )

    def test_every_complete_record_in_the_final_read_is_retained(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        # Three records in one write during the last polling wait: the bounded
        # drain has to split a single chunk back into three records.
        self.append(
            "first\nsecond\n[game-poll] {\"gameflowPhase\": \"endOfGame\"}\n"
        )
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        self.assertTrue(self.stats["drainCompleted"])
        self.assertEqual(self.stats["lines"], 3)
        self.assertEqual(
            self.recorded_lines(),
            ["first", "second", "[game-poll] {\"gameflowPhase\": \"endOfGame\"}"],
        )

    def test_a_partial_record_is_not_completed_by_post_boundary_bytes(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("complete-record\n")
        self.append("torn-at-the-boundary")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        # The overlay finishes the record immediately afterwards. An unbounded
        # readline() would swallow the remainder as this session's evidence.
        self.append("-completed-after-the-boundary\n")
        thread.join(timeout=5)

        self.assertTrue(self.stats["partialFinalLine"])
        self.assertFalse(self.stats["drainCompleted"])
        self.assertEqual(self.recorded_lines(), ["complete-record"])
        self.assertIn("mid-record", str(drain_validation_error(self.stats)))

    def test_a_post_boundary_end_of_game_is_excluded(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("[game-poll] {\"gameflowPhase\": \"inProgress\"}\n")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        self.append("[game-poll] {\"gameflowPhase\": \"endOfGame\"}\n")
        thread.join(timeout=5)

        lines = self.recorded_lines()
        self.assertTrue(any("inProgress" in line for line in lines))
        self.assertFalse(any("endOfGame" in line for line in lines))
        self.assertTrue(self.stats["drainCompleted"])

    def test_a_utf8_sequence_split_by_the_boundary_fails_closed(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        character = "中".encode("utf-8")  # three bytes
        with self.source.open("ab") as handle:
            handle.write(b"complete-record\n")
            handle.write(b"partial-" + character[:1])
            handle.flush()
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        with self.source.open("ab") as handle:
            handle.write(character[1:] + b"\n")
            handle.flush()
        thread.join(timeout=5)

        self.assertTrue(self.stats["partialFinalLine"])
        self.assertFalse(self.stats["drainCompleted"])
        self.assertEqual(self.recorded_lines(), ["complete-record"])

    def test_undecodable_bytes_inside_the_boundary_fail_closed(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        with self.source.open("ab") as handle:
            handle.write(b"complete-record\n")
            handle.write(b"broken-\xff\xfe\n")
            handle.flush()
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        self.assertTrue(self.stats["undecodableRecord"])
        self.assertFalse(self.stats["drainCompleted"])
        self.assertEqual(self.recorded_lines(), ["complete-record"])
        self.assertIn("valid UTF-8", str(drain_validation_error(self.stats)))

    def test_the_final_hash_and_count_exclude_post_boundary_bytes(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("first\n")
        self.append("second\n")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        self.append("third-after-the-boundary\n")
        thread.join(timeout=5)

        artifacts = finalized_artifacts(None, self.destination, 1_000, 26_000)
        self.assertTrue(self.stats["drainCompleted"])
        self.assertEqual(self.recorded_lines(), ["first", "second"])
        self.assertEqual(artifacts["traceRecordCount"], 2)
        self.assertEqual(artifacts["trace"]["sha256"], sha256_file(self.destination))
        self.assertEqual(
            artifacts["trace"]["bytes"], self.destination.stat().st_size
        )


class TraceBoundaryIdentityTest(unittest.TestCase):
    """A frozen boundary is only usable if it is complete and verifiable."""

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.directory))
        self.source = self.directory / "overlay.log"
        self.source.write_text("[game-poll] {}\n", encoding="utf-8")

    def test_a_boundary_carries_device_inode_size_and_a_checkpoint(self) -> None:
        boundary = trace_boundary(self.source)
        stat = self.source.stat()

        self.assertEqual(boundary["device"], stat.st_dev)
        self.assertEqual(boundary["inode"], stat.st_ino)
        self.assertEqual(boundary["size"], stat.st_size)
        self.assertEqual(
            boundary["checkpoint"], content_checkpoint(self.source, stat.st_size)
        )
        self.assertTrue(boundary_is_complete(boundary))

    def test_a_missing_trace_yields_no_boundary_at_all(self) -> None:
        self.source.unlink()
        boundary = trace_boundary(self.source)

        self.assertEqual(
            [boundary[key] for key in ("device", "inode", "size", "checkpoint")],
            [None, None, None, None],
        )
        self.assertFalse(boundary_is_complete(boundary))

    def test_a_failed_stat_yields_no_boundary(self) -> None:
        with patch.object(Path, "stat", side_effect=PermissionError("denied")):
            boundary = trace_boundary(self.source)

        self.assertIsNone(boundary["size"])
        self.assertFalse(boundary_is_complete(boundary))

    def test_an_unreadable_trace_yields_no_checkpoint(self) -> None:
        with patch.object(Path, "open", side_effect=PermissionError("denied")):
            boundary = trace_boundary(self.source)

        self.assertEqual(boundary["size"], self.source.stat().st_size)
        self.assertIsNone(boundary["checkpoint"])
        self.assertFalse(boundary_is_complete(boundary))

    def test_a_short_checkpoint_read_is_never_treated_as_a_match(self) -> None:
        # Asking for bytes the file does not have cannot silently succeed.
        self.assertIsNone(
            content_checkpoint(self.source, self.source.stat().st_size + 1)
        )
        self.assertIsNone(content_checkpoint(self.source, -1))
        self.assertIsNone(content_checkpoint(self.directory / "absent.log", 4))

    def test_every_missing_identity_field_invalidates_the_boundary(self) -> None:
        complete = trace_boundary(self.source)
        self.assertTrue(boundary_is_complete(complete))

        for field in ("device", "inode", "size", "checkpoint"):
            missing = dict(complete)
            missing.pop(field)
            self.assertFalse(boundary_is_complete(missing), field)
            nulled = dict(complete)
            nulled[field] = None
            self.assertFalse(boundary_is_complete(nulled), field)

    def test_a_zero_byte_trace_is_a_real_boundary_but_none_is_not(self) -> None:
        empty = self.directory / "empty.log"
        empty.write_text("", encoding="utf-8")
        self.assertTrue(boundary_is_complete(trace_boundary(empty)))

        unknown = dict(trace_boundary(self.source))
        unknown["size"] = None
        self.assertFalse(boundary_is_complete(unknown))

    def test_the_checkpoint_detects_a_same_size_content_replacement(self) -> None:
        before = trace_boundary(self.source)
        self.source.write_text("[game-poll] []\n", encoding="utf-8")
        after = trace_boundary(self.source)

        self.assertEqual(before["size"], after["size"])
        self.assertNotEqual(before["checkpoint"], after["checkpoint"])

    def test_no_invalid_boundary_can_produce_a_complete_manifest(self) -> None:
        for flag in (
            "partialFinalLine",
            "undecodableRecord",
            "boundaryMissing",
            "boundaryRotated",
            "boundaryTruncated",
            "boundaryDiscontinuous",
            "drainTimedOut",
        ):
            stats = initial_trace_stats(0)
            stats["lines"] = 12
            # Even a drain that claims it finished cleanly.
            stats["drainCompleted"] = True
            stats[flag] = True
            self.assertIsNotNone(drain_validation_error(stats), flag)

        never_completed = initial_trace_stats(0)
        never_completed["lines"] = 12
        self.assertIsNotNone(drain_validation_error(never_completed))

        clean = initial_trace_stats(0)
        clean["lines"] = 12
        clean["drainCompleted"] = True
        self.assertIsNone(drain_validation_error(clean))


class ShutdownOrderingTest(unittest.TestCase):
    """FFmpeg finalization time may never be charged to the trace."""

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.directory))
        self.source = self.directory / "overlay.log"
        self.source.write_text("[game-poll] {}\n", encoding="utf-8")

    def test_capture_stop_is_stamped_before_any_encoder_wait(self) -> None:
        stop = threading.Event()
        boundary: dict[str, object] = {}
        # One monotonic reading, taken at the instant of stop. Any later call
        # would consume a second value and raise StopIteration.
        with patch("record_session.time.monotonic", side_effect=[1_901.8]):
            capture_stop_elapsed_ms = begin_shutdown(0.0, self.source, stop, boundary)

        self.assertEqual(capture_stop_elapsed_ms, 1_901_800)
        self.assertTrue(stop.is_set())
        self.assertEqual(boundary["size"], self.source.stat().st_size)
        self.assertEqual(boundary["inode"], self.source.stat().st_ino)

    def test_finalization_delay_never_changes_terminal_silence(self) -> None:
        capture_stop_elapsed_ms = 1_901_800
        baseline = initial_trace_stats(0)
        baseline["lastLineElapsedMs"] = 1_900_666
        delayed = dict(baseline)

        self.assertIsNone(finalize_trace_silence(baseline, capture_stop_elapsed_ms, 30.0))
        # A 25-second container finalization moves only the finalization stamp.
        finalization_completed_elapsed_ms = capture_stop_elapsed_ms + 25_000
        self.assertIsNone(finalize_trace_silence(delayed, capture_stop_elapsed_ms, 30.0))

        self.assertEqual(baseline["terminalSilenceMs"], 1_134)
        self.assertEqual(delayed["terminalSilenceMs"], baseline["terminalSilenceMs"])
        self.assertEqual(delayed["maxSilenceMs"], baseline["maxSilenceMs"])
        self.assertEqual(
            finalization_completed_elapsed_ms - capture_stop_elapsed_ms,
            25_000,
        )

    def test_genuine_capture_interval_gap_still_fails(self) -> None:
        stats = initial_trace_stats(0)
        stats["lastLineElapsedMs"] = 1_870_000
        error = finalize_trace_silence(stats, 1_901_800, 30.0)

        self.assertEqual(stats["terminalSilenceMs"], 31_800)
        self.assertEqual(
            error, "Trace silence exceeded 30 seconds during the session."
        )

    def test_manifest_separates_capture_stop_from_finalization(self) -> None:
        trace = self.directory / "trace.timestamped.jsonl"
        trace.write_text(
            json.dumps({"elapsedMs": 10, "line": "[game-poll] {}"}) + "\n",
            encoding="utf-8",
        )
        artifacts = finalized_artifacts(None, trace, 1_901_800, 1_947_682)

        self.assertEqual(artifacts["captureStopElapsedMs"], 1_901_800)
        self.assertEqual(artifacts["finalizationCompletedElapsedMs"], 1_947_682)
        self.assertNotEqual(
            artifacts["captureStopElapsedMs"],
            artifacts["finalizationCompletedElapsedMs"],
        )


class OutputCapacityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.directory))

    def test_nested_missing_parents_are_measured_at_the_existing_ancestor(self) -> None:
        output = self.directory / "a" / "b" / "c" / "session"

        self.assertIsNone(check_output_capacity(output, 1))
        make_owner_only_dir(output)

        self.assertTrue(output.is_dir())
        for level in (output, output.parent, output.parent.parent):
            self.assertEqual(level.stat().st_mode & 0o777, 0o700)

    def test_insufficient_free_space_fails_cleanly(self) -> None:
        output = self.directory / "a" / "b" / "session"
        error = check_output_capacity(output, 1 << 62)

        self.assertIsNotNone(error)
        self.assertIn("GiB free", str(error))
        # Nothing was created on the way to the rejection.
        self.assertFalse((self.directory / "a").exists())

    def test_unwritable_ancestor_fails_clearly(self) -> None:
        locked = self.directory / "locked"
        locked.mkdir(mode=0o500)
        self.addCleanup(lambda: locked.chmod(0o700))
        output = locked / "nested" / "session"

        error = check_output_capacity(output, 1)

        self.assertIsNotNone(error)
        self.assertIn("not writable", str(error))
        self.assertFalse(output.exists())

    def test_missing_ancestor_resolution_stops_at_an_existing_directory(self) -> None:
        output = self.directory / "x" / "y" / "z"
        self.assertEqual(
            record_session.nearest_existing_ancestor(output.parent),
            self.directory,
        )

    def test_existing_nonempty_output_is_still_rejected(self) -> None:
        output = self.directory / "session"
        output.mkdir()
        (output / "screen.mp4").write_text("existing evidence", encoding="utf-8")
        trace = self.directory / "overlay.log"
        trace.write_text("[game-poll] {}\n", encoding="utf-8")
        argv = [
            "record_session.py",
            "--repo",
            str(self.directory),
            "--trace",
            str(trace),
            "--overlay-pid",
            "4242",
            "--display-index",
            "1",
            "--output",
            str(output),
            "--privacy-acknowledged",
        ]
        healthy = {
            "ok": True,
            "errors": [],
            "tools": {"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"},
            "captureDevices": [{"index": 1, "label": "Capture screen 0"}],
            "processes": {
                "overlay": [{"pid": 4242, "pgid": 4242}],
                "leagueClientUx": [],
                "leagueGame": [],
            },
        }
        stderr = io.StringIO()
        with (
            patch.object(sys, "argv", argv),
            patch.object(record_session, "collect", return_value=healthy),
            patch.object(
                record_session,
                "process_rows",
                return_value=[{"pid": 4242, "pgid": 4242, "command": "overlay"}],
            ),
            patch.object(
                record_session,
                "file_holder_access",
                return_value=[{"pid": 4242, "access": "w"}],
            ),
            patch.object(sys, "stderr", stderr),
        ):
            self.assertEqual(record_session.main(), 2)

        # Rejected for the evidence it already holds, not for an unrelated
        # earlier gate.
        self.assertIn("output already exists", stderr.getvalue())
        self.assertEqual(
            (output / "screen.mp4").read_text(encoding="utf-8"),
            "existing evidence",
        )


class ContinuityCheckpointTest(unittest.TestCase):
    """A continuity checkpoint is mandatory wherever it is expected. Every
    `content_checkpoint()` caller in `tail_trace` must treat `None` as
    "unverifiable" and fail closed immediately — never as "unavailable but
    optional". `content_checkpoint()` itself already returns `None` for a
    short read, a seek failure, a permission/read exception, and a missing
    source (proven directly by `TraceBoundaryIdentityTest` and by the two
    fault-injection tests below); this class proves every CALLER of that
    contract reacts identically: fail closed, never silently proceed."""

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.directory))
        self.source = self.directory / "overlay.log"
        self.destination = self.directory / "trace.timestamped.jsonl"
        self.source.write_text("", encoding="utf-8")
        self.stop = threading.Event()
        self.boundary: dict[str, object] = {}
        self.stats = initial_trace_stats(0)

    def start(self, drain_timeout: float = 2.0) -> threading.Thread:
        thread = threading.Thread(
            target=tail_trace,
            args=(
                self.source,
                self.destination,
                time.monotonic(),
                self.stop,
                self.stats,
                self.boundary,
                drain_timeout,
            ),
        )
        thread.start()
        self.addCleanup(lambda: (self.stop.set(), thread.join(timeout=5)))
        return thread

    def append(self, text: str) -> None:
        with self.source.open("a", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()

    def recorded_lines(self) -> list[str]:
        return [
            json.loads(line).get("line", "")
            for line in self.destination.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def wait_for_replacement(
        self, thread: threading.Thread, timeout: float = 2.0
    ) -> None:
        deadline = time.monotonic() + timeout
        while not self.stats["sourceReplaced"] and time.monotonic() < deadline:
            time.sleep(0.02)
        thread.join(timeout=2)

    # ---- 1. a valid checkpoint permits continued recording ------------------

    def test_a_valid_readable_checkpoint_permits_continued_recording(self) -> None:
        thread = self.start()
        time.sleep(0.15)
        self.append("first-record\n")
        self.append("second-record\n")
        deadline = time.monotonic() + 2.0
        while self.stats["lines"] < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        self.stop.set()
        thread.join(timeout=2)

        self.assertFalse(self.stats["sourceReplaced"])
        self.assertIsNone(self.stats["sourceReplacedReason"])
        self.assertEqual(self.recorded_lines(), ["first-record", "second-record"])

    # ---- 2. None during active recording fails immediately ------------------

    def test_none_checkpoint_during_idle_active_recording_fails_immediately(
        self,
    ) -> None:
        thread = self.start()
        time.sleep(0.15)  # pinned successfully; now idle, polling every 0.1s
        with patch.object(record_session, "content_checkpoint", return_value=None):
            self.wait_for_replacement(thread)

        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["sourceReplaced"])
        self.assertEqual(
            self.stats["sourceReplacedReason"], "trace-checkpoint-unreadable"
        )
        # No bytes were ever appended: this proves the idle periodic recheck
        # itself fails closed, not merely a post-read refresh.
        self.assertEqual(self.recorded_lines(), [])

    # ---- 4 & 6. two content_checkpoint() causes not yet covered directly ----
    # (a short read and a permission/read exception are already proven by
    # TraceBoundaryIdentityTest.test_a_short_checkpoint_read_is_never_treated_as_a_match
    # and .test_an_unreadable_trace_yields_no_checkpoint)

    def test_a_seek_failure_yields_no_checkpoint(self) -> None:
        class FailingSeekHandle:
            def __enter__(self):
                return self

            def __exit__(self, *exc_info: object) -> bool:
                return False

            def seek(self, *args: object, **kwargs: object) -> None:
                raise OSError("seek failed")

            def read(self, *args: object, **kwargs: object) -> bytes:
                return b""

        with patch.object(Path, "open", return_value=FailingSeekHandle()):
            self.assertIsNone(content_checkpoint(self.source, 10))

    def test_source_removed_mid_read_yields_no_checkpoint(self) -> None:
        class HandleThatVanishesMidRead:
            def __enter__(self):
                return self

            def __exit__(self, *exc_info: object) -> bool:
                return False

            def seek(self, *args: object, **kwargs: object) -> None:
                return None

            def read(self, *args: object, **kwargs: object) -> bytes:
                raise OSError("source vanished mid-read")

        with patch.object(Path, "open", return_value=HandleThatVanishesMidRead()):
            self.assertIsNone(content_checkpoint(self.source, 10))

    # ---- 7 & 10. copy-truncate combined with an unreadable checkpoint -------

    def test_same_inode_copy_truncate_combined_with_unreadable_checkpoint_fails(
        self,
    ) -> None:
        thread = self.start()
        time.sleep(0.15)
        self.append("original-record-one\n")
        time.sleep(0.15)  # consumed; the reader now sits past this record
        original_inode = self.source.stat().st_ino
        with patch.object(record_session, "content_checkpoint", return_value=None):
            with self.source.open("r+b") as handle:
                handle.seek(0)
                handle.truncate(0)
                # Re-grows past the reader position immediately, so (device,
                # inode, size) alone still looks untouched.
                handle.write(b"replacement-one\nreplacement-two\n")
                handle.flush()
            self.wait_for_replacement(thread)

        self.assertEqual(self.source.stat().st_ino, original_inode)
        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["sourceReplaced"])
        self.assertEqual(
            self.stats["sourceReplacedReason"], "trace-checkpoint-unreadable"
        )
        # Records before the failure are kept; nothing from the replacement
        # is ever combined into the same session's evidence.
        self.assertIn("original-record-one", self.recorded_lines())
        self.assertNotIn("replacement-one", self.recorded_lines())
        self.assertNotIn("replacement-two", self.recorded_lines())

    # ---- 8 & 9. a failure is permanent, even if a later read would succeed --

    def test_continuity_failure_is_permanent_even_if_a_later_read_would_succeed(
        self,
    ) -> None:
        thread = self.start()
        time.sleep(0.15)
        self.append("seen-before-failure\n")
        time.sleep(0.15)
        with patch.object(record_session, "content_checkpoint", return_value=None):
            self.wait_for_replacement(thread)

        self.assertFalse(thread.is_alive())
        self.assertTrue(self.stats["sourceReplaced"])
        self.assertEqual(
            self.stats["sourceReplacedReason"], "trace-checkpoint-unreadable"
        )
        stats_snapshot = dict(self.stats)

        # The underlying file is untouched and a fresh, unpatched read
        # succeeds right now...
        self.assertIsNotNone(
            content_checkpoint(self.source, self.source.stat().st_size)
        )
        # ...but nothing re-evaluates or clears the already-failed session:
        # the thread that could establish a replacement checkpoint is gone.
        self.assertEqual(self.stats, stats_snapshot)

    # ---- 11. an unreadable checkpoint during capture-stop validation fails --

    def test_an_unreadable_checkpoint_during_capture_stop_validation_fails(
        self,
    ) -> None:
        self.append("observed-record\n")
        with patch.object(Path, "open", side_effect=PermissionError("denied")):
            self.boundary.update(trace_boundary(self.source))
        self.assertIsNone(self.boundary["checkpoint"])

        thread = self.start(drain_timeout=1.0)
        self.stop.set()
        thread.join(timeout=5)

        self.assertFalse(boundary_is_complete(self.boundary))
        self.assertTrue(self.stats["boundaryMissing"])
        self.assertFalse(self.stats["drainCompleted"])
        self.assertIn("never established", str(drain_validation_error(self.stats)))

    # ---- 12. an unreadable checkpoint during final drain fails ---------------

    def test_an_unreadable_checkpoint_during_final_drain_fails(self) -> None:
        thread = self.start(drain_timeout=1.5)
        time.sleep(0.25)
        self.append("first-record\n")
        time.sleep(0.2)  # consumed
        self.boundary.update(trace_boundary(self.source))
        # The boundary expects more bytes than the source currently has, so
        # the drain is still waiting (not yet at position == boundary_size)
        # when the checkpoint read starts failing.
        self.boundary["size"] = int(self.boundary["size"]) + 20
        self.stop.set()
        time.sleep(0.1)  # the bounded drain is now waiting for those bytes

        with patch.object(record_session, "content_checkpoint", return_value=None):
            thread.join(timeout=5)

        self.assertTrue(self.stats["boundaryDiscontinuous"])
        self.assertFalse(self.stats["drainCompleted"])
        self.assertIn("continuous", str(drain_validation_error(self.stats)))

    # ---- 13, 14 & 17. manifest fields for a checkpoint failure ---------------

    def test_manifest_fields_fail_closed_without_raw_exception_text(self) -> None:
        stats = initial_trace_stats(0)
        stats["lines"] = 12
        stats["drainCompleted"] = True  # even a drain that claims success
        stats["sourceReplaced"] = True
        stats["sourceReplacedReason"] = "trace-checkpoint-unreadable"

        error = drain_validation_error(stats)

        self.assertIsNotNone(error)
        self.assertIn("trace-checkpoint-unreadable", error)
        self.assertNotIn("Traceback", error)
        self.assertNotIn("Errno", error)
        self.assertNotIn("PermissionError", error)
        self.assertFalse(trace_continuity_verified(stats))

        drain_phase_stats = initial_trace_stats(0)
        drain_phase_stats["lines"] = 12
        drain_phase_stats["drainCompleted"] = True
        drain_phase_stats["boundaryDiscontinuous"] = True
        self.assertIsNotNone(drain_validation_error(drain_phase_stats))
        self.assertFalse(trace_continuity_verified(drain_phase_stats))

    # ---- 18. a clean, verified EOF still succeeds -----------------------------

    def test_a_clean_verified_eof_still_succeeds(self) -> None:
        thread = self.start()
        time.sleep(0.25)
        self.append("[game-poll] {\"gameflowPhase\": \"endOfGame\"}\n")
        begin_shutdown(time.monotonic(), self.source, self.stop, self.boundary)
        thread.join(timeout=5)

        self.assertTrue(self.stats["drainCompleted"])
        self.assertFalse(self.stats["sourceReplaced"])
        self.assertFalse(self.stats["boundaryDiscontinuous"])
        self.assertIsNone(drain_validation_error(self.stats))
        self.assertTrue(trace_continuity_verified(self.stats))

    # ---- non-vacuity: the previous guard would have accepted this -----------

    def test_non_vacuity_old_guard_would_have_silently_accepted_a_none_checkpoint(
        self,
    ) -> None:
        # This is the exact expression removed from tail_trace's non-draining
        # recheck (the reviewed bug): a None checkpoint on either side skipped
        # verification entirely and fell through to accept the read, instead
        # of failing.
        def old_guard_would_flag_mismatch(
            checkpoint: str | None, current_checkpoint: str | None
        ) -> bool:
            return (
                checkpoint is not None
                and current_checkpoint is not None
                and current_checkpoint != checkpoint
            )

        self.assertFalse(
            old_guard_would_flag_mismatch(None, None),
            "the previous guard silently waves through a None checkpoint",
        )

        # The corrected implementation, exercised end-to-end for the exact
        # same None/None case, fails instead of accepting it.
        thread = self.start()
        time.sleep(0.2)
        with patch.object(record_session, "content_checkpoint", return_value=None):
            self.append("bytes-that-must-never-be-accepted\n")
            self.wait_for_replacement(thread)

        self.assertTrue(self.stats["sourceReplaced"])
        self.assertEqual(
            self.stats["sourceReplacedReason"], "trace-checkpoint-unreadable"
        )
        self.assertNotIn(
            "bytes-that-must-never-be-accepted", self.recorded_lines()
        )


class RepositoryFingerprintTest(unittest.TestCase):
    """Two different uncommitted patches touching the same paths must never
    produce the same provenance digest — the exact gap plain HEAD + dirty
    path names left open."""

    def make_repo(self) -> Path:
        # Unlike `DirtyStatusEntriesTest.make_repo`, this creates an initial
        # commit: a fingerprint always binds HEAD, and the real target
        # repository this ships for always has commit history — an unborn
        # branch is not a scenario worth handling in the production function.
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        subprocess.run(["git", "init", "-q"], cwd=directory, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=directory,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"], cwd=directory, check=True
        )
        (directory / ".gitkeep").write_text("")
        subprocess.run(["git", "add", ".gitkeep"], cwd=directory, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=directory, check=True)
        return directory

    def test_same_path_different_tracked_patch_bytes_yields_different_fingerprint(
        self,
    ) -> None:
        repo_a = self.make_repo()
        repo_b = self.make_repo()
        for repo in (repo_a, repo_b):
            (repo / "shared.txt").write_text("base\n")
            subprocess.run(["git", "add", "shared.txt"], cwd=repo, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True
            )
        (repo_a / "shared.txt").write_text("base\npatch A\n")
        (repo_b / "shared.txt").write_text("base\npatch B\n")

        fp_a = preflight.repository_fingerprint(repo_a)
        fp_b = preflight.repository_fingerprint(repo_b)

        self.assertIsNotNone(fp_a)
        self.assertIsNotNone(fp_b)
        # The old provenance (HEAD + dirty path names) is identical here...
        self.assertEqual(fp_a["dirtyPaths"], fp_b["dirtyPaths"])
        self.assertEqual(fp_a["dirtyPathCount"], fp_b["dirtyPathCount"])
        # ...but the actual bytes Vite/Tauri would build from differ.
        self.assertNotEqual(fp_a["sha256"], fp_b["sha256"])

    def test_same_untracked_path_different_content_yields_different_fingerprint(
        self,
    ) -> None:
        repo = self.make_repo()
        (repo / "new.txt").write_text("content A")
        first = preflight.repository_fingerprint(repo)

        (repo / "new.txt").write_text("content B")
        second = preflight.repository_fingerprint(repo)

        self.assertEqual(first["dirtyPaths"], second["dirtyPaths"])
        self.assertNotEqual(first["sha256"], second["sha256"])

    def test_staged_and_unstaged_tracked_changes_both_affect_fingerprint(self) -> None:
        repo = self.make_repo()
        tracked = repo / "tracked.txt"
        tracked.write_text("original\n")
        subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
        baseline = preflight.repository_fingerprint(repo)

        tracked.write_text("unstaged-change\n")
        unstaged = preflight.repository_fingerprint(repo)
        self.assertNotEqual(baseline["sha256"], unstaged["sha256"])

        subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True)
        staged = preflight.repository_fingerprint(repo)
        self.assertNotEqual(unstaged["sha256"], staged["sha256"])
        self.assertNotEqual(baseline["sha256"], staged["sha256"])

    def test_adding_or_removing_untracked_file_changes_fingerprint(self) -> None:
        repo = self.make_repo()
        baseline = preflight.repository_fingerprint(repo)

        added = repo / "extra.txt"
        added.write_text("extra")
        with_file = preflight.repository_fingerprint(repo)
        self.assertNotEqual(baseline["sha256"], with_file["sha256"])

        added.unlink()
        removed = preflight.repository_fingerprint(repo)
        self.assertEqual(baseline["sha256"], removed["sha256"])

    def test_untracked_executable_bit_change_is_represented(self) -> None:
        repo = self.make_repo()
        target = repo / "script.sh"
        target.write_text("#!/bin/sh\necho hi\n")
        target.chmod(0o644)
        first = preflight.repository_fingerprint(repo)

        target.chmod(0o755)
        second = preflight.repository_fingerprint(repo)

        self.assertNotEqual(first["sha256"], second["sha256"])

    def test_symlink_target_change_is_represented_without_following(self) -> None:
        repo = self.make_repo()
        link = repo / "link"
        link.symlink_to("/nonexistent-target-a")
        first = preflight.repository_fingerprint(repo)
        self.assertIsNotNone(first)

        link.unlink()
        link.symlink_to("/nonexistent-target-b")
        second = preflight.repository_fingerprint(repo)

        self.assertIsNotNone(second)
        self.assertNotEqual(first["sha256"], second["sha256"])

    def test_regular_file_versus_symlink_at_the_same_path_differ(self) -> None:
        repo = self.make_repo()
        path = repo / "thing"
        path.write_text("data")
        as_file = preflight.repository_fingerprint(repo)

        path.unlink()
        path.symlink_to("data")
        as_symlink = preflight.repository_fingerprint(repo)

        self.assertIsNotNone(as_file)
        self.assertIsNotNone(as_symlink)
        self.assertNotEqual(as_file["sha256"], as_symlink["sha256"])

    def test_special_filenames_are_handled(self) -> None:
        repo = self.make_repo()
        names = ["has spaces.txt", "tabs\there.txt", "文件-🎮.txt", "line\nbreak.txt"]
        for name in names:
            (repo / name).write_text("x")

        result = preflight.repository_fingerprint(repo)

        self.assertIsNotNone(result)
        self.assertEqual(result["dirtyPathCount"], len(names))
        self.assertEqual(set(result["dirtyPaths"]), set(names))

    def test_repeated_runs_produce_the_same_digest(self) -> None:
        repo = self.make_repo()
        (repo / "a.txt").write_text("a")
        (repo / "b.txt").write_text("b")

        first = preflight.repository_fingerprint(repo)
        second = preflight.repository_fingerprint(repo)

        self.assertEqual(first["sha256"], second["sha256"])

    def test_ignored_files_do_not_affect_fingerprint(self) -> None:
        repo = self.make_repo()
        (repo / ".gitignore").write_text("ignored.txt\n")
        subprocess.run(["git", "add", ".gitignore"], cwd=repo, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "add gitignore"], cwd=repo, check=True
        )
        baseline = preflight.repository_fingerprint(repo)

        (repo / "ignored.txt").write_text("should not matter")
        after = preflight.repository_fingerprint(repo)

        self.assertEqual(baseline["sha256"], after["sha256"])

    def test_excluded_path_does_not_affect_fingerprint(self) -> None:
        repo = self.make_repo()
        baseline = preflight.repository_fingerprint(repo)

        evidence_dir = repo / "session-evidence"
        evidence_dir.mkdir()
        (evidence_dir / "manifest.json").write_text("{}")

        with_evidence = preflight.repository_fingerprint(
            repo, exclude_paths=[evidence_dir]
        )
        self.assertEqual(baseline["sha256"], with_evidence["sha256"])

        without_exclusion = preflight.repository_fingerprint(repo)
        self.assertNotEqual(baseline["sha256"], without_exclusion["sha256"])

    def test_dirty_path_count_matches_reported_path_list(self) -> None:
        repo = self.make_repo()
        (repo / "a.txt").write_text("a")
        (repo / "nested").mkdir()
        (repo / "nested" / "b.txt").write_text("b")

        result = preflight.repository_fingerprint(repo)

        self.assertEqual(result["dirtyPathCount"], len(result["dirtyPaths"]))
        self.assertEqual(set(result["dirtyPaths"]), {"a.txt", "nested/b.txt"})

    def test_non_git_directory_fails_closed(self) -> None:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        self.assertIsNone(preflight.repository_fingerprint(directory))

    def test_unsupported_special_file_fails_closed(self) -> None:
        # Git's own working-tree walk is blind to FIFOs/sockets/devices (they
        # never appear in `git status`, so `repository_fingerprint` itself
        # never sees one via a real repo) — this exercises the read helper's
        # safety net directly rather than relying on git to surface one.
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        fifo = directory / "a.fifo"
        os.mkfifo(fifo)

        self.assertIsNone(preflight._read_untracked_entry(fifo))

    def test_file_mutating_during_read_fails_closed(self) -> None:
        repo = self.make_repo()
        target = repo / "mutating.txt"
        target.write_text("original")
        original_read_bytes = Path.read_bytes

        def flaky_read_bytes(self: Path) -> bytes:
            content = original_read_bytes(self)
            if self == target:
                # Simulate a writer mutating the file between the pre-read
                # and post-read stat, every single attempt, so the bounded
                # retry budget is always exhausted.
                with target.open("ab") as handle:
                    handle.write(b"!")
            return content

        with patch.object(Path, "read_bytes", flaky_read_bytes):
            result = preflight.repository_fingerprint(repo)

        self.assertIsNone(result)


class RepositoryDriftTest(unittest.TestCase):
    """The recorder must fail a session, not merely warn, if the repository
    it is attributing evidence to changes underneath it mid-recording."""

    def make_repo(self) -> Path:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory))
        subprocess.run(["git", "init", "-q"], cwd=directory, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=directory,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"], cwd=directory, check=True
        )
        (directory / "tracked.txt").write_text("original\n")
        subprocess.run(["git", "add", "tracked.txt"], cwd=directory, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=directory, check=True)
        return directory

    def pin(self, repo: Path) -> tuple[dict, threading.Lock]:
        fingerprint = preflight.repository_fingerprint(repo)
        self.assertIsNotNone(fingerprint)
        state = {
            "start": fingerprint["sha256"],
            "final": fingerprint["sha256"],
            "stable": True,
        }
        return state, threading.Lock()

    def test_unchanged_dirty_worktree_stays_stable(self) -> None:
        repo = self.make_repo()
        (repo / "untracked.txt").write_text("already here at pin time")
        state, lock = self.pin(repo)

        check_repo_fingerprint(repo, state, lock)
        check_repo_fingerprint(repo, state, lock)

        self.assertTrue(state["stable"])
        self.assertEqual(state["final"], state["start"])

    def test_tracked_file_edit_is_detected_as_drift(self) -> None:
        repo = self.make_repo()
        state, lock = self.pin(repo)

        (repo / "tracked.txt").write_text("edited during recording\n")
        check_repo_fingerprint(repo, state, lock)

        self.assertFalse(state["stable"])
        self.assertNotEqual(state["final"], state["start"])

    def test_untracked_file_edit_is_detected_as_drift(self) -> None:
        repo = self.make_repo()
        new_file = repo / "new.txt"
        new_file.write_text("before")
        state, lock = self.pin(repo)

        new_file.write_text("after")
        check_repo_fingerprint(repo, state, lock)

        self.assertFalse(state["stable"])

    def test_untracked_file_addition_is_detected_as_drift(self) -> None:
        repo = self.make_repo()
        state, lock = self.pin(repo)

        (repo / "appeared.txt").write_text("new during recording")
        check_repo_fingerprint(repo, state, lock)

        self.assertFalse(state["stable"])

    def test_untracked_file_removal_is_detected_as_drift(self) -> None:
        repo = self.make_repo()
        doomed = repo / "will-vanish.txt"
        doomed.write_text("present at pin time")
        state, lock = self.pin(repo)

        doomed.unlink()
        check_repo_fingerprint(repo, state, lock)

        self.assertFalse(state["stable"])

    def test_staged_state_change_is_detected_as_drift(self) -> None:
        repo = self.make_repo()
        (repo / "tracked.txt").write_text("staged during recording\n")
        state, lock = self.pin(repo)

        subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True)
        check_repo_fingerprint(repo, state, lock)

        self.assertFalse(state["stable"])

    def test_head_change_is_detected_as_drift(self) -> None:
        repo = self.make_repo()
        state, lock = self.pin(repo)

        (repo / "second.txt").write_text("committed during recording")
        subprocess.run(["git", "add", "second.txt"], cwd=repo, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "mid-recording commit"], cwd=repo, check=True
        )
        check_repo_fingerprint(repo, state, lock)

        self.assertFalse(state["stable"])

    def test_symlink_conversion_is_detected_as_drift(self) -> None:
        repo = self.make_repo()
        path = repo / "thing.txt"
        path.write_text("data")
        state, lock = self.pin(repo)

        path.unlink()
        path.symlink_to("data")
        check_repo_fingerprint(repo, state, lock)

        self.assertFalse(state["stable"])

    def test_restoration_after_drift_does_not_recover_stability(self) -> None:
        repo = self.make_repo()
        tracked = repo / "tracked.txt"
        state, lock = self.pin(repo)

        tracked.write_text("temporarily different\n")
        check_repo_fingerprint(repo, state, lock)
        self.assertFalse(state["stable"])
        drifted_final = state["final"]

        # Restore the exact original content and check again: periodic
        # validation already observed drift, so it must stay failed even
        # though the bytes now match the pinned start value again.
        tracked.write_text("original\n")
        check_repo_fingerprint(repo, state, lock)

        self.assertFalse(state["stable"])
        self.assertEqual(state["final"], drifted_final)

    def test_repository_inspection_failure_fails_closed(self) -> None:
        repo = self.make_repo()
        state, lock = self.pin(repo)

        shutil.rmtree(repo / ".git")
        check_repo_fingerprint(repo, state, lock)

        self.assertFalse(state["stable"])
        self.assertIsNone(state["final"])

    def test_excluded_output_directory_does_not_trigger_drift(self) -> None:
        repo = self.make_repo()
        output = repo / "session-evidence"
        output.mkdir()
        state = {
            "start": preflight.repository_fingerprint(repo, exclude_paths=(output,))[
                "sha256"
            ],
            "final": None,
            "stable": True,
        }
        lock = threading.Lock()

        (output / "manifest.json").write_text("{}")
        (output / "screen.mp4").write_bytes(b"not really a video")
        check_repo_fingerprint(repo, state, lock, exclude_paths=(output,))

        self.assertTrue(state["stable"])

    def test_drift_monitor_thread_detects_drift_and_stops(self) -> None:
        repo = self.make_repo()
        state, lock = self.pin(repo)
        stop = threading.Event()
        thread = threading.Thread(
            target=repository_drift_monitor,
            args=(repo, state, lock, stop),
            kwargs={"interval": 0.05},
            daemon=True,
        )
        thread.start()
        (repo / "tracked.txt").write_text("mutated while the monitor is running\n")
        thread.join(timeout=2)

        self.assertFalse(thread.is_alive())
        self.assertTrue(stop.is_set())
        self.assertFalse(state["stable"])

    def test_drift_monitor_thread_leaves_a_stable_repo_running_until_stopped(
        self,
    ) -> None:
        repo = self.make_repo()
        state, lock = self.pin(repo)
        stop = threading.Event()
        thread = threading.Thread(
            target=repository_drift_monitor,
            args=(repo, state, lock, stop),
            kwargs={"interval": 0.05},
            daemon=True,
        )
        thread.start()
        time.sleep(0.2)
        self.assertTrue(state["stable"])
        self.assertTrue(thread.is_alive())

        stop.set()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
