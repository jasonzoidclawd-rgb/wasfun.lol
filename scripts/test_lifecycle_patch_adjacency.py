#!/usr/bin/env python3
"""A structural diff may be dated only when it compares adjacent patches.

Regression: after the 2026-07/09 outage the first CDragon run compared
16.13 -> 16.18. Ten augments appeared in that diff and every one was recorded
as "added in 26.18", which six augment pages rendered verbatim. Riot's 26.18
notes announce none of them. The diff proves only "present in the first
observation after a gap".
"""

from __future__ import annotations

import unittest

from generate_pool_rules import comparison_is_patch_adjacent, lifecycle_from_events


def event(slug, kind, base, target, label):
    return {
        "entity_type": "augment", "slug": slug, "change_kind": kind,
        "source_patch_label": label,
        "comparison": {"base_version": base, "target_version": target},
    }


ADJACENT = ("16.17.1+branch", "16.18.8+branch")
THE_REAL_GAP = ("16.13.7915903+branch", "16.18.8159717+branch")


class PatchAdjacencyTests(unittest.TestCase):
    def test_adjacent_patches(self):
        self.assertTrue(comparison_is_patch_adjacent(
            {"base_version": "16.17.1+x", "target_version": "16.18.8+x"}))

    def test_same_patch_rerun(self):
        self.assertTrue(comparison_is_patch_adjacent(
            {"base_version": "16.18.8+x", "target_version": "16.18.9+x"}))

    def test_the_real_16_13_to_16_18_gap_is_not_adjacent(self):
        self.assertFalse(comparison_is_patch_adjacent(
            {"base_version": THE_REAL_GAP[0], "target_version": THE_REAL_GAP[1]}))

    def test_season_rollover_is_adjacent(self):
        self.assertTrue(comparison_is_patch_adjacent(
            {"base_version": "16.24.5+x", "target_version": "17.01.1+x"}))

    def test_cross_season_gap_is_not_adjacent(self):
        self.assertFalse(comparison_is_patch_adjacent(
            {"base_version": "16.20.1+x", "target_version": "17.05.1+x"}))

    def test_missing_or_malformed_comparison_is_not_adjacent(self):
        for comparison in (None, {}, {"base_version": "x", "target_version": "y"},
                           {"target_version": "16.18.1+x"}):
            self.assertFalse(comparison_is_patch_adjacent(comparison), comparison)


class LifecycleAttributionTests(unittest.TestCase):
    def test_adjacent_addition_is_dated(self):
        out = lifecycle_from_events([event("new-aug", "added", *ADJACENT, "26.18")])
        self.assertEqual(out["added"], {"new-aug": "26.18"})
        self.assertEqual(out["first_observed_across_gap"], {})

    def test_cross_gap_addition_is_not_dated(self):
        out = lifecycle_from_events([event("do-or-die", "added", *THE_REAL_GAP, "26.18")])
        self.assertEqual(out["added"], {})
        self.assertEqual(out["first_observed_across_gap"], {"do-or-die": "added"})

    def test_adjacent_removal_is_dated(self):
        out = lifecycle_from_events([event("gone", "removed", *ADJACENT, "26.18")])
        self.assertEqual(out["removed"], {"gone": "26.18"})

    def test_cross_gap_removal_is_not_dated(self):
        out = lifecycle_from_events([event("gone", "removed", *THE_REAL_GAP, "26.18")])
        self.assertEqual(out["removed"], {})
        self.assertEqual(out["first_observed_across_gap"], {"gone": "removed"})

    def test_same_patch_rerun_emits_no_false_lifecycle(self):
        out = lifecycle_from_events([])
        self.assertEqual(out["added"], {})
        self.assertEqual(out["removed"], {})

    def test_outage_then_recovery_does_not_date_the_recovery_patch(self):
        """The exact 2026-07/09 shape: ten entities in one cross-gap diff."""
        events = [
            event(f"aug-{i}", "added", *THE_REAL_GAP, "26.18") for i in range(10)
        ]
        out = lifecycle_from_events(events)
        self.assertEqual(out["added"], {})
        self.assertEqual(len(out["first_observed_across_gap"]), 10)

    def test_a_later_adjacent_event_still_dates_the_slug(self):
        out = lifecycle_from_events([
            event("aug", "added", *THE_REAL_GAP, "26.18"),
            event("aug", "added", *ADJACENT, "26.18"),
        ])
        self.assertEqual(out["added"], {"aug": "26.18"})
        self.assertNotIn("aug", out["first_observed_across_gap"])


class LiveArtifactTests(unittest.TestCase):
    def test_no_augment_in_the_published_catalog_claims_a_fabricated_date(self):
        import json
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent
        augments = json.loads((root / "public/data/augments.json").read_text())["augments"]
        dated = [a for a in augments if (a.get("flags") or {}).get("lifecycle_patch")]
        for a in dated:
            self.assertTrue(
                (a.get("flags") or {}).get("lifecycle_event"),
                f"{a['slug']} has a patch without an event kind",
            )
        do_or_die = next((a for a in augments if a["slug"] == "do-or-die"), None)
        if do_or_die:
            self.assertIsNone(
                (do_or_die.get("flags") or {}).get("lifecycle_patch"),
                "Do or Die was first observed across a 16.13->16.18 gap and must carry no date",
            )


if __name__ == "__main__":
    unittest.main()
