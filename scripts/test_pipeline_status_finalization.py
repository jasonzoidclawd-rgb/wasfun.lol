#!/usr/bin/env python3
"""`pipeline-status.json` must describe the FINAL outcome of the run.

Regression: the status was written at step 18, before the public export and the
roster-coverage gate. A run that failed one of those still left an artifact
claiming `{"overall": "ok"}` — the one file whose entire purpose is to report
degradation was able to lie about it.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "update-data.sh"


class PipelineStatusFinalizationTests(unittest.TestCase):
    def test_final_status_write_happens_after_every_required_gate(self):
        text = SCRIPT.read_text(encoding="utf-8")
        finalize = text.index("write_pipeline_status ok")
        for gate in (
            "python3 scripts/export_public_catalog.py",
            "python3 scripts/check_roster_coverage.py",
        ):
            self.assertLess(
                text.index(gate), finalize, f"{gate} must run before the final status write"
            )

    def test_run_is_marked_in_flight_before_any_lane(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertLess(
            text.index("write_pipeline_status running"),
            text.index('step "1/19'),
        )

    def test_exit_before_completion_is_recorded_as_failed(self):
        """A required gate failing after an optimistic write must not leave 'ok'."""
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            # Seed the exact hazard: a stale success from a previous run.
            (data_dir / "pipeline-status.json").write_text(
                json.dumps({"overall": "ok", "note": "stale"}), encoding="utf-8"
            )
            env = {**os.environ, "MAYHEM_DATA_DIR": str(data_dir)}
            result = subprocess.run(
                ["bash", str(SCRIPT)],
                cwd=str(ROOT), env=env, capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0, "run was expected to fail")
            status = json.loads((data_dir / "pipeline-status.json").read_text())

        self.assertEqual(status["overall"], "failed")
        self.assertNotEqual(status["overall"], "ok")
        self.assertIn("before completing required gates", status.get("detail", ""))

    def test_isolated_run_does_not_publish_its_status(self):
        published_before = json.loads(
            (ROOT / "public" / "data" / "pipeline-status.json").read_text()
        )
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "MAYHEM_DATA_DIR": tmp}
            subprocess.run(
                ["bash", str(SCRIPT)],
                cwd=str(ROOT), env=env, capture_output=True, text=True,
            )
        published_after = json.loads(
            (ROOT / "public" / "data" / "pipeline-status.json").read_text()
        )
        self.assertEqual(published_before, published_after)


if __name__ == "__main__":
    unittest.main()
