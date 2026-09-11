#!/usr/bin/env python3
"""Win-rate extraction must fail closed, never infer meaning from magnitude."""

from __future__ import annotations

import html
import unicodedata
import unittest
from html.parser import HTMLParser
from unittest.mock import patch

import scrape_arammayhem
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


# ── End-to-end token integrity (2026-09 pre-merge review) ───────────────────
# The numeric boundary was right, but extraction trimmed tokens before they
# reached it: "-1%" arrived as "1", "NaN%" did not arrive at all, and the
# vacancy let a sibling pick rate be promoted. These cases run the real page
# shape through `parse_augments`, not the validator in isolation.

PICK_RATE = "63.98"


def live_row(win_rate_cell: str, *, pick_rate: str = PICK_RATE, split: bool = False,
             slug: str = "tank-engine") -> str:
    """The live 2026-09-10 rank-row shape, with the win-rate cell's text replaced.

    `split` renders every stat the way React server output does when a
    component writes `{value}%`: `63.98<!-- -->%`.
    """
    sep = "<!-- -->" if split else ""
    return (
        f'<a href="/augments/{slug}/" class="augment-rank-row grid items-center" '
        f'data-availability="live">'
        '<div class="font-data text-lg font-bold text-foreground"><span data-rank-label>6</span></div>'
        '<div class="flex min-w-0 items-center gap-3"><div class="min-w-0">'
        '<div class="flex min-w-0 items-center gap-2">'
        '<span class="truncate text-sm font-semibold text-foreground sm:text-base">Tank Engine</span>'
        '</div><div class="mt-1 flex flex-wrap items-center gap-1.5">'
        '<span class="rounded border px-1.5 py-0.5 text-2xs font-semibold">Gold</span>'
        '<span class="rounded border border-info/50 bg-info/15 px-1.5 py-0.5 font-data '
        f'text-xs font-bold text-info sm:hidden">{pick_rate}{sep}%</span>'
        '</div></div></div>'
        '<div class="text-right font-data text-base font-semibold text-foreground sm:text-lg">'
        f'{win_rate_cell}</div>'
        '<div class="hidden text-right font-data text-sm text-muted-foreground sm:block">'
        f'{pick_rate}{sep}%</div>'
        '</a>'
    )


def extracted(html: str) -> tuple[float | None, str]:
    rows = parse_augments(html)
    assert len(rows) == 1, rows
    return rows[0]["win_rate"], rows[0]["extraction"]


class SignedTokenTests(unittest.TestCase):
    """A. A negative win rate must never be read as its magnitude."""

    def test_labelled_negative_is_quarantined_not_flipped(self):
        self.assertEqual(extracted(block("Win Rate: -1%")), (None, "quarantined_out_of_range"))

    def test_sole_negative_is_quarantined_not_flipped(self):
        self.assertEqual(extracted(block("<div>-1%</div>")), (None, "quarantined_out_of_range"))

    def test_structural_negative_is_quarantined_not_flipped(self):
        self.assertEqual(extracted(live_row("-1%")), (None, "quarantined_out_of_range"))

    def test_badge_negative_is_quarantined_not_flipped(self):
        self.assertEqual(
            extracted(block('<span class="wr">-1<!-- -->%</span>')),
            (None, "quarantined_out_of_range"),
        )

    def test_unicode_minus_is_a_sign_too(self):
        self.assertEqual(extracted(block("Win Rate: −1%")), (None, "quarantined_out_of_range"))

    def test_explicit_plus_sign_marks_a_delta_not_a_win_rate(self):
        self.assertEqual(extracted(live_row("+1.2%")), (None, "quarantined_signed_value"))
        self.assertEqual(extracted(live_row("-0%")), (None, "quarantined_signed_value"))


