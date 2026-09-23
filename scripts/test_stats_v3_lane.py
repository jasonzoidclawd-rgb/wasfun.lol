#!/usr/bin/env python3
"""The v3 statistics lane restores every file it touched when any step fails."""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("update-data.sh").read_text(encoding="utf-8")
FUNCTION = re.search(r"run_stats_v3\(\) \{.*?\n\}\n", SCRIPT, re.S).group(0)
FILES = ("augment-stats-feed.json", "champion-build-feed.json", "changed-augments.json", "augment-kit-tags.json")


def run_lane(data: Path, fail_at: str) -> subprocess.CompletedProcess:
    """Stub python3: every step 'writes' its outputs; the step named fail_at exits 1."""
    stub = f"""#!/usr/bin/env bash
for f in {' '.join(FILES)}; do echo new > "$DATA_DIR/$f"; done
case "$1" in *{fail_at}*) exit 1;; esac
exit 0
"""
    bin_dir = data.parent / "bin"
    bin_dir.mkdir(exist_ok=True)
    (bin_dir / "python3").write_text(stub)
    os.chmod(bin_dir / "python3", 0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "DATA_DIR": str(data)}
    return subprocess.run(["bash", "-c", FUNCTION + "\nrun_stats_v3"], env=env, capture_output=True, text=True)


class StatsLaneRollbackTests(unittest.TestCase):
    def test_every_file_is_restored_whichever_step_fails(self):
        for step in ("scrape_mayhem_stats", "changed_augments", "augment_kit_tags", "validate_stats_feeds"):
            with tempfile.TemporaryDirectory() as tmp:
                data = Path(tmp) / "data"
                data.mkdir()
                for f in FILES[:3]:
                    (data / f).write_text("old")
                result = run_lane(data, step)
                self.assertEqual(result.returncode, 1, step)
                for f in FILES[:3]:
                    self.assertEqual((data / f).read_text(), "old", f"{step}: {f}")
                self.assertFalse((data / FILES[3]).exists(), f"{step}: a file that did not exist is removed")

    def test_success_keeps_the_new_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            data.mkdir()
            result = run_lane(data, "never-matches")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((data / FILES[0]).read_text().strip(), "new")


if __name__ == "__main__":
    unittest.main()
