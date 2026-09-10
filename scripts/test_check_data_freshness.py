#!/usr/bin/env python3

import json
import unittest
from datetime import datetime, timezone
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

    def test_bounded_statistics_policy_decision_table(self):
        """Both bounds must hold. Patch inequality alone is not a verdict."""
        from check_data_freshness import (
            observation_age_hours, overall_status, patch_lag,
        )
        NOW = datetime(2026, 9, 11, tzinfo=timezone.utc)

        def classify(stats_pub, stats_up, struct_pub, struct_up, observed_at):
            return overall_status(
                freshness_status(struct_pub, struct_up),
                freshness_status(stats_pub, stats_up),
                stats_patch_lag=patch_lag(stats_pub, stats_up),
                stats_age_hours=observation_age_hours(observed_at, NOW),
            )

        FRESH = "2026-09-10T22:00:00Z"
        OUTAGE_59D = "2026-07-13T22:00:00Z"
        YEAR_OLD = "2025-09-10T22:00:00Z"

        cases = [
            ("26.17", "26.17", "26.18", "26.18", FRESH, "aligned"),
            ("26.16", "26.17", "26.18", "26.18", FRESH, "statistics_recently_behind"),
            ("26.16", "26.17", "26.18", "26.18", OUTAGE_59D, "statistics_stale"),
            ("26.13", "26.17", "26.18", "26.18", FRESH, "statistics_stale"),
            ("26.13", "26.17", "26.18", "26.18", OUTAGE_59D, "statistics_stale"),
            ("25.10", "26.17", "26.18", "26.18", YEAR_OLD, "statistics_stale"),
            ("26.17", "26.17", "26.18", "26.18", None, "unknown"),
            ("26.17", "26.17", "26.17", "26.18", FRESH, "structural_stale"),
            ("26.17", None, "26.18", "26.18", FRESH, "unknown"),
        ]
        for stats_pub, stats_up, struct_pub, struct_up, observed, expected in cases:
            with self.subTest(stats=stats_pub, observed=observed):
                self.assertEqual(
                    classify(stats_pub, stats_up, struct_pub, struct_up, observed),
                    expected,
                )

    def test_the_59_day_outage_is_never_reported_healthy(self):
        """The regression that motivated the bound.

        Every day of the 2026-07-12 -> 2026-09-10 outage looked like "just one
        more patch behind" and was reported as an expected steady state, which
        auto-closed the tracking issue.
        """
        from check_data_freshness import (
            HEALTHY_STATUSES, observation_age_hours, overall_status, patch_lag,
        )
        NOW = datetime(2026, 9, 10, tzinfo=timezone.utc)
        status = overall_status(
            freshness_status("26.18", "26.18"),
            freshness_status("26.13", "26.17"),
            stats_patch_lag=patch_lag("26.13", "26.17"),
            stats_age_hours=observation_age_hours("2026-07-12T22:38:58Z", NOW),
        )
        self.assertEqual(status, "statistics_stale")
        self.assertNotIn(status, HEALTHY_STATUSES)

    def test_cross_season_lag_is_not_reported_as_small(self):
        from check_data_freshness import patch_lag
        self.assertGreater(patch_lag("25.24", "26.01"), 1)

    def test_freshness_status_flags_stale_published_data(self):
        self.assertEqual(freshness_status("26.12", "26.13"), "stale")
        self.assertEqual(freshness_status("26.13", "26.13"), "fresh")
        self.assertEqual(freshness_status("26.14", "26.13"), "fresh")

    # Both clocks are always supplied explicitly so these stay hermetic — the
    # structural clock would otherwise be fetched from Riot over the network.
    BOTH_FRESH = [
        "--published-patch", "26.17", "--upstream-patch", "26.17",
        "--published-structural-patch", "26.18", "--upstream-structural-patch", "26.18",
        "--published-observed-at", "2026-09-10T22:00:00Z",
        "--now", "2026-09-11T00:00:00Z",
    ]

    def test_main_reports_fresh_json_with_zero_exit(self):
        out = StringIO()
        with patch("sys.argv", ["check", *self.BOTH_FRESH, "--json"]):
            with patch("sys.stdout", out):
                main()

        self.assertIn('"status": "aligned"', out.getvalue())

    def test_statistics_behind_within_policy_is_publishable(self):
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
        self.assertIn('"status": "aligned"', out.getvalue())

        out = StringIO()
        with patch("sys.argv", [
            "check",
            "--published-patch", "26.16", "--upstream-patch", "26.17",
            "--published-structural-patch", "26.18", "--upstream-structural-patch", "26.18",
            "--published-observed-at", "2026-09-10T22:00:00Z",
            "--now", "2026-09-11T00:00:00Z",
            "--json",
        ]):
            with patch("sys.stdout", out):
                main()  # must not raise
        self.assertIn('"status": "statistics_recently_behind"', out.getvalue())
        self.assertIn('"healthy": true', out.getvalue())

    def test_structural_drift_still_fails_with_exit_2(self):
        """Our catalog behind Riot's live patch remains a real failure."""
        out = StringIO()
        with patch("sys.argv", [
            "check",
            "--published-patch", "26.17", "--upstream-patch", "26.17",
            "--published-structural-patch", "26.17", "--upstream-structural-patch", "26.18",
            "--published-observed-at", "2026-09-10T22:00:00Z",
            "--now", "2026-09-11T00:00:00Z",
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
            "--published-observed-at", "2026-09-10T22:00:00Z",
            "--now", "2026-09-11T00:00:00Z",
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

        # Structural args are explicit so this stays hermetic; the subject of
        # the test is stdout/stderr routing, not clock classification.
        with patch("sys.argv", [
            "check", "--published-patch", "26.13",
            "--published-structural-patch", "26.18",
            "--upstream-structural-patch", "26.18",
            "--published-observed-at", "2026-09-10T22:00:00Z",
            "--now", "2026-09-11T00:00:00Z",
            "--json",
        ]):
            with patch("check_data_freshness.fetch_upstream_patch", side_effect=noisy_fetch):
                with patch("sys.stdout", out), patch("sys.stderr", err):
                    main()

        payload = json.loads(out.getvalue())
        self.assertEqual(payload["status"], "aligned")
        self.assertEqual(payload["published_patch"], "26.13")
        self.assertEqual(payload["upstream_patch"], "26.13")
        self.assertNotIn("Fetching", out.getvalue())
        self.assertIn("Fetching https://example.test/search-index.json ...", err.getvalue())


if __name__ == "__main__":
    unittest.main()