class NonFiniteTokenTests(unittest.TestCase):
    """B. An invalid explicit win rate quarantines; it never vacates the slot."""

    def test_labelled_nan_does_not_promote_the_pick_rate(self):
        for token in ("NaN", "Infinity", "inf", "-Infinity"):
            with self.subTest(token=token):
                wr, method = extracted(block(f"Win Rate: {token}% Pick Rate: {PICK_RATE}%"))
                self.assertIsNone(wr)
                self.assertNotEqual(wr, float(PICK_RATE))
                self.assertEqual(method, "quarantined_non_finite_value")

    def test_structural_nan_does_not_promote_the_pick_rate(self):
        for token in ("NaN", "Infinity"):
            with self.subTest(token=token):
                self.assertEqual(
                    extracted(live_row(f"{token}%")), (None, "quarantined_non_finite_value")
                )

    def test_badge_nan_does_not_promote_the_pick_rate(self):
        self.assertEqual(
            extracted(block(f'<span class="wr">NaN<!-- -->%</span> {PICK_RATE}%')),
            (None, "quarantined_non_finite_value"),
        )

    def test_unmarked_nan_sibling_keeps_the_row_ambiguous(self):
        wr, method = extracted(block(f"<div>NaN%</div><div>{PICK_RATE}%</div>"))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_ambiguous_percentages")


class MissingWinRateTests(unittest.TestCase):
    """C. An absent win rate beside a duplicated pick rate is not a sole value."""

    def test_dash_win_rate_with_duplicated_pick_rate_is_quarantined(self):
        for dash in ("—", "-", "N/A", ""):
            with self.subTest(dash=dash):
                wr, method = extracted(live_row(dash))
                self.assertIsNone(wr, "the duplicated pick rate must not become the win rate")
                self.assertEqual(method, "quarantined_pick_rate_only")

    def test_labelled_absent_win_rate_is_quarantined(self):
        wr, method = extracted(block(f"Win Rate: — Pick Rate: {PICK_RATE}%"))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_win_rate_unavailable")

    def test_labelled_pick_rate_is_never_a_sole_win_rate(self):
        wr, method = extracted(block(f"<div>Pick Rate: {PICK_RATE}%</div>"))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_pick_rate_only")

    def test_unmarked_duplicate_is_not_collapsed_into_a_sole_value(self):
        """Only the pick rate is rendered twice by this source (desktop + mobile)."""
        wr, method = extracted(block(
            f"<div>—</div><div>{PICK_RATE}%</div><span>{PICK_RATE}%</span>"
        ))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_ambiguous_percentages")


class ReactSplitMarkupTests(unittest.TestCase):
    """D. `<!-- -->` split markup must not let the mobile pick-rate badge win."""

    def test_split_row_reads_the_win_rate_not_the_first_badge(self):
        wr, method = extracted(live_row("55.25<!-- -->%", split=True))
        self.assertEqual(wr, 55.25)
        self.assertNotEqual(wr, float(PICK_RATE))
        # The split win-rate cell is still the primary emphasis cell, which
        # outranks the weaker badge fallback.
        self.assertEqual(method, "structural")

    def test_split_row_with_absent_win_rate_is_quarantined(self):
        wr, method = extracted(live_row("—", split=True))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_pick_rate_only")

    def test_split_row_with_invalid_win_rate_is_quarantined(self):
        self.assertEqual(
            extracted(live_row("NaN<!-- -->%", split=True)),
            (None, "quarantined_non_finite_value"),
        )

    def test_two_unmarked_badges_are_ambiguous_not_first_wins(self):
        wr, method = extracted(block(
            '<span class="wr">67.48<!-- -->%</span><span class="x">21.30<!-- -->%</span>'
        ))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_ambiguous_percentages")


class MalformedTokenTests(unittest.TestCase):
    """E. A malformed token quarantines its row; it cannot end the lane."""

    MALFORMED = ("1.2.3", "..", ".", "5..5", "1_0", "1e2", "1,5", "５５")

    def test_malformed_tokens_quarantine_on_every_path(self):
        for token in self.MALFORMED:
            for label, html in (
                ("sole", block(f"<div>{token}%</div>")),
                ("labelled", block(f"Win Rate: {token}%")),
                ("structural", live_row(f"{token}%")),
                ("badge", block(f'<span class="wr">{token}<!-- -->%</span>')),
            ):
                with self.subTest(token=token, path=label):
                    wr, method = extracted(html)  # must not raise
                    self.assertIsNone(wr)
                    self.assertEqual(method, "quarantined_unparseable_value")

    def test_malformed_sibling_does_not_raise(self):
        wr, method = extracted(block(f"<div>1.2.3%</div><div>{PICK_RATE}%</div>"))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_ambiguous_percentages")

    def test_one_malformed_row_leaves_the_rest_of_the_page_intact(self):
        page = (
            live_row("55.25%", slug="good-one")
            + live_row("1.2.3%", slug="broken")
            + block("<div>1..2%</div><div>..%</div>", slug="also-broken")
            + live_row("48.10%", slug="good-two")
        )
        rows = {row["sourceKey"]: row for row in parse_augments(page)}
        self.assertEqual(rows["good-one"]["win_rate"], 55.25)
        self.assertEqual(rows["good-two"]["win_rate"], 48.10)
        self.assertIsNone(rows["broken"]["win_rate"])
        self.assertEqual(rows["broken"]["extraction"], "quarantined_unparseable_value")
        self.assertIsNone(rows["also-broken"]["win_rate"])


