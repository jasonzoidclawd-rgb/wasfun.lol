#!/usr/bin/env python3
"""Win-rate extraction must fail closed, never infer meaning from magnitude."""

from __future__ import annotations

import unittest

from scrape_arammayhem import (
    extract_augment_win_rate,
    is_implausible_win_rate,
    parse_augments,
    validated_win_rate,
)


def block(inner: str, slug: str = "tank-engine") -> str:
    return f'<a href="/augments/{slug}" class="augment-rank-row">{inner}</a>'


class WinRateExtractionTests(unittest.TestCase):
    def test_badge_markup_is_preferred(self):
        self.assertEqual(
            extract_augment_win_rate('<span class="wr">67.48<!-- -->%</span> 21.30%'),
            (67.48, "badge"),
        )

    def test_labelled_win_rate_is_used_when_badge_is_absent(self):
        self.assertEqual(
            extract_augment_win_rate("Pick Rate: 63.98% Win Rate: 55.25%"),
            (55.25, "labelled"),
        )

    def test_sole_percentage_is_unambiguous(self):
        self.assertEqual(
            extract_augment_win_rate("<div>54.10 %</div>"),
            (54.10, "sole_percentage"),
        )

    def test_structural_cells_identify_win_rate_by_emphasis_not_magnitude(self):
        """The case max() gets wrong: pick rate HIGHER than win rate."""
        row = (
            '<span class="text-info sm:hidden">63.98%</span>'
            '<div class="text-right font-data text-foreground sm:text-lg">55.25%</div>'
            '<div class="hidden text-right text-muted-foreground sm:block">63.98%</div>'
        )
        value, method = extract_augment_win_rate(row)
        self.assertEqual(value, 55.25, "win rate is the primary cell, not the largest number")
        self.assertEqual(method, "structural")
        self.assertNotEqual(value, 63.98)

    def test_live_rank_row_shape_extracts_correctly(self):
        """Verbatim shape of a live 2026-09-10 rank row (transmute-prismatic)."""
        row = (
            '<span class="rounded border border-info/50 bg-info/15 px-1.5 py-0.5 '
            'font-data text-xs font-bold text-info sm:hidden">63.98%</span></div></div></div>'
            '<div class="text-right font-data text-base font-semibold text-foreground '
            'sm:text-lg">65.22%</div>'
            '<div class="hidden text-right font-data text-sm text-muted-foreground '
            'sm:block">63.98%</div>'
        )
        self.assertEqual(extract_augment_win_rate(row), (65.22, "structural"))

    def test_ambiguous_percentages_quarantine_instead_of_guessing(self):
        # The regression: pick rate 63.98 > win rate 55.25. The old
        # `max(percentages)` fallback published 63.98 as the win rate.
        value, method = extract_augment_win_rate("<div>55.25%</div><div>63.98%</div>")
        self.assertIsNone(value)
        self.assertEqual(method, "quarantined_ambiguous_percentages")

    def test_no_percentage_quarantines(self):
        self.assertEqual(
            extract_augment_win_rate("<div>no data</div>"),
            (None, "quarantined_no_percentage"),
        )

    def test_max_percentage_heuristic_is_gone(self):
        """Guard the exact historical defect: highest % must not win."""
        value, _ = extract_augment_win_rate("<div>49.82%</div><div>91.40%</div>")
        self.assertNotEqual(value, 91.40)
        self.assertIsNone(value)

    def test_parse_augments_records_absent_denominators_explicitly(self):
        rows = parse_augments(block('<span class="wr">67.48<!-- -->%</span>'))
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["win_rate"], 67.48)
        self.assertIsNone(row["games"])
        self.assertFalse(row["sampleDisclosed"])
        self.assertEqual(row["extraction"], "badge")

    def test_quarantined_row_carries_null_win_rate(self):
        rows = parse_augments(block("<div>55.25%</div><div>63.98%</div>"))
        self.assertIsNone(rows[0]["win_rate"])
        self.assertTrue(rows[0]["extraction"].startswith("quarantined"))


if __name__ == "__main__":
    unittest.main()


