#!/usr/bin/env python3
"""v3 phase 0 data feeds: parsers, identity, changed list, snapshots, kit tags, schema gate."""

from __future__ import annotations

import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path

from augment_kit_tags import OVERRIDES, TAGS_PATH, derive_profile, kit_mismatch, refresh, text_hash
from augment_stats_identity import build_context, resolve_augment
from changed_augments import build_patch_entry, catalog_tokens, parse_mayhem_section
from scrape_mayhem_stats import (
    ParseError,
    build_champion_build_feed,
    parse_augment_list,
    parse_build_page,
    win_rate_semantics,
)
import stats_snapshots
import validate_stats_feeds as V

FIXTURES = Path(__file__).parent / "fixtures" / "mayhem_stats"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


CATALOG = {
    "augments": [
        {"augmentId": "ARAM_SoulSiphon", "name": "Soul Siphon", "slug": "soul-siphon", "rarity": "gold"},
        {"augmentId": "ARAM_Siphon", "name": "Siphon", "slug": "siphon", "rarity": "silver"},
        {"augmentId": "ARAM_TankEngine", "name": "Tank Engine", "slug": "tank-engine", "rarity": "gold"},
        {"augmentId": "ARAM_HighRoller", "name": "High Roller", "slug": "high-roller", "rarity": "prismatic"},
        {"augmentId": "ARAM_SkilledSniper", "name": "Skilled Sniper", "slug": "skilled-sniper", "rarity": "gold"},
        {"augmentId": "BurstingTeeth", "name": "Tooth Fairy", "slug": "tooth-fairy", "rarity": "gold"},
        {"augmentId": "KingMe", "name": "King Me", "slug": "king-me", "rarity": "prismatic"},
        {"augmentId": "ARAM_Overloaded", "name": "Overloaded", "slug": "overloaded", "rarity": "prismatic"},
    ]
}


class GlobalAugmentListTests(unittest.TestCase):
    def test_reads_win_and_pick_rate_from_their_own_columns(self):
        rows = parse_augment_list(fixture("augments.html"))
        tank = next(r for r in rows if r["sourceSlug"] == "tank-engine")
        self.assertEqual(tank, {
            "sourceSlug": "tank-engine", "name": "Tank Engine", "rarity": "gold",
            "availability": "live", "winRate": 60.1, "pickRate": 43.61,
        })

    def test_keeps_retired_rows_labelled(self):
        rows = parse_augment_list(fixture("augments.html"))
        self.assertIn("retired", {r["availability"] for r in rows})

    def test_a_row_missing_its_pick_rate_column_fails_the_parse(self):
        page = fixture("augments.html").replace('sm:block">43.61%', 'sm:block">', 1)
        with self.assertRaises(ParseError):
            parse_augment_list(page)


class BuildPageTests(unittest.TestCase):
    def setUp(self):
        self.page = parse_build_page(fixture("build-yasuo.html"))

    def test_header(self):
        self.assertEqual(
            {k: self.page[k] for k in ("winRate", "pickRate", "patch", "dataDate")},
            {"winRate": 56.98, "pickRate": 10.76, "patch": "26.19", "dataDate": "2026-09-21"},
        )

    def test_six_listed_augments_per_rarity_in_provider_order(self):
        by_rarity = {}
        for row in self.page["augments"]:
            by_rarity.setdefault(row["rarity"], []).append(row)
        self.assertEqual({k: len(v) for k, v in by_rarity.items()}, {"prismatic": 6, "gold": 6, "silver": 6})
        self.assertEqual(by_rarity["gold"][0], {
            "rarity": "gold", "sourceSlug": "soul-siphon", "name": "Soul Siphon",
            "listPosition": 1, "appearanceRate": 24.42, "winRate": 58.67,
        })

    def test_item_paths_keep_their_order(self):
        core = self.page["items"]["core"][0]
        self.assertEqual([i["sourceSlug"] for i in core["items"]],
                         ["rite_of_ruin", "blade_of_the_ruined_king", "deaths_dance"])
        self.assertEqual((core["pickRate"], core["winRate"]), (6.99, 61.72))
        self.assertEqual(len(self.page["items"]["boots"]), 4)

    def test_the_providers_own_snapshot_history(self):
        from scrape_mayhem_stats import parse_build_history
        rows = parse_build_history(fixture("build-yasuo-history.html"))
        self.assertEqual(len(rows), 11)
        self.assertEqual(rows[0], {"snapshot": "20260922_081905", "date": "2026-09-22", "patch": "26.19",
                                   "winRate": 56.98, "pickRate": 10.76})
        self.assertEqual({r["patch"] for r in rows}, {"26.15", "26.16", "26.17", "26.18", "26.19"})

    def test_missing_appearance_label_fails_closed(self):
        with self.assertRaises(ParseError):
            parse_build_page(fixture("build-yasuo.html").replace("Appearance rate:", "Seen:", 1))


