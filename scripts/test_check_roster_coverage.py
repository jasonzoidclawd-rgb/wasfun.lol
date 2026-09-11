#!/usr/bin/env python3

from __future__ import annotations

import json
import unittest
from pathlib import Path

from check_roster_coverage import build_roster_report, load_json


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "scripts" / "fixtures" / "roster-coverage"


class RosterCoverageTests(unittest.TestCase):
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
                    "id": "63",
                    "icon": "https://example.test/63.png",
                },
                {
                    "slug": "monkeyking",
                    "id": "63",
                    "icon": "https://example.test/63.png",
                },
            ]
        }

        report = build_roster_report(ddragon, published, cdragon)

        self.assertEqual(report["duplicate_published_ids"], {"63": 2})
        self.assertEqual(report["alias_collisions"], {"monkeyking": ["monkeyking", "wukong"]})


if __name__ == "__main__":
    unittest.main()


# ── Champion identity regression (2026-09 icon-host change) ─────────────────
# arammayhem.com moved champion icons to `/icons/<slug>/64.png`, where the
# trailing number is a PIXEL SIZE. The gate used to read the last numeric path
# segment as a champion id, so all 173 champions resolved to id "64":
#   duplicate published IDs {'64': 171}, coverage 0.017.
# Identity now comes only from the canonical id stamped by the Data Dragon
# lane, never from a presentation URL.

DDRAGON_FIXTURE = {
    "version": "16.18.1",
    "data": {
        "Teemo": {"key": "17", "id": "Teemo", "name": "Teemo"},
        "Brand": {"key": "63", "id": "Brand", "name": "Brand"},
    },
}


def published(rows):
    return {"champions": rows}


class ChampionIdentityRegressionTests(unittest.TestCase):
    def _report(self, rows):
        return build_roster_report(DDRAGON_FIXTURE, published(rows))

    def test_new_r2_icon_url_does_not_supply_identity(self):
        """The exact shape that broke the gate: /icons/<slug>/64.png."""
        report = self._report([
            {"slug": "teemo", "name": "Teemo", "id": "17",
             "icon": "https://pub-x.r2.dev/v1/champions/icons/teemo/64.png",
             "win_rate": 53.5, "pick_rate": None},
            {"slug": "brand", "name": "Brand", "id": "63",
             "icon": "https://pub-x.r2.dev/v1/champions/icons/brand/64.png",
             "win_rate": 55.6, "pick_rate": None},
        ])
        self.assertEqual(report["duplicate_published_ids"], {})
        self.assertEqual(report["roster_coverage_ratio"], 1.0)
        self.assertEqual(report["missing_active_champion_count"], 0)

    def test_two_champions_ending_in_64_png_stay_distinct(self):
        report = self._report([
            {"slug": "teemo", "name": "Teemo", "id": "17", "icon": "/a/64.png"},
            {"slug": "brand", "name": "Brand", "id": "63", "icon": "/b/64.png"},
        ])
        self.assertEqual(report["duplicate_published_ids"], {})
        self.assertEqual(report["published_identified_champion_count"], 2)

    def test_legacy_cdragon_icon_url_still_resolves_via_stamped_id(self):
        report = self._report([
            {"slug": "teemo", "name": "Teemo", "id": "17",
             "icon": "https://raw.communitydragon.org/latest/plugins/"
                     "rcp-be-lol-game-data/global/default/v1/champion-icons/17.png"},
            {"slug": "brand", "name": "Brand", "id": "63",
             "icon": "https://raw.communitydragon.org/latest/plugins/"
                     "rcp-be-lol-game-data/global/default/v1/champion-icons/63.png"},
        ])
        self.assertEqual(report["roster_coverage_ratio"], 1.0)

    def test_missing_icon_is_irrelevant_to_identity(self):
        report = self._report([
            {"slug": "teemo", "name": "Teemo", "id": "17"},
            {"slug": "brand", "name": "Brand", "id": "63"},
        ])
        self.assertEqual(report["roster_coverage_ratio"], 1.0)
        self.assertEqual(report["duplicate_published_ids"], {})

    def test_missing_stamped_id_fails_coverage(self):
        """No canonical id means unidentified — the gate must not guess."""
        report = self._report([
            {"slug": "teemo", "name": "Teemo",
             "icon": "https://pub-x.r2.dev/v1/champions/icons/teemo/64.png"},
            {"slug": "brand", "name": "Brand", "id": "63"},
        ])
        self.assertLess(report["roster_coverage_ratio"], 1.0)
        self.assertIn("17", report["missing_active_champion_ids"])

    def test_unknown_champion_slug_is_reported_missing(self):
        report = self._report([
            {"slug": "teemo", "name": "Teemo", "id": "17"},
            {"slug": "notachampion", "name": "Not A Champion", "id": "99999"},
        ])
        self.assertEqual(report["missing_active_champion_ids"], ["63"])
        self.assertLess(report["roster_coverage_ratio"], 1.0)

    def test_duplicate_real_identity_is_detected(self):
        report = self._report([
            {"slug": "teemo", "name": "Teemo", "id": "17"},
            {"slug": "teemo-again", "name": "Teemo", "id": "17"},
            {"slug": "brand", "name": "Brand", "id": "63"},
        ])
        self.assertEqual(report["duplicate_published_ids"], {"17": 2})

    def test_live_catalog_resolves_every_champion_to_a_distinct_identity(self):
        """All published champions must carry distinct canonical ids."""
        path = Path(__file__).resolve().parent.parent / "public" / "data" / "champions.json"
        rows = json.loads(path.read_text(encoding="utf-8"))["champions"]
        ids = [row.get("id") for row in rows]
        self.assertTrue(all(ids), "every champion must carry a canonical id")
        self.assertEqual(len(set(ids)), len(rows), "canonical ids must be distinct")