# ── Numeric validity (2026-09 final review) ─────────────────────────────────
# Failing closed on MARKUP is not enough: a marker can survive while the cell
# behind it is repurposed. Every extraction path routes through one numeric
# boundary, so no branch can publish a number the others would reject.

BADGE = '<span class="wr">{}<!-- -->%</span>'
LABELLED = "Win Rate: {}%"
MUTED = '<div class="hidden text-right text-muted-foreground sm:block">63.98%</div>'
STRUCTURAL = '<div class="text-right font-data text-foreground sm:text-lg">{}%</div>'


class WinRateRangeValidationTests(unittest.TestCase):
    def _all_paths(self, value):
        """The same value through badge, labelled and structural extraction."""
        return {
            "badge": extract_augment_win_rate(BADGE.format(value)),
            "labelled": extract_augment_win_rate(LABELLED.format(value)),
            "structural": extract_augment_win_rate(STRUCTURAL.format(value) + MUTED),
        }

    def test_out_of_range_values_are_quarantined_on_every_path(self):
        for value in ("155.0", "999.9", "100.1"):
            for path, (wr, method) in self._all_paths(value).items():
                with self.subTest(value=value, path=path):
                    self.assertIsNone(wr, f"{value} must not publish via {path}")
                    self.assertEqual(method, "quarantined_out_of_range")

    def test_negative_values_are_quarantined(self):
        # A leading "-" is not part of the numeric capture, so a negative reads
        # as its magnitude; assert explicitly that the boundary rejects a real
        # negative rather than relying on the regex to hide it.
        self.assertEqual(validated_win_rate(-5.0), (None, "quarantined_out_of_range"))
        self.assertEqual(validated_win_rate("-0.5"), (None, "quarantined_out_of_range"))

    def test_non_finite_and_unparseable_values_are_quarantined(self):
        self.assertEqual(validated_win_rate(float("nan")), (None, "quarantined_non_finite_value"))
        self.assertEqual(validated_win_rate(float("inf")), (None, "quarantined_non_finite_value"))
        self.assertEqual(validated_win_rate("abc"), (None, "quarantined_unparseable_value"))
        self.assertEqual(validated_win_rate(None), (None, "quarantined_unparseable_value"))

    def test_boundary_values_are_accepted(self):
        for value in ("0", "0.0", "100", "100.0"):
            for path, (wr, method) in self._all_paths(value).items():
                with self.subTest(value=value, path=path):
                    self.assertEqual(wr, float(value))
                    self.assertEqual(method, path)

    def test_normal_values_are_unaffected(self):
        for path, (wr, method) in self._all_paths("55.25").items():
            with self.subTest(path=path):
                self.assertEqual(wr, 55.25)
                self.assertEqual(method, path)

    def test_an_out_of_range_sibling_no_longer_narrows_to_a_confident_answer(self):
        """Magnitude filtering used to drop 155% and leave one 'sole' value."""
        wr, method = extract_augment_win_rate("<div>155.0%</div><div>63.98%</div>")
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_ambiguous_percentages")

    def test_implausible_but_valid_values_are_reported_not_discarded(self):
        wr, method = extract_augment_win_rate(BADGE.format("12.5"))
        self.assertEqual(wr, 12.5)
        self.assertEqual(method, "badge")
        self.assertTrue(is_implausible_win_rate(12.5))
        self.assertFalse(is_implausible_win_rate(55.25))

    def test_quarantined_rows_carry_their_reason(self):
        rows = parse_augments(block('<span class="wr">155.0<!-- -->%</span>'))
        self.assertIsNone(rows[0]["win_rate"])
        self.assertEqual(rows[0]["extraction"], "quarantined_out_of_range")

    def test_live_source_rows_are_all_in_range(self):
        import json
        from pathlib import Path
        feed = json.loads(
            (Path(__file__).resolve().parent.parent
             / "data/internal/augment-winrate-feed.json").read_text()
        )
        for augment_id, value in feed["win_rates"].items():
            self.assertEqual(validated_win_rate(value)[1], None, augment_id)