class WinRateSemanticsTests(unittest.TestCase):
    PAGES = {"yasuo": {"augments": [{"sourceSlug": "a", "winRate": 55.0}, {"sourceSlug": "b", "winRate": 51.0}]}}

    def test_copies_of_the_global_row_are_recorded_as_such(self):
        glob = [{"sourceSlug": "a", "winRate": 55.0}, {"sourceSlug": "b", "winRate": 51.0}]
        self.assertEqual(win_rate_semantics(self.PAGES, glob)["status"], "global-copy")

    def test_nothing_to_compare_is_unknown_not_champion_specific(self):
        self.assertEqual(win_rate_semantics(self.PAGES, [])["status"], "unknown")

    def test_own_rows_and_mixtures_are_distinguished(self):
        self.assertEqual(win_rate_semantics(self.PAGES, [{"sourceSlug": "a", "winRate": 1.0},
                                                         {"sourceSlug": "b", "winRate": 2.0}])["status"],
                         "champion-specific")
        self.assertEqual(win_rate_semantics(self.PAGES, [{"sourceSlug": "a", "winRate": 55.0},
                                                         {"sourceSlug": "b", "winRate": 2.0}])["status"], "mixed")


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.ctx = build_context(CATALOG, {"aliases": [
            {"sourceSlug": "overloaded", "augmentId": None, "reason": "no registry entry"},
        ]})

    def test_exact_name_within_the_same_rarity(self):
        self.assertEqual(resolve_augment("soul-siphon", "Soul Siphon", "gold", self.ctx), ("ARAM_SoulSiphon", "name"))

    def test_never_a_substring_match(self):
        self.assertEqual(resolve_augment("siphon", "Siphon", "silver", self.ctx), ("ARAM_Siphon", "name"))
        self.assertEqual(resolve_augment("siphon", "Siphon", "gold", self.ctx), (None, "unmatched"))

    def test_a_slug_alone_is_only_a_candidate(self):
        self.assertEqual(resolve_augment("tank-engine", "Tank Engine Mk II", "gold", self.ctx),
                         (None, "slug-candidate:ARAM_TankEngine"))

    def test_rarity_must_agree(self):
        self.assertEqual(resolve_augment("tank-engine", "Tank Engine", "silver", self.ctx), (None, "unmatched"))

    def test_reviewed_alias_can_leave_a_row_unresolved(self):
        self.assertEqual(resolve_augment("overloaded", "Overloaded", "prismatic", self.ctx),
                         (None, "alias:unresolved"))

    def test_an_alias_does_not_override_a_rarity_disagreement(self):
        ctx = build_context(CATALOG, {"aliases": [{"sourceSlug": "x", "augmentId": "ARAM_TankEngine", "reason": "r"}]})
        self.assertEqual(resolve_augment("x", "X", "gold", ctx), ("ARAM_TankEngine", "alias"))
        self.assertEqual(resolve_augment("x", "X", "silver", ctx), (None, "alias:rarity-mismatch"))

    def test_aliases_need_a_reason_and_a_known_target(self):
        with self.assertRaises(ValueError):
            build_context(CATALOG, {"aliases": [{"sourceSlug": "x", "augmentId": "ARAM_TankEngine"}]})
        with self.assertRaises(ValueError):
            build_context(CATALOG, {"aliases": [{"sourceSlug": "x", "augmentId": "Nope", "reason": "r"}]})


class ChangedAugmentTests(unittest.TestCase):
    def setUp(self):
        self.tokens = catalog_tokens(CATALOG)

    def test_balance_changes_and_bugfix_subjects(self):
        found = parse_mayhem_section(fixture("patch-notes-26.19-mayhem.html"), self.tokens)
        balance = {f["augmentId"] for f in found if f["evidence"] == "patch-notes:balance"}
        bugfix = {f["augmentId"] for f in found if f["evidence"] == "patch-notes:bugfix"}
        self.assertEqual(balance, {"ARAM_HighRoller"})
        # Vel'Koz is not an augment; the bullet is about Skilled Sniper. Bursting Teeth
        # is Tooth Fairy's codename. King Me's bullet names other augments after it.
        self.assertTrue({"ARAM_SkilledSniper", "BurstingTeeth", "KingMe"} <= bugfix)
        self.assertNotIn("ARAM_Overloaded", bugfix)

    def test_an_entry_stays_provisional_until_both_signals_can_have_landed(self):
        from datetime import datetime, timezone
        page = fixture("patch-notes-26.19-mayhem.html")
        early = build_patch_entry("26.19", page, "u", CATALOG, {"events": []}, published_at="2026-09-22T18:00:00Z",
                                  now=datetime(2026, 9, 23, tzinfo=timezone.utc))
        late = build_patch_entry("26.19", page, "u", CATALOG, {"events": []}, published_at="2026-09-22T18:00:00Z",
                                 now=datetime(2026, 9, 26, tzinfo=timezone.utc))
        missing = build_patch_entry("26.19", None, None, CATALOG, {"events": []}, published_at="2026-09-01T00:00:00Z")
        self.assertEqual((early["status"], late["status"], missing["status"]), ("provisional", "complete", "provisional"))
        self.assertEqual(early["policyWhileProvisional"], "treat every augment as changed")

    def test_cdragon_diffs_merge_with_patch_notes(self):
        events = {"events": [
            {"entity_type": "augment", "canonical_id": "ARAM_HighRoller", "change_kind": "numeric", "source_patch_label": "26.19"},
            {"entity_type": "augment", "canonical_id": "ARAM_TankEngine", "change_kind": "text", "source_patch_label": "26.18"},
        ]}
        entry = build_patch_entry("26.19", fixture("patch-notes-26.19-mayhem.html"), "u", CATALOG, events)
        high_roller = next(c for c in entry["changed"] if c["augmentId"] == "ARAM_HighRoller")
        self.assertEqual(high_roller["evidence"], ["patch-notes:balance", "cdragon-diff:numeric"])
        self.assertNotIn("ARAM_TankEngine", {c["augmentId"] for c in entry["changed"]})