class EndToEndAcceptanceTests(unittest.TestCase):
    """Valid values still publish, end to end, on the live row shape."""

    def test_valid_values_are_accepted(self):
        for token, expected in (("0", 0.0), ("100", 100.0), ("55.25", 55.25),
                                ("12.5", 12.5), ("97.0", 97.0), ("0.0", 0.0)):
            for split in (False, True):
                with self.subTest(token=token, split=split):
                    cell = f"{token}<!-- -->%" if split else f"{token}%"
                    wr, method = extracted(live_row(cell, split=split))
                    self.assertEqual(wr, expected)
                    self.assertEqual(method, "structural")

    def test_out_of_range_values_are_rejected(self):
        for token in ("100.01", "155", "-0.01"):
            with self.subTest(token=token):
                self.assertEqual(
                    extracted(live_row(f"{token}%")), (None, "quarantined_out_of_range")
                )

    def test_pick_rate_higher_than_win_rate_still_resolves_by_emphasis(self):
        self.assertEqual(extracted(live_row("48.09%", pick_rate="60.32")), (48.09, "structural"))


# ── Fail-closed attribution (2026-09 final delta review) ────────────────────
# Three residual ways a pick rate, or the tail of a larger expression, could
# still be published as a win rate: a label reaching past the value it captions,
# a numeric suffix read out of a signed or fractional expression, and a pick-rate
# duplicate whose evidence sat on an enclosing element or drifted class.

MOBILE_BADGE = (
    '<span class="rounded border border-info/50 bg-info/15 px-1.5 py-0.5 font-data '
    'text-xs font-bold text-info sm:hidden">{}</span>'
)


def nested_mobile_row(win_rate_cell: str, *, split: bool = True,
                      badge_classes: str = "text-info sm:hidden") -> str:
    """`live_row` with the mobile pick-rate badge's value inside an unclassed child."""
    sep = "<!-- -->" if split else ""
    row = live_row(win_rate_cell, split=split)
    flat = MOBILE_BADGE.format(f"{PICK_RATE}{sep}%")
    assert flat in row, "live_row's mobile badge markup changed"
    return row.replace(
        flat, f'<span class="{badge_classes}"><span>{PICK_RATE}{sep}%</span></span>'
    )


