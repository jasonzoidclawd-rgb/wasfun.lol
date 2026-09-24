#!/usr/bin/env python3
"""The kill-switch crawl's detectors must see an augment statistic however it is rendered."""

import unittest

from verify_kill_switch import detect_fingerprint, detect_json, detect_marker, page_text

FINGERPRINTS = [("tank engine", ["60.10", "60.1"]), ("坦克引擎", ["60.10", "60.1"]),
                ("aram_tankengine", ["60.10", "60.1"]), ("tank-engine", ["60.10", "60.1"])]


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

    def test_fingerprint_in_raw_payloads_without_a_percent_sign(self):
        rsc = '1:["$","div",null,{"slug":"tank-engine","name":"Tank Engine","win_rate":60.1}]'
        self.assertTrue(detect_fingerprint(rsc.lower(), FINGERPRINTS))
        self.assertTrue(detect_fingerprint('{"id":"aram_tankengine","w":60.10}', FINGERPRINTS))
        flight = 'self.__next_f.push([1,"{\\"slug\\":\\"tank-engine\\",\\"win_rate\\":60.1}"])'
        self.assertTrue(detect_fingerprint(flight.lower(), FINGERPRINTS))

    def test_fingerprint_needs_the_exact_number(self):
        self.assertFalse(detect_fingerprint("tank engine 160.12% 60.15%", FINGERPRINTS))

    def test_both_roundings_of_a_half_are_fingerprinted(self):
        from verify_kill_switch import load_fingerprints
        values = dict(load_fingerprints())
        halves = [v for v in values.values() if any(x.endswith("5") and len(x.split(".")[1]) == 2 for x in v)]
        for v in halves:
            two = next(x for x in v if len(x.split(".")[1]) == 2)
            self.assertIn(f"{float(two) + 0.001:.1f}", v)  # the half-up rounding JavaScript produces

    def test_generic_slugs_are_not_fingerprints(self):
        from verify_kill_switch import load_fingerprints
        tokens = {name for name, _ in load_fingerprints()}
        self.assertNotIn("stats", tokens)   # the slug of "Stats!"
        self.assertIn("stats!", tokens)      # its display name still is
        self.assertIn("tank-engine", tokens)

    def test_a_bare_number_is_not_a_rate(self):
        # base-stat tables: "Attack Damage 60.1" next to an augment list is not a leak
        self.assertFalse(detect_fingerprint("tank engine</li></ul><td>attack damage</td><td>60.1</td>", FINGERPRINTS))

    def test_fingerprint_ignores_a_name_without_its_number(self):
        self.assertFalse(detect_fingerprint(page_text("<p>Tank Engine gives health. Yasuo 56.98%</p>", "text/html"),
                                            FINGERPRINTS))

    def test_grade_letters_count_as_statistics(self):
        self.assertTrue(detect_marker('<span class="grade-chip is-S" data-grade="S">'))
        self.assertTrue(detect_marker('self.__next_f.push([1,"{\\"letter\\":\\"A\\",\\"m\\":1}"])'))
        self.assertTrue(detect_marker('{"letter":"B"}'))
        self.assertFalse(detect_marker('<p>Letter S is a letter.</p>'))
        self.assertTrue(detect_marker('{"letter": "C", "m": -2}'))

    def test_champion_letters_are_not_augment_statistics(self):
        self.assertFalse(detect_marker('<span class="grade-chip is-S" role="img" aria-label="x" data-grade="S" data-grade-kind="champion">'))
        rsc = 'self.__next_f.push([1,"[\\"$\\",\\"span\\",null,{\\"className\\":\\"grade-chip is-A\\",\\"data-grade\\":\\"A\\",\\"data-grade-kind\\":\\"champion\\"}]"])'
        self.assertFalse(detect_marker(rsc))
        self.assertFalse(detect_marker('{"grade":"S","slug":"yasuo"}'))
        # an augment chip next to a champion chip is still caught
        both = '<span data-grade="S" data-grade-kind="champion"></span><span data-grade="B" data-grade-kind="option"></span>'
        self.assertEqual(detect_marker(both), ["grade letter chip"])
        self.assertEqual(detect_marker(rsc.replace("champion", "option")), ["grade letter chip"])


if __name__ == "__main__":
    unittest.main()
