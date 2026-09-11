#!/usr/bin/env python3
"""A failed locale enrichment must stop the run before anything publishes.

Regression: step 8 rebuilds abilities.json/items.json from CommunityDragon with
English fields only; step 10b puts the localized names and descriptions back.
The locale lane was `optional`, so a Data Dragon timeout after the champion
write left English-only abilities/items in place, the coverage gate (champions
and augments only) passed, and the de-localized files were exported and pushed.

These tests run the real `update-data.sh` inside a sandbox root. Every
acquisition command is stubbed, so they are hermetic; the lane policy, the
inline gates and the status writer are the real ones.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "update-data.sh"
LOCALE_STEP = "scripts/enrich_locale_names.py"
PUBLISH_STEP = "scripts/export_public_catalog.py"
LOCALES = ("zh_TW", "zh_CN", "ja", "ko")
BREAKERS = (
    "draw-your-sword", "jeweled-gauntlet", "master-of-duality", "mystic-punch",
    "tap-dancer", "marksmage", "slow-and-steady", "vulnerability",
)

# `python3 scripts/<x>.py` and `npx ...` are stubbed and logged; inline
# `python3 -`/`python3 -c` blocks run on the real interpreter.
PYTHON_STUB = f"""#!/usr/bin/env bash
case "$1" in
  scripts/*)
    echo "$1" >> "$STUB_LOG"
    if [ "$1" = "{LOCALE_STEP}" ]; then exit "${{LOCALE_EXIT:-0}}"; fi
    exit 0 ;;
  *) exec "{sys.executable}" "$@" ;;
esac
"""
NPX_STUB = """#!/usr/bin/env bash
echo "npx $*" >> "$STUB_LOG"
exit 0
"""


def localized(**fields: object) -> dict:
    return {**fields, **{f"name_{suffix}": "x" for suffix in LOCALES}}


class LocaleEnrichmentRequiredTests(unittest.TestCase):
    def run_pipeline(self, locale_exit: int) -> tuple[subprocess.CompletedProcess, list[str], dict]:
        with tempfile.TemporaryDirectory() as tmp:
            sandbox = Path(tmp)
            (sandbox / "scripts").mkdir()
            shutil.copy(SCRIPT, sandbox / "scripts" / "update-data.sh")
            bin_dir = sandbox / "bin"
            bin_dir.mkdir()
            for name, body in (("python3", PYTHON_STUB), ("npx", NPX_STUB)):
                (bin_dir / name).write_text(body, encoding="utf-8")
                (bin_dir / name).chmod(0o755)

            data = sandbox / "data" / "internal"
            data.mkdir(parents=True)
            (data / "meta.json").write_text(json.dumps({"patch": "26.17"}))
            (data / "patch-metadata.json").write_text(json.dumps({"patch": "26.18"}))
            (data / "champions.json").write_text(json.dumps({"champions": [
                localized(slug="brand", kit_tags=["mage"]),
            ]}))
            (data / "augments.json").write_text(json.dumps({"augments": [
                localized(slug=slug, kit_tags=["t"], flags={"system_breaker": True})
                for slug in BREAKERS
            ]}))

            log = sandbox / "stub.log"
            log.touch()
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "STUB_LOG": str(log),
                "LOCALE_EXIT": str(locale_exit),
            }
            env.pop("MAYHEM_DATA_DIR", None)
            result = subprocess.run(
                ["bash", str(sandbox / "scripts" / "update-data.sh")],
                cwd=str(sandbox), env=env, capture_output=True, text=True,
            )
            calls = log.read_text(encoding="utf-8").splitlines()
            status = json.loads((data / "pipeline-status.json").read_text(encoding="utf-8"))
        return result, calls, status

    def test_failed_locale_enrichment_prevents_publication(self):
        result, calls, status = self.run_pipeline(locale_exit=1)

        self.assertNotEqual(result.returncode, 0, result.stdout[-2000:])
        self.assertIn(LOCALE_STEP, calls)
        # Nothing downstream of the failed lane ran — above all, not the export
        # that writes public/data, and not the steps the workflow publishes after.
        self.assertNotIn(PUBLISH_STEP, calls)
        self.assertNotIn("scripts/check_roster_coverage.py", calls)
        self.assertIn("required lane 'locale-name-enrich' failed", result.stderr)
        self.assertEqual(status["overall"], "failed")
        self.assertNotIn("locale-name-enrich", status["degraded_lanes"],
                         "a locale failure must not be downgraded to a degraded publish")

    def test_successful_locale_enrichment_keeps_existing_behavior(self):
        result, calls, status = self.run_pipeline(locale_exit=0)

        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertLess(calls.index(LOCALE_STEP), calls.index(PUBLISH_STEP))
        self.assertIn("scripts/check_roster_coverage.py", calls)
        self.assertEqual(status["overall"], "ok")
        self.assertEqual(status["degraded_lanes"], [])


if __name__ == "__main__":
    unittest.main()