class LabelAttributionTests(unittest.TestCase):
    """A1. A label may name only a value it provably introduces."""

    SUFFIX_LABELS = {
        "sr-only suffix": live_row('55.25%<span class="sr-only">Win rate</span>'),
        "sr-only suffix, split": live_row(
            '55.25<!-- -->%<span class="sr-only">Win rate</span>', split=True
        ),
        "visible suffix": live_row("55.25% <small>Win Rate</small>"),
        "visible suffix, split": live_row("55.25<!-- -->% <small>Win Rate</small>", split=True),
        "value-first cards": block(
            "<div><b>55.25%</b><span>Win Rate</span></div>"
            f"<div><b>{PICK_RATE}%</b><span>Pick Rate</span></div>"
        ),
        "value-first cards, split": block(
            "<div><b>55.25<!-- -->%</b><span>Win Rate</span></div>"
            f"<div><b>{PICK_RATE}<!-- -->%</b><span>Pick Rate</span></div>"
        ),
        "value-first flat": block(
            f"<b>55.25%</b><span>Win Rate</span><b>{PICK_RATE}%</b><span>Pick Rate</span>"
        ),
        "value-first flat, split": block(
            "<b>55.25<!-- -->%</b><span>Win Rate</span>"
            f"<b>{PICK_RATE}<!-- -->%</b><span>Pick Rate</span>"
        ),
        "value-first text": block(f"55.25% Win Rate {PICK_RATE}% Pick Rate"),
    }

    def test_a_suffix_label_never_captures_the_following_pick_rate(self):
        for name, html in self.SUFFIX_LABELS.items():
            with self.subTest(layout=name):
                wr, method = extracted(html)
                self.assertNotEqual(wr, float(PICK_RATE), "the pick rate became the win rate")
                self.assertIsNone(wr)
                self.assertEqual(method, "quarantined_unattributed_label")

    def test_five_suffix_labelled_rows_publish_no_pick_rate(self):
        page = "".join(
            live_row(
                f'{50 + i / 10:.2f}%<span class="sr-only">Win rate</span>',
                pick_rate=f"{30 + i:.2f}",
                slug=f"row-{i}",
            )
            for i in range(5)
        )
        rows = parse_augments(page)
        self.assertEqual(len(rows), 5)
        for i, row in enumerate(rows):
            with self.subTest(row=row["sourceKey"]):
                self.assertNotEqual(row["win_rate"], 30 + i)
                self.assertIsNone(row["win_rate"])
                self.assertNotEqual(row["extraction"], "labelled")

    def test_a_label_does_not_reach_out_of_its_own_group(self):
        wr, method = extracted(block(
            f"<div><span>Win Rate</span></div><div><b>{PICK_RATE}%</b></div>"
        ))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_win_rate_unavailable")

    def test_a_label_pointing_at_pick_rate_evidence_is_quarantined(self):
        wr, method = extracted(block(
            f'<span>Win Rate</span><div class="text-muted-foreground">{PICK_RATE}%</div>'
        ))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_pick_rate_collision")

    def test_label_first_layouts_still_resolve(self):
        for name, html in {
            "sr-only prefix": live_row('<span class="sr-only">Win rate</span>55.25%'),
            "grouped cards": block(
                f"<div><span>Pick Rate</span><b>{PICK_RATE}%</b></div>"
                "<div><span>Win Rate</span><b>55.25%</b></div>"
            ),
            "separated text": block(f"Pick Rate: {PICK_RATE}% Win Rate: 55.25%"),
        }.items():
            with self.subTest(layout=name):
                self.assertEqual(extracted(html), (55.25, "labelled"))


class WholeExpressionTests(unittest.TestCase):
    """A2. A numeric suffix of a larger expression is never the value."""

    # Signed (entity, typographic and separated), fractional, split and
    # decorated expressions whose trailing digits alone would look valid.
    EXPRESSIONS = (
        "&minus;1", "&#45;1", "&#x2212;1", "&plus;1", "–1", "—1", "－1",
        "﹣1", "- 1", "− 1", "<span>-</span>1", "<span>&minus;</span>1",
        "<b>–</b> 1", "1/2", "1⁄2", "1 5", "<b>1</b>5", "~55", "&gt;55",
        "±55", "≈55",
    )

    def test_no_path_publishes_the_trailing_digits(self):
        for expression in self.EXPRESSIONS:
            for path, html in (
                ("sole", block(f"<div>{expression}%</div>")),
                ("structural", live_row(f"{expression}%")),
                ("badge", block(f'<span class="wr">{expression}<!-- -->%</span>')),
                ("labelled", block(f"Win Rate: {expression}%")),
            ):
                with self.subTest(expression=expression, path=path):
                    wr, method = extracted(html)
                    self.assertIsNone(wr, f"published {wr} from {expression!r}")
                    self.assertTrue(method.startswith("quarantined"), method)

    def test_standalone_values_are_still_accepted(self):
        for token, expected in (("0", 0.0), ("100", 100.0), ("55.25", 55.25),
                                ("12.5", 12.5), ("97.0", 97.0)):
            with self.subTest(token=token):
                self.assertEqual(extracted(block(f"<div>{token}%</div>")),
                                 (expected, "sole_percentage"))
                self.assertEqual(extracted(block(f"<div>Win Rate: {token}%</div>")),
                                 (expected, "labelled"))


