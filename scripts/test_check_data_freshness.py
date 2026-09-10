#!/usr/bin/env python3

import json
import unittest
from io import StringIO
from unittest.mock import patch

from check_data_freshness import (
    compare_patches,
    freshness_status,
    main,
    resolve_upstream_patch,
)


class DataFreshnessTests(unittest.TestCase):
    def test_compare_patches_uses_numeric_ordering(self):
        self.assertLess(compare_patches("26.12", "26.13"), 0)
        self.assertGreater(compare_patches("26.13", "26.12"), 0)
        self.assertGreater(compare_patches("26.10", "26.9"), 0)
        self.assertEqual(compare_patches("26.13", "26.13"), 0)

    def test_resolve_upstream_patch_uses_highest_search_or_page_patch(self):
        upstream = resolve_upstream_patch(
            {"patch": "26.13"},
            [
                "<html>Patch 26.12</html>",
                "<html>Patch 26.11</html>",
            ],
        )

        self.assertEqual(upstream, "26.13")

    def test_freshness_status_flags_stale_published_data(self):
        self.assertEqual(freshness_status("26.12", "26.13"), "stale")
        self.assertEqual(freshness_status("26.13", "26.13"), "fresh")
        self.assertEqual(freshness_status("26.14", "26.13"), "fresh")

    # Both clocks are always supplied explicitly so these stay hermetic — the
    # structural clock would otherwise be fetched from Riot over the network.
    BOTH_FRESH = [
        "--published-patch", "26.17", "--upstream-patch", "26.17",
        "--published-structural-patch", "26.18", "--upstream-structural-patch", "26.18",
    ]

    def test_main_reports_fresh_json_with_zero_exit(self):
        out = StringIO()
        with patch("sys.argv", ["check", *self.BOTH_FRESH, "--json"]):
            with patch("sys.stdout", out):
                main()

        self.assertIn('"status": "fresh"', out.getvalue())

    def test_statistics_behind_is_publishable_and_does_not_exit_non_zero(self):
        """The deadlock fix.

        Our statistics provider routinely lags the live game by a patch. That is
        the normal steady state, so it must not fail the run — the gate used to
        exit 2 here, before the commit step, which meant a run that acquired
        good data but still trailed upstream published nothing.
        """
        out = StringIO()
        with patch("sys.argv", [
            "check",
            "--published-patch", "26.17", "--upstream-patch", "26.17",
            "--published-structural-patch", "26.18", "--upstream-structural-patch", "26.18",
            "--json",
        ]):
            with patch("sys.stdout", out):
                main()  # must not raise
        self.assertIn('"status": "fresh"', out.getvalue())

        out = StringIO()
        with patch("sys.argv", [
            "check",
            "--published-patch", "26.16", "--upstream-patch", "26.17",
            "--published-structural-patch", "26.18", "--upstream-structural-patch", "26.18",
            "--json",
        ]):
            with patch("sys.stdout", out):
                main()  # must not raise
        self.assertIn('"status": "statistics_behind"', out.getvalue())

    def test_structural_drift_still_fails_with_exit_2(self):
        """Our catalog behind Riot's live patch remains a real failure."""
        out = StringIO()
        with patch("sys.argv", [
            "check",
            "--published-patch", "26.17", "--upstream-patch", "26.17",
            "--published-structural-patch", "26.17", "--upstream-structural-patch", "26.18",
            "--json",
        ]):
            with patch("sys.stdout", out):
                with self.assertRaises(SystemExit) as cm:
                    main()

        self.assertEqual(cm.exception.code, 2)
        self.assertIn('"status": "structural_stale"', out.getvalue())

    def test_main_reports_unknown_json_when_upstream_fetch_fails(self):
        out = StringIO()
        with patch("sys.argv", [
            "check", "--published-patch", "26.13",
            "--published-structural-patch", "26.18", "--upstream-structural-patch", "26.18",
            "--json",
        ]):
            with patch("check_data_freshness.fetch_upstream_patch", side_effect=RuntimeError("upstream unavailable")):
                with patch("sys.stdout", out):
                    with self.assertRaises(SystemExit) as cm:
                        main()

        self.assertEqual(cm.exception.code, 1)
        self.assertIn('"status": "unknown"', out.getvalue())
        self.assertIn('"upstream_error": "upstream unavailable"', out.getvalue())

    def test_json_mode_redirects_fetch_stdout_and_outputs_parseable_json(self):
        out = StringIO()
        err = StringIO()

        def noisy_fetch():
            print("Fetching https://example.test/search-index.json ...")
            return "26.13"

        with patch("sys.argv", ["check", "--published-patch", "26.13", "--json"]):
            with patch("check_data_freshness.fetch_upstream_patch", side_effect=noisy_fetch):
                with patch("sys.stdout", out), patch("sys.stderr", err):
                    main()

        payload = json.loads(out.getvalue())
        self.assertEqual(payload["status"], "fresh")
        self.assertEqual(payload["published_patch"], "26.13")
        self.assertEqual(payload["upstream_patch"], "26.13")
        self.assertNotIn("Fetching", out.getvalue())
        self.assertIn("Fetching https://example.test/search-index.json ...", err.getvalue())


if __name__ == "__main__":
    unittest.main()
