import unittest

from scrape_base_stats import enrich_champion_rows


class ChampionKeyPipelineTests(unittest.TestCase):
    def test_joins_numeric_riot_key_by_canonical_identity_not_localized_name(self):
        champions = [
            {"slug": "monkeyking", "name": "悟空"},
            {"slug": "karthus", "name": "卡爾瑟斯"},
        ]
        ddragon = {
            "MonkeyKing": {
                "id": "MonkeyKing",
                "name": "Wukong",
                "key": "62",
                "stats": {"hp": 625},
            },
            "Karthus": {
                "id": "Karthus",
                "name": "Karthus",
                "key": "30",
                "stats": {"hp": 620},
            },
        }

        matched, unmatched = enrich_champion_rows(champions, ddragon, {})

        self.assertEqual(matched, 2)
        self.assertEqual(unmatched, [])
        self.assertEqual(champions[0]["champion_key"], "62")
        self.assertEqual(champions[1]["champion_key"], "30")
        self.assertEqual(champions[0]["baseStats"]["baseHP"], 625)

    def test_rejects_missing_or_non_numeric_riot_keys(self):
        champions = [{"slug": "unknown", "name": "Unknown"}]
        ddragon = {
            "Unknown": {
                "id": "Unknown",
                "name": "Unknown",
                "key": "not-numeric",
                "stats": {"hp": 500},
            },
        }

        matched, unmatched = enrich_champion_rows(champions, ddragon, {})

        self.assertEqual(matched, 0)
        self.assertEqual(unmatched, ["Unknown"])
        self.assertNotIn("champion_key", champions[0])


if __name__ == "__main__":
    unittest.main()