class PickRateEvidenceTests(unittest.TestCase):
    """A3. A value already evidenced as the pick rate never becomes the win rate."""

    def test_nested_mobile_pick_rate_with_invalid_or_missing_win_rate(self):
        for name, html, expected in (
            ("WR NaN", nested_mobile_row("NaN<!-- -->%"), "quarantined_non_finite_value"),
            ("WR dash", nested_mobile_row("—"), "quarantined_pick_rate_only"),
            ("WR absent", nested_mobile_row("").replace(
                '<div class="text-right font-data text-base font-semibold text-foreground '
                'sm:text-lg"></div>', ""), "quarantined_pick_rate_only"),
            ("WR dash, unsplit", nested_mobile_row("—", split=False),
             "quarantined_pick_rate_only"),
        ):
            with self.subTest(case=name):
                wr, method = extracted(html)
                self.assertIsNone(wr, "the nested mobile pick rate became the win rate")
                self.assertEqual(method, expected)

    def test_mobile_class_drift_is_still_pick_rate_by_duplication(self):
        # Split, the drifted badge is a badge candidate that shares the pick
        # rate's value: a collision. Unsplit, it is no candidate at all, and
        # the row holds nothing but pick-rate evidence.
        for badge_classes in ("text-info max-sm:inline", "text-info", "text-foreground"):
            for split, expected in ((True, "quarantined_pick_rate_collision"),
                                    (False, "quarantined_pick_rate_only")):
                with self.subTest(classes=badge_classes, split=split):
                    wr, method = extracted(nested_mobile_row(
                        "—", split=split, badge_classes=badge_classes
                    ))
                    self.assertIsNone(wr)
                    self.assertEqual(method, expected)

    def test_text_foreground_on_the_mobile_badge_does_not_make_it_primary(self):
        for split in (True, False):
            with self.subTest(split=split):
                wr, method = extracted(nested_mobile_row(
                    "—", split=split, badge_classes="text-foreground sm:hidden"
                ))
                self.assertIsNone(wr)
                self.assertEqual(method, "quarantined_pick_rate_only")

    def test_real_win_rate_still_resolves_beside_drifted_pick_rate(self):
        for badge_classes in ("text-info sm:hidden", "text-info max-sm:inline",
                              "text-foreground sm:hidden"):
            with self.subTest(classes=badge_classes, split=True):
                self.assertEqual(
                    extracted(nested_mobile_row("55.25<!-- -->%", badge_classes=badge_classes)),
                    (55.25, "structural"),
                )
            with self.subTest(classes=badge_classes, split=False):
                self.assertEqual(
                    extracted(nested_mobile_row("55.25%", split=False,
                                                badge_classes=badge_classes)),
                    (55.25, "structural"),
                )

    def test_a_primary_cell_equal_to_the_pick_rate_is_not_trusted(self):
        wr, method = extracted(live_row(f"{PICK_RATE}%"))
        self.assertIsNone(wr)
        self.assertEqual(method, "quarantined_pick_rate_collision")


class LaneResilienceTests(unittest.TestCase):
    """A4. New malformed shapes quarantine their own row; the lane continues."""

    def test_malformed_rows_are_quarantined_individually(self):
        page = (
            live_row("55.25%", slug="good-one")
            + live_row('55.25%<span class="sr-only">Win rate</span>', slug="suffix-label")
            + block("<div><span>-</span>1%</div>", slug="split-sign")
            + nested_mobile_row("NaN<!-- -->%").replace("tank-engine", "nested-nan")
            + block("<div>1/2%</div>", slug="fraction")
            + live_row("48.10%", slug="good-two")
        )
        rows = {row["sourceKey"]: row for row in parse_augments(page)}
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows["good-one"]["win_rate"], 55.25)
        self.assertEqual(rows["good-two"]["win_rate"], 48.10)
        for slug in ("suffix-label", "split-sign", "nested-nan", "fraction"):
            with self.subTest(row=slug):
                self.assertIsNone(rows[slug]["win_rate"])
                self.assertTrue(rows[slug]["extraction"].startswith("quarantined"))


# ── Parser regressions of the HTML reader (2026-09 merge-gate review) ───────

# Marked-section shapes the reviewer's fuzz run found raising AssertionError
# out of Python's HTMLParser (_markupbase), which aborted the whole scrape.
MARKED_SECTION_VARIANTS = (
    "<![foo[ ]]>", "<![ x]>", "<!['/ix?b", "<![ac#xb ]b", "<![-",
)
EXTRA_SPLIT_CELL = '<div class="text-right font-data text-sm">12.50<!-- -->%</div>'


