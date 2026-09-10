#!/usr/bin/env python3

from __future__ import annotations

import json
import unittest
from pathlib import Path

from check_roster_coverage import build_roster_report, load_json


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "scripts" / "fixtures" / "roster-coverage"


class RosterCoverageTests(unittest.TestCase):
    def test_published_numeric_champion_key_is_the_primary_roster_join(self):
        ddragon = load_json(FIXTURES / "ddragon-16.13.1.json")
        cdragon = load_json(FIXTURES / "cdragon-summary.json")
        published = {
            "champions": [
                {"slug": "brand", "champion_key": "63", "icon": "https://example.test/999.png"},
                {"slug": "locke", "champion_key": "805"},
            ]
        }

        report = build_roster_report(ddragon, published, cdragon)

        self.assertEqual(report["missing_active_champion_ids"], [])
        self.assertEqual(report["duplicate_published_ids"], {})

    def test_fixture_exposes_the_current_locke_gap(self):
        ddragon = load_json(FIXTURES / "ddragon-16.13.1.json")
        cdragon = load_json(FIXTURES / "cdragon-summary.json")
        published = load_json(FIXTURES / "published-missing-locke.json")

        report = build_roster_report(ddragon, published, cdragon)

        self.assertEqual(report["upstream_active_champion_count"], 2)
        self.assertEqual(report["missing_active_champion_count"], 1)
        self.assertEqual(report["missing_active_champion_ids"], ["805"])
        self.assertEqual(report["roster_coverage_ratio"], 0.5)
        self.assertEqual(report["communitydragon_missing_authority_ids"], [])

    def test_duplicate_ids_and_alias_collisions_are_reported(self):
        ddragon = load_json(FIXTURES / "ddragon-16.13.1.json")
        cdragon = load_json(FIXTURES / "cdragon-summary.json")
        published = {
            "champions": [
                {
                    "slug": "wukong",
                    "icon": "https://example.test/63.png",
                },
                {
                    "slug": "monkeyking",
                    "icon": "https://example.test/63.png",
                },
            ]
        }

        report = build_roster_report(ddragon, published, cdragon)

        self.assertEqual(report["duplicate_published_ids"], {"63": 2})
        self.assertEqual(report["alias_collisions"], {"monkeyking": ["monkeyking", "wukong"]})


if __name__ == "__main__":
    unittest.main()