def _feed(patch: str) -> dict:
    return {
        "schemaVersion": 1, "feed": "augment-stats-feed", "fetchedAt": "t", "patch": patch,
        "provenance": {k: None for k in V.PROVENANCE_KEYS}, "fieldProvenance": {}, "units": {},
        "rows": [{"sourceSlug": "a", "name": "A", "augmentId": "X", "rarity": "gold", "availability": "live",
                  "winRate": 55.0, "pickRate": 20.0, "identity": "name"}],
    }


class SnapshotTests(unittest.TestCase):
    def test_write_once_slim_gzip_and_prune_to_two_patches(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, snaps = Path(tmp), Path(tmp) / "stats-snapshots"
            for day, patch in (("2026-09-01", "26.17"), ("2026-09-10", "26.18"), ("2026-09-22", "26.19")):
                (data / "augment-stats-feed.json").write_text(json.dumps(_feed(patch)))
                self.assertEqual(len(stats_snapshots.take_snapshot(day, data, snaps)), 1)
            (data / "augment-stats-feed.json").write_text(json.dumps(_feed("26.19") | {"rows": []}))
            self.assertEqual(stats_snapshots.take_snapshot("2026-09-22", data, snaps), [])  # never overwritten
            doc = json.loads(gzip.decompress((snaps / "2026-09-22" / "augment-stats-feed.json.gz").read_bytes()))
            self.assertEqual((doc["snapshotDate"], doc["rows"][0]["winRate"]), ("2026-09-22", 55.0))
            self.assertNotIn("name", doc["rows"][0])
            self.assertEqual(stats_snapshots.prune(snaps), ["2026-09-01"])
            self.assertEqual(sorted(p.name for p in snaps.iterdir()), ["2026-09-10", "2026-09-22"])


class KitTagTests(unittest.TestCase):
    def test_derivation(self):
        self.assertEqual(derive_profile({"effectText": {"desc": "Gain <scaleAP>Ability Power</scaleAP>."}}), "ap")
        self.assertEqual(derive_profile({"effectText": {"desc": "Gain Attack Speed."}}), "ad")
        self.assertEqual(derive_profile({"effectText": {"desc": "Gain <scaleHealth>max Health</scaleHealth>."}}), "tank")
        self.assertEqual(derive_profile({"effectText": {"desc": "Gain Adaptive Force and Attack Speed."}}), "neutral")

    def test_a_text_change_reopens_the_review(self):
        aug = {"augmentId": "X", "availability": {"status": "confirmed_live"}, "effectText": {"desc": "Gain Attack Speed."}}
        catalog = {"augments": [aug]}
        reviewed = {"tags": {"X": {"profile": "ad", "derived": "ad", "reviewed": True, "textHash": text_hash(aug, catalog)}}}
        self.assertTrue(refresh(catalog, reviewed, "d")["tags"]["X"]["reviewed"])
        aug["effectText"]["desc"] = "Gain Ability Power."
        tag = refresh(catalog, reviewed, "d")["tags"]["X"]
        self.assertEqual((tag["reviewed"], tag["profile"]), (False, "ap"))

    def test_new_augments_are_never_marked_reviewed(self):
        aug = {"augmentId": "Y", "availability": {"status": "confirmed_live"}, "effectText": {"desc": "Gain Armor."}}
        self.assertFalse(refresh({"augments": [aug]}, {"tags": {}}, "d")["tags"]["Y"]["reviewed"])

    def test_mismatch_is_symmetric_and_mixed_kits_never_mismatch(self):
        self.assertEqual(kit_mismatch("ap", "physical"), 1)
        self.assertEqual(kit_mismatch("ad", "magic"), 1)
        self.assertEqual(kit_mismatch("ap", "mixed"), 0)
        self.assertEqual(kit_mismatch("tank", "physical"), 0)
        self.assertEqual(kit_mismatch(None, "physical"), 0)

    def test_every_override_is_reasoned_and_the_persisted_table_is_reviewed(self):
        self.assertTrue(all(profile in ("ad", "ap", "tank", "neutral") and reason for profile, reason in OVERRIDES.values()))
        tags = json.loads(TAGS_PATH.read_text(encoding="utf-8"))
        self.assertGreaterEqual(tags["review"]["reviewed"], 200)
        for augment_id, (profile, _) in OVERRIDES.items():
            self.assertEqual(tags["tags"][augment_id]["profile"], profile)


class ValidatorTests(unittest.TestCase):
    def _build(self) -> dict:
        champ = {"winRate": 56.0, "pickRate": 10.0, "patch": "26.19", "dataDate": "2026-09-21",
                 "augments": [{"rarity": "gold", "sourceSlug": "a", "appearanceRate": 10.0, "winRate": 55.0}],
                 "items": {"boots": [{"items": [{"sourceSlug": "b"}], "pickRate": 50.0, "winRate": 55.0}]}}
        return {"schemaVersion": 1, "feed": "champion-build-feed", "fetchedAt": "t", "patch": "26.19",
                "dataDate": "2026-09-21",
                "provenance": {k: None for k in V.PROVENANCE_KEYS}, "fieldProvenance": {}, "units": {},
                "semantics": {"augments[].winRate": {"status": "global-copy"}},
                "champions": {f"c{i}": copy.deepcopy(champ) for i in range(V.MIN_CHAMPIONS)}}

    def _errors(self, check, doc) -> list[str]:
        rep = V.Report()
        check(rep, doc)
        return rep.errors

    def test_a_clean_feed_passes(self):
        self.assertEqual(self._errors(V.check_champion_builds, self._build()), [])
        self.assertEqual(self._errors(V.check_augment_stats, _feed("26.19")), [])

    def test_out_of_range_rates_fail(self):
        doc = self._build()
        doc["champions"]["c0"]["augments"][0]["winRate"] = 155.0
        self.assertTrue(self._errors(V.check_champion_builds, doc))

    def test_units_cannot_be_confirmed_without_a_record(self):
        doc = _feed("26.19")
        doc["units"] = {"pickRate": {"status": "confirmed"}}
        self.assertTrue(self._errors(V.check_augment_stats, doc))

    def test_a_sample_size_is_never_invented(self):
        doc = _feed("26.19")
        doc["provenance"]["sampleSize"] = 1000
        self.assertTrue(self._errors(V.check_augment_stats, doc))

    def test_win_rate_semantics_must_be_recorded(self):
        doc = self._build()
        del doc["semantics"]
        self.assertTrue(self._errors(V.check_champion_builds, doc))

    def test_the_confirmed_pick_rate_unit_is_rechecked_every_run(self):
        doc = self._build()
        doc["units"] = {"pickRate": {"status": "confirmed", "confirmation": "sums to 1000%"}}
        for champ in doc["champions"].values():
            champ["pickRate"] = 1000.0 / len(doc["champions"])
        self.assertEqual(self._errors(V.check_champion_builds, doc), [])
        doc["champions"]["c0"]["pickRate"] += 50
        self.assertTrue(self._errors(V.check_champion_builds, doc))

    def test_unknown_semantics_fail(self):
        doc = self._build()
        doc["semantics"] = {"augments[].winRate": {"status": "unknown"}}
        self.assertTrue(self._errors(V.check_champion_builds, doc))

    def test_too_few_champions_fail(self):
        doc = self._build()
        doc["champions"] = dict(list(doc["champions"].items())[:10])
        self.assertTrue(self._errors(V.check_champion_builds, doc))

    def test_feed_built_from_parsed_pages_passes(self):
        page = parse_build_page(fixture("build-yasuo.html"))
        page["pickRate"] = 1000.0 / V.MIN_CHAMPIONS  # the confirmed unit: champion pick rates sum to 1000%
        glob = [{"sourceSlug": r["sourceSlug"], "winRate": r["winRate"]} for r in page["augments"]]
        ctx = build_context(CATALOG, {})
        feed = build_champion_build_feed({f"c{i}": page for i in range(V.MIN_CHAMPIONS)}, [], ctx,
                                         fetched_at="t", global_rows=glob)
        self.assertEqual(feed["semantics"]["augments[].winRate"]["status"], "global-copy")
        self.assertEqual(self._errors(V.check_champion_builds, feed), [])


if __name__ == "__main__":
    unittest.main()