def parser_rejects(markup: str) -> bool:
    """Whether THIS Python's HTMLParser raises on `markup`.

    CPython releases differ on non-standard `<![` sections (newer security
    releases read them as bogus comments, as browsers do), so tests on real
    inputs assert the quarantine wherever the parser actually refuses them.
    """
    parser = HTMLParser(convert_charrefs=True)
    try:
        parser.feed(markup)
        parser.close()
    except Exception:
        return True
    return False


def with_extra_cell(row: str, cell: str = EXTRA_SPLIT_CELL) -> str:
    assert row.endswith("</a>")
    return row[: -len("</a>")] + cell + "</a>"


class MalformedMarkupTests(unittest.TestCase):
    """1. Markup the parser refuses quarantines ONE row; the lane continues."""

    def test_a_parser_failure_quarantines_only_its_row_on_any_python(self):
        original = scrape_arammayhem._RowReader.feed

        def failing_feed(reader, data):
            # Collect runs first, so a result built from partial runs would show.
            original(reader, data)
            if "BROKEN" in data:
                raise AssertionError("unknown status keyword 'foo' in marked section")

        with patch.object(scrape_arammayhem._RowReader, "feed", failing_feed):
            self.assertEqual(
                extract_augment_win_rate(live_row("48.10%") + "<i>BROKEN</i>"),
                (None, "quarantined_unparseable_markup"),
            )
            rows = parse_augments(
                live_row("55.25%", slug="good-one")
                + block("<i>BROKEN</i><div>48.10%</div>", slug="broken")
                + live_row("48.10%", slug="good-two")
            )
        by_slug = {row["sourceKey"]: row for row in rows}
        self.assertEqual(by_slug["good-one"]["win_rate"], 55.25)
        self.assertEqual(by_slug["good-two"]["win_rate"], 48.10)
        self.assertIsNone(by_slug["broken"]["win_rate"])
        self.assertEqual(by_slug["broken"]["extraction"], "quarantined_unparseable_markup")

    def test_a_malformed_marked_section_does_not_raise(self):
        wr, method = extract_augment_win_rate(block("<![foo[ ]]>"))
        self.assertIsNone(wr)
        if parser_rejects("<![foo[ ]]>"):
            self.assertEqual(method, "quarantined_unparseable_markup")
        else:
            self.assertTrue(method.startswith("quarantined"), method)

    def test_a_malformed_middle_row_leaves_its_neighbours_intact(self):
        page = (
            live_row("55.25%", slug="good-one")
            + live_row("<![foo[ ]]>48.10%", slug="malformed")
            + live_row("48.10%", slug="good-two")
        )
        rows = {row["sourceKey"]: row for row in parse_augments(page)}  # must not raise
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows["good-one"]["win_rate"], 55.25)
        self.assertEqual(rows["good-two"]["win_rate"], 48.10)
        self.assertNotEqual(rows["malformed"]["win_rate"], float(PICK_RATE))
        if parser_rejects("<![foo[ ]]>"):
            self.assertIsNone(rows["malformed"]["win_rate"])
            self.assertEqual(rows["malformed"]["extraction"], "quarantined_unparseable_markup")

    def test_fuzz_marked_section_variants_never_escape_the_row(self):
        for markup in MARKED_SECTION_VARIANTS:
            for name, html_row in (
                ("row", live_row(f"{markup}48.10%")),
                ("split row", live_row(f"{markup}48.10<!-- -->%", split=True)),
                ("block", block(f"<div>55%</div>{markup}")),
            ):
                with self.subTest(markup=markup, shape=name):
                    wr, method = extracted(html_row)  # must not raise
                    self.assertNotEqual(wr, float(PICK_RATE))
                    if parser_rejects(markup):
                        self.assertEqual((wr, method), (None, "quarantined_unparseable_markup"))


