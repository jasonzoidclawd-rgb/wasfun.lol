#!/usr/bin/env python3
"""The kill-switch crawl's detectors must see an augment statistic however it is rendered."""

import unittest

from verify_kill_switch import detect_fingerprint, detect_json, detect_marker, page_text

FINGERPRINTS = [("tank engine", ["60.10", "60.1"]), ("坦克引擎", ["60.10", "60.1"])]


class DetectorTests(unittest.TestCase):
    def test_marker(self):
        self.assertTrue(detect_marker('<span data-augment-stat="win">60.1%</span>'))
        self.assertFalse(detect_marker("<span>60.1%</span>"))

    def test_json_rows_that_name_an_augment_and_carry_a_number(self):
        self.assertTrue(detect_json('{"rows":[{"augmentId":"ARAM_TankEngine","winRate":60.1}]}'))
        self.assertFalse(detect_json('{"rows":[{"augmentId":"ARAM_TankEngine","winRate":null}]}'))
        self.assertFalse(detect_json('{"champions":[{"slug":"yasuo","win_rate":56.98}]}'))

    def test_fingerprint_in_rendered_text_any_locale(self):
        html = "<li><b>Tank Engine</b><span>win 60.1%</span></li>"
        self.assertTrue(detect_fingerprint(page_text(html, "text/html"), FINGERPRINTS))
        self.assertTrue(detect_fingerprint(page_text("<p>坦克引擎 · 胜率 60.10%</p>", "text/html"), FINGERPRINTS))

    def test_fingerprint_ignores_a_name_without_its_number(self):
        self.assertFalse(detect_fingerprint(page_text("<p>Tank Engine gives health. Yasuo 56.98%</p>", "text/html"),
                                            FINGERPRINTS))


if __name__ == "__main__":
    unittest.main()
