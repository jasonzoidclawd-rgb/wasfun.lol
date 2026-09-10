#!/usr/bin/env python3

import inspect
import unittest

import scrape_arammayhem
from scrape_arammayhem import merge_champion_sources, parse_augments, parse_search_index


AUGMENT_DEFINITION_FIELDS = {
    "name",
    "rarity",
    "icon",
    "lifecycle",
    "flags",
    "type",
    "wikiDescription",
    "name_zh_CN",
    "name_zh_TW",
    "name_ja",
    "name_ko",
    "availability",
}


def assert_no_definition_fields(test_case, value):
    if isinstance(value, dict):
        forbidden = AUGMENT_DEFINITION_FIELDS.intersection(value)
        test_case.assertEqual(forbidden, set())
        for child in value.values():
            assert_no_definition_fields(test_case, child)
    elif isinstance(value, list):
        for child in value:
            assert_no_definition_fields(test_case, child)


class SearchIndexParserTests(unittest.TestCase):
    def test_parses_champion_tier_win_rate_and_combos(self):
        champions, combos = parse_search_index({
            "patch": "26.12",
            "champions": [{
                "id": "Brand",
                "championId": "Brand",
                "name": {"en": "Brand"},
                "tier": "S+",
                "winRate": "56.49%",
                "icon": "/champions/brand.png",
            }],
            "augments": [{
                "id": "infernal_conduit",
                "name": {"en": "Infernal Conduit"},
            }],
            "combos": [{
                "slug": "brand-infernal-conduit",
                "championId": "Brand",
                "augmentIds": ["infernal_conduit"],
                "tier": "S",
            }],
        })

        self.assertEqual(champions, [{
            "slug": "brand",
            "name": "Brand",
            "tier": "S+",
            "rank": 1,
            "win_rate": 56.49,
            "pick_rate": None,
            "tags": [],
            "icon": "https://arammayhem.com/champions/brand.png",
        }])
        self.assertEqual(combos, [{
            "champion": "brand",
            "augment": "Infernal Conduit",
            "tier": "S",
            "ref": "search-index:brand-infernal-conduit",
        }])

    def test_display_slug_aliases_merge_into_canonical_champion_rows(self):
        primary = [{
            "slug": "drmundo",
            "name": "Drmundo",
            "tier": "S+",
            "rank": 4,
            "win_rate": 54.34,
            "pick_rate": 1.2,
            "tags": ["tank"],
            "icon": "/champions/36.png",
        }]
        fallback = [{
            "slug": "dr-mundo",
            "name": "Dr. Mundo",
            "tier": "S+",
            "rank": 29,
            "win_rate": 54.34,
            "pick_rate": None,
            "tags": [],
            "icon": "/champions/36.png",
        }]

        merged = merge_champion_sources(primary, fallback)

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["slug"], "drmundo")
        self.assertEqual(merged[0]["rank"], 4)


class AugmentWinRateFeedTests(unittest.TestCase):
    def test_arammayhem_augment_parser_returns_win_rate_rows_only(self):
        # Mirrors live rank-row markup (verified 2026-09-10): the win rate is
        # the primary `text-foreground` cell; the pick rate is the muted cell
        # and is duplicated into a mobile-only badge.
        html = """
        <a href="/augments/adapt" class="augment-rank-row" data-rarity="silver" data-availability="live">
          <img src="/augments/adapt.png" alt="ADAPt">
          <span class="text-info sm:hidden">11.2%</span>
          <div class="text-right font-data text-base font-semibold text-foreground sm:text-lg">55.96%</div>
          <div class="hidden text-right font-data text-sm text-muted-foreground sm:block">11.2%</div>
        </a>
        """

        rows = parse_augments(html)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sourceKey"], "adapt")
        self.assertEqual(rows[0]["win_rate"], 55.96)
        self.assertEqual(rows[0]["extraction"], "structural")
        assert_no_definition_fields(self, rows)

    def test_win_rate_feed_resolves_to_cdragon_ids_and_reports_unmatched_rows(self):
        from augment_winrate_feed import build_arammayhem_win_rate_feed

        feed = build_arammayhem_win_rate_feed(
            rows=[
                {"sourceKey": "adapt", "win_rate": 56.2},
                {"sourceKey": "unmapped-augment", "win_rate": 49.1},
            ],
            identity_map={
                "mappings": [
                    {
                        "augmentId": "ARAM_ADAPt",
                        "sources": {
                            "arammayhem_win_rate": [
                                {"sourceKey": "adapt", "slug": "adapt", "win_rate": 55.96}
                            ]
                        },
                    }
                ]
            },
            base_catalog={
                "augments": [
                    {"augmentId": "ARAM_ADAPt"},
                    {"augmentId": "ARAM_Missing"},
                ]
            },
            generated_at="2026-06-23T00:00:00+00:00",
        )

        self.assertEqual(feed["win_rates"], {"ARAM_ADAPt": 56.2})
        self.assertEqual(feed["missingAugmentIds"], ["ARAM_Missing"])
        self.assertEqual(feed["unmatched"], [
            {
                "sourceKey": "unmapped-augment",
                "win_rate": 49.1,
                "reason": "no Step 1 arammayhem_win_rate mapping",
            }
        ])
        self.assertEqual(feed["counts"]["matchedAugmentIds"], 1)
        self.assertEqual(feed["counts"]["missingWinRateAugmentIds"], 1)
        self.assertEqual(feed["counts"]["unmatchedSourceRows"], 1)
        self.assertNotIn("augments", feed)
        assert_no_definition_fields(self, feed)

    def test_arammayhem_main_has_no_augments_json_write_path(self):
        main_source = inspect.getsource(scrape_arammayhem.main)

        self.assertNotIn('"augments.json"', main_source)
        self.assertNotIn("fetch_missing_descriptions", main_source)
        self.assertIn("WIN_RATE_FEED_PATH", main_source)


if __name__ == "__main__":
    unittest.main()