class CrossTagPrefixTests(unittest.TestCase):
    """2. A qualifier in its own element means what it means in the same node."""

    PREFIXES = (
        "\u25bc", "\u25b2", "\u2796", "\u2796&#xFE0F;", "\u00b1", "\u2248", "&dollar;",
        "-&shy;", "-&#8203;", "-&#x2060;", "-&#769;", "\u2212&shy;", "\u25bc&#8203;",
    )

    def test_symbol_or_invisible_prefixes_across_tags_quarantine(self):
        for prefix in self.PREFIXES:
            for path, row in (
                ("sole", block(f"<div><span>{prefix}</span>1.2%</div>")),
                ("structural", live_row(f"<span>{prefix}</span>1.2%")),
                ("structural, split", live_row(f"<span>{prefix}</span>1.2<!-- -->%", split=True)),
                ("badge", block(f'<span class="wr"><span>{prefix}</span>1.2<!-- -->%</span>')),
            ):
                with self.subTest(prefix=prefix, path=path):
                    wr, method = extracted(row)
                    self.assertIsNone(wr, f"{prefix!r} + 1.2% published {wr}")
                    self.assertTrue(method.startswith("quarantined"), method)

    def test_same_node_and_cross_tag_forms_agree_for_every_symbol_and_dash(self):
        """Swept by Unicode category, not by example: every dash (Pd) and symbol
        (S*) below U+3000 fails closed both inline and in its own element."""
        swept = 0
        for code in range(0x21, 0x3000):
            char = chr(code)
            category = unicodedata.category(char)
            # Label separators ("=" is Sm) keep their pre-existing inline reading.
            if char in ":=\uff1a" or not (category == "Pd" or category.startswith("S")):
                continue
            encoded = html.escape(char)
            for spacer in ("", " "):
                inline = extracted(block(f"<div>{encoded}{spacer}1.2%</div>"))
                tagged = extracted(block(f"<div><span>{encoded}</span>{spacer}1.2%</div>"))
                with self.subTest(char=f"U+{code:04X}", spacer=bool(spacer)):
                    self.assertIsNone(inline[0])
                    self.assertIsNone(tagged[0])
            swept += 1
        self.assertGreater(swept, 1000)

    def test_ordinary_values_and_labels_still_resolve(self):
        for token, expected in (("0", 0.0), ("100", 100.0), ("55.25", 55.25),
                                ("12.5", 12.5), ("97.0", 97.0)):
            with self.subTest(token=token):
                self.assertEqual(extracted(live_row(f"{token}%")), (expected, "structural"))
                self.assertEqual(extracted(block(f"<div><span>Gold</span>{token}%</div>")),
                                 (expected, "sole_percentage"))
                self.assertEqual(extracted(block(f"<div>{token}%</div>")),
                                 (expected, "sole_percentage"))


class CollisionPrecedenceTests(unittest.TestCase):
    """3. A value-collision quarantines; it never hands the row to a weaker value."""

    def test_primary_equal_to_pick_rate_never_promotes_an_extra_split_cell(self):
        for name, row in (
            ("unsplit win rate", with_extra_cell(live_row(f"{PICK_RATE}%"))),
            ("split win rate", with_extra_cell(live_row(f"{PICK_RATE}<!-- -->%", split=True))),
        ):
            with self.subTest(case=name):
                wr, method = extracted(row)
                self.assertNotEqual(wr, 12.5)
                self.assertEqual((wr, method), (None, "quarantined_pick_rate_collision"))

    def test_a_badge_equal_to_pick_rate_is_a_collision_not_a_dropout(self):
        row = block(
            '<div class="hidden text-muted-foreground sm:block">63.98%</div>'
            f'<span class="wr">{PICK_RATE}<!-- -->%</span>'
            '<span class="x">12.50<!-- -->%</span>'
        )
        self.assertEqual(extracted(row), (None, "quarantined_pick_rate_collision"))

    def test_the_real_win_rate_still_wins_beside_extra_structure(self):
        for name, row in (
            ("extra split cell", with_extra_cell(live_row("55.25%"))),
            ("extra split cell, split row", with_extra_cell(live_row("55.25<!-- -->%", split=True))),
            ("extra plain cell", with_extra_cell(
                live_row("55.25%"), '<div class="text-right">12.50%</div>')),
        ):
            with self.subTest(case=name):
                self.assertEqual(extracted(row), (55.25, "structural"))

    def test_structural_pick_rate_evidence_is_excluded_not_a_collision(self):
        self.assertEqual(extracted(nested_mobile_row("55.25<!-- -->%")), (55.25, "structural"))
        self.assertEqual(extracted(nested_mobile_row("\u2014")), (None, "quarantined_pick_rate_only"))
        self.assertEqual(extracted(live_row("\u2014", split=True)),
                         (None, "quarantined_pick_rate_only"))
